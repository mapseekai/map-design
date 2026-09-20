import express, { type Express } from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createCartographyAuthoringRouter } from '../../../src/map-design/routes/cartography-authoring-routes.js';
import { requireLocalDaemonRequest } from '../../../src/http/local-daemon-request.js';
import { generateCartographyEdit } from '../../../src/map-design/application/cartography-authoring.js';
vi.mock('../../../src/map-design/application/cartography-authoring.js', async (load) => ({ ...await load<typeof import('../../../src/map-design/application/cartography-authoring.js')>(), generateCartographyEdit: vi.fn() }));
const roots: string[] = [];
afterEach(async () => { vi.resetAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function request(app: Express, path: string, method = 'GET', body?: unknown, origin?: string) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  try { return await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}
it('keeps edit sessions local, starts once, publishes explicitly and reports bad session IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'edit-routes-')); roots.push(root);
  const source = '---\nversion: "0.4.0"\nname: Atlas\n---\n\n## Overview\nOriginal.';
  const updated = `${source}\n\n## Scale\nPreserve hierarchy.`;
  vi.mocked(generateCartographyEdit).mockResolvedValue({ source: updated, message: 'Completed the guidance.' });
  const save = vi.fn(() => ({ id: 'a'.repeat(64), name: 'Atlas', description: '', version: '0.4.0' }));
  const app = express();
  app.use(createCartographyAuthoringRouter({ dataRoot: root, projectRoot: '/unused', projectService: { importCartography: save }, requireLocal: requireLocalDaemonRequest }));
  const base = '/api/map-design/cartography-tools/edit-sessions';
  const input = { source, runtime: 'api', initialPrompt: 'Improve this document' };
  expect((await request(app, base, 'POST', input, 'https://untrusted.example')).status).toBe(403);
  const created = await request(app, base, 'POST', input);
  expect(created.status).toBe(201);
  const session = await created.json() as { id: string };
  const path = `${base}/${session.id}`;
  expect((await request(app, `${base}/invalid`)).status).toBe(400);
  const turn = { requestId: session.id, expectedRevision: 0, prompt: input.initialPrompt, runtime: 'api' };
  expect((await request(app, `${path}/turns`, 'POST', turn)).status).toBe(202);
  await vi.waitFor(async () => {
    const current = await (await request(app, path)).json() as { status: string; source: string };
    expect(current.status).toBe('idle'); expect(current.source).toBe(updated);
  });
  expect((await request(app, `${path}/turns`, 'POST', turn)).status).toBe(202);
  expect(generateCartographyEdit).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
  expect((await request(app, `${path}/save`, 'POST', { expectedRevision: 0 })).status).toBe(409);
  expect((await request(app, `${path}/save`, 'POST', { expectedRevision: 1 })).status).toBe(200);
  expect(save).toHaveBeenCalledWith({ source: updated, description: '' });
});
