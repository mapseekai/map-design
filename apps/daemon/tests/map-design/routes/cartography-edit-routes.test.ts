import express, { type Express } from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createCartographyAuthoringRouter } from '../../../src/map-design/routes/cartography-authoring-routes.js';
import { requireLocalDaemonRequest } from '../../../src/http/local-daemon-request.js';
import { generateCartographyEdit } from '../../../src/map-design/application/cartography-authoring.js';
import { CartographyEditSessionSchema, CartographyEditSaveOutputSchema } from '@mapseekai/map-design-contracts';
import { CartographyService } from '../../../src/map-design/application/cartography-service.js';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';
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
    expect(current.status, JSON.stringify(current)).toBe('idle'); expect(current.source).toBe(updated);
  });
  expect((await request(app, `${path}/turns`, 'POST', turn)).status).toBe(202);
  expect(generateCartographyEdit).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
  expect((await request(app, `${path}/save`, 'POST', { expectedRevision: 0 })).status).toBe(409);
  expect((await request(app, `${path}/save`, 'POST', { expectedRevision: 1 })).status).toBe(200);
  expect(save).toHaveBeenCalledWith({ source: updated, description: '' });
});

it('accepts a maximum-size original upload with a conversion report when creating an edit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'edit-source-route-')); roots.push(root);
  const source = ['---', 'version: "0.4.0"', 'name: Atlas', '---', '', '## Overview', 'Original.'].join(String.fromCharCode(10));
  const sourceFile = { fileName: 'style.json', content: Buffer.from('{}' + ' '.repeat(4 * 1024 * 1024 - 2)).toString('base64') };
  const app = express();
  app.use(createCartographyAuthoringRouter({ dataRoot: root, projectRoot: '/unused', projectService: { importCartography: vi.fn() }, requireLocal: requireLocalDaemonRequest }));
  const response = await request(app, '/api/map-design/cartography-tools/edit-sessions', 'POST', {
    source, sourceFile, reportMarkdown: '报告'.repeat(512 * 1024), runtime: 'api', initialPrompt: 'Read the original',
  });
  expect(response.status).toBe(201);
  expect(await response.json()).not.toHaveProperty('sourceFile');
});

it('saves an edited library specification through HTTP and retains independent named copies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'edit-save-routes-')); roots.push(root);
  const db = openMapDesignDatabase(root);
  try {
    const library = new CartographyService(createMapDesignLocalStore(db));
    const source = '---\nversion: "0.4.0"\nname: Atlas\n---\n\n## Overview\nOriginal.';
    const original = library.import({ source });
    const app = express();
    app.use(createCartographyAuthoringRouter({ dataRoot: root, projectRoot: root, requireLocal: requireLocalDaemonRequest,
      projectService: { importCartography: (input) => library.import(input), getCartography: (id) => library.get(id),
        canOverwriteCartography: (id) => library.canOverwrite(id), saveCartographyEdit: (input) => library.saveEdit(input) },
    }));
    const base = '/api/map-design/cartography-tools/edit-sessions';
    const initial = CartographyEditSessionSchema.parse(await (await request(app, base, 'POST', {
      source: `${source}\nImproved guidance.`, sourceDocumentId: original.id, initialPrompt: 'Improve',
    })).json());
    expect(initial.canOverwrite).toBe(true);

    const response = await request(app, `${base}/${initial.id}/save`, 'POST', { expectedRevision: 0, mode: 'overwrite' });

    expect(response.status).toBe(200);
    const saved = CartographyEditSaveOutputSchema.parse(await response.json());
    expect(library.list().documents.map(({ id }) => id)).toEqual([saved.document.id]);
    const copyResponse = await request(app, `${base}/${initial.id}/save`, 'POST', { expectedRevision: 0, mode: 'new', name: 'New Atlas' });
    expect(copyResponse.status).toBe(200);
    const copy = CartographyEditSaveOutputSchema.parse(await copyResponse.json());
    expect(copy.session).toMatchObject({ sourceDocumentId: copy.document.id, name: 'New Atlas', revision: 1, savedRevision: 1 });
    expect(library.list().documents).toHaveLength(2);
    expect((await request(app, `${base}/${initial.id}/save`, 'POST', { expectedRevision: 0, mode: 'overwrite' })).status).toBe(409);
    expect((await request(app, `${base}/${initial.id}/save`, 'POST', { expectedRevision: 1, mode: 'new', name: ' ' })).status).toBe(400);
    const duplicate = await request(app, `${base}/${initial.id}/save`, 'POST', { expectedRevision: 1, mode: 'new', name: 'New Atlas' });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ error: { details: { reason: 'CARTOGRAPHY_EXISTS' } } });
  } finally { db.close(); }
});
