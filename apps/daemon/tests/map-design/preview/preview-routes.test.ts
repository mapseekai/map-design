import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMapDesignPreviewRouter } from '../../../src/map-design/routes/preview-routes.js';
import { MapDraftError } from '../../../src/map-design/application/errors.js';


describe('MapDesign preview fulfillment route', () => {
  const servers: Server[] = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  }))));

  it('fulfills previews with local auth and treats former workspace headers as inert', async () => {
    const fulfill = vi.fn(async () => ({ status: 'failed' as const, previewId: 'preview-1', draftRevision: 4,
      styleHash: 'b'.repeat(64), png: null, report: { digest: 'd'.repeat(64), mediaType: 'application/json' as const, byteLength: 10 },
      validationSummary: { status: 'valid' as const, errors: 0, warnings: 0, infos: 0, totalFindings: 0, returnedFindings: 0, omittedFindings: 0 } }));
    const projectReader = { getProject: vi.fn(async () => ({})) };
    const { url } = await listen(createMapDesignPreviewRouter({
      previewFulfillmentService: { fulfill, getCurrent: vi.fn() },
      projectReader,
      requireLocalDaemonRequest: (_req, _res, next) => next(),
    }), servers);
    const body = { status: 'failed', previewId: 'preview-1', draftRevision: 4, styleHash: 'b'.repeat(64), pngBase64: null,
      report: { previewId: 'preview-1', validationDigest: 'd'.repeat(64) } };
    const response = await fetch(`${url}/api/map-design/projects/project-1/previews/preview-1/fulfill`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'attacker', 'x-workspace-member-id': 'attacker' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(projectReader.getProject).toHaveBeenCalledWith('project-1');
    expect(fulfill).toHaveBeenCalledWith('project-1', 'preview-1', body);
  });

  it('returns local not-found before fulfilling a preview', async () => {
    const fulfill = vi.fn();
    const { url } = await listen(createMapDesignPreviewRouter({
      previewFulfillmentService: { fulfill, getCurrent: vi.fn() },
      projectReader: { getProject: vi.fn(async () => { throw new MapDraftError('NOT_FOUND', 'The map project was not found.'); }) },
      requireLocalDaemonRequest: (_req, _res, next) => next(),
    }), servers);
    const response = await fetch(`${url}/api/map-design/projects/project-1/previews/preview-1/fulfill`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ previewId: 'preview-1' }),
    });
    expect(response.status).toBe(404);
    expect(fulfill).not.toHaveBeenCalled();
  });

  it('reads the current terminal preview only after local project existence and auth checks', async () => {
    const output = { preview: { status: 'failed' as const, previewId: 'preview-1', draftRevision: 4,
      styleHash: 'b'.repeat(64), png: null, report: { digest: 'd'.repeat(64), mediaType: 'application/json' as const, byteLength: 10 },
      validationSummary: { status: 'valid' as const, errors: 0, warnings: 0, infos: 0,
        totalFindings: 0, returnedFindings: 0, omittedFindings: 0 } } };
    const getCurrent = vi.fn(() => output);
    const projectReader = { getProject: vi.fn(async () => ({})) };
    const { url } = await listen(createMapDesignPreviewRouter({
      previewFulfillmentService: { fulfill: vi.fn(), getCurrent },
      projectReader,
      requireLocalDaemonRequest: (_req, _res, next) => next(),
    }), servers);
    const response = await fetch(`${url}/api/map-design/projects/project-1/previews/current`, {
      headers: { 'x-workspace-id': 'ignored' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(output);
    expect(projectReader.getProject).toHaveBeenCalledWith('project-1');
    expect(getCurrent).toHaveBeenCalledWith('project-1');
  });

  it('does not read previews when local daemon authentication rejects the request', async () => {
    const getCurrent = vi.fn();
    const { url } = await listen(createMapDesignPreviewRouter({
      previewFulfillmentService: { fulfill: vi.fn(), getCurrent },
      projectReader: { getProject: vi.fn(async () => ({})) },
      requireLocalDaemonRequest: (_req, response) => response.status(401).end(),
    }), servers);
    const response = await fetch(`${url}/api/map-design/projects/project-1/previews/current`);
    expect(response.status).toBe(401);
    expect(getCurrent).not.toHaveBeenCalled();
  });

  it('returns a conflict when the project is not ready for its current preview', async () => {
    const { url } = await listen(createMapDesignPreviewRouter({
      previewFulfillmentService: { fulfill: vi.fn(), getCurrent: () => {
        throw new MapDraftError('PROJECT_NOT_READY', 'The map project is not ready.');
      } },
      projectReader: { getProject: async () => ({ lifecycle: 'importing' }) },
      requireLocalDaemonRequest: (_req, _res, next) => next(),
    }), servers);
    const response = await fetch(`${url}/api/map-design/projects/project-1/previews/current`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'PROJECT_NOT_READY' } });
  });
});


async function listen(router: express.Router, servers: Server[]) {
  const app = express(); app.use(router); const server = createServer(app); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  return { url: `http://127.0.0.1:${address.port}` };
}
