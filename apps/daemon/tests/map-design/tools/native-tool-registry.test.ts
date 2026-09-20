import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { SafeToolSummarySchema } from '@mapseekai/contracts';
import { MAP_TOOL_NAMES, type MapToolName } from '@mapseekai/map-design-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256CanonicalJson } from 'maplibre-style-tools/bridge';
import { applyStyleTransactionInputSchema } from 'maplibre-style-tools/capabilities';
import { createStyleToolError, type StyleDocument } from 'maplibre-style-tools/core';

import { MapDraftError } from '../../../src/map-design/application/errors.js';
import { createMapStyleSdk } from '../../../src/map-design/sdk/style-sdk.js';
import { MapPreviewRequestServiceImpl } from '../../../src/map-design/application/preview-request-service.js';
import type { MapTrustedRunStore } from '../../../src/map-design/application/revision-service.js';
import { createMapDesignNativeToolRegistry } from '../../../src/map-design/tools/native-tool-registry.js';
import type { MapNativeToolCallContext } from '../../../src/map-design/tools/tool-context.js';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import type { LoadedMapDesignSystem } from '../../../src/map-design/validation/design-system-loader.js';
import {
  createMapDesignProjectServices,
  type MapDesignProjectServices,
} from '../../../src/server-context.js';

const PROJECT_ID = 'native-tools-project';
const NOW = '2026-08-31T00:00:00.000Z';
const DESIGN_SYSTEM: LoadedMapDesignSystem = {
  id: 'quiet-walking',
  digest: 'd'.repeat(64),
  humanGuidance: '',
  rules: {
    version: 1,
    requiredSemanticRoles: [],
    maxLabelLayerCount: 10,
    minimumContrastRatio: 1,
  },
};
const STYLE: StyleDocument = {
  version: 8,
  sources: {
    base: {
      type: 'vector',
      tiles: [`/api/map-design/projects/${PROJECT_ID}/resources/base/tiles/{z}/{x}/{y}.pbf`],
    },
  },
  layers: [
    {
      id: 'roads',
      type: 'line',
      source: 'base',
      'source-layer': 'roads',
      paint: { 'line-color': '#111111', 'line-width': 2 },
    },
    {
      id: 'parks',
      type: 'fill',
      source: 'base',
      'source-layer': 'parks',
      paint: { 'fill-color': '#77aa77' },
    },
  ],
};
const SEMANTICS = {
  version: 1 as const,
  groups: [
    { id: 'roads', label: 'Roads', role: 'roads', layerIds: ['roads'], sourceIds: ['base'] },
    { id: 'parks', label: 'Parks', role: 'parks', layerIds: ['parks'], sourceIds: ['base'] },
  ],
};

const runStore: MapTrustedRunStore = {
  get: (runId) => ['run-1', 'run-a', 'run-b'].includes(runId)
    ? {
        runId,
        projectId: PROJECT_ID,
        runtime: { id: 'codex', version: '1.0.0', adapter: 'native' },
        model: { id: 'gpt-5', provider: 'openai' },
      }
    : null,
};

function contextAtRevision(revision: number, runId = 'run-1'): MapNativeToolCallContext {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('invalid test revision');
  return {
    runId,
    projectId: PROJECT_ID,
    conversationId: 'conversation-1',
    toolUseId: 'call-1',
    signal: new AbortController().signal,
  };
}

function applyInput(expectedRevision: number, color = '#335577') {
  return {
    expectedRevision,
    idempotencyKey: `native-apply-${expectedRevision}`,
    transaction: {
      operations: [
        { op: 'setLayerProperties', layerId: 'roads', paint: { 'line-color': color } },
      ],
    },
    intentSummary: 'Update the road color',
  };
}

describe('MapDesign native tool registry', () => {
  let tempDir: string;
  let database: Database.Database;
  let services: MapDesignProjectServices;

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'map-design-native-tools-'));
    database = openMapDesignDatabase(tempDir);
    services = createMapDesignProjectServices({
      db: database,
      dataRoot: tempDir,
      projectRoot: tempDir,
      designSystem: DESIGN_SYSTEM,
      runStore,
    });

    const [styleBlob, semanticBlob, manifestBlob] = await Promise.all([
      services.blobStore.putJson(PROJECT_ID, 'styles', STYLE),
      services.blobStore.putJson(PROJECT_ID, 'semantics', SEMANTICS),
      services.blobStore.putJson(PROJECT_ID, 'sources', {
        kind: 'style',
        digest: 'a'.repeat(64),
        mediaType: 'application/json',
        byteLength: 1,
        resourceCount: 1,
        capturedAt: NOW,
      }),
    ]);
    database.prepare('INSERT INTO projects (id, title, runtime_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(PROJECT_ID, 'Native tools', '{}', NOW, NOW);
    database.prepare(`INSERT INTO map_design_projects (
      project_id, lifecycle_state, source_kind, source_manifest_digest,
      design_system_id, design_system_digest, draft_revision,
      draft_style_digest, draft_style_hash, draft_semantic_digest, created_at, updated_at
    ) VALUES (?, 'ready', 'style', ?, ?, ?, 3, ?, ?, ?, ?, ?)`)
      .run(
        PROJECT_ID,
        manifestBlob.digest,
        DESIGN_SYSTEM.id,
        DESIGN_SYSTEM.digest,
        styleBlob.digest,
        await sha256CanonicalJson(STYLE),
        semanticBlob.digest,
        NOW,
        NOW,
      );
  });

  afterEach(() => {
    services.previewService.shutdown();
    database.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exposes all nine existing schemas in stable contract order', () => {
    expect(services.nativeToolRegistry.definitions().map((definition) => definition.name))
      .toEqual(MAP_TOOL_NAMES);
    expect(services.nativeToolRegistry.definitions().every((definition) => (
      definition.description.length > 0
      && definition.inputSchema.type === 'object'
    ))).toBe(true);
  });

  it('inspects a real SDK style fixture through the native registry', async () => {
    const result = await services.nativeToolRegistry.call(
      contextAtRevision(3),
      'map_inspect',
      { target: { kind: 'layer', layerId: 'roads' } },
    );

    expect(result).toEqual({
      ok: true,
      toolUseId: 'call-1',
      summary: { targetKind: 'layer', returned: 1, truncated: false },
      modelContent: JSON.stringify({
        target: { kind: 'layer', layerId: 'roads' },
        view: {
          kind: 'layer',
          layer: {
            id: 'roads',
            type: 'line',
            sourceId: 'base',
            sourceLayer: 'roads',
            filter: null,
            paint: { 'line-color': '#111111', 'line-width': 2 },
            layout: {},
          },
          semanticGroupIds: ['roads'],
        },
        truncated: false,
      }),
    });
  });

  it('returns bounded layer records to the model while keeping the public summary aggregate-only', async () => {
    const result = await services.nativeToolRegistry.call(
      contextAtRevision(3),
      'map_search_layers',
      { types: ['line', 'fill'], limit: 2 },
    );

    expect(result).toEqual({
      ok: true,
      toolUseId: 'call-1',
      summary: { returned: 2, truncated: false },
      modelContent: JSON.stringify({
        layers: [
          { id: 'roads', type: 'line', sourceId: 'base', sourceLayer: 'roads' },
          { id: 'parks', type: 'fill', sourceId: 'base', sourceLayer: 'parks' },
        ],
        returned: 2,
        truncated: false,
      }),
    });
  });

  it('preflights with the real SDK and persists one authorized transaction', async () => {
    const result = await services.nativeToolRegistry.call(
      contextAtRevision(3),
      'map_apply_transaction',
      applyInput(3),
    );

    expect(result).toEqual({
      ok: true,
      toolUseId: 'call-1',
      summary: {
        operationCount: 1,
        changedLayerCount: 1,
        changedSourceCount: 0,
        warningCount: 0,
        revision: 4,
      },
    });
    expect(services.repository.get(PROJECT_ID)?.draftRevision).toBe(4);
  });

  it('projects provider-enriched transaction envelopes onto SDK-owned fields before persistence', async () => {
    const input = applyInput(3, '#111318');
    const result = await services.nativeToolRegistry.call(
      contextAtRevision(3),
      'map_apply_transaction',
      {
        ...input,
        transaction: {
          id: 'provider-dark-theme-001',
          expectedRevision: 3,
          ...input.transaction,
          validate: true,
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      summary: { operationCount: 1, changedLayerCount: 1, revision: 4 },
    });
    const project = services.repository.get(PROJECT_ID)!;
    const style = await services.blobStore.getJson<StyleDocument>(PROJECT_ID, 'styles', project.draftStyleDigest!);
    expect(project.draftRevision).toBe(4);
    expect(style.layers[0]).toMatchObject({ paint: { 'line-color': '#111318' } });
  });

  it('scopes native write idempotency to the authorized run while preserving replay and conflicts', async () => {
    const publicKey = 'shared-dark-theme-key';
    const runAInput = { ...applyInput(3, '#111318'), idempotencyKey: publicKey };

    const first = await services.nativeToolRegistry.call(
      contextAtRevision(3, 'run-a'),
      'map_apply_transaction',
      runAInput,
    );
    const replay = await services.nativeToolRegistry.call(
      contextAtRevision(3, 'run-a'),
      'map_apply_transaction',
      runAInput,
    );
    const conflict = await services.nativeToolRegistry.call(
      contextAtRevision(3, 'run-a'),
      'map_apply_transaction',
      { ...runAInput, transaction: applyInput(3, '#222222').transaction },
    );

    expect(first).toMatchObject({ ok: true, summary: { revision: 4 } });
    expect(replay).toEqual(first);
    expect(conflict).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });

    const transition = await services.nativeToolRegistry.call(
      contextAtRevision(4, 'run-a'),
      'map_apply_transaction',
      { ...applyInput(4, '#f8f4f0'), idempotencyKey: 'run-a-transition-key' },
    );
    const runB = await services.nativeToolRegistry.call(
      contextAtRevision(5, 'run-b'),
      'map_apply_transaction',
      { ...applyInput(5, '#334455'), idempotencyKey: publicKey },
    );

    expect(transition).toMatchObject({ ok: true, summary: { revision: 5 } });
    expect(runB).toMatchObject({ ok: true, summary: { revision: 6 } });
    const project = services.repository.get(PROJECT_ID)!;
    const style = await services.blobStore.getJson<StyleDocument>(PROJECT_ID, 'styles', project.draftStyleDigest!);
    expect(project.draftRevision).toBe(6);
    expect(style.layers[0]).toMatchObject({ paint: { 'line-color': '#334455' } });
    const rows = database.prepare(`SELECT idempotency_key AS idempotencyKey
      FROM map_design_idempotency ORDER BY created_at, idempotency_key`).all() as Array<{ idempotencyKey: string }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => /^native:[a-f0-9]{64}$/u.test(row.idempotencyKey))).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/run-a|run-b|shared-dark-theme-key|run-a-transition-key/u);
  });

  it('replays a same-run receipt before current-style preflight after the target is removed', async () => {
    const original = { ...applyInput(3, '#111318'), idempotencyKey: 'post-removal-replay' };
    const first = await services.nativeToolRegistry.call(
      contextAtRevision(3, 'run-a'),
      'map_apply_transaction',
      original,
    );
    const semantics = await services.nativeToolRegistry.call(
      contextAtRevision(4, 'run-a'),
      'map_update_semantics',
      {
        expectedRevision: 4,
        idempotencyKey: 'remove-roads-semantics',
        semantics: { version: 1, groups: [SEMANTICS.groups[1]] },
        intentSummary: 'Remove the roads semantic group',
      },
    );
    const removal = await services.nativeToolRegistry.call(
      contextAtRevision(5, 'run-a'),
      'map_apply_transaction',
      {
        expectedRevision: 5,
        idempotencyKey: 'remove-roads-layer',
        transaction: { operations: [{ op: 'removeLayer', layerId: 'roads' }] },
        intentSummary: 'Remove the roads layer',
      },
    );

    expect(first).toMatchObject({ ok: true, summary: { revision: 4 } });
    expect(semantics).toMatchObject({ ok: true, summary: { revision: 5 } });
    expect(removal).toMatchObject({ ok: true, summary: { revision: 6 } });

    const replay = await services.nativeToolRegistry.call(
      contextAtRevision(3, 'run-a'),
      'map_apply_transaction',
      original,
    );
    const conflict = await services.nativeToolRegistry.call(
      contextAtRevision(3, 'run-a'),
      'map_apply_transaction',
      { ...original, transaction: applyInput(3, '#222222').transaction },
    );
    const invalidFirstCall = await services.nativeToolRegistry.call(
      contextAtRevision(6, 'run-b'),
      'map_apply_transaction',
      {
        expectedRevision: 6,
        idempotencyKey: 'first-invalid-after-removal',
        transaction: { operations: [{ op: 'setPaintProperty', layerId: 'parks' }] },
        intentSummary: 'Reject an invalid first transaction',
      },
    );

    expect(replay).toEqual(first);
    expect(conflict).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(invalidFirstCall).toEqual({
      ok: false,
      toolUseId: 'call-1',
      error: {
        code: 'INVALID_INPUT',
        message: 'The map tool input is invalid.',
        retryable: false,
        details: { category: 'INVALID_INPUT', operationIndex: 0, firstPath: 'transaction.operations.0.op' },
      },
    });
    const project = services.repository.get(PROJECT_ID)!;
    const style = await services.blobStore.getJson<StyleDocument>(PROJECT_ID, 'styles', project.draftStyleDigest!);
    expect(project.draftRevision).toBe(6);
    expect(style.layers.some((layer) => layer.id === 'roads')).toBe(false);
  });

  it('keeps SDK dry-runs detached from the repository-owned snapshot', async () => {
    const project = services.repository.get(PROJECT_ID)!;
    const stored = await services.blobStore.getJson<StyleDocument>(PROJECT_ID, 'styles', project.draftStyleDigest!);
    const sdk = createMapStyleSdk();

    const result = sdk.apply(stored, applyStyleTransactionInputSchema.parse({
      transaction: applyInput(3).transaction,
      dryRun: true,
      diff: true,
    }));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        applied: false,
        changedLayers: ['roads'],
        changedSources: [],
      });
      expect(result.data.style.layers[0]).toMatchObject({ paint: { 'line-color': '#335577' } });
    }
    expect(stored.layers[0]).toMatchObject({ paint: { 'line-color': '#111111' } });
    expect(services.repository.get(PROJECT_ID)?.draftRevision).toBe(3);
  });

  it('reports an actionable missing source field without exposing submitted values', async () => {
    const result = await services.nativeToolRegistry.call(contextAtRevision(3), 'map_apply_transaction', {
      expectedRevision: 3, idempotencyKey: 'missing-source-001', intentSummary: 'Add a point',
      transaction: { operations: [{ op: 'addSource', sourceId: 'credential-do-not-echo' }] },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', details: {
      category: 'INVALID_INPUT', operationIndex: 0, firstPath: 'transaction.operations.0.source',
    } } });
    expect(JSON.stringify(result)).not.toMatch(/credential-do-not-echo|expected record/);
    expect(services.repository.get(PROJECT_ID)?.draftRevision).toBe(3);
  });

  it('returns SDK validation failures without persisting', async () => {
    const input = {
      ...applyInput(3),
      transaction: {
        operations: [{
          op: 'setLayerProperties',
          layerId: 'roads',
          paint: { 'line-color': '#335577', 'line-width': 'not-a-number' },
        }],
      },
    };

    const result = await services.nativeToolRegistry.call(
      contextAtRevision(3),
      'map_apply_transaction',
      input,
    );

    expect(result).toMatchObject({
      ok: false,
      toolUseId: 'call-1',
      error: { code: 'STYLE_INVALID', retryable: false, details: { category: 'STYLE_INVALID', firstPath: 'layers.0.paint' } },
    });
    expect(services.repository.get(PROJECT_ID)?.draftRevision).toBe(3);
  });

  it('returns a safe authoritative-service failure for an invalid SDK operation', async () => {
    const result = await services.nativeToolRegistry.call(
      contextAtRevision(3),
      'map_apply_transaction',
      {
        expectedRevision: 3,
        idempotencyKey: 'invalid-op-001',
        transaction: { operations: [{ op: 'setPaintProperty', layerId: 'water' }] },
        intentSummary: 'Invalid legacy operation',
      },
    );

    expect(result).toEqual({
      ok: false,
      toolUseId: 'call-1',
      error: { code: 'INVALID_INPUT', message: 'The map tool input is invalid.', retryable: false,
        details: { category: 'INVALID_INPUT', operationIndex: 0, firstPath: 'transaction.operations.0.op' } },
    });
    expect(JSON.stringify(result)).not.toContain('source.json');
    expect(services.repository.get(PROJECT_ID)?.draftRevision).toBe(3);
  });

  it.each([
    [
      'missing operation discriminator',
      {},
      { category: 'INVALID_INPUT', operationIndex: 0, firstPath: 'transaction.operations.0.op' },
    ],
    [
      'properties-wrapped layer paint',
      {
        op: 'setLayerProperties',
        layerId: 'roads',
        properties: { paint: { 'line-color': '#111318' } },
      },
      { category: 'INVALID_INPUT', operationIndex: 0, firstPath: 'transaction.operations.0' },
    ],
  ])('keeps malformed authoritative-service failures safe for %s', async (_name, operation, expectedDetails) => {
    const result = await services.nativeToolRegistry.call(
      contextAtRevision(3),
      'map_apply_transaction',
      {
        expectedRevision: 3,
        idempotencyKey: 'actionable-issue-001',
        transaction: { operations: [operation] },
        intentSummary: 'Reject a malformed operation',
      },
    );

    expect(result).toEqual({
      ok: false,
      toolUseId: 'call-1',
      error: { code: 'INVALID_INPUT', message: 'The map tool input is invalid.', retryable: false, details: expectedDetails },
    });
    if (result.ok) throw new TypeError('expected SDK validation failure');
    expect(JSON.stringify(result)).not.toMatch(
      /Too big|matching discriminator|setStyleRootProperties|properties-wrapped|#111318/iu,
    );
    expect(services.repository.get(PROJECT_ID)?.draftRevision).toBe(3);
  });

  it('drops arbitrary service detail fields and custom path segments', async () => {
    vi.spyOn(services.draftService, 'applyTransaction').mockRejectedValueOnce(new MapDraftError('INVALID_INPUT', 'raw-secret-message', {
      details: { category: 'INVALID_INPUT', operationIndex: 0, firstPath: 'transaction.operations.0.secret-value',
        sourceId: 'secret-source', message: 'secret-message', nested: { token: 'secret-token' } },
    }));
    const result = await services.nativeToolRegistry.call(contextAtRevision(3), 'map_apply_transaction', applyInput(3));
    expect(result).toMatchObject({ ok: false, error: { details: { category: 'INVALID_INPUT', operationIndex: 0 } } });
    expect(JSON.stringify(result)).not.toContain('secret');
    if (result.ok) throw new Error('Expected rejection.');
    expect(result.error.details).toEqual({ category: 'INVALID_INPUT', operationIndex: 0 });
  });

  it('identifies source validation failures without echoing a custom source id', async () => {
    const result = await services.nativeToolRegistry.call(contextAtRevision(3), 'map_apply_transaction', {
      expectedRevision: 3, idempotencyKey: 'invalid-source-001', intentSummary: 'Add a point',
      transaction: { operations: [{ op: 'addSource', sourceId: 'private-source-value', source: { kind: 'geojson', data: { type: 'FeatureCollection', features: [] } } }] },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'STYLE_INVALID', details: { category: 'STYLE_INVALID', firstPath: 'sources' } } });
    expect(JSON.stringify(result)).not.toContain('private-source-value');
    expect(services.repository.get(PROJECT_ID)?.draftRevision).toBe(3);
  });

  it('projects only bounded safe primitives from an SDK tool error', async () => {
    const realSdk = createMapStyleSdk();
    const registry = createMapDesignNativeToolRegistry({
      repository: services.repository,
      blobStore: services.blobStore,
      query: services.queryService,
      draft: services.draftService,
      validation: services.validationService,
      preview: services.previewService,
      revision: services.revisionService,
      runStore,
      sdk: {
        inspect: () => ({
          success: false,
          message: 'provider error with source.json and https://unsafe.example',
          error: createStyleToolError(
            'INVALID_INPUT',
            'credential token provider error',
            '/transaction/operations/0',
            {
              operationIndex: 0,
              layerId: 'roads',
              style: { source: 'source.json' },
              url: 'https://unsafe.example',
              credential: 'secret-value',
              providerError: 'raw provider failure',
              reason: 'raw-provider-message',
              noteA: '/Users/alice/private/source.json',
              noteB: 'secret=super-sensitive-value',
              noteC: 'password=hunter2',
              noteD: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
              noteE: 'api_key=private-key-value',
              noteF: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtYXAifQ.c2lnbmF0dXJlMTIzNDU2',
              authorization: 'present',
            },
          ),
        }),
        apply: realSdk.apply,
      },
    });

    const result = await registry.call(
      contextAtRevision(3),
      'map_inspect',
      { target: { kind: 'root' } },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        details: {
          firstPath: 'transaction.operations.0',
          operationIndex: 0,
          layerId: 'roads',
        },
      },
    });
    if (result.ok) throw new TypeError('expected SDK failure');
    expect(SafeToolSummarySchema.safeParse(result.error.details).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /source\.json|unsafe\.example|secret-value|provider failure|raw-provider-message|super-sensitive-value|hunter2|Bearer|private-key-value|eyJhbGci|authorization/,
    );
    expect(services.repository.get(PROJECT_ID)?.draftRevision).toBe(3);
  });

  it.each([
    '/workspace/operations/0',
    '/Users/alice/private/source.json',
    'C:\\Users\\alice\\private\\source.json',
    'https://unsafe.example/transaction/operations/0',
    '/transaction/~2invalid',
    '/transaction/operations/0/password',
  ])('drops an untrusted or malformed SDK error path: %s', async (unsafePath) => {
    const realSdk = createMapStyleSdk();
    const registry = createMapDesignNativeToolRegistry({
      repository: services.repository,
      blobStore: services.blobStore,
      query: services.queryService,
      draft: services.draftService,
      validation: services.validationService,
      preview: services.previewService,
      revision: services.revisionService,
      runStore,
      sdk: {
        inspect: () => ({
          success: false,
          message: 'SDK failure',
          error: createStyleToolError('INVALID_INPUT', 'Invalid operation', unsafePath),
        }),
        apply: realSdk.apply,
      },
    });

    const result = await registry.call(
      contextAtRevision(3),
      'map_inspect',
      { target: { kind: 'root' } },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    if (result.ok) throw new TypeError('expected SDK failure');
    expect(result.error.details).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(unsafePath);
  });

  it('returns a revision conflict before SDK work or persistence', async () => {
    const result = await services.nativeToolRegistry.call(
      contextAtRevision(2),
      'map_apply_transaction',
      applyInput(2),
    );

    expect(result).toEqual({
      ok: false,
      toolUseId: 'call-1',
      error: {
        code: 'REVISION_CONFLICT',
        message: 'The map draft revision has changed.',
        retryable: true,
      },
    });
    expect(services.repository.get(PROJECT_ID)?.draftRevision).toBe(3);
  });

  it('rejects an already-aborted call without persistence', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await services.nativeToolRegistry.call(
      { ...contextAtRevision(3), signal: controller.signal },
      'map_apply_transaction',
      applyInput(3),
    );

    expect(result).toEqual({
      ok: false,
      toolUseId: 'call-1',
      error: { code: 'CANCELLED', message: 'The map tool call was cancelled.', retryable: false },
    });
    expect(services.repository.get(PROJECT_ID)?.draftRevision).toBe(3);
  });

  it('checks cancellation again after read-only SDK preflight', async () => {
    const controller = new AbortController();
    const realSdk = createMapStyleSdk();
    const registry = createMapDesignNativeToolRegistry({
      repository: services.repository,
      blobStore: services.blobStore,
      query: services.queryService,
      draft: services.draftService,
      validation: services.validationService,
      preview: services.previewService,
      revision: services.revisionService,
      runStore,
      sdk: {
        inspect(style, input) {
          const result = realSdk.inspect(style, input);
          controller.abort();
          return result;
        },
        apply: realSdk.apply,
      },
    });

    const result = await registry.call(
      { ...contextAtRevision(3), signal: controller.signal },
      'map_inspect',
      { target: { kind: 'root' } },
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(services.repository.get(PROJECT_ID)?.draftRevision).toBe(3);
  });

  it('delegates preview validation to the authoritative preview service without SDK preflight', async () => {
    const invalidStyle = await services.blobStore.putJson(PROJECT_ID, 'styles', {
      ...STYLE,
      version: 7,
    });
    database.prepare(`UPDATE map_design_projects
      SET draft_style_digest = ?, draft_style_hash = ? WHERE project_id = ?`)
      .run(invalidStyle.digest, 'e'.repeat(64), PROJECT_ID);
    let previewRequests = 0;
    const realSdk = createMapStyleSdk();
    const inspect = vi.fn(realSdk.inspect);
    const registry = createMapDesignNativeToolRegistry({
      repository: services.repository,
      blobStore: services.blobStore,
      query: services.queryService,
      draft: services.draftService,
      validation: services.validationService,
      preview: {
        async requestAndWait() {
          previewRequests += 1;
          return {
            status: 'failed',
            previewId: 'preview-invalid-style',
            draftRevision: 3,
            styleHash: 'e'.repeat(64),
            png: null,
            report: { digest: 'f'.repeat(64), mediaType: 'application/json', byteLength: 1 },
            validationSummary: {
              status: 'valid',
              errors: 0,
              warnings: 0,
              infos: 0,
              totalFindings: 0,
              returnedFindings: 0,
              omittedFindings: 0,
            },
          };
        },
      },
      revision: services.revisionService,
      runStore,
      sdk: { inspect, apply: realSdk.apply },
    });

    const result = await registry.call(
      contextAtRevision(3),
      'map_render_preview',
      { expectedRevision: 3, idempotencyKey: 'preview-invalid-style' },
    );

    expect(result).toMatchObject({ ok: true, summary: { status: 'failed', revision: 3 } });
    expect(previewRequests).toBe(1);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('keeps a truthful terminal preview failure after durable enqueue even when the signal aborts', async () => {
    const controller = new AbortController();
    const pending = services.nativeToolRegistry.call(
      { ...contextAtRevision(3), signal: controller.signal },
      'map_render_preview',
      { expectedRevision: 3, idempotencyKey: 'preview-abort-after-enqueue' },
    );
    await waitForPreviewRow(database);

    controller.abort();
    services.previewService.shutdown();

    await expect(pending).resolves.toEqual({
      ok: false,
      toolUseId: 'call-1',
      error: {
        code: 'PREVIEW_FAILED',
        message: 'The map preview failed.',
        retryable: true,
      },
    });
    expect(database.prepare(`SELECT status FROM map_design_previews
      WHERE project_id = ?`).get(PROJECT_ID)).toEqual({ status: 'requested' });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM map_design_event_outbox
      WHERE project_id = ?`).get(PROJECT_ID)).toEqual({ count: 1 });
  });

  it('keeps pre-commit preview aborts cancelled and rolls back durable enqueue state', async () => {
    const controller = new AbortController();
    const preview = new MapPreviewRequestServiceImpl({
      db: database,
      outbox: {
        appendInTransaction(db, projectId, event) {
          const sequence = services.outbox.appendInTransaction(db, projectId, event);
          controller.abort();
          return sequence;
        },
        drainPending: () => services.outbox.drainPending(),
      },
      now: () => NOW,
      createId: () => 'preview-precommit-abort',
    });
    const registry = createMapDesignNativeToolRegistry({
      repository: services.repository,
      blobStore: services.blobStore,
      query: services.queryService,
      draft: services.draftService,
      validation: services.validationService,
      preview,
      revision: services.revisionService,
      runStore,
    });

    const result = await registry.call(
      { ...contextAtRevision(3), signal: controller.signal },
      'map_render_preview',
      { expectedRevision: 3, idempotencyKey: 'preview-precommit-abort' },
    );

    expect(result).toEqual({
      ok: false,
      toolUseId: 'call-1',
      error: { code: 'CANCELLED', message: 'The map tool call was cancelled.', retryable: false },
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM map_design_previews').get())
      .toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM map_design_event_outbox').get())
      .toEqual({ count: 0 });
    preview.shutdown();
  });

  it('does not report a durable atomic write as cancelled once persistence begins', async () => {
    const controller = new AbortController();
    const registry = createMapDesignNativeToolRegistry({
      repository: services.repository,
      blobStore: services.blobStore,
      query: services.queryService,
      draft: {
        ...services.draftService,
        async applyTransaction(context, input) {
          const output = await services.draftService.applyTransaction(context, input);
          controller.abort();
          return output;
        },
        updateSemantics: services.draftService.updateSemantics.bind(services.draftService),
      },
      validation: services.validationService,
      preview: services.previewService,
      revision: services.revisionService,
      runStore,
    });

    const result = await registry.call(
      { ...contextAtRevision(3), signal: controller.signal },
      'map_apply_transaction',
      applyInput(3),
    );

    expect(result).toMatchObject({
      ok: true,
      summary: { revision: 4, changedLayerCount: 1 },
    });
    expect(services.repository.get(PROJECT_ID)?.draftRevision).toBe(4);
  });

  it('fails closed for unknown tools', async () => {
    const result = await services.nativeToolRegistry.call(
      contextAtRevision(3),
      'map_read_local_file' as MapToolName,
      {},
    );

    expect(result).toEqual({
      ok: false,
      toolUseId: 'call-1',
      error: { code: 'UNKNOWN_TOOL', message: 'The map tool is not registered.', retryable: false },
    });
    expect(services.repository.get(PROJECT_ID)?.draftRevision).toBe(3);
  });
});

async function waitForPreviewRow(database: Database.Database): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = database.prepare('SELECT id FROM map_design_previews LIMIT 1').get();
    if (row) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('preview row was not durably enqueued');
}
