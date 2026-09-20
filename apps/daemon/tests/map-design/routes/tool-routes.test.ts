import { createServer, type Server } from 'node:http';

import {
  MAP_TOOL_NAMES,
  type MapToolName,
} from '@mapseekai/map-design-contracts';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapDraftError } from '../../../src/map-design/application/errors.js';

import { createToolRequestAuth } from '../../../src/http/tool-request-auth.js';
import {
  registerMapDesignToolRoutes,
  type RegisterMapDesignToolRoutesDeps,
} from '../../../src/map-design/routes/tool-routes.js';
import {
  MAP_DESIGN_TOOL_ENDPOINTS,
  MAP_DESIGN_TOOL_OPERATIONS,
  ToolTokenRegistry,
} from '../../../src/tool-tokens.js';

const INPUTS: Record<MapToolName, unknown> = {
  map_get_context: {},
  map_inspect: { target: { kind: 'root' } },
  map_search_layers: { query: 'roads', limit: 25 },
  map_apply_transaction: {
    expectedRevision: 4,
    idempotencyKey: 'apply-001',
    transaction: { operations: [] },
    intentSummary: 'Apply a safe change',
  },
  map_update_semantics: {
    expectedRevision: 4,
    idempotencyKey: 'semantic-001',
    semantics: { version: 1, groups: [] },
    intentSummary: 'Update semantics',
  },
  map_validate: { expectedRevision: 4 },
  map_render_preview: { expectedRevision: 4, idempotencyKey: 'preview-001' },
  map_commit_revision: {
    expectedRevision: 4,
    idempotencyKey: 'commit-001',
    previewId: 'preview-1',
    intentSummary: 'Commit map',
  },
  map_discard_draft: {
    expectedRevision: 4,
    idempotencyKey: 'discard-001',
    intentSummary: 'Discard changes',
  },
};

const WRITE_TOOLS = new Set<MapToolName>([
  'map_apply_transaction',
  'map_update_semantics',
  'map_render_preview',
  'map_commit_revision',
  'map_discard_draft',
]);

let server: Server | undefined;
let registry: ToolTokenRegistry | undefined;

afterEach(async () => {
  vi.useRealTimers();
  registry?.clear();
  registry = undefined;
  if (server) {
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  }
});

async function startRouteServer(options: {
  projectReader?: RegisterMapDesignToolRoutesDeps['projectReader'];
} = {}) {
  registry = new ToolTokenRegistry();
  const auth = createToolRequestAuth(registry);
  const calls: Array<{ name: MapToolName; context: { requestId: string; projectId: string; runId: string }; input: unknown }> = [];
  const handlers = Object.fromEntries(MAP_TOOL_NAMES.map((name) => [
    name,
    async (context: { requestId: string; projectId: string; runId: string }, input: unknown) => {
      calls.push({ name, context, input });
      return {
        ok: false as const,
        error: { code: 'PROJECT_NOT_READY' as const, message: 'fixture domain failure', retryable: false },
        meta: context,
      };
    },
  ])) as unknown as RegisterMapDesignToolRoutesDeps['handlers'];
  const projectReads: string[] = [];
  const projectReader = options.projectReader ?? {
    getProject: async (projectId: string) => {
      projectReads.push(projectId);
      return { lifecycle: 'ready' as const };
    },
  };
  let request = 0;
  const app = express();
  app.use(express.json());
  registerMapDesignToolRoutes(app, {
    auth: { authorizeToolRequest: auth.authorizeToolRequest },
    projectReader,
    handlers,
    randomId: () => `request-${++request}`,
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('unexpected route server address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, calls, projectReader, projectReads };
}

async function post(
  baseUrl: string,
  name: MapToolName,
  token?: string,
  body: unknown = INPUTS[name],
  headers: Record<string, string> = {},
) {
  return fetch(`${baseUrl}${MAP_DESIGN_TOOL_ENDPOINTS[MAP_TOOL_NAMES.indexOf(name)]}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function mint(name: MapToolName, overrides: Partial<Parameters<ToolTokenRegistry['mint']>[0]> = {}) {
  const index = MAP_TOOL_NAMES.indexOf(name);
  return registry!.mint({
    runId: 'run-1',
    projectId: 'project-1',
    allowedEndpoints: [MAP_DESIGN_TOOL_ENDPOINTS[index]!],
    allowedOperations: [MAP_DESIGN_TOOL_OPERATIONS[index]!],
    ...overrides,
  });
}

describe('MapDesign run-scoped tool routes', () => {
  it('registers all nine contract tools after locally reading the token project', async () => {
    expect(MAP_DESIGN_TOOL_ENDPOINTS).toEqual(MAP_TOOL_NAMES.map((name) => `/api/map-design/tools/${name}`));

    const { baseUrl, calls, projectReads } = await startRouteServer();

    for (const name of MAP_TOOL_NAMES) {
      const response = await post(baseUrl, name, mint(name).token);
      expect(response.status, name).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: 'PROJECT_NOT_READY' },
        meta: { projectId: 'project-1', runId: 'run-1' },
      });
    }

    expect(calls.map((call) => call.name)).toEqual(MAP_TOOL_NAMES);
    expect(calls.every((call) => call.context.projectId === 'project-1' && call.context.runId === 'run-1')).toBe(true);
    expect(calls.map((call) => call.input)).toEqual(MAP_TOOL_NAMES.map((name) => INPUTS[name]));
    expect(projectReads).toEqual(MAP_TOOL_NAMES.map(() => 'project-1'));
  });

  it('rejects missing, revoked, expired, wrong-endpoint, and wrong-operation grants before handlers', async () => {
    const { baseUrl, calls } = await startRouteServer();

    expect((await post(baseUrl, 'map_get_context')).status).toBe(401);

    const revoked = mint('map_get_context');
    registry!.revokeToken(revoked.token);
    expect((await post(baseUrl, 'map_get_context', revoked.token)).status).toBe(401);

    const expired = mint('map_get_context', { nowMs: Date.now() - 1_000, ttlMs: 500 });
    expect((await post(baseUrl, 'map_get_context', expired.token)).status).toBe(401);

    const wrongEndpoint = registry!.mint({
      runId: 'run-1', projectId: 'project-1',
      allowedEndpoints: ['/api/tools/map-design/map_validate'],
      allowedOperations: ['map-design:map_get_context'],
    });
    expect((await post(baseUrl, 'map_get_context', wrongEndpoint.token)).status).toBe(403);

    const wrongOperation = registry!.mint({
      runId: 'run-1', projectId: 'project-1',
      allowedEndpoints: ['/api/tools/map-design/map_get_context'],
      allowedOperations: ['map-design:map_validate'],
    });
    expect((await post(baseUrl, 'map_get_context', wrongOperation.token)).status).toBe(403);

    expect(calls).toEqual([]);
  });

  it('uses the token project, ignores former workspace headers, and rejects body identity smuggling', async () => {
    const { baseUrl, calls, projectReads } = await startRouteServer();
    const token = mint('map_get_context').token;

    const response = await post(baseUrl, 'map_get_context', token, {
      projectId: 'other-project',
      runId: 'other-run',
    }, {
      'x-workspace-id': 'other-workspace',
      'x-workspace-capability': 'writeFiles',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(calls).toEqual([]);
    expect(projectReads).toEqual(['project-1']);
  });

  it('returns local not-found and readiness envelopes before dispatching a handler', async () => {
    const missing = await startRouteServer({
      projectReader: {
        getProject: async () => { throw new MapDraftError('NOT_FOUND', 'The map project was not found.'); },
      },
    });

    const missingResponse = await post(missing.baseUrl, 'map_get_context', mint('map_get_context').token);
    expect(missingResponse.status).toBe(200);
    expect(await missingResponse.json()).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
      meta: { projectId: 'project-1', runId: 'run-1' },
    });
    expect(missing.calls).toEqual([]);

    registry!.clear();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    const importing = await startRouteServer({
      projectReader: { getProject: async () => ({ lifecycle: 'importing' }) },
    });
    const importingResponse = await post(importing.baseUrl, 'map_get_context', mint('map_get_context').token);
    expect(importingResponse.status).toBe(200);
    expect(await importingResponse.json()).toMatchObject({
      ok: false,
      error: { code: 'PROJECT_NOT_READY' },
      meta: { projectId: 'project-1', runId: 'run-1' },
    });
    expect(importing.calls).toEqual([]);
  });
});
