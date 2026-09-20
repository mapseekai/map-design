import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMapDesignImportRouter } from '../../../src/map-design/routes/import-routes.js';
import { MapDraftError } from '../../../src/map-design/application/errors.js';

describe('MapDesign import routes', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
  });

  it('enforces the local gate before JSON parsing and service invocation', async () => {
    const preflight = vi.fn();
    const { url } = await listen(createMapDesignImportRouter({
      sourceImportService: { preflight, retryImport: vi.fn(), failRetryEnqueue: vi.fn(), prepareImportInTransaction: vi.fn() },
      importJobRunner: { enqueue: vi.fn() },
      projectReader: { getProject: vi.fn() },
      requireLocalDaemonRequest: (_request, response) => { response.status(403).json({ error: 'local only' }); },
    }), servers);

    const response = await fetch(`${url}/api/map-design/source-preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{malformed',
    });

    expect(response.status).toBe(403);
    expect(preflight).not.toHaveBeenCalled();
  });

  it('verifies a local project exists before parsing a retry body', async () => {
    const retryImport = vi.fn();
    const getProject = vi.fn(async () => { throw new MapDraftError('NOT_FOUND', 'The map project was not found.'); });
    const { url } = await listen(createMapDesignImportRouter({
      sourceImportService: { preflight: vi.fn(), retryImport, failRetryEnqueue: vi.fn(), prepareImportInTransaction: vi.fn() },
      importJobRunner: { enqueue: vi.fn() },
      projectReader: { getProject },
      requireLocalDaemonRequest: (_request, _response, next) => next(),
    }), servers);

    const response = await fetch(`${url}/api/map-design/projects/project-1/retry-import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{malformed',
    });

    expect(response.status).toBe(404);
    expect(getProject).toHaveBeenCalledWith('project-1');
    expect(retryImport).not.toHaveBeenCalled();
  });

  it('ignores workspace headers and enqueues only an importing retry', async () => {
    const enqueue = vi.fn(() => true);
    const retryImport = vi.fn(async () => importingProject('project-1'));
    const { url } = await listen(createMapDesignImportRouter({
      sourceImportService: { preflight: vi.fn(), retryImport, failRetryEnqueue: vi.fn(), prepareImportInTransaction: vi.fn() },
      importJobRunner: { enqueue },
      projectReader: { getProject: vi.fn(async () => importingProject('project-1')) },
      requireLocalDaemonRequest: (_request, _response, next) => next(),
    }), servers);

    const response = await fetch(`${url}/api/map-design/projects/project-1/retry-import`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-map-design-workspace-id': 'other-workspace',
        'x-map-design-project-id': 'other-project',
      },
      body: JSON.stringify({ idempotencyKey: 'retry-key' }),
    });

    expect(response.status).toBe(200);
    expect(retryImport).toHaveBeenCalledWith('project-1', { idempotencyKey: 'retry-key' });
    expect(enqueue).toHaveBeenCalledWith('project-1');
  });

  it('persists and returns a failed retry when the runner declines it', async () => {
    const failed = { ...importingProject('project-1'), lifecycle: 'failed' as const,
      failure: { code: 'IMPORT_RUNNER_UNAVAILABLE' as const, message: 'The import runner is unavailable and the import can be retried.' } };
    const failRetryEnqueue = vi.fn(async () => failed);
    const { url } = await listen(createMapDesignImportRouter({
      sourceImportService: { preflight: vi.fn(), retryImport: vi.fn(async () => importingProject('project-1')), failRetryEnqueue, prepareImportInTransaction: vi.fn() },
      importJobRunner: { enqueue: vi.fn(() => false) },
      projectReader: { getProject: vi.fn(async () => importingProject('project-1')) },
      requireLocalDaemonRequest: (_request, _response, next) => next(),
    }), servers);
    const response = await fetch(`${url}/api/map-design/projects/project-1/retry-import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'retry-key' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ lifecycle: 'failed', failure: { code: 'IMPORT_RUNNER_UNAVAILABLE' } });
    expect(failRetryEnqueue).toHaveBeenCalledWith('project-1', { idempotencyKey: 'retry-key' });
  });

  it('keeps a normal preflight request signal live until the response is written', async () => {
    const preflight = vi.fn(async (_input, signal: AbortSignal) => {
      await new Promise((resolve) => setImmediate(resolve));
      expect(signal.aborted).toBe(false);
      return {
        kind: 'style', requestedHost: 'maps.example.test', finalHost: 'maps.example.test',
        redirectCount: 0, reachability: 'reachable',
        security: { scheme: 'https', allResolvedAddressesPublic: true, credentialsPresent: false },
        mediaType: 'application/vnd.mapbox.style+json', byteLength: 100,
        preview: {
          previewId: 'preview-1',
          styleUrl: '/api/map-design/source-previews/preview-1/style',
          expiresAt: '2026-09-04T03:10:00.000Z',
        },
      } as const;
    });
    const { url } = await listen(createMapDesignImportRouter({
      sourceImportService: { preflight, retryImport: vi.fn(), failRetryEnqueue: vi.fn(), prepareImportInTransaction: vi.fn() },
      importJobRunner: { enqueue: vi.fn() },
      projectReader: { getProject: vi.fn() },
      requireLocalDaemonRequest: (_request, _response, next) => next(),
    }), servers);

    const response = await fetch(`${url}/api/map-design/source-preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { url: 'https://maps.example.test/style.json' } }),
    });

    expect(response.status).toBe(200);
    expect(preflight).toHaveBeenCalledOnce();
  });
});

function importingProject(projectId: string) {
  return {
    projectId,
    lifecycle: 'importing' as const,
    sourceKind: null,
    designSystemId: 'quiet-walking',
    designSystemDigest: 'a'.repeat(64),
    draftRevision: 0,
    committedRevision: null,
    failure: null,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  };
}

async function listen(router: express.Router, servers: Server[]): Promise<{ url: string }> {
  const app = express();
  app.use(router);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  return { url: `http://127.0.0.1:${address.port}` };
}
