import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256CanonicalJson } from 'maplibre-style-tools/bridge';
import { applyStyleTransaction, type StyleDocument } from 'maplibre-style-tools/core';
import { MapDraftService } from '../../../src/map-design/application/draft-service.js';
import { InMemoryMapDraftEventBus } from '../../../src/map-design/application/event-bus.js';
import { createMapDesignBlobStore } from '../../../src/map-design/storage/blob-store.js';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { testDesignSystem } from '../../fixtures/map-design/test-design-system.js';

const PROJECT_ID = 'compact-project';
const NOW = '2026-09-22T00:00:00.000Z';
const style: StyleDocument = { version: 8, sources: { base: { type: 'vector', tiles: [`/api/map-design/projects/${PROJECT_ID}/resources/base/tiles/{z}/{x}/{y}.pbf`] } }, layers: ['land', 'water'].map(id => ({
  id, type: 'background', paint: { 'background-color': '#111111' },
})) };
const compact = { op: 'setLayersProperties', layerIds: ['land', 'water'], paint: { 'background-color': '#3366ff' } };
const request = { expectedRevision: 4, idempotencyKey: 'compact-batch-1', intentSummary: 'Recolor backgrounds',
  transaction: { operations: [compact] } };
const context = { projectId: PROJECT_ID, runId: 'compact-run' };

describe('compact draft transactions', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(path.join(os.tmpdir(), 'map-design-compact-')); });
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  async function fixture() {
    const db = openMapDesignDatabase(tempDir);
    const blobStore = createMapDesignBlobStore(tempDir);
    const [styleBlob, semanticBlob, manifestBlob] = await Promise.all([
      blobStore.putJson(PROJECT_ID, 'styles', style),
      blobStore.putJson(PROJECT_ID, 'semantics', { version: 1, groups: [] }),
      blobStore.putJson(PROJECT_ID, 'sources', { kind: 'style', digest: 'a'.repeat(64), mediaType: 'application/json', byteLength: 1, resourceCount: 1, capturedAt: NOW }),
    ]);
    db.prepare("INSERT INTO projects (id,title,runtime_json,created_at,updated_at) VALUES (?,?,'{}',?,?)").run(PROJECT_ID, PROJECT_ID, NOW, NOW);
    db.prepare(`INSERT INTO map_design_projects (project_id,lifecycle_state,source_kind,source_manifest_digest,design_system_id,design_system_digest,draft_revision,draft_style_digest,draft_style_hash,draft_semantic_digest,created_at,updated_at)
      VALUES (?,'ready','style',?,'quiet-atlas',?,4,?,?,?,?,?)`).run(PROJECT_ID, manifestBlob.digest, 'd'.repeat(64), styleBlob.digest, await sha256CanonicalJson(style), semanticBlob.digest, NOW, NOW);
    const events = new InMemoryMapDraftEventBus();
    const service = new MapDraftService({ db, blobStore, eventBus: events,
      loadDesignSystem: async () => testDesignSystem({ id: 'quiet-atlas', digest: 'd'.repeat(64) }), now: () => NOW });
    return { db, events, service };
  }

  it('updates all selected layers atomically and emits a client-applicable SDK transaction', async () => {
    const { db, events, service } = await fixture();
    try {
      const output = await service.applyTransaction(context, request);
      expect(output).toMatchObject({ draftRevision: 5, changedLayers: ['land', 'water'] });
      const eventTransaction = events.events[0]?.event.payload.transaction;
      const client = applyStyleTransaction(style, eventTransaction);
      expect(client.ok).toBe(true);
      expect(await sha256CanonicalJson(client.style)).toBe(output.styleHash);
      expect(client.style.layers).toEqual(style.layers.map(layer => ({ ...layer, paint: compact.paint })));
    } finally { db.close(); }
  });

  it('replays the original compact request and rejects a different request under the same key', async () => {
    const { db, events, service } = await fixture();
    try {
      const original = await service.applyTransaction(context, request);
      expect(await service.applyTransaction(context, request)).toEqual(original);
      await expect(service.applyTransaction(context, { ...request, transaction: { operations: [
        { ...compact, paint: { 'background-color': '#ff0000' } },
      ] } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(events.events).toHaveLength(1);
    } finally { db.close(); }
  });

  it.each([
    { ...compact, layerIds: ['land', 'land'] },
    { ...compact, layerIds: ['land', 'missing'] },
    { ...compact, source: 'protected' },
    { ...compact, layerIds: [] },
    { ...compact, minzoom: 12, maxzoom: 3 },
  ])('rejects invalid selections or fields without persisting a partial update: %j', async operation => {
    const { db, events, service } = await fixture();
    try {
      await expect(service.applyTransaction(context, { ...request, transaction: { operations: [operation] } }))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(events.events).toHaveLength(0);
      expect(db.prepare('SELECT draft_revision FROM map_design_projects WHERE project_id=?').get(PROJECT_ID)).toEqual({ draft_revision: 4 });
    } finally { db.close(); }
  });

  it('enforces the operation budget after compact expansion', async () => {
    const { db, service } = await fixture();
    try {
      await expect(service.applyTransaction(context, { ...request, transaction: { operations: Array.from({ length: 51 }, () => compact) } }))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    } finally { db.close(); }
  });
});
