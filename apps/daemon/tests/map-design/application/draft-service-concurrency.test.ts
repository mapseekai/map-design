import {testDesignSystem} from '../../fixtures/map-design/test-design-system.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { MapDraftService } from '../../../src/map-design/application/draft-service.js';
import { InMemoryMapDraftEventBus } from '../../../src/map-design/application/event-bus.js';
import { createMapDesignBlobStore } from '../../../src/map-design/storage/blob-store.js';
import { sha256CanonicalJson } from 'maplibre-style-tools/bridge';

const PROJECT_ID = 'concurrent-project';
const NOW = '2026-08-14T00:00:00.000Z';
const style = { version: 8, sources: { base: { type: 'vector', tiles: [`/api/map-design/projects/${PROJECT_ID}/resources/base/tiles/{z}/{x}/{y}.pbf`] } }, layers: [{ id: 'roads', type: 'line', source: 'base', 'source-layer': 'roads', paint: { 'line-color': '#111111' } }] };
const semantics = { version: 1 as const, groups: [{ id: 'roads', label: 'Roads', role: 'roads', layerIds: ['roads'], sourceIds: ['base'] }] };

function createBarrier() {
  let arrived = 0;
  let release!: () => void;
  const settled = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrived += 1;
    if (arrived === 2) release();
    await settled;
  };
}

describe('MapDraftService concurrent writers', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(path.join(os.tmpdir(), 'map-design-map-design-cas-')); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('allows exactly one independently connected writer at revision 4 to commit revision 5', async () => {
    const primary = openMapDesignDatabase(tempDir);
    const store = createMapDesignBlobStore(tempDir);
    const [styleBlob, semanticBlob, manifestBlob] = await Promise.all([
      store.putJson(PROJECT_ID, 'styles', style), store.putJson(PROJECT_ID, 'semantics', semantics),
      store.putJson(PROJECT_ID, 'sources', { kind: 'style', digest: 'a'.repeat(64), mediaType: 'application/json', byteLength: 1, resourceCount: 1, capturedAt: NOW }),
    ]);
    primary.prepare(`INSERT INTO projects (id, title, runtime_json, created_at, updated_at)
      VALUES (?, ?, '{}', ?, ?)`).run(PROJECT_ID, PROJECT_ID, NOW, NOW);
    primary.prepare(`INSERT INTO map_design_projects (project_id, lifecycle_state, source_kind, source_manifest_digest, design_system_id, design_system_digest, draft_revision, draft_style_digest, draft_style_hash, draft_semantic_digest, created_at, updated_at)
      VALUES (?, 'ready', 'style', ?, 'quiet-atlas', ?, 4, ?, ?, ?, ?, ?)`).run(PROJECT_ID, manifestBlob.digest, 'd'.repeat(64), styleBlob.digest, await sha256CanonicalJson(style), semanticBlob.digest, NOW, NOW);
    const second = new Database(path.join(tempDir, 'map-design.sqlite'));
    second.pragma('journal_mode = WAL'); second.pragma('foreign_keys = ON');
    const system = async () => (testDesignSystem({ id: 'quiet-atlas', digest: 'd'.repeat(64) }));
    const request = (key: string, color: string) => ({ expectedRevision: 4, idempotencyKey: key, intentSummary: `Set ${color}`, transaction: { operations: [{ op: 'setLayerProperties', layerId: 'roads', paint: { 'line-color': color } }] } });
    const events = new InMemoryMapDraftEventBus();
    const beforeImmediate = createBarrier();
    const one = new MapDraftService({ db: primary, blobStore: store, eventBus: events, loadDesignSystem: system, now: () => NOW, beforeImmediate });
    const two = new MapDraftService({ db: second, blobStore: store, eventBus: events, loadDesignSystem: system, now: () => NOW, beforeImmediate });
    const results = await Promise.allSettled([
      one.applyTransaction({ projectId: PROJECT_ID, runId: 'run-a' }, request('writer-a', '#3366ff')),
      two.applyTransaction({ projectId: PROJECT_ID, runId: 'run-b' }, request('writer-b', '#ff6633')),
    ]);
    const successes = results.filter((result) => result.status === 'fulfilled');
    const failures = results.filter((result) => result.status === 'rejected');
    expect(successes).toHaveLength(1);
    const success = successes[0];
    expect(success?.status).toBe('fulfilled');
    if (success?.status === 'fulfilled') expect(success.value.draftRevision).toBe(5);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toMatchObject({ code: 'REVISION_CONFLICT', details: { currentRevision: 5 } });
    const visible = primary.prepare('SELECT draft_revision, draft_style_digest FROM map_design_projects WHERE project_id = ?').get(PROJECT_ID) as { draft_revision: number; draft_style_digest: string };
    expect(visible).toMatchObject({ draft_revision: 5 });
    const winningColor = results[0]?.status === 'fulfilled' ? '#3366ff' : '#ff6633';
    await expect(store.getJson<{ layers: Array<{ paint: { 'line-color': string } }> }>(PROJECT_ID, 'styles', visible.draft_style_digest))
      .resolves.toMatchObject({ layers: [{ paint: { 'line-color': winningColor } }] });
    expect(primary.prepare('SELECT COUNT(*) AS count FROM map_design_idempotency WHERE project_id = ?').get(PROJECT_ID)).toEqual({ count: 1 });
    expect(events.events).toHaveLength(1);
    second.close();
    primary.close();
  });

  it('returns the sole stored receipt and emits one event when two connections race the same request key', async () => {
    const primary = openMapDesignDatabase(tempDir);
    const store = createMapDesignBlobStore(tempDir);
    const [styleBlob, semanticBlob, manifestBlob] = await Promise.all([
      store.putJson(PROJECT_ID, 'styles', style), store.putJson(PROJECT_ID, 'semantics', semantics),
      store.putJson(PROJECT_ID, 'sources', { kind: 'style', digest: 'a'.repeat(64), mediaType: 'application/json', byteLength: 1, resourceCount: 1, capturedAt: NOW }),
    ]);
    primary.prepare(`INSERT INTO projects (id, title, runtime_json, created_at, updated_at)
      VALUES (?, ?, '{}', ?, ?)`).run(PROJECT_ID, PROJECT_ID, NOW, NOW);
    primary.prepare(`INSERT INTO map_design_projects (project_id, lifecycle_state, source_kind, source_manifest_digest, design_system_id, design_system_digest, draft_revision, draft_style_digest, draft_style_hash, draft_semantic_digest, created_at, updated_at)
      VALUES (?, 'ready', 'style', ?, 'quiet-atlas', ?, 4, ?, ?, ?, ?, ?)`).run(PROJECT_ID, manifestBlob.digest, 'd'.repeat(64), styleBlob.digest, await sha256CanonicalJson(style), semanticBlob.digest, NOW, NOW);
    const second = new Database(path.join(tempDir, 'map-design.sqlite'));
    second.pragma('journal_mode = WAL'); second.pragma('foreign_keys = ON');
    const events = new InMemoryMapDraftEventBus();
    const system = async () => (testDesignSystem({ id: 'quiet-atlas', digest: 'd'.repeat(64) }));
    const request = { expectedRevision: 4, idempotencyKey: 'same-request', intentSummary: 'Set blue', transaction: { operations: [{ op: 'setLayerProperties', layerId: 'roads', paint: { 'line-color': '#3366ff' } }] } };
    const beforeImmediate = createBarrier();
    const one = new MapDraftService({ db: primary, blobStore: store, eventBus: events, loadDesignSystem: system, now: () => NOW, beforeImmediate });
    const two = new MapDraftService({ db: second, blobStore: store, eventBus: events, loadDesignSystem: system, now: () => NOW, beforeImmediate });
    const [left, right] = await Promise.all([one.applyTransaction({ projectId: PROJECT_ID, runId: 'run-a' }, request), two.applyTransaction({ projectId: PROJECT_ID, runId: 'run-b' }, request)]);
    expect(left).toEqual(right);
    expect(primary.prepare('SELECT COUNT(*) AS count FROM map_design_idempotency WHERE project_id = ?').get(PROJECT_ID)).toEqual({ count: 1 });
    expect(events.events).toHaveLength(1);
    second.close();
    primary.close();
  });
});
