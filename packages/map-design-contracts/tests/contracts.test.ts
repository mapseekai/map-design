import { describe, expect, expectTypeOf, it } from 'vitest';

import * as Contracts from '../src/index.js';
import {
  MAP_DIFF_MAX_BYTES,
  MAP_ERROR_DETAILS_MAX_BYTES,
  MAP_INSPECT_MAX_BYTES,
  MAP_REVISION_SNAPSHOT_MAX_BYTES,
  MAP_REVISION_HISTORY_MAX,
  MAP_TOOL_ERROR_CODES,
  MAP_TOOL_NAMES,
  MAP_VALIDATION_FINDINGS_MAX,
  DEFAULT_MAP_DESIGN_SYSTEM_ID,
  LayerTypeSchema,
  MapApplyTransactionInputSchema,
  MapApplyTransactionOutputSchema,
  MapCommitRevisionInputSchema,
  MapCommitRevisionOutputSchema,
  mapCommitPreviewIntentSummary,
  MapDiscardDraftInputSchema,
  MapDiscardDraftOutputSchema,
  MapGetContextInputSchema,
  MapGetContextOutputSchema,
  MapInspectInputSchema,
  MapInspectOutputSchema,
  MapDesignProjectCreateInputSchema,
  MapDesignProjectCreateOutputSchema,
  MapDesignProjectListOutputSchema,
  MapDesignProjectReadSchema,
  MapDesignProjectSummarySchema,
  MapDesignRuntimeSelectionSchema,
  MapPreviewFulfillRequestSchema,
  MapCurrentPreviewOutputSchema,
  MapPreviewRuntimeReportSchema,
  MapProjectImportInputSchema,
  MapProjectRetryInputSchema,
  MapProjectLifecycleSchema,
  MapPreviewEvidenceSchema,
  MapRenderPreviewInputSchema,
  MapRenderPreviewOutputSchema,
  MapRevisionHistoryOutputSchema,
  MapRevisionSnapshotOutputSchema,
  MapRevisionSchema,
  MapRestoreRevisionInputSchema,
  MapRestoreRevisionOutputSchema,
  MapSearchLayersInputSchema,
  MapSearchLayersOutputSchema,
  MapSourceKindSchema,
  MapSourcePreflightInputSchema,
  MapSourcePreflightOutputSchema,
  MapSourceReferenceSchema,
  MapStudioEventSchema,
  MapStudioEventRecordSchema,
  MapStudioEventReplaySchema,
  MapToolEnvelopeSchema,
  MapToolErrorCodeSchema,
  MapToolNameSchema,
  MapToolJsonInputSchemas,
  MapToolJsonOutputSchemas,
  MapUpdateSemanticsInputSchema,
  MapUpdateSemanticsOutputSchema,
  MapValidateInputSchema,
  MapValidateOutputSchema,
  MapValidationSummarySchema,
  assertMapDesignStyleResourceUrls,
  assertMapDesignTransactionResourceUrls,
  SemanticDocumentSchema,
  StyleHashSchema,
  DEFAULT_MAP_PREVIEW_VIEWPORT,
  type MapApplyTransactionInput,
  type MapRestoreRevisionInput,
  type MapRestoreRevisionOutput,
  type MapStyleDiffEntry,
  type MapStyleDiffTarget,
} from '../src/index.js';

const HASH = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);
const TIMESTAMP = '2026-08-13T12:34:56.000Z';
const IDEMPOTENCY_KEY = 'idem-12345678';

const validationSummary = {
  status: 'valid' as const,
  errors: 0,
  warnings: 0,
  infos: 0,
  totalFindings: 0,
  returnedFindings: 0,
  omittedFindings: 0,
};

const semanticSummary = {
  version: 1 as const,
  groupCount: 0,
  mappedLayerCount: 0,
  mappedSourceCount: 0,
};

const layerSummary = {
  id: 'water',
  type: 'fill' as const,
  sourceId: 'basemap',
  sourceLayer: 'water',
};

const sourceSummary = {
  id: 'basemap',
  kind: 'vector' as const,
  sourceLayerCount: 1,
  layerCount: 1,
};

const pngDescriptor = {
  digest: DIGEST,
  mediaType: 'image/png' as const,
  byteLength: 1_024,
  width: 800,
  height: 600,
};

const reportDescriptor = {
  digest: DIGEST,
  mediaType: 'application/json' as const,
  byteLength: 512,
};

const mutationInputs = [
  [MapApplyTransactionInputSchema, { transaction: { operations: [] }, intentSummary: 'Apply style changes' }],
  [MapUpdateSemanticsInputSchema, { semantics: { version: 1, groups: [] }, intentSummary: 'Update semantics' }],
  [MapRenderPreviewInputSchema, {}],
  [MapCommitRevisionInputSchema, { previewId: 'preview-1', intentSummary: 'Commit revision' }],
  [MapDiscardDraftInputSchema, { intentSummary: 'Discard draft' }],
] as const;

describe('stable vocabulary', () => {
  it('exposes exactly the supported tool names in transport order', () => {
    expect(MAP_TOOL_NAMES).toEqual([
      'map_get_context',
      'map_inspect',
      'map_search_layers',
      'map_apply_transaction',
      'map_update_semantics',
      'map_validate',
      'map_render_preview',
      'map_commit_revision',
      'map_discard_draft',
    ]);
    expect(MapToolNameSchema.options).toEqual(MAP_TOOL_NAMES);
  });

  it('accepts exactly four source kinds, three lifecycle states, and current layer types', () => {
    expect(MapSourceKindSchema.options).toEqual(['style', 'tilejson', 'pmtiles', 'geojson']);
    expect(MapProjectLifecycleSchema.options).toEqual(['importing', 'ready', 'failed']);
    expect(LayerTypeSchema.options).toEqual([
      'background', 'fill', 'line', 'symbol', 'raster', 'circle', 'fill-extrusion',
      'heatmap', 'hillshade', 'color-relief',
    ]);
  });

  it('enforces the canonical lowercase SHA-256 style hash', () => {
    expect(StyleHashSchema.parse(HASH)).toBe(HASH);
    for (const invalid of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
      expect(() => StyleHashSchema.parse(invalid)).toThrow();
    }
  });

  it('exposes exactly the fourteen stable public error codes', () => {
    expect(MAP_TOOL_ERROR_CODES).toHaveLength(14);
    expect(MapToolErrorCodeSchema.options).toEqual([
      'INVALID_INPUT', 'NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT',
      'STYLE_INVALID', 'SEMANTIC_INVALID', 'DESIGN_SYSTEM_VIOLATION',
      'SOURCE_UNAVAILABLE', 'PREVIEW_FAILED', 'PREVIEW_STALE',
      'RUN_NOT_AUTHORIZED', 'PROJECT_NOT_READY', 'RUNTIME_CONFLICT', 'INTERNAL',
    ]);
    expect(MapToolErrorCodeSchema.parse('PREVIEW_STALE')).toBe('PREVIEW_STALE');
    expect(MapToolErrorCodeSchema.parse('RUNTIME_CONFLICT')).toBe('RUNTIME_CONFLICT');
  });
});

describe('browser-safe project reads', () => {
  const revisionZero = {
    revision: 0,
    draftRevision: 0,
    styleHash: HASH,
    sourceDigest: DIGEST,
    semanticDigest: DIGEST,
    designSystemDigest: DIGEST,
    previewId: null,
    attestationDigest: DIGEST,
    committedAt: TIMESTAMP,
  };
  const revisionOne = { ...revisionZero, revision: 1, draftRevision: 7, previewId: 'preview-1' };

  // Mutation caught: making previewId always required/optional instead of preserving the revision-0 provenance exception.
  it('requires null preview only for revision zero and a real preview for later revisions', () => {
    expect(MapRevisionSchema.parse(revisionZero)).toEqual(revisionZero);
    expect(MapRevisionSchema.parse(revisionOne)).toEqual(revisionOne);
    expect(() => MapRevisionSchema.parse({ ...revisionZero, previewId: 'fabricated-preview' })).toThrow();
    expect(() => MapRevisionSchema.parse({ ...revisionOne, previewId: null })).toThrow();
  });

  // Mutation caught: returning storage digests/paths or an unbounded failure shape from the aggregate project endpoint.
  it('accepts only the strict public project aggregate fields', () => {
    const project = {
      projectId: 'project-1',
      lifecycle: 'failed' as const,
      sourceKind: null,
      designSystemId: 'quiet-atlas',
      designSystemDigest: DIGEST,
      draftRevision: 7,
      committedRevision: 1,
      failure: { code: 'IMPORT_FAILED', message: 'Import failed safely.' },
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    };
    expect(MapDesignProjectReadSchema.parse(project)).toEqual(project);
    expect(() => MapDesignProjectReadSchema.parse({ ...project, draftStyleDigest: DIGEST })).toThrow();
    expect(() => MapDesignProjectReadSchema.parse({ ...project, failure: { ...project.failure, path: '/private/blob' } })).toThrow();
  });

  // Mutation caught: returning an unbounded revision array or a returned count unrelated to the serialized slice.
  it('bounds revision history and correlates returned count with the serialized entries', () => {
    const output = { revisions: [revisionOne, revisionZero], returned: 2, truncated: true };
    expect(MAP_REVISION_HISTORY_MAX).toBe(100);
    expect(MapRevisionHistoryOutputSchema.parse(output)).toEqual(output);
    expect(() => MapRevisionHistoryOutputSchema.parse({ ...output, returned: 1 })).toThrow();
    expect(() => MapRevisionHistoryOutputSchema.parse({
      revisions: Array.from({ length: 101 }, (_, index) => ({
        ...revisionOne,
        revision: index + 1,
        draftRevision: index + 7,
        previewId: `preview-${index + 1}`,
      })),
      returned: 101,
      truncated: false,
    })).toThrow();
  });
});

describe('historical revision contracts', () => {
  const revision = {
    revision: 1,
    draftRevision: 8,
    styleHash: HASH,
    sourceDigest: DIGEST,
    semanticDigest: DIGEST,
    designSystemDigest: DIGEST,
    previewId: 'preview-1',
    attestationDigest: DIGEST,
    committedAt: TIMESTAMP,
  };
  const validation = {
    draftRevision: 8,
    styleHash: HASH,
    validationDigest: DIGEST,
    summary: validationSummary,
    findings: [],
  };
  const inspect = {
    target: { kind: 'root' as const },
    view: {
      kind: 'root' as const,
      style: { layerCount: 0, sourceCount: 0, layerTypes: [] },
      layers: [],
      sources: [],
    },
    truncated: false,
  };

  it('strictly bounds the public immutable revision snapshot', () => {
    const snapshot = {
      revision,
      style: { version: 8, sources: {}, layers: [] },
      semantics: { version: 1 as const, groups: [] },
      validation,
      inspect,
    };

    expect(MAP_REVISION_SNAPSHOT_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(MapRevisionSnapshotOutputSchema.parse(snapshot)).toEqual(snapshot);
    expect(() => MapRevisionSnapshotOutputSchema.parse({ ...snapshot, blobPath: '/private/map' })).toThrow();
    expect(() => MapRevisionSnapshotOutputSchema.parse({
      ...snapshot,
      style: { note: 'x'.repeat(MAP_REVISION_SNAPSHOT_MAX_BYTES) },
    })).toThrow(/Revision snapshot exceeds the response limit/);
  });

  it('requires an explicit, bounded restore request and returns public revision evidence', () => {
    const restore = {
      expectedDraftRevision: 8,
      idempotencyKey: 'restore-run-1-r8-v1',
      confirmReplaceDraft: true as const,
      intentSummary: 'Restore committed revision 1 as a new draft',
    };
    const output = {
      draftRevision: 9,
      restoredRevision: 1,
      styleHash: HASH,
      semanticDigest: DIGEST,
      validationSummary,
    };

    expect(MapRestoreRevisionInputSchema.parse(restore)).toEqual(restore);
    expect(() => MapRestoreRevisionInputSchema.parse({ ...restore, confirmReplaceDraft: false })).toThrow();
    expect(() => MapRestoreRevisionInputSchema.parse({ ...restore, storagePath: '/private/map' })).toThrow();
    expect(MapRestoreRevisionOutputSchema.parse(output)).toEqual(output);
    expect(() => MapRestoreRevisionOutputSchema.parse({ ...output, restoredRevision: -1 })).toThrow();
    expect(() => MapRestoreRevisionOutputSchema.parse({ ...output, blobPath: '/private/map' })).toThrow();
    expectTypeOf<MapRestoreRevisionInput>().toEqualTypeOf<typeof restore>();
    expectTypeOf<typeof output>().toMatchTypeOf<MapRestoreRevisionOutput>();
  });
});

describe('current preview reads', () => {
  it('exposes a strict nullable terminal preview envelope', () => {
    expect(MapCurrentPreviewOutputSchema.parse({ preview: null })).toEqual({ preview: null });
    expect(MapCurrentPreviewOutputSchema.parse({
      preview: {
        status: 'succeeded', previewId: 'preview-1', draftRevision: 3, styleHash: HASH,
        png: pngDescriptor, report: reportDescriptor, validationSummary,
      },
    }).preview?.previewId).toBe('preview-1');
    expect(() => MapCurrentPreviewOutputSchema.parse({ preview: null, projectId: 'attacker-controlled' })).toThrow();
    expect(Object.hasOwn(Contracts, 'MapCurrentPreviewOutputSchema')).toBe(true);
  });
});

describe('browser-safe MapLibre resource URLs', () => {
  const projectId = 'project-a';
  const gateway = `/api/map-design/projects/${projectId}/resources/resource-a`;
  const previewId = 'preview-a';
  const previewGateway = `/api/map-design/source-previews/${previewId}/resources/resource-a`;

  it('accepts only same-project gateway paths and approved custom protocols', () => {
    expect(() => assertMapDesignStyleResourceUrls({
      version: 8,
      glyphs: `${gateway}/fonts/{fontstack}/{range}.pbf`,
      sprite: `${gateway}/sprite`,
      sources: {
        tiles: { type: 'vector', tiles: [`${gateway}/tiles/{z}/{x}/{y}.pbf`] },
        archive: { type: 'vector', url: `pmtiles://${gateway}/archive.pmtiles` },
        data: { type: 'geojson', data: `map-design-resource://${gateway}/data.geojson` },
      },
      layers: [],
    }, projectId)).not.toThrow();
  });

  it('accepts source-preview gateway paths only with an explicit preview scope', () => {
    const style = {
      version: 8,
      glyphs: `${previewGateway}/fonts/{fontstack}/{range}.pbf`,
      sources: {
        archive: { type: 'vector', url: `pmtiles://${previewGateway}/archive.pmtiles` },
        data: { type: 'geojson', data: `${previewGateway}/data.geojson` },
      },
      layers: [],
    };

    expect(() => assertMapDesignStyleResourceUrls(style, previewId, { scope: 'source-previews' }))
      .not.toThrow();
    expect(() => assertMapDesignStyleResourceUrls(style, previewId))
      .toThrow(/same-project resource gateway/i);
  });

  it.each([
    ['source.url', { sources: { bad: { type: 'vector', url: 'https://attacker.test/source.json' } } }],
    ['source.tiles', { sources: { bad: { type: 'vector', tiles: ['https://attacker.test/{z}/{x}/{y}.pbf'] } } }],
    ['source.data', { sources: { bad: { type: 'geojson', data: 'https://attacker.test/data.geojson' } } }],
    ['source.urls', { sources: { bad: { type: 'video', urls: ['https://attacker.test/video.mp4'] } } }],
    ['glyphs', { sources: {}, glyphs: 'https://attacker.test/{fontstack}/{range}.pbf' }],
    ['sprite', { sources: {}, sprite: 'https://attacker.test/sprite' }],
    ['cross-project', { sources: { bad: { type: 'vector', url: '/api/map-design/projects/project-b/resources/x/source.json' } } }],
  ] as const)('rejects native %s fetch bypasses', (_name, fragment) => {
    expect(() => assertMapDesignStyleResourceUrls({ version: 8, layers: [], ...fragment }, projectId))
      .toThrow(/same-project resource gateway/i);
  });

  it('rejects an unsafe transaction before a browser adapter can apply it', () => {
    for (const operation of [
      { op: 'addSource', sourceId: 'bad', source: { type: 'vector', tiles: ['https://attacker.test/tile'] } },
      { op: 'duplicateSource', sourceId: 'source', newSourceId: 'bad', overrides: { url: 'https://attacker.test/source' } },
      { op: 'patchSource', sourceId: 'source', patch: { data: 'https://attacker.test/data' } },
      { op: 'deepMergeSourceDefinition', sourceId: 'source', patch: { urls: ['https://attacker.test/video'] } },
      { op: 'replaceSourceDefinition', sourceId: 'source', source: { url: 'https://attacker.test/source' } },
      { op: 'setGeoJsonData', sourceId: 'source', data: 'https://attacker.test/data' },
      { op: 'addGeoJsonLayer', sourceId: 'source', layerId: 'layer', data: 'https://attacker.test/data' },
      { op: 'setStyleRootProperties', properties: { glyphs: 'https://attacker.test/glyphs' } },
      { op: 'setStyleRootProperties', properties: { sprite: 'https://attacker.test/sprite' } },
      { op: 'setStyleRootProperties', properties: { imports: [{ id: 'bad', url: 'https://attacker.test/style' }] } },
    ]) {
      expect(() => assertMapDesignTransactionResourceUrls({ operations: [operation] }, projectId))
        .toThrow(/same-project resource gateway/i);
    }
  });

  it('does not treat arbitrary metadata fields as MapLibre resource URLs', () => {
    expect(() => assertMapDesignTransactionResourceUrls({
      operations: [{
        op: 'setStyleRootProperties',
        properties: { metadata: { data: 'not-a-resource', url: 'also-not-a-resource' } },
      }],
    }, projectId)).not.toThrow();
  });
});

describe('strict tool inputs', () => {
  it('derives one locale-independent bounded commit intent from public preview identity', () => {
    const projectId = 'p'.repeat(128);
    const previewId = 'v'.repeat(128);
    const intentSummary = mapCommitPreviewIntentSummary(projectId, previewId);
    expect(intentSummary).toBe(`Commit MapDesign preview ${previewId} for project ${projectId}.`);
    expect(MapCommitRevisionInputSchema.parse({
      expectedRevision: 4,
      idempotencyKey: 'mapdesign-preview-commit:stable-intent',
      previewId,
      intentSummary,
    }).intentSummary).toBe(intentSummary);
  });

  it('keeps the commit intent inside its schema at both identifier boundaries', () => {
    const projectId = 'project-middle-'.padEnd(256, 'p');
    const previewId = 'preview-middle-'.padEnd(256, 'v');
    const intentSummary = mapCommitPreviewIntentSummary(projectId, previewId);

    expect(intentSummary).toBe(
      `Commit MapDesign preview ${previewId.slice(0, 64)}…${previewId.slice(-64)} [256]`
      + ` for project ${projectId.slice(0, 64)}…${projectId.slice(-64)} [256].`,
    );
    expect(intentSummary.length).toBeLessThanOrEqual(500);
    expect(MapCommitRevisionInputSchema.parse({
      expectedRevision: 4,
      idempotencyKey: 'mapdesign-preview-commit:boundary',
      previewId,
      intentSummary,
    }).intentSummary).toBe(intentSummary);
  });
  it('rejects unknown fields for empty and nested read inputs', () => {
    expect(MapGetContextInputSchema.parse({})).toEqual({});
    expect(() => MapGetContextInputSchema.parse({ projectId: 'other' })).toThrow();
    expect(() => MapInspectInputSchema.parse({
      target: { kind: 'layer', layerId: 'water', extra: true },
    })).toThrow();
    expect(() => MapInspectInputSchema.parse({ target: { kind: 'root' }, runId: 'run-1' })).toThrow();
  });

  it('requires CAS and idempotency fields for every derived or mutating write', () => {
    for (const [schema, rest] of mutationInputs) {
      expect(() => schema.parse({ expectedRevision: -1, idempotencyKey: IDEMPOTENCY_KEY, ...rest })).toThrow();
      expect(() => schema.parse({ idempotencyKey: IDEMPOTENCY_KEY, ...rest })).toThrow();
      expect(() => schema.parse({ expectedRevision: 0, ...rest })).toThrow();
      expect(() => schema.parse({ expectedRevision: 0, idempotencyKey: 'short', ...rest })).toThrow();
      expect(() => schema.parse({ expectedRevision: 0, idempotencyKey: 'invalid key', ...rest })).toThrow();
      expect(() => schema.parse({ expectedRevision: 0, idempotencyKey: IDEMPOTENCY_KEY, projectId: 'other', ...rest })).toThrow();
      expect(() => schema.parse({ expectedRevision: 0, idempotencyKey: IDEMPOTENCY_KEY, runId: 'other', ...rest })).toThrow();
    }
  });

  it('keeps validation revision-bound without inventing idempotency', () => {
    expect(MapValidateInputSchema.parse({ expectedRevision: 0 })).toEqual({ expectedRevision: 0 });
    expect(() => MapValidateInputSchema.parse({ expectedRevision: -1 })).toThrow();
    expect(() => MapValidateInputSchema.parse({})).toThrow();
    expect(() => MapValidateInputSchema.parse({ expectedRevision: 0, projectId: 'other' })).toThrow();
  });

  it('trims strings while rejecting whitespace-only and out-of-range values', () => {
    expect(MapApplyTransactionInputSchema.parse({
      expectedRevision: 0,
      idempotencyKey: `  ${IDEMPOTENCY_KEY}  `,
      transaction: { operations: [] },
      intentSummary: '  make water blue  ',
    })).toMatchObject({ idempotencyKey: IDEMPOTENCY_KEY, intentSummary: 'make water blue' });
    expect(() => MapApplyTransactionInputSchema.parse({
      expectedRevision: 0,
      idempotencyKey: IDEMPOTENCY_KEY,
      transaction: { operations: [] },
      intentSummary: '   ',
    })).toThrow();
    expect(() => MapInspectInputSchema.parse({ target: { kind: 'layer', layerId: 'x'.repeat(257) } })).toThrow();
    expect(() => MapInspectInputSchema.parse({ target: { kind: 'source-layer', sourceId: 'source', sourceLayer: '  ' } })).toThrow();
  });

  it('defaults bounded reads and enforces viewport numeric limits', () => {
    expect(MapSearchLayersInputSchema.parse({})).toEqual({ limit: 25 });
    expect(MapSearchLayersInputSchema.parse({ query: '  water  ', limit: 100 })).toEqual({ query: 'water', limit: 100 });
    expect(MapSearchLayersInputSchema.parse({ query: '' })).toEqual({ query: '', limit: 25 });
    expect(MapSearchLayersInputSchema.parse({ query: '   ' })).toEqual({ query: '', limit: 25 });
    expect(() => MapSearchLayersInputSchema.parse({ limit: 0 })).toThrow();
    expect(() => MapSearchLayersInputSchema.parse({ limit: 201 })).toThrow();
    expect(() => MapSearchLayersInputSchema.parse({ query: 'x'.repeat(257) })).toThrow();
    expect(() => MapSearchLayersInputSchema.parse({ types: ['fill', 'fill'] })).toThrow();

    const validViewport = {
      center: [-180, 90], zoom: 24, bearing: 180, pitch: 85,
      width: 320, height: 240, pixelRatio: 0.5,
    };
    expect(MapRenderPreviewInputSchema.parse({
      expectedRevision: 0,
      idempotencyKey: IDEMPOTENCY_KEY,
      viewport: validViewport,
    }).viewport).toEqual(validViewport);
    for (const viewport of [
      { ...validViewport, center: [-181, 0] },
      { ...validViewport, center: [0, 91] },
      { ...validViewport, zoom: 25 },
      { ...validViewport, bearing: -181 },
      { ...validViewport, pitch: 86 },
      { ...validViewport, width: 319 },
      { ...validViewport, height: 2049 },
      { ...validViewport, pixelRatio: 2.1 },
    ]) {
      expect(() => MapRenderPreviewInputSchema.parse({
        expectedRevision: 0,
        idempotencyKey: IDEMPOTENCY_KEY,
        viewport,
      })).toThrow();
    }
  });

  it('rejects duplicate semantic group, layer, and source identifiers', () => {
    const group = { id: 'transport', label: 'Transport', role: 'mobility', layerIds: ['roads'], sourceIds: ['base'] };
    expect(SemanticDocumentSchema.parse({ version: 1, groups: [group] }).groups).toHaveLength(1);
    expect(() => SemanticDocumentSchema.parse({ version: 1, groups: [group, group] })).toThrow();
    expect(() => SemanticDocumentSchema.parse({ version: 1, groups: [{ ...group, layerIds: ['roads', 'roads'] }] })).toThrow();
    expect(() => SemanticDocumentSchema.parse({ version: 1, groups: [{ ...group, sourceIds: ['base', 'base'] }] })).toThrow();
    expect(() => SemanticDocumentSchema.parse({ version: 1, groups: [{ ...group, id: '   ' }] })).toThrow();
    expect(() => SemanticDocumentSchema.parse({ version: 1, groups: Array.from({ length: 257 }, (_, i) => ({ ...group, id: `group-${i}` })) })).toThrow();
  });

  it('accepts SDK-style transaction operations while exposing them as unknown', () => {
    const parsed = MapApplyTransactionInputSchema.parse({
      expectedRevision: 0,
      idempotencyKey: IDEMPOTENCY_KEY,
      transaction: {
        operations: [{
          op: 'setLayerProperties',
          layerId: 'background',
          paint: { 'background-color': '#111318' },
        }],
      },
      intentSummary: 'Apply the first dark-theme batch',
    });
    expect(parsed.transaction).toMatchObject({ operations: [{ op: 'setLayerProperties' }] });
    expectTypeOf<MapApplyTransactionInput['transaction']>().toEqualTypeOf<unknown>();
  });
});

describe('strict browser-safe outputs and caps', () => {
  it('parses complete context data without public URLs or tokens', () => {
    const context = {
      lifecycle: 'ready',
      source: { kind: 'style', digest: DIGEST, status: 'available', resourceCount: 2 },
      designSystem: { id: 'default', name: 'Default', digest: DIGEST },
      draftRevision: 2,
      committedRevision: 1,
      styleHash: HASH,
      styleSummary: { layerCount: 1, sourceCount: 1, layerTypes: ['fill'] },
      semanticSummary,
      validationStatus: 'valid',
      previewStatus: 'current',
      cartographicGuidance: ['Keep labels legible'],
    };
    expect(MapGetContextOutputSchema.parse(context)).toEqual(context);
    expect(() => MapGetContextOutputSchema.parse({ ...context, source: { ...context.source, url: 'https://secret.test/token' } })).toThrow();
  });

  it('limits inspect wire payloads to 256 KiB and only read collections expose truncation', () => {
    expect(MAP_INSPECT_MAX_BYTES).toBe(256 * 1024);
    const inspect = {
      target: { kind: 'layer', layerId: 'water' },
      view: { kind: 'layer', layer: layerSummary, semanticGroupIds: ['hydrography'] },
      truncated: false,
    };
    expect(MapInspectOutputSchema.parse(inspect)).toEqual(inspect);
    expect(() => MapInspectOutputSchema.parse({ ...inspect, padding: 'x'.repeat(MAP_INSPECT_MAX_BYTES) })).toThrow();
    expect(() => MapInspectOutputSchema.parse({
      ...inspect,
      view: { kind: 'layer', layer: { ...layerSummary, title: 'x'.repeat(MAP_INSPECT_MAX_BYTES) }, semanticGroupIds: [] },
    })).toThrow();
    expect(MapSearchLayersOutputSchema.parse({ layers: [layerSummary], returned: 1, truncated: true }).truncated).toBe(true);

    const apply = {
      draftRevision: 1,
      styleHash: HASH,
      changedLayers: ['water'],
      changedSources: [],
      diff: [],
      warnings: [],
      validationSummary,
    };
    expect(() => MapApplyTransactionOutputSchema.parse({ ...apply, truncated: true })).toThrow();
  });

  it('models the public engine diff as strict structured entries', () => {
    const diff = [{
      op: 'replace',
      path: '/layers/0/paint/fill-color',
      before: '#000000',
      after: '#0000ff',
      target: { kind: 'layer', id: 'water' },
    }];
    const output = {
      draftRevision: 1,
      styleHash: HASH,
      changedLayers: ['water'],
      changedSources: [],
      diff,
      warnings: [],
      validationSummary,
    };

    expect(MapApplyTransactionOutputSchema.parse(output).diff).toEqual(diff);
    expect(() => MapApplyTransactionOutputSchema.parse({ ...output, diff: '[]' })).toThrow();
    expect(() => MapApplyTransactionOutputSchema.parse({
      ...output,
      diff: [{ ...diff[0]!, extra: true }],
    })).toThrow();
    expect(() => MapApplyTransactionOutputSchema.parse({
      ...output,
      diff: [{ ...diff[0]!, target: { ...diff[0]!.target, extra: true } }],
    })).toThrow();
    expect(() => MapApplyTransactionOutputSchema.parse({
      ...output,
      diff: [{ ...diff[0]!, path: 'layers/0' }],
    })).toThrow();
    expect(() => MapApplyTransactionOutputSchema.parse({
      ...output,
      diff: [{ ...diff[0]!, path: '/layers/~2bad' }],
    })).toThrow();
    expect(MapApplyTransactionOutputSchema.parse({
      ...output,
      diff: [{ op: 'add', path: '', after: null, target: { kind: 'style' } }],
    }).diff).toHaveLength(1);
    expect(MapApplyTransactionOutputSchema.parse({
      ...output,
      diff: [{ op: 'move', path: '/layers/~0escaped~1id', from: '/layers/0', target: { kind: 'style' } }],
    }).diff).toHaveLength(1);
  });

  it('exports local structured diff schemas and inferred types', () => {
    expect(Contracts.MapStyleDiffTargetSchema).toBeDefined();
    expect(Contracts.MapStyleDiffEntrySchema).toBeDefined();
    expectTypeOf<MapStyleDiffTarget>().toMatchTypeOf<{ kind: string }>();
    expectTypeOf<MapStyleDiffEntry>().toMatchTypeOf<{ op: string; path: string }>();
  });

  it('caps structured diff bytes and validates unique changed identifiers', () => {
    expect(MAP_DIFF_MAX_BYTES).toBe(1024 * 1024);
    const output = {
      draftRevision: 1,
      styleHash: HASH,
      changedLayers: ['water'],
      changedSources: ['basemap'],
      diff: [{
        op: 'add',
        path: '/metadata/note',
        after: 'x'.repeat(MAP_DIFF_MAX_BYTES),
        target: { kind: 'style' },
      }],
      warnings: [],
      validationSummary,
    };
    expect(() => MapApplyTransactionOutputSchema.parse(output)).toThrow();
    expect(() => MapApplyTransactionOutputSchema.parse({ ...output, changedLayers: ['water', 'water'] })).toThrow();
    expect(() => MapApplyTransactionOutputSchema.parse({ ...output, changedSources: ['basemap', 'basemap'] })).toThrow();
  });

  it('correlates inspect targets with the returned view and identifiers', () => {
    const root = {
      target: { kind: 'root' },
      view: {
        kind: 'root',
        style: { layerCount: 1, sourceCount: 1, layerTypes: ['fill'] },
        layers: [layerSummary],
        sources: [sourceSummary],
      },
      truncated: false,
    };
    const layer = {
      target: { kind: 'layer', layerId: 'water' },
      view: { kind: 'layer', layer: layerSummary, semanticGroupIds: [] },
      truncated: false,
    };
    const source = {
      target: { kind: 'source', sourceId: 'basemap' },
      view: { kind: 'source', source: sourceSummary },
      truncated: false,
    };
    const sourceLayer = {
      target: { kind: 'source-layer', sourceId: 'basemap', sourceLayer: 'water' },
      view: { kind: 'source-layer', sourceId: 'basemap', sourceLayer: 'water', layerIds: ['water'] },
      truncated: false,
    };

    for (const matched of [root, layer, source, sourceLayer]) {
      expect(MapInspectOutputSchema.parse(matched)).toEqual(matched);
    }
    expect(() => MapInspectOutputSchema.parse({ ...layer, view: source.view })).toThrow();
    expect(() => MapInspectOutputSchema.parse({
      ...layer,
      view: { ...layer.view, layer: { ...layerSummary, id: 'land' } },
    })).toThrow();
    expect(() => MapInspectOutputSchema.parse({
      ...source,
      view: { kind: 'source', source: { ...sourceSummary, id: 'other' } },
    })).toThrow();
    expect(() => MapInspectOutputSchema.parse({
      ...sourceLayer,
      view: { ...sourceLayer.view, sourceId: 'other' },
    })).toThrow();
    expect(() => MapInspectOutputSchema.parse({
      ...sourceLayer,
      view: { ...sourceLayer.view, sourceLayer: 'land' },
    })).toThrow();
  });

  it('ties terminal preview status to PNG presence', () => {
    const evidenceBase = {
      previewId: 'preview-1',
      draftRevision: 3,
      styleHash: HASH,
      report: reportDescriptor,
      validationSummary,
      createdAt: TIMESTAMP,
    };
    const outputBase = {
      previewId: 'preview-1',
      draftRevision: 3,
      styleHash: HASH,
      report: reportDescriptor,
      validationSummary,
    };

    expect(MapPreviewEvidenceSchema.parse({ ...evidenceBase, status: 'succeeded', png: pngDescriptor }).status).toBe('succeeded');
    expect(MapPreviewEvidenceSchema.parse({ ...evidenceBase, status: 'failed', png: null }).status).toBe('failed');
    expect(() => MapPreviewEvidenceSchema.parse({ ...evidenceBase, status: 'succeeded', png: null })).toThrow();
    expect(() => MapPreviewEvidenceSchema.parse({ ...evidenceBase, status: 'failed', png: pngDescriptor })).toThrow();

    expect(MapRenderPreviewOutputSchema.parse({ ...outputBase, status: 'succeeded', png: pngDescriptor }).status).toBe('succeeded');
    expect(MapRenderPreviewOutputSchema.parse({ ...outputBase, status: 'failed', png: null }).status).toBe('failed');
    expect(() => MapRenderPreviewOutputSchema.parse({ ...outputBase, status: 'succeeded', png: null })).toThrow();
    expect(() => MapRenderPreviewOutputSchema.parse({ ...outputBase, status: 'failed', png: pngDescriptor })).toThrow();
  });

  it('correlates validation status with error counts', () => {
    const summary = {
      errors: 0,
      warnings: 0,
      infos: 0,
      totalFindings: 0,
      returnedFindings: 0,
      omittedFindings: 0,
    };
    expect(MapValidationSummarySchema.parse({ ...summary, status: 'valid' }).status).toBe('valid');
    expect(MapValidationSummarySchema.parse({
      ...summary,
      status: 'valid',
      warnings: 1,
      totalFindings: 1,
      returnedFindings: 1,
    }).status).toBe('valid');
    expect(MapValidationSummarySchema.parse({
      ...summary,
      status: 'invalid',
      errors: 1,
      totalFindings: 1,
      returnedFindings: 1,
    }).status).toBe('invalid');
    expect(MapValidationSummarySchema.parse({ ...summary, status: 'unknown' }).status).toBe('unknown');

    expect(() => MapValidationSummarySchema.parse({
      ...summary,
      status: 'valid',
      errors: 1,
      totalFindings: 1,
      returnedFindings: 1,
    })).toThrow();
    expect(() => MapValidationSummarySchema.parse({ ...summary, status: 'invalid' })).toThrow();
    expect(() => MapValidationSummarySchema.parse({
      ...summary,
      status: 'unknown',
      warnings: 1,
      totalFindings: 1,
      returnedFindings: 1,
    })).toThrow();
  });

  it('caps validation findings at 500 and carries total and omitted counts', () => {
    expect(MAP_VALIDATION_FINDINGS_MAX).toBe(500);
    const finding = { severity: 'warning', code: 'LABEL_DENSITY', message: 'Dense labels', scope: { kind: 'layer', id: 'labels' } };
    const findings = Array.from({ length: 500 }, () => finding);
    const output = {
      draftRevision: 2,
      styleHash: HASH,
      validationDigest: DIGEST,
      summary: { status: 'invalid', errors: 1, warnings: 500, infos: 0, totalFindings: 501, returnedFindings: 500, omittedFindings: 1 },
      findings,
    };
    expect(MapValidateOutputSchema.parse(output).findings).toHaveLength(500);
    expect(() => MapValidateOutputSchema.parse({ ...output, findings: [...findings, finding] })).toThrow();
    expect(() => MapValidateOutputSchema.parse({ ...output, summary: { ...output.summary, omittedFindings: 0 } })).toThrow();
  });

  it('caps public error details and keeps envelope metadata strict', () => {
    expect(MAP_ERROR_DETAILS_MAX_BYTES).toBe(64 * 1024);
    const envelope = MapToolEnvelopeSchema(MapGetContextOutputSchema);
    const meta = { requestId: 'request-1', projectId: 'project-1', runId: 'run-1', draftRevision: 0 };
    expect(envelope.parse({ ok: false, error: { code: 'PREVIEW_STALE', message: 'Preview is stale', retryable: true, details: 'x'.repeat(MAP_ERROR_DETAILS_MAX_BYTES - 2) }, meta }).ok).toBe(false);
    expect(() => envelope.parse({ ok: false, error: { code: 'INTERNAL', message: 'failed', retryable: false, details: 'x'.repeat(MAP_ERROR_DETAILS_MAX_BYTES) }, meta })).toThrow();
    expect(() => envelope.parse({ ok: true, data: MapGetContextOutputSchema.parse({
      lifecycle: 'ready', source: { kind: 'style', digest: DIGEST, status: 'available', resourceCount: 0 },
      designSystem: { id: 'default', name: 'Default', digest: DIGEST }, draftRevision: 0, committedRevision: null,
      styleHash: HASH, styleSummary: { layerCount: 0, sourceCount: 0, layerTypes: [] }, semanticSummary,
      validationStatus: 'unknown', previewStatus: 'missing', cartographicGuidance: [],
    }), meta: { ...meta, token: 'secret' } })).toThrow();
  });

  it('parses complete semantic, preview, commit, and discard outputs without truncation fields', () => {
    expect(MapUpdateSemanticsOutputSchema.parse({ draftRevision: 3, semanticDigest: DIGEST, semanticSummary, validationSummary }).draftRevision).toBe(3);
    expect(MapRenderPreviewOutputSchema.parse({
      previewId: 'preview-1', draftRevision: 3, styleHash: HASH, status: 'succeeded',
      png: pngDescriptor,
      report: reportDescriptor, validationSummary,
    }).status).toBe('succeeded');
    expect(MapCommitRevisionOutputSchema.parse({ revision: 2, draftRevision: 3, styleHash: HASH, attestationDigest: DIGEST, committedAt: TIMESTAMP }).revision).toBe(2);
    expect(MapDiscardDraftOutputSchema.parse({ draftRevision: 4, restoredCommittedRevision: 2, styleHash: HASH, semanticDigest: DIGEST, validationSummary }).draftRevision).toBe(4);
    for (const [schema, value] of [
      [MapUpdateSemanticsOutputSchema, { draftRevision: 3, semanticDigest: DIGEST, semanticSummary, validationSummary, truncated: true }],
      [MapRenderPreviewOutputSchema, { previewId: 'preview-1', draftRevision: 3, styleHash: HASH, status: 'failed', png: null, report: { digest: DIGEST, mediaType: 'application/json', byteLength: 1 }, validationSummary, truncated: true }],
      [MapCommitRevisionOutputSchema, { revision: 2, draftRevision: 3, styleHash: HASH, attestationDigest: DIGEST, committedAt: TIMESTAMP, truncated: true }],
    ] as const) {
      expect(() => schema.parse(value)).toThrow();
    }
  });

  it('rejects unknown keys in representative nested output objects', () => {
    expect(() => MapSearchLayersOutputSchema.parse({ layers: [{ ...layerSummary, secret: true }], returned: 1, truncated: false })).toThrow();
    expect(() => MapInspectOutputSchema.parse({
      target: { kind: 'source', sourceId: 'basemap' },
      view: { kind: 'source', source: { ...sourceSummary, rawUrl: 'https://secret.test' } },
      truncated: false,
    })).toThrow();
  });
});

describe('Studio events', () => {
  it('requires both draft revision and style hash on every event payload', () => {
    const events = [
      { type: 'draft.updated', occurredAt: TIMESTAMP, payload: { draftRevision: 2, styleHash: HASH, transaction: { operations: [] }, changedLayers: [], changedSources: [] } },
      { type: 'validation.updated', occurredAt: TIMESTAMP, payload: { draftRevision: 2, styleHash: HASH, validationDigest: DIGEST, summary: validationSummary } },
      { type: 'preview.updated', occurredAt: TIMESTAMP, payload: { draftRevision: 2, styleHash: HASH, previewId: 'preview-1', status: 'succeeded' } },
      { type: 'revision.committed', occurredAt: TIMESTAMP, payload: { draftRevision: 2, styleHash: HASH, revision: 1, committedAt: TIMESTAMP } },
      { type: 'draft.discarded', occurredAt: TIMESTAMP, payload: { draftRevision: 3, styleHash: HASH, restoredCommittedRevision: 1 } },
    ];
    for (const event of events) {
      expect(MapStudioEventSchema.parse(event)).toEqual(event);
      const { draftRevision: _revision, ...withoutRevision } = event.payload;
      expect(() => MapStudioEventSchema.parse({ ...event, payload: withoutRevision })).toThrow();
      const { styleHash: _hash, ...withoutHash } = event.payload;
      expect(() => MapStudioEventSchema.parse({ ...event, payload: withoutHash })).toThrow();
    }
  });

  it('accepts the complete strict project lifecycle event vocabulary', () => {
    const events = [
      { type: 'project.lifecycle.updated', occurredAt: TIMESTAMP, payload: { lifecycle: 'ready', failure: null } },
      { type: 'draft.reloaded', occurredAt: TIMESTAMP, payload: { draftRevision: 2, styleHash: HASH, semanticDigest: DIGEST, sourceDigest: DIGEST, reason: 'manual' } },
      { type: 'preview.requested', occurredAt: TIMESTAMP, payload: { draftRevision: 2, styleHash: HASH, previewId: 'preview-1', viewport: DEFAULT_MAP_PREVIEW_VIEWPORT, expiresAt: TIMESTAMP } },
      { type: 'project.failed', occurredAt: TIMESTAMP, payload: { code: 'IMPORT_FAILED', message: 'Import failed safely.' } },
    ];
    for (const event of events) {
      expect(MapStudioEventSchema.parse(event)).toEqual(event);
      expect(() => MapStudioEventSchema.parse({ ...event, payload: { ...event.payload, unexpected: true } })).toThrow();
    }
  });

  it('emits a strict public event when a historical revision becomes the new draft', () => {
    const event = {
      type: 'draft.restored' as const,
      occurredAt: TIMESTAMP,
      payload: { draftRevision: 9, restoredRevision: 1, styleHash: HASH },
    };

    expect(MapStudioEventSchema.parse(event)).toEqual(expect.objectContaining({ type: 'draft.restored' }));
    expect(() => MapStudioEventSchema.parse({ ...event, payload: { ...event.payload, blobPath: '/private/map' } })).toThrow();
  });
});

describe('project import and Studio transport contracts', () => {
  const source = { url: 'https://maps.example.test/style.json' };

  it('strictly validates source preflight and atomic import inputs', () => {
    expect(MapSourceReferenceSchema.parse(source)).toEqual(source);
    expect(MapSourcePreflightInputSchema.parse({ source })).toEqual({ source });
    const preview = {
      previewId: 'preview-1',
      styleUrl: '/api/map-design/source-previews/preview-1/style',
      expiresAt: TIMESTAMP,
    };
    expect(MapSourcePreflightOutputSchema.parse({
      kind: 'style', requestedHost: 'maps.example.test', finalHost: 'cdn.example.test', redirectCount: 1,
      reachability: 'reachable', security: { scheme: 'https', allResolvedAddressesPublic: true, credentialsPresent: false },
      mediaType: 'application/json', byteLength: null, preview,
    }).preview).toEqual(preview);
    expect(MapProjectImportInputSchema.parse({ source, designRequirement: '  Calm walking map  ', idempotencyKey: 'import-123' }).designRequirement).toBe('Calm walking map');
    expect(MapProjectRetryInputSchema.parse({ idempotencyKey: 'import-123' })).toEqual({ idempotencyKey: 'import-123' });
    expect(() => MapSourceReferenceSchema.parse({ url: 'not-a-url' })).toThrow();
    expect(() => MapSourcePreflightOutputSchema.parse({ kind: 'style', requestedHost: 'maps', finalHost: 'maps', redirectCount: 6, reachability: 'reachable', security: { scheme: 'https', allResolvedAddressesPublic: true, credentialsPresent: false }, mediaType: 'application/json', byteLength: null, preview })).toThrow();
    for (const invalidPreview of [
      { ...preview, styleUrl: 'https://maps.example.test/style.json' },
      { ...preview, styleUrl: '/api/map-design/projects/preview-1/style' },
      { ...preview, styleUrl: '/api/map-design/source-previews/preview-2/style' },
    ]) {
      expect(() => MapSourcePreflightOutputSchema.parse({
        kind: 'style', requestedHost: 'maps', finalHost: 'maps', redirectCount: 0,
        reachability: 'reachable', security: { scheme: 'https', allResolvedAddressesPublic: true, credentialsPresent: false },
        mediaType: 'application/json', byteLength: null, preview: invalidPreview,
      })).toThrow();
    }
    expect(() => MapProjectImportInputSchema.parse({ source, designRequirement: ' ', idempotencyKey: 'import-123' })).toThrow();
  });

  it('pins the first MapDesign rules package and strict project list shape', () => {
    const summary = {
      projectId: 'project-1', title: 'Walking map', lifecycle: 'ready' as const, sourceKind: 'style' as const,
      draftRevision: 3, committedRevision: 2, validationStatus: 'valid' as const, updatedAt: TIMESTAMP,
    };
    expect(DEFAULT_MAP_DESIGN_SYSTEM_ID).toBe('quiet-atlas');
    expect(MapDesignProjectSummarySchema.parse(summary)).toEqual(summary);
    expect(MapDesignProjectListOutputSchema.parse({ projects: [summary] })).toEqual({ projects: [summary] });
    expect(() => MapDesignProjectListOutputSchema.parse({ projects: [{ ...summary, url: source.url }] })).toThrow();
  });

  it('keeps runtime selection and replay envelopes browser-safe and strict', () => {
    expect(MapDesignRuntimeSelectionSchema.parse({ agentId: 'agent-1', model: '  map-model  ' })).toEqual({ agentId: 'agent-1', model: 'map-model' });
    const event = { type: 'project.lifecycle.updated', occurredAt: TIMESTAMP, payload: { lifecycle: 'ready', failure: null } } as const;
    const record = { sequence: 4, event };
    expect(MapStudioEventRecordSchema.parse(record)).toEqual(record);
    expect(MapStudioEventReplaySchema.parse({ events: [record], oldestAvailableSequence: 3, latestSequence: 4, gap: false })).toMatchObject({ events: [record], gap: false });
    expect(() => MapDesignRuntimeSelectionSchema.parse({ agentId: 'agent-1', extra: true })).toThrow();
    expect(() => MapStudioEventReplaySchema.parse({ events: [record], oldestAvailableSequence: 3, latestSequence: 4, gap: false, runId: 'run-1' })).toThrow();
  });
});

describe('atomic MapDesign project creation contracts', () => {
  const createInput = {
    projectId: 'map-123',
    title: 'Transit hierarchy',
    source: { url: 'https://example.com/style.json' },
    designRequirement: 'Clarify transit lines and station hierarchy.',
    runtime: {
      agentId: 'claude',
      model: 'claude-sonnet',
      reasoning: 'medium',
    },
    workingDirectory: {
      path: '/workspace/maps',
      token: 'trusted-picker-token',
    },
    idempotencyKey: 'map-create:map-123',
  };

  const project = {
    projectId: 'map-123',
    lifecycle: 'ready' as const,
    sourceKind: 'style' as const,
    designSystemId: 'quiet-atlas',
    designSystemDigest: DIGEST,
    draftRevision: 1,
    committedRevision: null,
    failure: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };

  it('accepts a complete strict project creation input', () => {
    expect(MapDesignProjectCreateInputSchema.parse(createInput)).toEqual(createInput);
    expect(MapDesignProjectCreateInputSchema.parse({
      ...createInput,
      workingDirectory: undefined,
    })).toEqual({ ...createInput, workingDirectory: undefined });
  });

  it('rejects incomplete, generic, and malformed project creation inputs', () => {
    expect(() => MapDesignProjectCreateInputSchema.parse({
      ...createInput,
      runtime: undefined,
    })).toThrow();
    expect(() => MapDesignProjectCreateInputSchema.parse({
      ...createInput,
      designRequirement: ' ',
    })).toThrow();
    expect(() => MapDesignProjectCreateInputSchema.parse({
      ...createInput,
      kind: 'prototype',
    })).toThrow();
    expect(() => MapDesignProjectCreateInputSchema.parse({
      ...createInput,
      designSystemId: 'quiet-atlas',
    })).toThrow();
    expect(() => MapDesignProjectCreateInputSchema.parse({
      ...createInput,
      workspaceId: 'team-1',
    })).toThrow();
    expect(() => MapDesignProjectCreateInputSchema.parse({
      ...createInput,
      workingDirectory: { path: '/workspace/maps', token: 'short' },
    })).toThrow();
    expect(() => MapDesignProjectCreateInputSchema.parse({
      ...createInput,
      workingDirectory: { ...createInput.workingDirectory, workspaceId: 'team-1' },
    })).toThrow();
  });

  it('enforces the approved runtime limits', () => {
    expect(MapDesignRuntimeSelectionSchema.parse({
      agentId: 'claude',
      model: 'm'.repeat(256),
      reasoning: 'r'.repeat(64),
      serviceTier: 's'.repeat(64),
    })).toBeTruthy();
    expect(() => MapDesignRuntimeSelectionSchema.parse({
      agentId: 'claude',
      model: 'm'.repeat(257),
    })).toThrow();
    expect(() => MapDesignRuntimeSelectionSchema.parse({
      agentId: 'claude',
      reasoning: 'r'.repeat(65),
    })).toThrow();
    expect(() => MapDesignRuntimeSelectionSchema.parse({
      agentId: 'claude',
      serviceTier: 's'.repeat(65),
    })).toThrow();
  });

  it('returns a strict project aggregate with the persisted runtime', () => {
    const output = {
      project,
      conversationId: 'conversation-123',
      title: 'Transit atlas',
      runtime: { agentId: 'claude', model: 'sonnet', reasoning: 'high', serviceTier: 'priority' },
    };
    expect(MapDesignProjectCreateOutputSchema.parse(output)).toEqual(output);
    expect(MapDesignProjectCreateOutputSchema.parse({ ...output, conversationId: null }))
      .toEqual({ ...output, conversationId: null });
    expect(() => MapDesignProjectCreateOutputSchema.parse({
      ...output,
      project: { ...project, kind: 'prototype' },
    })).toThrow();
    expect(() => MapDesignProjectCreateOutputSchema.parse({
      ...output,
      workspaceId: 'team-1',
    })).toThrow();
    expect(() => MapDesignProjectCreateOutputSchema.parse({
      project,
      conversationId: 'conversation-123',
      title: 'Transit atlas',
    })).toThrow();
  });
});


describe('preview fulfillment and tool JSON Schema contracts', () => {
  const report = { previewId: 'preview-1', validationDigest: DIGEST };
  const fulfill = {
    previewId: 'preview-1', draftRevision: 3, styleHash: HASH, report, status: 'succeeded' as const, pngBase64: 'aGVsbG8=',
  };

  it('uses the canonical preview viewport and correlates fulfillment report identity', () => {
    expect(DEFAULT_MAP_PREVIEW_VIEWPORT).toEqual({ center: [0, 0], zoom: 1, bearing: 0, pitch: 0, width: 1280, height: 720, pixelRatio: 1 });
    expect(MapPreviewRuntimeReportSchema.parse(report)).toEqual(report);
    expect(MapPreviewFulfillRequestSchema.parse(fulfill)).toEqual(fulfill);
    expect(MapPreviewFulfillRequestSchema.parse({ ...fulfill, status: 'failed', pngBase64: null })).toMatchObject({ status: 'failed' });
    expect(() => MapPreviewFulfillRequestSchema.parse({ ...fulfill, report: { ...report, previewId: 'preview-2' } })).toThrow(/identity/i);
    expect(() => MapPreviewFulfillRequestSchema.parse({ ...fulfill, pngBase64: 'a=b' })).toThrow();
  });

  it('exports deterministic strict JSON Schemas for every tool envelope', () => {
    const inputNames = Object.keys(MapToolJsonInputSchemas).sort();
    const outputNames = Object.keys(MapToolJsonOutputSchemas).sort();
    expect(inputNames).toEqual([...MAP_TOOL_NAMES].sort());
    expect(outputNames).toEqual(inputNames);
    for (const schema of Object.values(MapToolJsonInputSchemas)) {
      expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    for (const schema of Object.values(MapToolJsonOutputSchemas)) {
      expect(schema).toMatchObject({ oneOf: expect.any(Array) });
      expect((schema as { oneOf: unknown[] }).oneOf).toHaveLength(2);
      for (const branch of (schema as { oneOf: Array<Record<string, unknown>> }).oneOf) {
        expect(branch).toMatchObject({ type: 'object', additionalProperties: false });
      }
    }
    expect(JSON.stringify(MapToolJsonInputSchemas)).toBe(JSON.stringify(MapToolJsonInputSchemas));
    expect(JSON.stringify(MapToolJsonOutputSchemas)).toBe(JSON.stringify(MapToolJsonOutputSchemas));
  });
});
