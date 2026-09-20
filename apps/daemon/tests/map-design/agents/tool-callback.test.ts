import { createServer, type Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createToolRequestAuth } from '../../../src/http/tool-request-auth.js';
import {
  createRunToolCallback,
  RUN_TOOL_CALLBACK_AGENT_HEADER,
  RUN_TOOL_CALLBACK_CONVERSATION_HEADER,
  RUN_TOOL_CALLBACK_PROJECT_HEADER,
  RUN_TOOL_CALLBACK_RUN_HEADER,
  RUN_TOOL_CALLBACK_TOOL_USE_HEADER,
} from '../../../src/map-design/agents/tool-callback.js';
import { createSdkMapToolRuntime } from '../../../src/map-design/agents/sdk-tool-runtime.js';
import { registerMapDesignToolRoutes } from '../../../src/map-design/routes/tool-routes.js';
import type { MapDesignNativeToolRegistry } from '../../../src/map-design/tools/tool-context.js';
import {
  MAP_DESIGN_TOOL_ENDPOINTS,
  MAP_DESIGN_TOOL_OPERATIONS,
  ToolTokenRegistry,
} from '../../../src/tool-tokens.js';

let server: Server | undefined;
let tokens: ToolTokenRegistry | undefined;

afterEach(async () => {
  tokens?.clear();
  tokens = undefined;
  vi.restoreAllMocks();
  if (server) {
    const activeServer = server;
    server = undefined;
    activeServer.closeAllConnections();
    if (activeServer.listening) {
      await new Promise<void>((resolve, reject) => activeServer.close((error) => error ? reject(error) : resolve()));
    }
  }
});

async function fixture(options: {
  projectReader?: { getProject(projectId: string): Promise<{ lifecycle: 'importing' | 'ready' | 'failed' }> };
} = {}) {
  const calls: unknown[] = [];
  const nativeRegistry: MapDesignNativeToolRegistry = {
    definitions: () => [{ name: 'map_validate', description: 'Validate.', inputSchema: { type: 'object' } }],
    call: vi.fn(async (context, name, input) => {
      calls.push({ context, name, input });
      return {
        ok: true as const,
        toolUseId: context.toolUseId,
        summary: { valid: true },
        modelContent: '{"valid":true}',
      };
    }),
  };
  const sdkToolRuntime = createSdkMapToolRuntime(nativeRegistry);
  const noteActivity = vi.fn();
  tokens = new ToolTokenRegistry();
  const app = express();
  registerMapDesignToolRoutes(app, {
    auth: createToolRequestAuth(tokens),
    projectReader: options.projectReader ?? { getProject: async () => ({ lifecycle: 'ready' }) },
    handlers: {} as never,
    sdkToolRuntime,
    noteActivity,
  });
  app.use((error: unknown, _request: unknown, response: express.Response, _next: unknown) => {
    const status = typeof error === 'object' && error !== null && 'type' in error
      && (error as { type?: string }).type === 'entity.too.large' ? 413 : 500;
    response.status(status).json({
      error: {
        code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL',
        message: status === 413 ? 'The request body is too large.' : 'The request failed.',
      },
    });
  });
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(0, '127.0.0.1', () => {
      server?.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  const grant = tokens.mint({
    runId: 'run-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    agentId: 'opencode',
    allowedEndpoints: [MAP_DESIGN_TOOL_ENDPOINTS[5]],
    allowedOperations: [MAP_DESIGN_TOOL_OPERATIONS[5]],
    ttlMs: 60_000,
  });
  const close = vi.fn(() => {
    sdkToolRuntime.closeRun(grant.runId);
    tokens?.revokeRun(grant.runId, 'manual');
  });
  const callback = createRunToolCallback({
    daemonUrl: `http://127.0.0.1:${address.port}`,
    grant,
    close,
  });
  return { callback, calls, close, grant, nativeRegistry, noteActivity, sdkToolRuntime };
}

function headers(token: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    [RUN_TOOL_CALLBACK_RUN_HEADER]: 'run-1',
    [RUN_TOOL_CALLBACK_PROJECT_HEADER]: 'project-1',
    [RUN_TOOL_CALLBACK_CONVERSATION_HEADER]: 'conversation-1',
    [RUN_TOOL_CALLBACK_AGENT_HEADER]: 'opencode',
    [RUN_TOOL_CALLBACK_TOOL_USE_HEADER]: 'tool-1',
    ...overrides,
  };
}

function validate(url: string, token: string, options: {
  body?: string;
  headers?: Record<string, string>;
} = {}) {
  return fetch(`${url}/map_validate`, {
    method: 'POST',
    headers: headers(token, options.headers),
    body: options.body ?? JSON.stringify({ expectedRevision: 4 }),
  });
}

describe('run-scoped child tool callback', () => {
  it('exposes a loopback-only token-free URL and uses bearer authentication', async () => {
    const { callback, calls, noteActivity } = await fixture();

    expect(callback.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/map-design\/tools$/u);
    expect(callback.url).not.toContain(callback.token);
    expect((await validate(callback.url, 'wrong-token')).status).toBe(401);
    expect(noteActivity).not.toHaveBeenCalled();

    const response = await validate(callback.url, callback.token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      toolUseId: 'tool-1',
      summary: { valid: true },
      modelContent: '{"valid":true}',
    });
    expect(calls).toHaveLength(1);
    expect(noteActivity.mock.calls).toEqual([['run-1'], ['run-1']]);
  });

  it('rejects non-loopback callback URLs without leaking its token', () => {
    const token = 'odtt_never-print-this';
    const grant = {
      token,
      runId: 'run-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      agentId: 'opencode',
      allowedEndpoints: [MAP_DESIGN_TOOL_ENDPOINTS[5]],
      allowedOperations: [MAP_DESIGN_TOOL_OPERATIONS[5]],
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
    };

    let caught: unknown;
    try {
      createRunToolCallback({ daemonUrl: 'https://example.com', grant, close: vi.fn() });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(token);
  });

  it('enforces endpoint, operation, Run, project, conversation, and Agent scope', async () => {
    const { callback, calls, noteActivity } = await fixture();
    const mismatches = [
      { [RUN_TOOL_CALLBACK_RUN_HEADER]: 'run-2' },
      { [RUN_TOOL_CALLBACK_PROJECT_HEADER]: 'project-2' },
      { [RUN_TOOL_CALLBACK_CONVERSATION_HEADER]: 'conversation-2' },
      { [RUN_TOOL_CALLBACK_AGENT_HEADER]: 'pi' },
    ];
    for (const mismatch of mismatches) {
      const response = await validate(callback.url, callback.token, { headers: mismatch });
      expect(response.status).toBe(403);
      expect(JSON.stringify(await response.json())).not.toContain(callback.token);
    }

    const wrongEndpoint = await fetch(`${callback.url}/map_get_context`, {
      method: 'POST',
      headers: headers(callback.token),
      body: '{}',
    });
    expect(wrongEndpoint.status).toBe(403);
    expect(calls).toEqual([]);
    expect(noteActivity).not.toHaveBeenCalled();
  });

  it('correlates a project-not-ready callback failure to the declared tool-use id', async () => {
    const { callback, calls, noteActivity } = await fixture({
      projectReader: { getProject: async () => ({ lifecycle: 'importing' }) },
    });

    const response = await validate(callback.url, callback.token);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      toolUseId: 'tool-1',
      error: {
        code: 'PROJECT_NOT_READY',
        message: 'The map project is not ready.',
        retryable: false,
      },
    });
    expect(calls).toEqual([]);
    expect(noteActivity).not.toHaveBeenCalled();
  });

  it('correlates an invalid-input callback failure to the declared tool-use id', async () => {
    const { callback, calls, noteActivity } = await fixture();

    const response = await validate(callback.url, callback.token, {
      body: JSON.stringify({ expectedRevision: 'invalid' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      toolUseId: 'tool-1',
      error: {
        code: 'INVALID_INPUT',
        message: 'The map tool input is invalid.',
        retryable: false,
      },
    });
    expect(calls).toEqual([]);
    expect(noteActivity).not.toHaveBeenCalled();
  });

  it('bounds request bodies and never prints the bearer token in logs or public errors', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { callback, calls, noteActivity } = await fixture();

    const response = await validate(callback.url, callback.token, {
      body: JSON.stringify({ expectedRevision: 4, padding: 'x'.repeat(1024 * 1024) }),
    });

    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain(callback.token);
    expect(JSON.stringify(info.mock.calls)).not.toContain(callback.token);
    expect(JSON.stringify(error.mock.calls)).not.toContain(callback.token);
    expect(calls).toEqual([]);
    expect(noteActivity).not.toHaveBeenCalled();
  });

  it('rejects expired and revoked grants before Native Tool Registry dispatch', async () => {
    const { callback, calls, noteActivity } = await fixture();
    tokens?.revokeRun('run-1', 'manual');

    expect((await validate(callback.url, callback.token)).status).toBe(401);
    expect(calls).toEqual([]);

    const expired = tokens!.mint({
      runId: 'run-expired',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      agentId: 'opencode',
      allowedEndpoints: [MAP_DESIGN_TOOL_ENDPOINTS[5]],
      allowedOperations: [MAP_DESIGN_TOOL_OPERATIONS[5]],
      nowMs: Date.now() - 10_000,
      ttlMs: 1,
    });
    const response = await validate(callback.url, expired.token, {
      headers: { [RUN_TOOL_CALLBACK_RUN_HEADER]: 'run-expired' },
    });
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
    expect(noteActivity).not.toHaveBeenCalled();
  });

  it('replays an identical duplicate call once and rejects changed duplicate input', async () => {
    const { callback, calls, noteActivity } = await fixture();

    const first = await validate(callback.url, callback.token);
    const replay = await validate(callback.url, callback.token);
    expect(await replay.json()).toEqual(await first.json());
    expect(calls).toHaveLength(1);
    expect(noteActivity.mock.calls).toEqual([['run-1'], ['run-1']]);

    const changed = await validate(callback.url, callback.token, {
      body: JSON.stringify({ expectedRevision: 5 }),
    });
    expect(await changed.json()).toMatchObject({
      ok: false,
      toolUseId: 'tool-1',
      error: { code: 'DUPLICATE_TOOL_CALL', retryable: false },
    });
    expect(calls).toHaveLength(1);
    expect(noteActivity.mock.calls).toEqual([['run-1'], ['run-1']]);
  });

  it('closes once, revokes authorization, and rejects terminal late calls', async () => {
    const { callback, calls, close } = await fixture();
    callback.close();
    callback.close();

    expect(close).toHaveBeenCalledTimes(1);
    expect((await validate(callback.url, callback.token)).status).toBe(401);
    expect(calls).toEqual([]);
  });
});
