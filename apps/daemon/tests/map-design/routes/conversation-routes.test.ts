import express, { type Express } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requireLocalDaemonRequest } from '../../../src/http/local-daemon-request.js';
import { MapDesignConversationService } from '../../../src/map-design/application/conversation-service.js';
import { MapDesignConversationRuntimeService, type ConversationRuntimeChoicePolicy } from '../../../src/map-design/application/conversation-runtime-service.js';
import { createMapDesignConversationRouter } from '../../../src/map-design/routes/conversation-routes.js';
import { closeMapDesignDatabase, openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';

const roots: Array<{ db: ReturnType<typeof openMapDesignDatabase>; root: string }> = [];
const NOW = '2026-08-27T00:00:00.000Z';

const runtimePolicy: ConversationRuntimeChoicePolicy = {
  validate(input) {
    if (!['codex', 'opencode', 'pi'].includes(input.agentId)) throw new Error('unsupported runtime');
    return input;
  },
  normalizeSaved(input) {
    return { runtime: input };
  },
};

function setup(options: { requireLocalDaemonRequest?: express.RequestHandler; projectRunning?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'map-conversation-routes-'));
  const db = openMapDesignDatabase(root);
  const store = createMapDesignLocalStore(db);
  createProject(db, store, 'project-1', 'conversation-1');
  const ids = ['conversation-2'];
  const service = new MapDesignConversationService({
    store,
    isConversationRunning: () => options.projectRunning ?? false,
    randomId: () => ids.shift() ?? 'unexpected-conversation',
    now: () => NOW,
  });
  const runtimeService = new MapDesignConversationRuntimeService({
    store,
    policy: runtimePolicy,
    isProjectRunning: () => options.projectRunning ?? false,
    now: () => NOW,
  });
  roots.push({ db, root });
  const app: Express = express();
  app.use(createMapDesignConversationRouter({
    service,
    runtimeService,
    requireLocalDaemonRequest: options.requireLocalDaemonRequest ?? requireLocalDaemonRequest,
  }));
  return { app, db, store };
}

function createProject(
  db: ReturnType<typeof openMapDesignDatabase>,
  store: ReturnType<typeof createMapDesignLocalStore>,
  projectId: string,
  primaryConversationId: string,
) {
  store.createProject({
    project: {
      projectId,
      title: 'Map',
      runtime: { agentId: 'claude' },
      source: { url: 'https://example.com/style.json' },
      designRequirement: 'Keep labels clear',
      idempotencyKey: `${projectId}-create`,
    },
    primaryConversationId,
    verifiedWorkingDirectory: null,
  });
  db.prepare(`INSERT INTO map_design_projects (
    project_id, lifecycle_state, design_system_id, design_system_digest,
    draft_revision, created_at, updated_at
  ) VALUES (?, 'importing', 'quiet-walking', ?, 0, ?, ?)`)
    .run(projectId, 'a'.repeat(64), NOW, NOW);
}

async function request(app: Express, route: string, init: RequestInit = {}) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not listen');
  try {
    return await fetch(`http://127.0.0.1:${address.port}${route}`, init);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function requestReadWithBody(app: Express, route: string): Promise<number> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not listen');
  try {
    return await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest({
        hostname: '127.0.0.1',
        port: address.port,
        path: route,
        method: 'GET',
        headers: { 'content-type': 'application/json', 'content-length': '2' },
      }, (response) => resolve(response.statusCode ?? 0));
      outgoing.once('error', reject);
      outgoing.end('{}');
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function requestReadWithTransferEncoding(app: Express, route: string): Promise<number> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not listen');
  try {
    return await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest({
        hostname: '127.0.0.1', port: address.port, path: route, method: 'GET',
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      }, (response) => resolve(response.statusCode ?? 0));
      outgoing.once('error', reject);
      outgoing.end('{}');
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('MapDesign conversation routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const { db, root } of roots.splice(0)) {
      closeMapDesignDatabase(db);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deletes conversations through the project-scoped guarded endpoint', async () => {
    const { app, store, db } = setup();
    createProject(db, store, 'project-2', 'other-conversation');
    const path = '/api/map-design/projects/project-1/conversations/conversation-1';
    expect((await request(app, path, { method: 'DELETE', headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await request(app, '/api/map-design/projects/project-2/conversations/conversation-1', { method: 'DELETE' })).status).toBe(404);
    expect((await request(app, path, { method: 'DELETE' })).status).toBe(204);
    expect((await request(app, path, { method: 'DELETE' })).status).toBe(204);
    expect(store.getConversation('conversation-1')).toBeNull();
    expect(store.getConversation('other-conversation')).not.toBeNull();
  });

  it('returns a conflict when the conversation is running', async () => {
    const { app, store } = setup({ projectRunning: true });
    const result = await request(app, '/api/map-design/projects/project-1/conversations/conversation-1', { method: 'DELETE' });
    expect(result.status).toBe(409);
    expect(store.getConversation('conversation-1')).not.toBeNull();
  });

  it('lists project conversations and creates one after JSON validation', async () => {
    const { app } = setup();
    const response = await request(app, '/api/map-design/projects/project-1/conversations');
    expect(await response.json()).toEqual({
      conversations: [expect.objectContaining({ conversationId: 'conversation-1' })],
    });

    const created = await request(app, '/api/map-design/projects/project-1/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'new-chat-1' }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      conversation: expect.objectContaining({ conversationId: 'conversation-2' }),
    });
  });

  it('reads and updates a project-owned runtime with CAS replay protection', async () => {
    const { app } = setup();
    const route = '/api/map-design/projects/project-1/conversations/conversation-1/runtime';

    const initial = await request(app, route);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      runtime: expect.objectContaining({ agentId: 'claude', revision: 0 }),
      effectiveRuntime: expect.objectContaining({ agentId: 'claude', revision: 0 }),
    });

    const body = {
      expectedRevision: 0,
      clientRequestId: 'runtime-update-1',
      runtime: { agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog' },
    };
    const updated = await request(app, route, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      runtime: { agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 1, updatedAt: NOW },
      effectiveRuntime: { agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 1, updatedAt: NOW },
    });
    const replay = await request(app, route, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      runtime: { agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 1, updatedAt: NOW },
      effectiveRuntime: { agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 1, updatedAt: NOW },
    });
    const stale = await request(app, route, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        expectedRevision: 0, clientRequestId: 'runtime-update-2', runtime: { agentId: 'pi' },
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: {
        code: 'RUNTIME_CONFLICT',
        message: 'The conversation runtime changed in another client.',
        retryable: false,
        details: {
          currentRuntime: {
            agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 1, updatedAt: NOW,
          },
        },
      },
    });
  });

  it('enforces strict JSON runtime writes and rejects runtime changes while a project run is active', async () => {
    const route = '/api/map-design/projects/project-1/conversations/conversation-1/runtime';
    const { app } = setup();
    expect((await request(app, route, { method: 'PUT', body: '{}' })).status).toBe(415);
    expect((await request(app, route, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{',
    })).status).toBe(400);
    expect((await request(app, route, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        expectedRevision: 0, clientRequestId: 'runtime-update-1', runtime: { agentId: 'opencode' }, extra: true,
      }),
    })).status).toBe(400);
    expect((await request(app, route, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        expectedRevision: 0, clientRequestId: 'x'.repeat(70_000), runtime: { agentId: 'opencode' },
      }),
    })).status).toBe(413);

    const { app: runningApp } = setup({ projectRunning: true });
    const blocked = await request(runningApp, route, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        expectedRevision: 0, clientRequestId: 'runtime-update-1', runtime: { agentId: 'opencode' },
      }),
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: 'RUNTIME_CONFLICT', details: { reason: 'ACTIVE_RUN' } } });
  });

  it('reads a project conversation and keeps cross-project reads indistinguishable from missing conversations', async () => {
    const { app, db, store } = setup();
    createProject(db, store, 'project-2', 'conversation-2');

    const found = await request(app, '/api/map-design/projects/project-1/conversations/conversation-1');
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual(expect.objectContaining({
      id: 'conversation-1', projectId: 'project-1', messages: [],
    }));

    const missing = await request(app, '/api/map-design/projects/project-1/conversations/missing-conversation');
    const crossProject = await request(app, '/api/map-design/projects/project-1/conversations/conversation-2');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'The map conversation was not found.',
        retryable: false,
      },
    });
    expect(await crossProject.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'The map conversation was not found.',
        retryable: false,
      },
    });
  });

  it('validates item identifiers, rejects read bodies, and gates item reads before validation', async () => {
    const { app } = setup();
    expect((await request(app, `/api/map-design/projects/project-1/conversations/${'a'.repeat(257)}`)).status).toBe(400);
    expect(await requestReadWithBody(app, '/api/map-design/projects/project-1/conversations/conversation-1')).toBe(400);

    const denied = vi.fn((_request: express.Request, response: express.Response) => {
      response.status(403).json({ error: 'local only' });
    });
    const { app: deniedApp } = setup({ requireLocalDaemonRequest: denied });
    const response = await request(deniedApp, `/api/map-design/projects/${'a'.repeat(257)}/conversations/${'a'.repeat(257)}`);

    expect(response.status).toBe(403);
    expect(denied).toHaveBeenCalledOnce();
  });

  it('rejects collection read bodies after the local-request and project-id gates', async () => {
    const { app } = setup();
    const route = '/api/map-design/projects/project-1/conversations';
    expect(await requestReadWithBody(app, route)).toBe(400);
    expect(await requestReadWithTransferEncoding(app, route)).toBe(400);

    const denied = vi.fn((_request: express.Request, response: express.Response) => {
      response.status(403).json({ error: 'local only' });
    });
    const { app: deniedApp } = setup({ requireLocalDaemonRequest: denied });
    const response = await requestReadWithBody(deniedApp, `/api/map-design/projects/${'a'.repeat(257)}/conversations`);
    expect(response).toBe(403);
    expect(denied).toHaveBeenCalledOnce();
  });

  it('rejects malformed JSON, non-JSON creates, and invalid project or idempotency identifiers', async () => {
    const { app, store } = setup();
    const route = '/api/map-design/projects/project-1/conversations';
    expect((await request(app, route, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    })).status).toBe(400);
    expect((await request(app, route, {
      method: 'POST', body: JSON.stringify({ idempotencyKey: 'new-chat-1' }),
    })).status).toBe(415);
    expect((await request(app, `/api/map-design/projects/${'a'.repeat(257)}/conversations`)).status).toBe(400);
    expect((await request(app, route, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: '   ' }),
    })).status).toBe(400);
    expect(store.listConversations('project-1')).toHaveLength(1);
  });

  it('applies the local-request gate before JSON parsing or service invocation', async () => {
    const denied = vi.fn((_request: express.Request, response: express.Response) => {
      response.status(403).json({ error: 'local only' });
    });
    const { app, store } = setup({ requireLocalDaemonRequest: denied });

    const response = await request(app, '/api/map-design/projects/project-1/conversations', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{malformed',
    });

    expect(response.status).toBe(403);
    expect(denied).toHaveBeenCalledOnce();
    expect(store.listConversations('project-1')).toHaveLength(1);
  });

  it('returns a conflict when an idempotency key belongs to a different project', async () => {
    const { app, db, store } = setup();
    const create = (projectId: string) => request(app, `/api/map-design/projects/${projectId}/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'new-chat-1' }),
    });
    expect((await create('project-1')).status).toBe(201);
    createProject(db, store, 'project-2', 'conversation-3');

    const response = await create('project-2');

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(store.listConversations('project-2')).toHaveLength(1);
  });
});
