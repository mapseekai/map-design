import express, { type Express } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { requireLocalDaemonRequest } from '../../../src/http/local-daemon-request.js';
import { createMapDesignProjectRouter } from '../../../src/map-design/routes/project-routes.js';
import { MapDraftError } from '../../../src/map-design/application/errors.js';

function setup() {
  const projectService = {
    create: vi.fn(),
    list: vi.fn(() => ({ projects: [] })),
    get: vi.fn(),
    getConversation: vi.fn(() => ({
      id: 'conversation-1', projectId: 'project-1', messages: [],
      createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
    })),
    delete: vi.fn(),
    listCartographies: vi.fn(() => ({ documents: [] })),
    importCartography: vi.fn(),
    updateCartography: vi.fn(),
    deleteCartography: vi.fn(),
    getCartography: vi.fn(),
  };
  const queryService = {
    getContext: vi.fn(async () => ({ projectId: 'project-1', context: 'context' })),
    inspect: vi.fn(async () => ({ projectId: 'project-1', inspection: 'inspection' })),
    searchLayers: vi.fn(async () => ({ projectId: 'project-1', layers: [] })),
    getStyle: vi.fn(async () => ({ version: 8, sources: {}, layers: [] })),
    getSemantics: vi.fn(async () => ({ version: 1, roles: [] })),
    listRevisions: vi.fn(async () => ({ projectId: 'project-1', revisions: [] })),
  };
  const validationService = { validate: vi.fn(async () => ({ projectId: 'project-1', valid: true })) };
  const app: Express = express();
  app.use(createMapDesignProjectRouter({ projectService, queryService: queryService as never, validationService: validationService as never, requireLocalDaemonRequest }));
  return { app, projectService };
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

describe('MapDesign project legacy read routes', () => {
  it('allows JSON escaping overhead for documents below the source byte limit', async () => {
    const { app, projectService } = setup();
    projectService.importCartography.mockReturnValue({ id: 'a'.repeat(64) });
    const source = '"'.repeat(40 * 1024);
    const response = await request(app, '/api/map-design/cartographies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
    expect(response.status).toBe(201);
    expect(projectService.importCartography).toHaveBeenCalledWith({ source });
  });
  it('deletes specifications through the local boundary and reports referenced or missing documents', async () => {
    const { app, projectService } = setup();
    const id = 'a'.repeat(64);
    const path = `/api/map-design/cartographies/${id}`;
    expect((await request(app, path, { method: 'DELETE', headers: { origin: 'https://untrusted.example' } })).status).toBe(403);
    expect((await request(app, '/api/map-design/cartographies/invalid', { method: 'DELETE' })).status).toBe(400);
    expect(projectService.deleteCartography).not.toHaveBeenCalled();
    expect((await request(app, path, { method: 'DELETE' })).status).toBe(204);
    expect(projectService.deleteCartography).toHaveBeenCalledWith(id);
    projectService.deleteCartography.mockImplementationOnce(() => { throw new MapDraftError('INVALID_INPUT', 'In use', { details: { reason: 'CARTOGRAPHY_IN_USE' } }); });
    const blocked = await request(app, path, { method: 'DELETE' });
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toMatchObject({ error: { details: { reason: 'CARTOGRAPHY_IN_USE' } } });
    projectService.deleteCartography.mockImplementationOnce(() => { throw new MapDraftError('NOT_FOUND', 'Not found'); });
    expect((await request(app, path, { method: 'DELETE' })).status).toBe(404);
  });
  it('lists, imports and reads cartography documents through the local daemon boundary', async () => {
    const { app, projectService } = setup();
    const document = { id: 'a'.repeat(64), name: 'Atlas', description: '', version: '0.4.0' };
    projectService.importCartography.mockReturnValue(document);
    projectService.getCartography.mockReturnValue({ ...document, source: 'specification' });
    const list = await request(app, '/api/map-design/cartographies');
    expect(await list.json()).toEqual({ documents: [] });
    const imported = await request(app, '/api/map-design/cartographies', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'specification' }),
    });
    expect(imported.status).toBe(201);
    expect(await imported.json()).toEqual(document);
    expect(projectService.importCartography).toHaveBeenCalledWith({ source: 'specification' });
    projectService.updateCartography.mockReturnValue({ ...document, description: 'User update', updatedAt: '2026-09-07T12:00:00.000Z' });
    const updated = await request(app, `/api/map-design/cartographies/${document.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'User update' }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ id: document.id, description: 'User update', updatedAt: '2026-09-07T12:00:00.000Z' });
    expect(projectService.updateCartography).toHaveBeenCalledWith(document.id, { description: 'User update' });
    expect((await request(app, `/api/map-design/cartographies/${document.id}`)).status).toBe(200);
    expect((await request(app, '/api/map-design/cartographies/not-a-digest')).status).toBe(400);
    expect((await request(app, '/api/map-design/cartographies', { headers: { origin: 'https://untrusted.example' } })).status).toBe(403);
    expect((await request(app, '/api/map-design/cartographies', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'x'.repeat(450_000) }),
    })).status).toBe(413);
  });
  it('keeps the singular conversation route pinned to the primary conversation', async () => {
    const { app, projectService } = setup();
    const primary = {
      id: 'conversation-1', projectId: 'project-1', messages: [],
      createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z',
    };
    const conversations = [primary];
    conversations.push({
      id: 'conversation-2', projectId: 'project-1', messages: [],
      createdAt: '2026-08-27T00:01:00.000Z', updatedAt: '2026-08-27T00:01:00.000Z',
    });
    projectService.getConversation.mockImplementation(() => conversations[0]!);

    const response = await request(app, '/api/map-design/projects/project-1/conversation');

    expect(await response.json()).toEqual(primary);
    expect(projectService.getConversation).toHaveBeenCalledWith('project-1');
  });

  it('serves context, inspect, layer search, validation, style, semantics, and revisions without workspace authority', async () => {
    const { app } = setup();
    const prefix = '/api/map-design/projects/project-1';
    const reads = await Promise.all([
      request(app, `${prefix}/context`),
      request(app, `${prefix}/inspect`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'workspace-a' }, body: JSON.stringify({ target: { kind: 'root' } }) }),
      request(app, `${prefix}/search-layers`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'workspace-b' }, body: JSON.stringify({ query: 'road' }) }),
      request(app, `${prefix}/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0 }) }),
      request(app, `${prefix}/style`),
      request(app, `${prefix}/semantics`),
      request(app, `${prefix}/revisions`),
    ]);
    expect(reads.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
    expect(await reads[0].json()).toMatchObject({ context: 'context' });
    expect(await reads[1].json()).toMatchObject({ inspection: 'inspection' });
    expect(await reads[2].json()).toMatchObject({ layers: [] });
    expect(await reads[3].json()).toMatchObject({ valid: true });
    expect(await reads[4].json()).toMatchObject({ version: 8 });
    expect(await reads[5].json()).toMatchObject({ version: 1 });
    expect(await reads[6].json()).toMatchObject({ revisions: [] });
  });

  it('keeps strict JSON and read-body guards on legacy routes', async () => {
    const { app } = setup();
    const prefix = '/api/map-design/projects/project-1';
    expect((await request(app, `${prefix}/inspect`, { method: 'POST', body: JSON.stringify({ target: { kind: 'root' } }) })).status).toBe(415);
    expect((await request(app, `${prefix}/search-layers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'road', extra: true }) })).status).toBe(400);
    expect((await request(app, `/api/map-design/projects/${'a'.repeat(257)}/context`)).status).toBe(400);
  });
});
