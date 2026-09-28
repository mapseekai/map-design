import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CartographyService } from '../../../src/map-design/application/cartography-service.js';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';
import { pinCartographyDocument, loadPinnedCartography } from '../../../src/map-design/storage/cartography-bindings.js';
import { CartographyEditService } from '../../../src/map-design/application/cartography-edit-service.js';

const source = '---\nversion: "0.4.0"\nname: Atlas\ncolors:\n  ink: "#123456"\n---\n\n## Overview\nOriginal guidance.\n';
const sourceFile = { fileName: 'style.json', content: Buffer.from('{}').toString('base64') };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cartography-save-'));
  const db = openMapDesignDatabase(root);
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = createMapDesignLocalStore(db);
  const service = new CartographyService(store);
  const original = service.import({ source, sourceFile });
  return { service, db, original, root, store };
}

it('overwrites the visible library entry while preserving project source and uploaded bytes', () => {
  const { service, db, original } = setup();
  db.prepare("INSERT INTO projects (id, title, runtime_json, created_at, updated_at) VALUES ('map', 'Map', '{}', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
  db.prepare('INSERT INTO project_cartography VALUES (?, ?)').run('map', original.id);
  const pinned = pinCartographyDocument(db, original.id, source);

  const saved = service.saveEdit({ mode: 'overwrite', targetId: original.id, source: `${source}\nUpdated guidance.`, description: 'Revised' });

  expect(service.list().documents.map(({ id }) => id)).toEqual([saved.id]);
  expect(service.forProject('map')?.source).toBe(source);
  expect(loadPinnedCartography(db, pinned)).toMatchObject({ source });
  expect(service.get(saved.id).sourceFile).toEqual(sourceFile);
  expect(saved.id).toBe(createHash('sha256').update(service.get(saved.id).source).digest('hex'));
  expect(service.canOverwrite(original.id)).toBe(false);
  expect(() => service.saveEdit({ mode: 'overwrite', targetId: original.id, source, description: '' })).toThrow(expect.objectContaining({ details: { reason: 'CARTOGRAPHY_CHANGED' } }));
});

it('rebinds saved edit sessions to the new document and preserves the target on later overwrites', async () => {
  const { service, original, root } = setup();
  const edits = new CartographyEditService({ dataRoot: root, projectRoot: root,
    saveDocument: (input) => service.import(input), saveEditedDocument: (input) => service.saveEdit(input),
    canOverwriteDocument: (id) => service.canOverwrite(id),
  });
  const initial = await edits.create({ source, sourceDocumentId: original.id, initialPrompt: 'Improve' });

  const saved = await edits.save(initial.id, { expectedRevision: 0, mode: 'new', name: 'New Atlas' });

  expect(saved.session).toMatchObject({ sourceDocumentId: saved.document.id, savedId: saved.document.id,
    name: 'New Atlas', revision: 1, savedRevision: 1, canOverwrite: true });
  expect(saved.document).not.toHaveProperty('sourceFile');
  expect((await edits.get(initial.id)).source).toBe(service.get(saved.document.id).source);
  expect((await edits.history(saved.document.id)).sessions.map(({ id }) => id)).toEqual([initial.id]);
  expect((await edits.save(initial.id, { expectedRevision: 1, mode: 'overwrite' })).document.id).toBe(saved.document.id);
  await expect(edits.save(initial.id, { expectedRevision: 0, mode: 'overwrite' })).rejects.toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }));
  expect(service.list().documents).toHaveLength(2);
});

it('keeps a deleted document draft available for save as a new specification', async () => {
  const { service, original, root } = setup();
  const edits = new CartographyEditService({ dataRoot: root, projectRoot: root,
    saveDocument: (input) => service.import(input), saveEditedDocument: (input) => service.saveEdit(input),
    canOverwriteDocument: (id) => service.canOverwrite(id),
  });
  const initial = await edits.create({ source, sourceFile, sourceDocumentId: original.id, initialPrompt: 'Improve' });
  service.delete(original.id);

  const saved = await edits.save(initial.id, { expectedRevision: 0, mode: 'new', name: 'Recovered Atlas' });

  expect(service.get(saved.document.id).sourceFile).toEqual(sourceFile);
  expect(saved.session.canOverwrite).toBe(true);
});

it('saves a named copy and rejects a duplicate without changing the existing entries', () => {
  const { service, original } = setup();

  const saved = service.saveEdit({ mode: 'new', name: 'Atlas copy', targetId: original.id, source, description: '' });

  expect(service.list().documents).toHaveLength(2);
  expect(saved.name).toBe('Atlas copy');
  expect(service.get(saved.id).sourceFile).toEqual(sourceFile);
  expect(service.get(saved.id).source).toContain('Original guidance.');
  expect(() => service.saveEdit({ mode: 'new', name: 'Atlas copy', source, description: '' })).toThrow(expect.objectContaining({ details: { reason: 'CARTOGRAPHY_EXISTS' } }));
  expect(service.get(original.id).source).toBe(source);
});

it('rejects overwriting presets and missing targets', () => {
  const { service, db, original } = setup();
  db.prepare("UPDATE cartography_documents SET origin = 'preset' WHERE id = ?").run(original.id);

  expect(() => service.saveEdit({ mode: 'overwrite', targetId: original.id, source, description: '' })).toThrow(expect.objectContaining({ details: { reason: 'CARTOGRAPHY_PRESET' } }));
  expect(() => service.saveEdit({ mode: 'overwrite', targetId: 'f'.repeat(64), source, description: '' })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  expect(service.canOverwrite(original.id)).toBe(false);
});

it('preserves library names on overwrite and shows explicitly reimported archived documents', () => {
  const { service, original } = setup();
  service.updateMetadata(original.id, { name: 'My renamed atlas' });

  const saved = service.saveEdit({ mode: 'overwrite', targetId: original.id, source: source.replace('name: Atlas', 'name: Agent title'), description: '' });

  expect(saved.name).toBe('My renamed atlas');
  expect(service.list().documents).toHaveLength(1);
  service.import({ source });
  expect(service.list().documents).toHaveLength(2);
  expect(service.canOverwrite(original.id)).toBe(true);
});

it('includes earlier discussions after consecutive overwrites without attaching them to a named copy', async () => {
  const { service, original, root, store } = setup();
  const edits = new CartographyEditService({ dataRoot: root, projectRoot: root, store,
    saveDocument: (input) => service.import(input), saveEditedDocument: (input) => service.saveEdit(input),
    canOverwriteDocument: (id) => service.canOverwrite(id), documentHistoryIds: (id) => service.historyIds(id),
  });
  const old = await edits.create({ source, sourceDocumentId: original.id, initialPrompt: 'Earlier discussion' });
  const first = service.saveEdit({ mode: 'overwrite', targetId: original.id, source: `${source}\nFirst edit.`, description: '' });
  const second = service.saveEdit({ mode: 'overwrite', targetId: first.id, source: `${source}\nSecond edit.`, description: '' });
  const current = await edits.create({ source: second.source, sourceDocumentId: second.id, initialPrompt: 'Current discussion' });

  const history = await edits.history(second.id);

  expect(history.sessions.map(({ id }) => id)).toEqual(expect.arrayContaining([old.id, current.id]));
  expect((await edits.get(old.id)).canOverwrite).toBe(false);
  const copy = await edits.save(current.id, { mode: 'new', name: 'Copy', expectedRevision: 0 });
  expect((await edits.history(copy.document.id)).sessions.map(({ id }) => id)).toEqual([current.id]);
  service.delete(second.id);
  expect(service.list().documents.map(({ id }) => id)).toEqual([copy.document.id]);
});
