import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyStyleTransaction, validateStyleDocument, type StyleDocument } from 'maplibre-style-tools/core';
import type { MapApplyTransactionOutput } from '@mapseekai/map-design-contracts';

import { MapDesignStyleEditService } from '../../../src/map-design/application/style-edit-service.js';
import type { MapDraftMutationContext, MapDraftService } from '../../../src/map-design/application/draft-service.js';
import { canonicalJson } from '../../../src/map-design/storage/canonical-json.js';
import { requestDigest } from '../../../src/map-design/application/request-digest.js';

const HASH = 'a'.repeat(64);
const style = {
  version: 8 as const,
  sources: { places: { type: 'geojson' as const, data: { type: 'FeatureCollection' as const, features: [
    { type: 'Feature' as const, id: 7, properties: { class: 'city' }, geometry: { type: 'Point' as const, coordinates: [0, 0] } },
  ] } } },
  layers: [{ id: 'places-layer', type: 'circle' as const, source: 'places', paint: { 'circle-color': '#111111' } }],
} as unknown as StyleDocument;
const output: MapApplyTransactionOutput = { draftRevision: 4, styleHash: 'b'.repeat(64), changedLayers: ['places-layer'], changedSources: [], diff: [], warnings: [], validationSummary: { status: 'valid', errors: 0, warnings: 0, infos: 0, totalFindings: 0, returnedFindings: 0, omittedFindings: 0 } };
const input = (overrides: Record<string, unknown> = {}) => ({
  expectedRevision: 3, styleHash: HASH, idempotencyKey: 'style-edit-1',
  target: { layerId: 'places-layer', sourceId: 'places', featureId: 7, properties: { class: 'city' }, anchor: [0, 0], geometryType: 'Point' },
  scope: 'feature', changes: { 'circle-color': '#3366ff' }, ...overrides,
});

describe('MapDesignStyleEditService', () => {
  let db: Database.Database;
  let applyTransaction: ReturnType<typeof vi.fn<MapDraftService['applyTransaction']>>;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE map_design_projects (project_id TEXT PRIMARY KEY, lifecycle_state TEXT, draft_revision INTEGER, draft_style_hash TEXT);');
    db.exec('CREATE TABLE map_design_idempotency (project_id TEXT, operation TEXT, idempotency_key TEXT, request_digest TEXT, canonical_request_json TEXT, canonical_request_digest TEXT, response_json TEXT, created_at TEXT, PRIMARY KEY(project_id,operation,idempotency_key));');
    db.prepare("INSERT INTO map_design_projects VALUES ('project-1','ready',3,?)").run(HASH);
    applyTransaction = vi.fn(async (_context: MapDraftMutationContext, _input: unknown) => output);
  });
  afterEach(() => db.close());

  it('turns a validated feature edit into a trusted UI draft transaction', async () => {
    const service = new MapDesignStyleEditService({ db, getStyle: async () => style, applyTransaction, isProjectRunning: () => false });
    await service.apply('project-1', 'request-1', input());
    expect(applyTransaction).toHaveBeenCalledWith(
      { kind: 'ui', projectId: 'project-1', requestId: 'request-1', isProjectRunning: expect.any(Function),
        requestWitness: { digest: requestDigest(input()), json: canonicalJson(input()) } },
      { expectedRevision: 3, idempotencyKey: 'style-edit-1', intentSummary: 'Edit places-layer style', transaction: { operations: [{ op: 'setLayerProperties', layerId: 'places-layer', paint: { 'circle-color': ['case', ['==', ['id'], 7], '#3366ff', '#111111'] } }] } },
    );
  });

  it('produces a transaction accepted by the real style engine for zoom and data-driven paint', async () => {
    const zoomStyle = structuredClone(style);
    zoomStyle.layers[0]!.paint = { 'circle-color': [
      'interpolate', ['linear'], ['zoom'],
      4, ['match', ['get', 'class'], 'city', '#111111', '#333333'],
      10, ['match', ['get', 'class'], 'city', '#222222', '#444444'],
    ] };
    const service = new MapDesignStyleEditService({ db, getStyle: async () => zoomStyle, applyTransaction, isProjectRunning: () => false });
    await service.apply('project-1', 'request-1', input());
    const transaction = applyTransaction.mock.calls[0]![1] as { transaction: unknown };
    const applied = applyStyleTransaction(zoomStyle, transaction.transaction);
    if (!applied.ok) throw new Error(JSON.stringify({ error: applied.error, transaction }));
    expect(applied.ok).toBe(true);
    expect(validateStyleDocument(applied.style).ok).toBe(true);
  });

  it('rejects stale hashes and active runs before applying', async () => {
    const stale = new MapDesignStyleEditService({ db, getStyle: async () => style, applyTransaction, isProjectRunning: () => false });
    await expect(stale.apply('project-1', 'request-1', input({ styleHash: 'c'.repeat(64) }))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const running = new MapDesignStyleEditService({ db, getStyle: async () => style, applyTransaction, isProjectRunning: () => true });
    await expect(running.apply('project-1', 'request-1', input())).rejects.toMatchObject({ code: 'RUN_NOT_AUTHORIZED', details: { reason: 'ACTIVE_RUN' } });
    expect(applyTransaction).not.toHaveBeenCalled();
  });

  it('rejects generated or non-unique feature ids and mismatched targets', async () => {
    const generated = structuredClone(style);
    (generated.sources.places as Record<string, unknown>).generateId = true;
    const service = new MapDesignStyleEditService({ db, getStyle: async () => generated, applyTransaction, isProjectRunning: () => false });
    await expect(service.apply('project-1', 'request-1', input())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const duplicate = structuredClone(style);
    const data = (duplicate.sources.places as unknown as { data: { features: unknown[] } }).data;
    data.features.push(structuredClone(data.features[0]!));
    const duplicateService = new MapDesignStyleEditService({ db, getStyle: async () => duplicate, applyTransaction, isProjectRunning: () => false });
    await expect(duplicateService.apply('project-1', 'request-1', input())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(duplicateService.apply('project-1', 'request-1', input({ target: { ...input().target, sourceId: 'other' } }))).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('replays an acknowledged style edit after its revision advanced and rejects changed same-key input', async () => {
    const request = input();
    const json = canonicalJson(request);
    const digest = requestDigest(request);
    db.prepare("INSERT INTO map_design_idempotency VALUES (?,'map_apply_transaction',?,?,?,?,?,?)")
      .run('project-1', request.idempotencyKey, digest, json, digest, canonicalJson(output), '2026-09-08T00:00:00.000Z');
    db.prepare('UPDATE map_design_projects SET draft_revision=4,draft_style_hash=? WHERE project_id=?').run(output.styleHash, 'project-1');
    const getStyle = vi.fn(async () => style);
    const service = new MapDesignStyleEditService({ db, getStyle, applyTransaction, isProjectRunning: () => false });
    await expect(service.apply('project-1', 'request-2', request)).resolves.toEqual(output);
    expect(getStyle).not.toHaveBeenCalled();
    expect(applyTransaction).not.toHaveBeenCalled();
    await expect(service.apply('project-1', 'request-3', { ...request, changes: { 'circle-color': '#ff0000' } }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('rejects a valid property used on the wrong layer or with an unsupported scope as invalid input', async () => {
    const service = new MapDesignStyleEditService({ db, getStyle: async () => style, applyTransaction, isProjectRunning: () => false });
    await expect(service.apply('project-1', 'request-1', input({ changes: { 'line-cap': 'round' } }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.apply('project-1', 'request-1', input({ changes: { 'circle-translate': [2, 4] } }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(applyTransaction).not.toHaveBeenCalled();
  });

});
