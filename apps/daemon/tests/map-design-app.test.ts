import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMapDesignApp } from '../src/map-design-app.js';
import type { MapDesignProjectServices } from '../src/server-context.js';
import type { MapDesignProjectService } from '../src/map-design/application/project-service.js';
import type { MapDesignRunService } from '../src/map-design/application/run-service.js';
import { createMapDesignConfigStore, type MapDesignConfigStore } from '../src/map-design/storage/config-store.js';
import type { MapDesignLocalAgentRegistry } from '../src/map-design/application/local-agent-registry.js';
import type { SdkMapToolRuntime } from '../src/map-design/agents/sdk-tool-runtime.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';
import { startServer, type StartServerResult } from '../src/server.js';

let started: StartServerResult | undefined;
let dataDir: string | undefined;
afterEach(async () => { await started?.shutdown(); await new Promise<void>((resolve) => started?.server.close(() => resolve()) ?? resolve()); if (dataDir) await rm(dataDir, { recursive: true, force: true }); delete process.env.MAP_DESIGN_DATA_DIR; });

function sdkToolRuntime(): SdkMapToolRuntime {
  return {
    execute: vi.fn(async (call) => ({
      ok: false as const,
      toolUseId: call.toolUseId,
      error: { code: 'UNKNOWN_TOOL', message: 'The map tool call is not registered.', retryable: false },
    })),
    closeRun: vi.fn(),
  };
}

describe('MapDesign daemon route manifest', () => {
  it('serves retained system routes and returns 404 for retired surfaces', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'map-design-daemon-'));
    process.env.MAP_DESIGN_DATA_DIR = dataDir;
    started = await startServer({ port: 0, returnServer: true });
    await expect(fetch(`${started.url}/api/health`).then((response) => response.status)).resolves.toBe(200);
    await expect(fetch(`${started.url}/api/map-design/projects`).then((response) => response.status)).resolves.toBe(200);
    for (const route of ['/api/workspace/context', '/api/media/models', '/api/mcp/install-info', '/api/brands', '/api/library']) {
      await expect(fetch(`${started.url}${route}`).then((response) => response.status)).resolves.toBe(404);
    }
  });

  it('wires the daemon native tool registry into the concrete Codex capability at startup', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'map-design-codex-capability-'));
    process.env.MAP_DESIGN_DATA_DIR = dataDir;
    createMapDesignConfigStore(dataDir).update({
      agentCliEnv: { codex: { CODEX_BIN: process.execPath } },
    });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      kill: () => {
        queueMicrotask(() => child.emit('close', null));
        return true;
      },
    });
    const probeThreadStarts: Array<Record<string, unknown>> = [];
    stdin.on('data', (chunk: Buffer | string) => {
      for (const line of String(chunk).split('\n')) {
        if (!line) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.method === 'initialize') {
          stdout.write(`${JSON.stringify({
            id: frame.id,
            result: {
              userAgent: 'codex-app-server/test',
              codexHome: '/safe/codex-home',
              platformFamily: 'unix',
              platformOs: 'macos',
            },
          })}\n`);
        } else if (frame.method === 'thread/start') {
          probeThreadStarts.push(frame);
          stdout.write(`${JSON.stringify({ id: frame.id, result: { thread: { id: 'probe-thread' } } })}\n`);
        }
      }
    });
    const spawn = vi.fn(() => child);

    started = await startServer({
      port: 0,
      returnServer: true,
      localAgentSpawn: spawn,
    } as unknown as Parameters<typeof startServer>[0]);
    const response = await fetch(`${started.url}/api/agents`);
    const body = await response.json() as {
      agents: Array<{
        id: string;
        available: boolean;
        mapDesign: { nativeMapTools: boolean; publicReasoningSummary: boolean; reason?: string };
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.agents.find((agent) => agent.id === 'codex')).toMatchObject({
      id: 'codex',
      available: true,
      mapDesign: {
        nativeMapTools: true,
        publicReasoningSummary: true,
      },
    });
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['app-server', '--stdio'],
      expect.objectContaining({ cwd: expect.any(String) }),
    );
    expect(probeThreadStarts).toMatchObject([{
      method: 'thread/start',
      params: {
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        dynamicTools: [{ type: 'namespace', name: 'map-design' }],
      },
    }]);
  });

  it('creates and reads a local map project and conversation from a clean data root', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'map-design-lifecycle-'));
    process.env.MAP_DESIGN_DATA_DIR = dataDir;
    started = await startServer({ port: 0, returnServer: true });
    const created = await fetch(`${started.url}/api/map-design/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'clean-root-map',
        title: 'Clean root map',
        source: { url: 'https://maps.example.test/style.json' },
        designRequirement: 'Make it clear.',
        runtime: { agentId: 'claude' },
        idempotencyKey: 'clean-root-create',
      }),
    });
    expect(created.status).toBe(201);
    const aggregate = await created.json() as { conversationId: string; project: { projectId: string } };
    expect(aggregate).toMatchObject({ project: { projectId: 'clean-root-map' }, conversationId: expect.any(String) });
    await expect(fetch(`${started.url}/api/map-design/projects/clean-root-map`).then((response) => response.status)).resolves.toBe(200);
    await expect(fetch(`${started.url}/api/map-design/projects/clean-root-map/conversation`).then((response) => response.json())).resolves.toMatchObject({ id: aggregate.conversationId, projectId: 'clean-root-map' });
  });
  it('mounts project-scoped conversation runtime routes with the authoritative production runtime policy', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'map-design-runtime-routes-'));
    process.env.MAP_DESIGN_DATA_DIR = dataDir;
    createMapDesignConfigStore(dataDir).update({ agentCliEnv: { codex: { CODEX_BIN: process.execPath } } });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      kill: () => {
        queueMicrotask(() => child.emit('close', null));
        return true;
      },
    });
    stdin.on('data', (chunk: Buffer | string) => {
      for (const line of String(chunk).split('\n')) {
        if (!line) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.method === 'initialize') {
          stdout.write(`${JSON.stringify({
            id: frame.id,
            result: {
              userAgent: 'codex-app-server/test',
              codexHome: '/safe/codex-home',
              platformFamily: 'unix',
              platformOs: 'macos',
            },
          })}\n`);
        } else if (frame.method === 'thread/start') {
          stdout.write(`${JSON.stringify({ id: frame.id, result: { thread: { id: 'probe-thread' } } })}\n`);
        }
      }
    });
    started = await startServer({
      port: 0,
      returnServer: true,
      localAgentSpawn: () => child,
    });

    const created = await fetch(`${started.url}/api/map-design/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'runtime-routes-map', title: 'Runtime routes map',
        source: { url: 'https://maps.example.test/style.json' }, designRequirement: 'Make it clear.',
        runtime: { agentId: 'codex' }, idempotencyKey: 'runtime-routes-create',
      }),
    });
    const createdBody = await created.json() as { conversationId: string };
    const route = `${started.url}/api/map-design/projects/runtime-routes-map/conversations/${createdBody.conversationId}/runtime`;

    await expect(fetch(route).then(async (response) => ({ status: response.status, body: await response.json() })))
      .resolves.toEqual({
        status: 200,
        body: {
          runtime: expect.objectContaining({ agentId: 'codex', revision: 0 }),
          effectiveRuntime: expect.objectContaining({ agentId: 'codex', model: 'default', revision: 0 }),
        },
      });
    await expect(fetch(route, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, clientRequestId: 'runtime-routes-update', runtime: { agentId: 'codex' } }),
    }).then(async (response) => ({ status: response.status, body: await response.json() })))
      .resolves.toEqual({
        status: 200,
        body: {
          runtime: expect.objectContaining({ agentId: 'codex', revision: 1 }),
          effectiveRuntime: expect.objectContaining({ agentId: 'codex', model: 'default', revision: 1 }),
        },
      });
    await expect(fetch(route, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        clientRequestId: 'runtime-routes-invalid-reasoning',
        runtime: { agentId: 'codex', reasoning: 'not-supported' },
      }),
    }).then(async (response) => ({ status: response.status, body: await response.json() })))
      .resolves.toEqual({
        status: 400,
        body: { error: { code: 'INVALID_INPUT', message: 'The map draft request is invalid.', retryable: false } },
      });
  });
  it('logs only a bounded redacted completion record', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'map-design-request-log-'));
    process.env.MAP_DESIGN_DATA_DIR = dataDir;
    const records: unknown[][] = [];
    const info = console.info;
    console.info = (...args: unknown[]) => { records.push(args); };
    try {
      started = await startServer({ port: 0, returnServer: true });
      const response = await fetch(`${started.url}/api/health?access_token=secret-query`, {
        headers: { Authorization: 'Bearer secret-token', 'X-Api-Key': 'secret-key' },
      });
      expect(response.status).toBe(200);
    } finally {
      console.info = info;
    }
    expect(records).toContainEqual([
      'map-design.request',
      expect.objectContaining({
        method: 'GET',
        path: '/api/health',
        status: 200,
        durationMs: expect.any(Number),
        requestId: expect.any(String),
      }),
    ]);
    const completion = records.find(([event]) => event === 'map-design.request')?.[1] as Record<string, unknown>;
    expect(Object.keys(completion).sort()).toEqual(['durationMs', 'method', 'path', 'requestId', 'status']);
    expect(JSON.stringify(records)).not.toContain('secret-');
  });
  it('returns 400 for malformed JSON and 413 for oversized JSON', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'map-design-body-errors-'));
    process.env.MAP_DESIGN_DATA_DIR = dataDir;
    started = await startServer({ port: 0, returnServer: true });
    const malformed = await fetch(`${started.url}/api/map-design/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    const oversized = await fetch(`${started.url}/api/map-design/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(65 * 1024) }),
    });
    expect(oversized.status).toBe(413);
  });

  it('mounts source preview Style and cleanup routes', async () => {
    const getPreviewStyle = vi.fn(() => ({ version: 8 as const, sources: {}, layers: [] }));
    const deletePreview = vi.fn();
    const sourceImportService = {
      getPreviewStyle,
      deletePreview,
      getResource: vi.fn(),
      getPmtilesArchiveRange: vi.fn(),
    };
    const app = createMapDesignApp({
      mapServices: {
        queryService: { getProject: async () => ({}) },
        resourceService: { getResource: vi.fn(), getPmtilesArchiveRange: vi.fn() },
        sourceImportService,
      } as unknown as MapDesignProjectServices,
      projectService: {} as MapDesignProjectService,
      runService: {} as MapDesignRunService,
      config: {} as MapDesignConfigStore,
      agents: {} as MapDesignLocalAgentRegistry,
      toolTokens: new ToolTokenRegistry(),
      sdkToolRuntime: sdkToolRuntime(),
      loadPreviewRun: () => null,
      requireLocalRequest: (_request, _response, next) => next(),
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test app did not bind');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const style = await fetch(`${origin}/api/map-design/source-previews/preview-1/style`);
      expect(style.status).toBe(200);
      expect(await style.json()).toEqual({ version: 8, sources: {}, layers: [] });
      const removed = await fetch(`${origin}/api/map-design/source-previews/preview-1`, { method: 'DELETE' });
      expect(removed.status).toBe(204);
      expect(getPreviewStyle).toHaveBeenCalledWith('preview-1');
      expect(deletePreview).toHaveBeenCalledWith('preview-1');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('applies the preview route 12 MiB parser before the global 64 KiB parser', async () => {
    const fulfilled = {
      status: 'failed' as const, previewId: 'preview-1', draftRevision: 4, styleHash: 'b'.repeat(64), png: null,
      report: { digest: 'd'.repeat(64), mediaType: 'application/json' as const, byteLength: 10 },
      validationSummary: { status: 'valid' as const, errors: 0, warnings: 0, infos: 0, totalFindings: 0, returnedFindings: 0, omittedFindings: 0 },
    };
    const fulfill = async () => fulfilled;
    const app = createMapDesignApp({
      mapServices: {
        queryService: { getProject: async () => ({}) },
        previewFulfillmentService: { fulfill, getCurrent: () => ({ preview: fulfilled }) },
      } as unknown as MapDesignProjectServices,
      projectService: {} as MapDesignProjectService,
      runService: {} as MapDesignRunService,
      config: {} as MapDesignConfigStore,
      agents: {} as MapDesignLocalAgentRegistry,
      toolTokens: new ToolTokenRegistry(),
      sdkToolRuntime: sdkToolRuntime(),
      loadPreviewRun: () => null,
      requireLocalRequest: (_request, _response, next) => next(),
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test app did not bind');
    const route = `http://127.0.0.1:${address.port}/api/map-design/projects/project-1/previews/preview-1/fulfill`;
    const valid = {
      status: 'succeeded', previewId: 'preview-1', draftRevision: 4, styleHash: 'b'.repeat(64),
      pngBase64: 'A'.repeat(65 * 1024), report: { previewId: 'preview-1', validationDigest: 'd'.repeat(64) },
    };
    try {
      expect((await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid) })).status).toBe(200);
      valid.pngBase64 = 'A'.repeat(12 * 1024 * 1024);
      expect((await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid) })).status).toBe(413);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it('registers commit-from-preview after the preview parser without narrowing preview payloads', async () => {
    const commit = async () => ({ revision: 1, draftRevision: 4, styleHash: 'b'.repeat(64),
      attestationDigest: 'd'.repeat(64), committedAt: '2026-08-15T00:00:00.000Z' });
    const app = createMapDesignApp({
      mapServices: {
        queryService: { getProject: async () => ({}) },
        revisionService: { commit },
      } as unknown as MapDesignProjectServices,
      projectService: {} as MapDesignProjectService,
      runService: {} as MapDesignRunService,
      config: {} as MapDesignConfigStore,
      agents: {} as MapDesignLocalAgentRegistry,
      toolTokens: new ToolTokenRegistry(),
      sdkToolRuntime: sdkToolRuntime(),
      loadPreviewRun: () => ({ runId: 'run-1' }),
      requireLocalRequest: (_request, _response, next) => next(),
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test app did not bind');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const response = await fetch(`${origin}/api/map-design/projects/project-1/revisions/commit-from-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 4,
          idempotencyKey: 'commit-preview-1',
          previewId: 'preview-1',
          intentSummary: 'Approve map.',
        }),
      });
      expect(response.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });


  it('returns a safe 500 when an operational dependency fails', async () => {
    const failingServices = {
      queryService: { getProject: async () => { throw new Error('database secret'); } },
      resourceService: {},
    } as unknown as MapDesignProjectServices;
    const app = createMapDesignApp({
      mapServices: failingServices,
      projectService: {} as unknown as MapDesignProjectService,
      runService: {} as unknown as MapDesignRunService,
      config: {} as unknown as MapDesignConfigStore,
      agents: {} as unknown as MapDesignLocalAgentRegistry,
      toolTokens: new ToolTokenRegistry(),
      sdkToolRuntime: sdkToolRuntime(),
      loadPreviewRun: () => null,
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test app did not bind');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/map-design/projects/project/resources/resource/asset`);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: { code: 'RESOURCE_ERROR', message: 'Map resource request failed' },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
