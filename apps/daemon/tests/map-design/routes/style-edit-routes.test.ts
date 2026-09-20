import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import type { MapApplyTransactionOutput } from '@mapseekai/map-design-contracts';

import { MapDraftError } from '../../../src/map-design/application/errors.js';
import { createMapDesignStyleEditRouter } from '../../../src/map-design/routes/style-edit-routes.js';

const servers: Array<ReturnType<ReturnType<typeof express>['listen']>> = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); });

async function fixture() {
  const output: MapApplyTransactionOutput = { draftRevision: 4, styleHash: 'b'.repeat(64), changedLayers: [], changedSources: [], diff: [], warnings: [], validationSummary: { status: 'valid', errors: 0, warnings: 0, infos: 0, totalFindings: 0, returnedFindings: 0, omittedFindings: 0 } };
  const service = { apply: vi.fn(async () => output), applyDocument: vi.fn(async () => output) };
  const app = express();
  app.use(createMapDesignStyleEditRouter({ service, requireLocalDaemonRequest: (_req, res, next) => { res.locals.requestId = 'request-1'; next(); } }));
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  return { service, url: `http://127.0.0.1:${address.port}/api/map-design/projects/project-1/style-edits` };
}

it('requires JSON and passes the trusted request identity to the service', async () => {
  const { service, url } = await fixture();
  expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(415);
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(response.status).toBe(200);
  expect(service.apply).toHaveBeenCalledWith('project-1', 'request-1', {});
});

it('maps active runs and revision conflicts to HTTP conflicts', async () => {
  const { service, url } = await fixture();
  service.apply.mockRejectedValueOnce(new MapDraftError('RUN_NOT_AUTHORIZED', 'A map run is active.', { details: { reason: 'ACTIVE_RUN' } }));
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'RUN_NOT_AUTHORIZED', details: { reason: 'ACTIVE_RUN' } } });
});

it('accepts full style documents through the authenticated JSON route and rejects malformed or oversized bodies', async () => {
  const { service, url } = await fixture();
  const endpoint = url.replace('style-edits', 'style-document');
  const put = (body: string) => fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
  expect((await fetch(endpoint, { method: 'PUT', body: '{}' })).status).toBe(415);
  expect((await put('{')).status).toBe(400);
  const oversized = await put(JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024 + 8192) }));
  expect(oversized.status).toBe(413);
  expect(service.applyDocument).not.toHaveBeenCalled();
  expect((await put('{}')).status).toBe(200);
  expect(service.applyDocument).toHaveBeenCalledWith('project-1', 'request-1', {});
  service.applyDocument.mockRejectedValueOnce(new MapDraftError('STYLE_INVALID', 'Invalid style'));
  expect((await put('{}')).status).toBe(400);
});
