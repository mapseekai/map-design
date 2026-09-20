import {testDesignSystem} from '../../fixtures/map-design/test-design-system.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256CanonicalJson } from 'maplibre-style-tools/bridge';

import { MapDraftService } from '../../../src/map-design/application/draft-service.js';
import { InMemoryMapDraftEventBus } from '../../../src/map-design/application/event-bus.js';
import { createMapDesignBlobStore } from '../../../src/map-design/storage/blob-store.js';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';

const PROJECT_ID = 'ui-style-project';
const NOW = '2026-09-08T00:00:00.000Z';
const style = { version: 8, sources: { base: { type: 'vector', tiles: [`/api/map-design/projects/${PROJECT_ID}/resources/base/tiles/{z}/{x}/{y}.pbf`] } }, layers: [{ id: 'roads', type: 'line', source: 'base', 'source-layer': 'roads', paint: { 'line-color': '#111111' } }] };
const semantics = { version: 1 as const, groups: [{ id: 'roads', label: 'Roads', role: 'roads', layerIds: ['roads'], sourceIds: ['base'] }] };
const transaction = { expectedRevision: 4, idempotencyKey: 'ui-style-edit', intentSummary: 'Edit roads style', transaction: { operations: [{ op: 'setLayerProperties', layerId: 'roads', paint: { 'line-color': '#3366ff' } }] } };

describe('MapDraftService UI mutations', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(path.join(os.tmpdir(), 'map-design-ui-draft-')); });
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  async function fixture(beforeImmediate?: () => void) {
    const db = openMapDesignDatabase(tempDir);
    const blobStore = createMapDesignBlobStore(tempDir);
    const [styleBlob, semanticBlob, manifestBlob] = await Promise.all([
      blobStore.putJson(PROJECT_ID, 'styles', style), blobStore.putJson(PROJECT_ID, 'semantics', semantics),
      blobStore.putJson(PROJECT_ID, 'sources', { kind: 'style', digest: 'a'.repeat(64), mediaType: 'application/json', byteLength: 1, resourceCount: 1, capturedAt: NOW }),
    ]);
    db.prepare("INSERT INTO projects (id,title,runtime_json,created_at,updated_at) VALUES (?,?,'{}',?,?)").run(PROJECT_ID, PROJECT_ID, NOW, NOW);
    db.prepare(`INSERT INTO map_design_projects (project_id,lifecycle_state,source_kind,source_manifest_digest,design_system_id,design_system_digest,draft_revision,draft_style_digest,draft_style_hash,draft_semantic_digest,created_at,updated_at)
      VALUES (?,'ready','style',?,'quiet-atlas',?,4,?,?,?,?,?)`).run(PROJECT_ID, manifestBlob.digest, 'd'.repeat(64), styleBlob.digest, await sha256CanonicalJson(style), semanticBlob.digest, NOW, NOW);
    const events = new InMemoryMapDraftEventBus();
    const service = new MapDraftService({ db, blobStore, eventBus: events,
      loadDesignSystem: async () => (testDesignSystem({ id: 'quiet-atlas', digest: 'd'.repeat(64) })),
      now: () => NOW, ...(beforeImmediate ? { beforeImmediate } : {}) });
    return { db, events, service };
  }

  it('replaces the complete style, preserves nested null metadata, and replays safely', async () => {
    const { db, events, service } = await fixture();
    try {
      const context = { kind: 'ui' as const, projectId: PROJECT_ID, requestId: 'code-1', isProjectRunning: () => false,
        requestWitness: { digest: 'code', json: '{}' } };
      const input = { expectedRevision: 4, styleHash: await sha256CanonicalJson(style), idempotencyKey: 'code-1',
        style: { ...style, name: 'Edited JSON', metadata: { nullable: null }, layers: style.layers.map(layer => ({ ...layer, paint: { 'line-color': '#ff0000' } })) } };
      const output = await service.replaceStyle(context, input);
      expect(output.draftRevision).toBe(5);
      expect(output.styleHash).toBe(await sha256CanonicalJson(input.style));
      expect(events.events[0]?.event.payload.transaction).toBeNull();
      expect(await service.replaceStyle(context, input)).toEqual(output);
      await expect(service.replaceStyle(context, { ...input, idempotencyKey: 'stale' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      expect(events.events).toHaveLength(1);
    } finally { db.close(); }
  });

  it('rejects unsafe or invalid replacement without changing the draft', async () => {
    const { db, service } = await fixture();
    try {
      const context = { kind: 'ui' as const, projectId: PROJECT_ID, requestId: 'code-2', isProjectRunning: () => false, requestWitness: { digest: 'code', json: '{}' } };
      const input = { expectedRevision: 4, styleHash: await sha256CanonicalJson(style), idempotencyKey: 'code-2', style };
      for (const replacement of [{ ...style, version: 7 }, { ...style, glyphs: 'file:///private/font/{fontstack}/{range}.pbf' }]) {
        await expect(service.replaceStyle(context, { ...input, style: replacement })).rejects.toMatchObject({ code: 'STYLE_INVALID' });
      }
      await expect(service.replaceStyle({ ...context, isProjectRunning: () => true }, input)).rejects.toMatchObject({ code: 'RUN_NOT_AUTHORIZED' });
      expect((await service.replaceStyle(context, input)).draftRevision).toBe(4);
    } finally { db.close(); }
  });

  it('publishes a UI actor and persists the edit without inventing a run', async () => {
    const { db, events, service } = await fixture();
    const output = await service.applyTransaction({ kind: 'ui', projectId: PROJECT_ID, requestId: 'request-1', isProjectRunning: () => false,
      requestWitness: { digest: 'witness-digest', json: '{"request":"one"}' } }, transaction);
    expect(output.draftRevision).toBe(5);
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({ projectId: PROJECT_ID, requestId: 'request-1', actor: { kind: 'ui', requestId: 'request-1' } });
    expect(events.events[0]).not.toHaveProperty('runId');
    expect(db.prepare(`SELECT canonical_request_digest AS digest, canonical_request_json AS json
      FROM map_design_idempotency WHERE project_id=? AND operation='map_apply_transaction'`).get(PROJECT_ID))
      .toEqual({ digest: 'witness-digest', json: '{"request":"one"}' });
    db.close();
  });

  it('preserves bounded structural SDK diagnostics without input values', async () => {
    const { db, service } = await fixture();
    try {
      await expect(service.applyTransaction({ kind: 'ui', projectId: PROJECT_ID, requestId: 'request-1', isProjectRunning: () => false,
        requestWitness: { digest: 'witness-digest', json: '{}' } }, { ...transaction,
        transaction: { operations: [{ op: 'addSource', sourceId: 'private-value' }] },
      })).rejects.toMatchObject({ code: 'INVALID_INPUT', details: {
        category: 'INVALID_INPUT', firstPath: 'transaction.operations.0.source', operationIndex: 0,
      } });
      expect(db.prepare('SELECT draft_revision AS revision FROM map_design_projects WHERE project_id=?').get(PROJECT_ID)).toEqual({ revision: 4 });
    } finally { db.close(); }
  });

  it('rechecks the active-run lock inside the immediate transaction', async () => {
    let running = false;
    const { db, service } = await fixture(() => { running = true; });
    await expect(service.applyTransaction({ kind: 'ui', projectId: PROJECT_ID, requestId: 'request-1', isProjectRunning: () => running,
      requestWitness: { digest: 'witness-digest', json: '{"request":"one"}' } }, transaction))
      .rejects.toMatchObject({ code: 'RUN_NOT_AUTHORIZED', details: { reason: 'ACTIVE_RUN' } });
    expect(db.prepare('SELECT draft_revision AS revision FROM map_design_projects WHERE project_id=?').get(PROJECT_ID)).toEqual({ revision: 4 });
    db.close();
  });
});
