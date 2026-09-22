import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAP_INSPECT_MAX_BYTES, MapInspectOutputSchema, MapSearchLayersOutputSchema } from '@mapseekai/map-design-contracts';
import { sha256CanonicalJson } from 'maplibre-style-tools/bridge';
import type { StyleDocument } from 'maplibre-style-tools/core';
import { testDesignSystem } from '../../fixtures/map-design/test-design-system.js';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignProjectServices, type MapDesignProjectServices } from '../../../src/server-context.js';
import type { MapNativeToolCallContext } from '../../../src/map-design/tools/tool-context.js';

const PROJECT_ID = 'batch-layer-project';
const NOW = '2026-09-22T00:00:00.000Z';
const designSystem = testDesignSystem({ id: 'batch-atlas' });
const style: StyleDocument = {
  version: 8,
  sources: {},
  layers: Array.from({ length: 205 }, (_, index) => ({
    id: `background-${index}`, type: 'background' as const,
    paint: { 'background-color': '#112233', 'background-opacity': 0.8 },
    layout: { visibility: 'visible' as const },
  })),
};

const context: MapNativeToolCallContext = {
  projectId: PROJECT_ID, runId: 'batch-run', conversationId: 'batch-conversation', toolUseId: 'batch-call',
  signal: new AbortController().signal,
};

describe('native batch layer reads', () => {
  let root: string;
  let db: Database.Database;
  let services: MapDesignProjectServices;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'map-batch-read-'));
    db = openMapDesignDatabase(root);
    services = createMapDesignProjectServices({
      db, dataRoot: root, projectRoot: root, designSystem,
      runStore: { get: (runId) => runId === context.runId ? {
        runId, projectId: PROJECT_ID, runtime: { id: 'api', version: 'test', adapter: 'native' },
        model: { id: 'test', provider: 'local' },
      } : null },
    });
    const [styleBlob, semantics, manifest] = await Promise.all([
      services.blobStore.putJson(PROJECT_ID, 'styles', style),
      services.blobStore.putJson(PROJECT_ID, 'semantics', { version: 1, groups: [] }),
      services.blobStore.putJson(PROJECT_ID, 'sources', {
        kind: 'style', digest: 'a'.repeat(64), mediaType: 'application/json', byteLength: 1,
        resourceCount: 0, capturedAt: NOW,
      }),
    ]);
    db.prepare('INSERT INTO projects (id, title, runtime_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(PROJECT_ID, 'Batch reads', '{}', NOW, NOW);
    db.prepare(`INSERT INTO map_design_projects (project_id, lifecycle_state, source_kind, source_manifest_digest,
      design_system_id, design_system_digest, draft_revision, draft_style_digest, draft_style_hash,
      draft_semantic_digest, created_at, updated_at) VALUES (?, 'ready', 'style', ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
      .run(PROJECT_ID, manifest.digest, designSystem.id, designSystem.digest, styleBlob.digest,
        await sha256CanonicalJson(style), semantics.digest, NOW, NOW);
  });

  afterEach(() => {
    services.previewService.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns 200 layer paint records in one authorized call without layout or filter tokens', async () => {
    const result = await services.nativeToolRegistry.call(context, 'map_inspect', {
      target: { kind: 'layers', layerIds: style.layers.slice(0, 200).map(layer => layer.id) }, fields: ['paint'],
      maxBytes: MAP_INSPECT_MAX_BYTES,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.modelContent) throw new Error('Missing batch result');
    expect(result.summary).toEqual({ targetKind: 'layers', returned: 200, truncated: false });
    const output = MapInspectOutputSchema.parse(JSON.parse(result.modelContent));
    expect(output.view.kind).toBe('layers');
    if (output.view.kind !== 'layers') throw new Error('Expected batch view');
    expect(output.view.layers).toHaveLength(200);
    expect(output.view.layers[199]).toMatchObject({ id: 'background-199', paint: style.layers[199]?.paint });
    expect(output.view.layers.every(layer => !Object.hasOwn(layer, 'layout') && !Object.hasOwn(layer, 'filter'))).toBe(true);
    expect(services.repository.get(PROJECT_ID)?.draftRevision).toBe(0);
  });

  it('unions search terms without duplicate rows and paginates beyond 200', async () => {
    const first = await services.nativeToolRegistry.call(context, 'map_search_layers', {
      query: ['background', 'background-1'], limit: 200,
    });
    if (!first.ok || !first.modelContent) throw new Error('Missing first search page');
    const output = MapSearchLayersOutputSchema.parse(JSON.parse(first.modelContent));
    expect(output).toMatchObject({ returned: 200, total: 205, nextOffset: 200, truncated: true });
    expect(new Set(output.layers.map(layer => layer.id)).size).toBe(200);
    const second = await services.nativeToolRegistry.call(context, 'map_search_layers', {
      query: ['background', 'background-1'], limit: 200, offset: output.nextOffset,
    });
    if (!second.ok || !second.modelContent) throw new Error('Missing second search page');
    expect(MapSearchLayersOutputSchema.parse(JSON.parse(second.modelContent))).toMatchObject({
      returned: 5, total: 205, truncated: false, layers: [{ id: 'background-200' }, { id: 'background-201' },
        { id: 'background-202' }, { id: 'background-203' }, { id: 'background-204' }],
    });
  });

  it('returns requested properties through the authorized native search surface', async () => {
    const result = await services.nativeToolRegistry.call(context, 'map_search_layers', {
      query: 'background-0', properties: { paint: ['background-color'] },
    });
    if (!result.ok || !result.modelContent) throw new Error('Missing projected search result');
    const output = MapSearchLayersOutputSchema.parse(JSON.parse(result.modelContent));
    expect(output.layers).toEqual([{ id: 'background-0', type: 'background', paint: { 'background-color': '#112233' } }]);
  });

  it('returns requested properties through the authorized native inspect surface', async () => {
    const result = await services.nativeToolRegistry.call(context, 'map_inspect', {
      target: { kind: 'layers', layerIds: ['background-0'] }, properties: { layout: ['visibility'] },
    });
    if (!result.ok || !result.modelContent) throw new Error('Missing projected inspect result');
    const output = MapInspectOutputSchema.parse(JSON.parse(result.modelContent));
    if (output.view.kind !== 'layers') throw new Error('Expected layers');
    expect(output.view.layers).toEqual([{ id: 'background-0', type: 'background', layout: { visibility: 'visible' } }]);
  });

  it('preserves requested order and reports missing IDs without losing valid records', async () => {
    const result = await services.nativeToolRegistry.call(context, 'map_inspect', {
      target: { kind: 'layers', layerIds: ['background-2', 'missing', 'background-0'] }, fields: [],
    });
    if (!result.ok || !result.modelContent) throw new Error('Missing batch result');
    const output = MapInspectOutputSchema.parse(JSON.parse(result.modelContent));
    expect(output).toMatchObject({ truncated: false, view: { kind: 'layers', returned: 2,
      layers: [{ id: 'background-2' }, { id: 'background-0' }], missingLayerIds: ['missing'], omittedLayerIds: [] } });
  });

  it('bounds root and source-layer discovery to 200 records', async () => {
    const sourceStyle: StyleDocument = { version: 8, sources: {
      base: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] },
    }, layers: style.layers.map(layer => ({ id: layer.id, type: 'line', source: 'base', 'source-layer': 'roads' })) };
    const blob = await services.blobStore.putJson(PROJECT_ID, 'styles', sourceStyle);
    db.prepare('UPDATE map_design_projects SET draft_style_digest = ?, draft_style_hash = ? WHERE project_id = ?')
      .run(blob.digest, await sha256CanonicalJson(sourceStyle), PROJECT_ID);
    const root = await services.queryService.inspect(PROJECT_ID, { target: { kind: 'root' }, maxBytes: MAP_INSPECT_MAX_BYTES });
    expect(root.truncated).toBe(true);
    if (root.view.kind !== 'root') throw new Error('Expected root view');
    expect(root.view.layers).toHaveLength(200);
    const source = await services.queryService.inspect(PROJECT_ID, {
      target: { kind: 'source-layer', sourceId: 'base', sourceLayer: 'roads' },
    });
    expect(source.truncated).toBe(true);
    if (source.view.kind !== 'source-layer') throw new Error('Expected source-layer view');
    expect(source.view.layerIds).toHaveLength(200);
    const remainder = await services.queryService.searchLayers(PROJECT_ID, {
      sourceId: 'base', sourceLayer: 'roads', offset: 200, limit: 200,
    });
    expect(remainder).toMatchObject({ returned: 5, total: 205, truncated: false });
  });

  it('identifies oversized rows and still returns later small rows within the byte budget', async () => {
    const largeStyle = structuredClone(style);
    largeStyle.layers[0] = { id: 'oversized', type: 'background', paint: {
      'background-color': ['case', ['==', ['global-state', 'huge'], 'x'.repeat(MAP_INSPECT_MAX_BYTES)], '#000000', '#ffffff'],
    } };
    const blob = await services.blobStore.putJson(PROJECT_ID, 'styles', largeStyle);
    db.prepare('UPDATE map_design_projects SET draft_style_digest = ?, draft_style_hash = ? WHERE project_id = ?')
      .run(blob.digest, await sha256CanonicalJson(largeStyle), PROJECT_ID);
    const result = await services.nativeToolRegistry.call(context, 'map_inspect', {
      target: { kind: 'layers', layerIds: ['oversized', 'background-1'] }, fields: ['paint'],
    });
    if (!result.ok || !result.modelContent) throw new Error('Missing bounded result');
    expect(Buffer.byteLength(result.modelContent)).toBeLessThanOrEqual(MAP_INSPECT_MAX_BYTES);
    expect(MapInspectOutputSchema.parse(JSON.parse(result.modelContent))).toMatchObject({ truncated: true,
      view: { kind: 'layers', returned: 1, layers: [{ id: 'background-1' }], omittedLayerIds: ['oversized'] } });
  });
});
