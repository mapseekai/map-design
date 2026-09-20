import { createHmac, randomBytes } from 'node:crypto';
import express, { type Express } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { resetDesktopAuthForTests, setDesktopAuthSecret, verifyDesktopWorkingDirectoryGrant } from '../../../src/desktop-auth.js';
import { requireLocalDaemonRequest } from '../../../src/http/local-daemon-request.js';
import { MapDesignProjectService } from '../../../src/map-design/application/project-service.js';
import { createMapDesignProjectRouter } from '../../../src/map-design/routes/project-routes.js';
import { closeMapDesignDatabase, openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';

const roots: string[] = [];
const NOW = '2026-08-24T00:00:00.000Z';

function createInput(projectId = 'project-1') {
  return {
    projectId,
    title: 'Map',
    source: { url: 'https://example.com/style.json' },
    designRequirement: 'Make it clear',
    runtime: { agentId: 'claude' },
    idempotencyKey: 'create-key',
  };
}

it('imports and binds a cartography document through HTTP and returns the same document when reopened', async () => {
  const { app, db } = setup();
  try {
    const source = '---\nversion: "0.4.0"\nname: Atlas\n---\n\n## Overview\n\nQuiet ink.\n';
    const headers = { 'content-type': 'application/json' };
    const imported = await request(app, '/api/map-design/cartographies', { method: 'POST', headers, body: JSON.stringify({ source }) });
    expect(imported.status).toBe(201);
    const document = await imported.json() as { id: string; name: string };
    const created = await request(app, '/api/map-design/projects', { method: 'POST', headers, body: JSON.stringify({
      projectId: 'cartography-project', title: 'Atlas', source: { url: 'https://example.com/style.json' },
      designRequirement: 'Quiet ink', runtime: { agentId: 'claude' }, idempotencyKey: 'cartography-create', cartographyId: document.id,
    }) });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ cartography: document });
    const reopened = await request(app, '/api/map-design/projects/cartography-project');
    expect(await reopened.json()).toMatchObject({ cartography: document });
    const stored = await request(app, `/api/map-design/cartographies/${document.id}`);
    expect(await stored.json()).toMatchObject({ source });
  } finally { db.close(); }
});

function setup(options: { verifyWorkingDirectoryGrant?: (grant: { path: string; token: string }) => Promise<string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'map-project-routes-'));
  roots.push(root);
  const db = openMapDesignDatabase(root);
  const store = createMapDesignLocalStore(db);
  const projectService = new MapDesignProjectService({
    store,
    sourceImportService: {
      prepareImportInTransaction(database: Database.Database, projectId: string) {
        database.prepare(`INSERT INTO map_design_projects (project_id, lifecycle_state, design_system_id, design_system_digest, draft_revision, created_at, updated_at) VALUES (?, 'importing', 'quiet-walking', ?, 0, ?, ?)`)
          .run(projectId, 'a'.repeat(64), NOW, NOW);
        database.prepare(`INSERT INTO map_design_import_jobs (project_id, status, import_request_json, import_request_digest, attempt, queued_at) VALUES (?, 'queued', '{}', 'a', 1, ?)`)
          .run(projectId, NOW);
        return { projectId, lifecycle: 'importing' as const, sourceKind: null, designSystemId: 'quiet-walking', designSystemDigest: 'a'.repeat(64), draftRevision: 0, committedRevision: null, failure: null, createdAt: NOW, updatedAt: NOW };
      },
    } as never,
    importJobRunner: { enqueue: vi.fn(() => true) },
    queryService: {
      getProject: vi.fn(async (projectId: string) => ({
        projectId,
        lifecycle: 'importing' as const,
        sourceKind: null,
        designSystemId: 'quiet-walking',
        designSystemDigest: 'a'.repeat(64),
        draftRevision: 0,
        committedRevision: null,
        failure: null,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    },
    verifyWorkingDirectoryGrant: options.verifyWorkingDirectoryGrant ?? vi.fn(async (grant) => `/canonical${grant.path}`),
    randomId: () => 'conversation-1',
  });
  const queryService = {
    getProject: vi.fn(async (projectId: string) => ({ projectId, legacy: true })),
    getContext: vi.fn(async () => ({ context: true })),
    inspect: vi.fn(async () => ({ inspected: true })),
    searchLayers: vi.fn(async () => ({ layers: [] })),
    getStyle: vi.fn(async () => ({ version: 8, sources: {}, layers: [] })),
    getSemantics: vi.fn(async () => ({ version: 1, roles: [] })),
    listRevisions: vi.fn(async () => ({ revisions: [] })),
  };
  const validationService = { validate: vi.fn(async () => ({ valid: true })) };
  const app: Express = express();
  app.use(createMapDesignProjectRouter({ projectService, queryService: queryService as never, validationService: validationService as never, requireLocalDaemonRequest }));
  return { app, db };
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

afterEach(() => {
  resetDesktopAuthForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function getWithBody(app: Express, route: string) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not listen');
  try {
    return await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest({ hostname: '127.0.0.1', port: address.port, path: route, method: 'GET', headers: { 'content-type': 'application/json', 'content-length': '2' } }, (response) => resolve(response.statusCode ?? 0));
      outgoing.once('error', reject);
      outgoing.end('{}');
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('local MapDesign project lifecycle routes', () => {
  it('creates, replays, lists, reads its conversation, and deletes local projects without workspace authority', async () => {
    const { app, db } = setup();
    try {
      const body = createInput();
      const create = () => request(app, '/api/map-design/projects', { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'workspace-a' }, body: JSON.stringify(body) });
      const first = await create();
      expect(first.status).toBe(201);
      const firstOutput = await first.json() as { project: { projectId: string }; conversationId: string };
      expect(firstOutput).toMatchObject({ project: { projectId: 'project-1' }, conversationId: 'conversation-1' });
      const replay = await create();
      expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual(firstOutput);
      const listed = await request(app, '/api/map-design/projects', { headers: { 'x-workspace-id': 'workspace-b' } });
      expect(await listed.json()).toMatchObject({ projects: [{ projectId: 'project-1' }] });
      const read = await request(app, '/api/map-design/projects/project-1');
      expect(await read.json()).toEqual(firstOutput);
      const conversation = await request(app, '/api/map-design/projects/project-1/conversation');
      expect(await conversation.json()).toMatchObject({ id: 'conversation-1', projectId: 'project-1' });
      expect((await request(app, '/api/map-design/projects/project-1', { method: 'DELETE' })).status).toBe(204);
      expect((await request(app, '/api/map-design/projects/project-1')).status).toBe(404);
      expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 0 });
    } finally { closeMapDesignDatabase(db); }
  });

  it('rejects invalid create inputs, conflicting idempotency requests, invalid identifiers, read bodies, and non-JSON writes', async () => {
    const { app, db } = setup();
    try {
      const invalid = await request(app, '/api/map-design/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...createInput(), kind: 'prototype' }) });
      expect(invalid.status).toBe(400);
      expect((await request(app, '/api/map-design/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createInput()) })).status).toBe(201);
      const conflict = await request(app, '/api/map-design/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...createInput(), title: 'Changed' }) });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
      expect((await request(app, `/api/map-design/projects/${'a'.repeat(257)}`)).status).toBe(400);
      expect(await getWithBody(app, '/api/map-design/projects')).toBe(400);
      expect((await request(app, '/api/map-design/projects', { method: 'POST', body: JSON.stringify(createInput('project-2')) })).status).toBe(415);
    } finally { closeMapDesignDatabase(db); }
  });

  it('returns 403 without persistence for raw missing or short desktop grant tokens while retaining 400 for unrelated schema errors', async () => {
    const { app, db } = setup();
    try {
      for (const workingDirectory of [{ path: '/picked' }, { path: '/picked', token: 'short' }]) {
        const response = await request(app, '/api/map-design/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...createInput(workingDirectory.token ? 'project-short' : 'project-missing'), workingDirectory }),
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'RUN_NOT_AUTHORIZED' } });
      }
      expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 0 });
      const invalid = await request(app, '/api/map-design/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...createInput('project-invalid'), kind: 'prototype' }),
      });
      expect(invalid.status).toBe(400);
    } finally { closeMapDesignDatabase(db); }
  });

  it('accepts a production-format desktop picker token once and denies wrong-path or replayed project creates', async () => {
    const secret = randomBytes(32);
    setDesktopAuthSecret(secret);
    const { app, db } = setup({ verifyWorkingDirectoryGrant: verifyDesktopWorkingDirectoryGrant });
    const expiry = new Date(Date.now() + 30_000).toISOString();
    const signDesktopProducerToken = (pickerPath: string, nonce: string) => [
      nonce,
      expiry,
      createHmac('sha256', secret).update(`${pickerPath}\n${nonce}\n${expiry}`).digest('base64url'),
    ].join('~');
    try {
      const path = '/picked/project';
      const token = signDesktopProducerToken(path, 'desktop-nonce');
      const accepted = await request(app, '/api/map-design/projects', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...createInput('desktop-project'), workingDirectory: { path, token } }),
      });
      expect(accepted.status).toBe(201);

      const wrongPath = await request(app, '/api/map-design/projects', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...createInput('wrong-path-project'), idempotencyKey: 'wrong-path-key', workingDirectory: { path: '/picked/other', token } }),
      });
      expect(wrongPath.status).toBe(403);

      const replay = await request(app, '/api/map-design/projects', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...createInput('replay-project'), idempotencyKey: 'replay-key', workingDirectory: { path, token } }),
      });
      expect(replay.status).toBe(403);
      expect(db.prepare('SELECT id AS projectId FROM projects ORDER BY id').all()).toEqual([{ projectId: 'desktop-project' }]);
    } finally { closeMapDesignDatabase(db); }
  });
});
