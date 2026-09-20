import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createMapDesignCommentRouter } from '../../../src/map-design/routes/comment-routes.js';
import { MapDraftError } from '../../../src/map-design/application/errors.js';
import { requireLocalDaemonRequest } from '../../../src/http/local-daemon-request.js';

const servers: Array<ReturnType<ReturnType<typeof express>['listen']>> = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); });

async function fixture() {
  const service = { list: vi.fn(() => []), save: vi.fn(async () => { throw new MapDraftError('INVALID_INPUT', 'Invalid comment.'); }), delete: vi.fn() };
  const app = express();
  app.use(createMapDesignCommentRouter({ service, requireLocalDaemonRequest }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return { service, url: `http://127.0.0.1:${address.port}/api/map-design/projects/p/comments` };
}

it('requires local JSON mutations and versioned deletion', async () => {
  const { url, service } = await fixture();
  expect((await fetch(url, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
  expect((await fetch(url)).status).toBe(200);
  expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(415);
  expect((await fetch(url, { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } })).status).toBe(400);
  expect((await fetch(`${url}/c?version=-1`, { method: 'DELETE' })).status).toBe(400);
  expect(service.delete).not.toHaveBeenCalled();
  expect((await fetch(`${url}/c?version=2`, { method: 'DELETE' })).status).toBe(204);
  expect(service.delete).toHaveBeenCalledWith('p', 'c', 2);
});

it('returns actionable conflicts without exposing internal errors', async () => {
  const { url, service } = await fixture();
  service.save.mockRejectedValueOnce(new MapDraftError('REVISION_CONFLICT', 'Pick again.'));
  const response = await fetch(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
  service.list.mockImplementationOnce(() => { throw new Error('secret path'); });
  const error = await fetch(url);
  expect(error.status).toBe(500);
  expect(await error.text()).not.toContain('secret path');
});
