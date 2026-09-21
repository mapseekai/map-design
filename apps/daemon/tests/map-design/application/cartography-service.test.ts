import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CARTOGRAPHY_MAX_BYTES } from '@mapseekai/map-design-contracts';
import { CartographyService, cartographyPrompt } from '../../../src/map-design/application/cartography-service.js';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';

const roots: string[] = [];
const source = '---\nversion: "0.4.0"\nname: Quiet Atlas\ncolors:\n  ink: "#24303A"\n---\n\n## Overview\n\nWarm paper and restrained ink.\n';
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('CARTOGRAPHY.md library', () => {
  it('renames library metadata without changing source, identity or description', () => {
    const root = mkdtempSync(join(tmpdir(), 'cartography-rename-'));
    roots.push(root);
    const db = openMapDesignDatabase(root);
    try {
      const service = new CartographyService(createMapDesignLocalStore(db));
      const saved = service.import({ source, description: 'Keep this' });
      expect(service.updateMetadata(saved.id, { name: ' New Atlas ' })).toMatchObject({ id: saved.id, name: 'New Atlas', description: 'Keep this' });
      expect(service.get(saved.id).source).toBe(source);
      expect(() => service.updateMetadata(saved.id, { name: ' ' })).toThrow();
      expect(() => service.updateMetadata(saved.id, {})).toThrow();
      expect(service.updateMetadata(saved.id, { description: 'Updated' }).name).toBe('New Atlas');
    } finally { db.close(); }
  });
  it('persists Agent sample bindings separately from the immutable specification', () => {
    const root = mkdtempSync(join(tmpdir(), 'cartography-bindings-'));
    roots.push(root);
    let db = openMapDesignDatabase(root);
    const mapped = source.replace('colors:', 'elements:\n  custom-road:\n    geometry: line\n    strokeColor: "#123456"\n    strokeWidth: 4px\ncolors:');
    try {
      const service = new CartographyService(createMapDesignLocalStore(db));
      const sampleBindings = { 'road.primary': 'custom-road' };
      const saved = service.import({ source: mapped, sampleBindings });
      expect(saved.preview?.sampleBindings).toEqual(sampleBindings);
      expect(() => service.import({ source: mapped, sampleBindings: { 'water.river': 'custom-road' } })).toThrow();
      db.close(); db = openMapDesignDatabase(root);
      const reopened = new CartographyService(createMapDesignLocalStore(db));
      expect(reopened.get(saved.id)).toMatchObject({ source: mapped, preview: { sampleBindings } });
      expect(reopened.list().documents[0]?.preview?.sampleBindings).toEqual(sampleBindings);
    } finally { db.close(); }
  });
  it('saves specifications between 32 and 64 KiB without truncation', () => {
    const root = mkdtempSync(join(tmpdir(), 'cartography-large-'));
    roots.push(root);
    const db = openMapDesignDatabase(root);
    try {
      const service = new CartographyService(createMapDesignLocalStore(db));
      const large = source + 'Detailed visual guidance. '.repeat(1600);
      expect(Buffer.byteLength(large)).toBeGreaterThan(32 * 1024);
      const saved = service.import({ source: large });
      expect(service.get(saved.id).source).toBe(large);
    } finally { db.close(); }
  });
  it('deletes unused documents and preserves specifications referenced by projects', () => {
    const root = mkdtempSync(join(tmpdir(), 'cartography-delete-'));
    roots.push(root);
    const db = openMapDesignDatabase(root);
    try {
      const service = new CartographyService(createMapDesignLocalStore(db));
      const saved = service.import({ source });
      service.delete(saved.id);
      expect(service.list().documents).toEqual([]);
      expect(() => service.get(saved.id)).toThrow('not found');
      expect(() => service.delete(saved.id)).toThrow('not found');
      service.import({ source });
      db.prepare("INSERT INTO projects (id, title, runtime_json, created_at, updated_at) VALUES ('project-1', 'Map', '{}', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
      db.prepare('INSERT INTO project_cartography VALUES (?, ?)').run('project-1', saved.id);
      expect(() => service.delete(saved.id)).toThrow('used by a project');
      expect(service.forProject('project-1')?.source).toBe(source);
      db.prepare("DELETE FROM projects WHERE id = 'project-1'").run();
      service.delete(saved.id);
      expect(service.list().documents).toEqual([]);
    } finally { db.close(); }
  });
  it('validates, deduplicates and preserves full documents across database reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'cartography-test-'));
    roots.push(root);
    let db = openMapDesignDatabase(root);
    try {
      const service = new CartographyService(createMapDesignLocalStore(db));
      const saved = service.import({ source });
      expect(service.import({ source })).toEqual(saved);
      expect(service.list().documents).toEqual([saved]);
      expect(service.get(saved.id).source).toBe(source);
      db.close();
      db = openMapDesignDatabase(root);
      expect(new CartographyService(createMapDesignLocalStore(db)).get(saved.id).source).toBe(source);
    } finally { db.close(); }
  });

  it('rejects invalid, oversized and unresolved-token documents without saving them', () => {
    const root = mkdtempSync(join(tmpdir(), 'cartography-invalid-'));
    roots.push(root);
    const db = openMapDesignDatabase(root);
    try {
      const service = new CartographyService(createMapDesignLocalStore(db));
      for (const invalid of ['# Missing frontmatter', source.replace('#24303A', '{colors.missing}'), 'x'.repeat(CARTOGRAPHY_MAX_BYTES + 1)]) {
        expect(() => service.import({ source: invalid })).toThrow();
      }
      expect(service.list().documents).toEqual([]);
      expect(() => service.get('f'.repeat(64))).toThrow('not found');
    } finally { db.close(); }
  });

  it('keeps the end of long specifications in the prompt', () => {
    const longSource = `${source}${'Cartographic judgment. '.repeat(600)}\nFINAL_TOKEN: #123456`;
    const prompt = cartographyPrompt({ id: 'a'.repeat(64), name: 'Quiet Atlas', description: '', version: '0.4.0', source: longSource });
    expect(prompt).toContain('FINAL_TOKEN: #123456');
    expect(prompt).toContain('not tool permissions');
    expect(cartographyPrompt(null)).toBe('');
  });
});

it('stores user descriptions and update times without changing the referenced document', () => {
  const root = mkdtempSync(join(tmpdir(), 'cartography-metadata-'));
  roots.push(root);
  const db = openMapDesignDatabase(root);
  try {
    const service = new CartographyService(createMapDesignLocalStore(db));
    const saved = service.import({ source, description: 'Walking map specification' });
    expect(saved.description).toBe('Walking map specification');
    expect(saved.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const updated = service.updateMetadata(saved.id, { description: 'Revised for park routes' });
    expect(updated.id).toBe(saved.id);
    expect(updated.description).toBe('Revised for park routes');
    expect(service.get(saved.id).source).toBe(source);
    expect(service.list().documents).toEqual([updated]);
    expect(() => service.updateMetadata(saved.id, { description: 'x'.repeat(2049) })).toThrow();
    expect(service.get(saved.id).description).toBe('Revised for park routes');
  } finally { db.close(); }
});


it('upgrades legacy libraries without inventing update dates or altering documents', () => {
  const root = mkdtempSync(join(tmpdir(), 'cartography-legacy-'));
  roots.push(root);
  const old = new Database(join(root, 'map-design.sqlite'));
  old.exec('CREATE TABLE cartography_documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL)');
  old.prepare('INSERT INTO cartography_documents VALUES (?,?,?,?,?)').run('b'.repeat(64), 'Legacy atlas', 'Existing note', '0.4.0', source);
  old.close();
  const db = openMapDesignDatabase(root);
  try {
    const saved = new CartographyService(createMapDesignLocalStore(db)).get('b'.repeat(64));
    expect(saved.source).toBe(source);
    expect(saved.description).toBe('Existing note');
    expect(saved.updatedAt).toBeNull();
  } finally { db.close(); }
});
