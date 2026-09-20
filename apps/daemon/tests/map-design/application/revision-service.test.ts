import {LEGACY_QUIET_WALKING_ID, LEGACY_QUIET_WALKING_DIGEST, loadLegacyDesignSystem} from '../../../src/map-design/validation/legacy-design-system.js';
import {testDesignSystem} from '../../fixtures/map-design/test-design-system.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256CanonicalJson } from 'maplibre-style-tools/bridge';
import type {
  MapRestoreRevisionInput,
  MapStudioEvent,
} from '@mapseekai/map-design-contracts';

import {
  createMapImportAttestation,
  createMapRevisionAttestation,
} from '../../../src/map-design/application/attestation.js';
import { MapDraftError } from '../../../src/map-design/application/errors.js';
import {
  MapRevisionService,
  type MapRevisionEventEnvelope,
  type MapRevisionEventBus,
  type MapRevisionImmediateCheckpoint,
} from '../../../src/map-design/application/revision-service.js';
import { createMapDesignBlobStore } from '../../../src/map-design/storage/blob-store.js';
import {
  closeMapDesignDatabase,
  openMapDesignDatabase,
} from '../../../src/map-design/storage/database.js';
import { blobPath } from '../../../src/map-design/storage/paths.js';
import { MapDesignSqliteProjectRepository } from '../../../src/map-design/storage/project-repository.js';
import type { LoadedMapDesignSystem } from '../../../src/map-design/validation/design-system-loader.js';

const NOW = '2026-09-01T00:00:00.000Z';
const HISTORICAL_SYSTEM: LoadedMapDesignSystem = testDesignSystem({ id: 'historical-system', digest: 'd'.repeat(64) });
const CURRENT_SYSTEM: LoadedMapDesignSystem = testDesignSystem({ id: 'current-system', digest: 'e'.repeat(64) });
const IMPORT_SYSTEM: LoadedMapDesignSystem = testDesignSystem({ id: 'quiet-atlas', digest: 'c'.repeat(64) });
const systems = new Map([
  [HISTORICAL_SYSTEM.id, HISTORICAL_SYSTEM],
  [CURRENT_SYSTEM.id, CURRENT_SYSTEM],
  [IMPORT_SYSTEM.id, IMPORT_SYSTEM],
]);

type RuntimeAttestation = ReturnType<typeof createMapRevisionAttestation>;

function style(projectId: string, color: string) {
  return {
    version: 8 as const,
    sources: {
      base: {
        type: 'vector' as const,
        tiles: [`/api/map-design/projects/${projectId}/resources/base/tiles/{z}/{x}/{y}.pbf`],
      },
    },
    layers: [{
      id: 'roads',
      type: 'line' as const,
      source: 'base',
      'source-layer': 'roads',
      paint: { 'line-color': color },
    }],
  };
}

const semantics = {
  version: 1 as const,
  groups: [{ id: 'roads', label: 'Roads', role: 'roads', layerIds: ['roads'], sourceIds: ['base'] }],
};

describe('MapRevisionService historical snapshots', () => {
  let root: string;
  let db: ReturnType<typeof openMapDesignDatabase>;
  let blobStore: ReturnType<typeof createMapDesignBlobStore>;
  let repository: MapDesignSqliteProjectRepository;
  let revisionService: MapRevisionService;
  let requestedDesignSystems: Array<{ id: string; digest: string }>;
  let loadDesignSystem: (input: { id: string; digest: string }) => Promise<LoadedMapDesignSystem>;
  let publishedEnvelopes: MapRevisionEventEnvelope[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'map-revision-snapshot-'));
    db = openMapDesignDatabase(root);
    blobStore = createMapDesignBlobStore(root);
    repository = new MapDesignSqliteProjectRepository(db);
    requestedDesignSystems = [];
    publishedEnvelopes = [];
    loadDesignSystem = async ({ id, digest }) => {
      requestedDesignSystems.push({ id, digest });
      const system = systems.get(id);
      if (!system || system.digest !== digest) throw new TypeError('design system unavailable');
      return system;
    };
    revisionService = new MapRevisionService({
      db,
      blobStore,
      loadDesignSystem,
      runStore: { get: () => null },
      eventBus: eventBus(publishedEnvelopes),
      now: () => NOW,
    });

    await seedProject('project-a', '#ff0000');
    await seedProject('project-b', '#00ff00');
    await seedImportRevision('project-a', '#010203');
    await seedRuntimeRevision('project-a', 1, '#123456');
    await seedRuntimeRevision('project-b', 1, '#abcdef');
    await seedRuntimeRevision('project-b', 2, '#fedcba');
  });

  afterEach(() => {
    closeMapDesignDatabase(db);
    rmSync(root, { recursive: true, force: true });
  });

  it('looks up overlapping revision numbers within the requested project', () => {
    expect(repository.getRevision('project-a', 1)?.projectId).toBe('project-a');
    expect(repository.getRevision('project-b', 1)?.projectId).toBe('project-b');
    expect(repository.getRevision('project-a', 99)).toBeNull();
  });

  it('returns immutable historical paint and attested design-system evidence without changing the project', async () => {
    const stateBefore = storedState('project-a');
    const historyBefore = repository.listRevisions('project-a');

    const snapshot = await revisionService.getSnapshot('project-a', 1);

    expect(snapshot.style).toMatchObject({
      layers: [{ id: 'roads', paint: { 'line-color': '#123456' } }],
    });
    expect(snapshot.revision).toMatchObject({ revision: 1, draftRevision: 1 });
    expect(snapshot.inspect).toMatchObject({
      target: { kind: 'root' },
      view: { kind: 'root', style: { layerCount: 1, sourceCount: 1 } },
    });
    expect(snapshot.validation.draftRevision).toBe(1);
    expect(requestedDesignSystems).toContainEqual({
      id: HISTORICAL_SYSTEM.id,
      digest: HISTORICAL_SYSTEM.digest,
    });
    expect(storedState('project-a')).toEqual(stateBefore);
    expect(repository.listRevisions('project-a')).toEqual(historyBefore);
  });

  it('loads revision zero with import-attestation rules and its attested design system', async () => {
    const snapshot = await revisionService.getSnapshot('project-a', 0);

    expect(snapshot).toMatchObject({
      revision: { revision: 0, draftRevision: 0, previewId: null },
      style: { layers: [{ paint: { 'line-color': '#010203' } }] },
    });
    expect(requestedDesignSystems).toContainEqual({
      id: IMPORT_SYSTEM.id,
      digest: IMPORT_SYSTEM.digest,
    });
  });

  it.each(['restore', 'discard'] as const)('keeps the migrated standard binding when %s reads legacy evidence', async (operation) => {
    const legacy = loadLegacyDesignSystem(LEGACY_QUIET_WALKING_ID, LEGACY_QUIET_WALKING_DIGEST)!;
    const revision = repository.getRevision('project-a', 0)!;
    const original = await blobStore.getJson<Record<string, unknown>>('project-a', 'attestations', revision.attestationDigest);
    await replaceAttestation('project-a', 0, createMapImportAttestation({
      ...original, designSystemId: legacy.id, designSystemDigest: legacy.digest,
    }));
    db.prepare('UPDATE map_design_revisions SET design_system_digest = ? WHERE project_id = ? AND revision = 0').run(legacy.digest, 'project-a');
    if (operation === 'discard') db.prepare('UPDATE map_design_projects SET committed_revision = 0 WHERE project_id = ?').run('project-a');
    const historyBefore = repository.listRevisions('project-a');
    const service = new MapRevisionService({
      db, blobStore,
      loadDesignSystem: async (binding) => loadLegacyDesignSystem(binding.id, binding.digest) ?? loadDesignSystem(binding),
      runStore: {get: (runId) => ({runId, projectId: 'project-a', runtime: {id: 'codex', version: '1.0.0', adapter: 'native'}, model: {id: 'gpt-5', provider: 'openai'}})},
      eventBus: eventBus(publishedEnvelopes), now: () => NOW,
    });
    const snapshot = await service.getSnapshot('project-a', 0);
    expect(snapshot.revision.designSystemDigest).toBe(legacy.digest);
    expect(snapshot.validation.findings).toContainEqual(expect.objectContaining({code: 'DESIGN_SYSTEM_VIOLATION', scope: {kind: 'design-system', id: legacy.id}}));
    if (operation === 'restore') await service.restore(uiContext('legacy-restore'), 0, restoreInput());
    else await service.discard({projectId: 'project-a', runId: 'legacy-discard'}, {expectedRevision: 7, idempotencyKey: 'legacy-discard', intentSummary: 'Discard the migrated draft'});
    expect(repository.get('project-a')).toMatchObject({
      designSystemId: CURRENT_SYSTEM.id, designSystemDigest: CURRENT_SYSTEM.digest,
      draftRevision: 8, draftStyleDigest: revision.styleDigest,
    });
    expect(repository.listRevisions('project-a')).toEqual(historyBefore);
    expect((await service.getSnapshot('project-a', 0)).revision.designSystemDigest).toBe(legacy.digest);
  });

  it('rejects an import attestation attached to a runtime revision', async () => {
    const revision = repository.getRevision('project-a', 1)!;
    await replaceAttestation('project-a', 1, createMapImportAttestation({
      version: 1,
      kind: 'import',
      projectId: revision.projectId,
      revision: 0,
      sourceManifestDigest: revision.sourceManifestDigest,
      styleDigest: revision.styleDigest,
      styleHash: revision.styleHash,
      semanticDigest: revision.semanticDigest,
      designSystemId: 'quiet-atlas',
      designSystemDigest: revision.designSystemDigest,
      importedAt: revision.createdAt,
    }));

    await expectSafeEvidenceError(revisionService.getSnapshot('project-a', 1));
  });

  it('rejects a runtime attestation attached to revision zero', async () => {
    const runtimeAttestation = await readRuntimeAttestation('project-a', 1);
    await replaceAttestation('project-a', 0, runtimeAttestation);

    await expectSafeEvidenceError(revisionService.getSnapshot('project-a', 0));
  });

  it.each([
    {
      field: 'project',
      change: (attestation: RuntimeAttestation) => createMapRevisionAttestation({
        ...attestation,
        projectId: 'project-b',
      }),
    },
    {
      field: 'revision',
      change: (attestation: RuntimeAttestation) => createMapRevisionAttestation({
        ...attestation,
        revision: 2,
      }),
    },
    {
      field: 'draft revision',
      change: (attestation: RuntimeAttestation) => createMapRevisionAttestation({
        ...attestation,
        draftRevision: 2,
      }),
    },
    {
      field: 'style digest',
      change: (attestation: RuntimeAttestation) => createMapRevisionAttestation({
        ...attestation,
        style: { ...attestation.style, digest: '4'.repeat(64) },
      }),
    },
    {
      field: 'semantic digest',
      change: (attestation: RuntimeAttestation) => createMapRevisionAttestation({
        ...attestation,
        semantics: { digest: '5'.repeat(64) },
      }),
    },
    {
      field: 'source digest',
      change: (attestation: RuntimeAttestation) => createMapRevisionAttestation({
        ...attestation,
        source: { manifestDigest: '6'.repeat(64) },
      }),
    },
    {
      field: 'design-system digest',
      change: (attestation: RuntimeAttestation) => createMapRevisionAttestation({
        ...attestation,
        designSystem: { ...attestation.designSystem, digest: '7'.repeat(64) },
      }),
    },
    {
      field: 'preview binding',
      change: (attestation: RuntimeAttestation) => createMapRevisionAttestation({
        ...attestation,
        preview: { ...attestation.preview, id: 'preview-other' },
      }),
    },
    {
      field: 'run binding',
      change: (attestation: RuntimeAttestation) => createMapRevisionAttestation({
        ...attestation,
        run: { id: 'run-other' },
      }),
    },
    {
      field: 'committed timestamp',
      change: (attestation: RuntimeAttestation) => createMapRevisionAttestation({
        ...attestation,
        committedAt: '2026-09-01T00:00:01.000Z',
      }),
    },
  ])('rejects a mismatched $field attestation binding', async ({ change }) => {
    const attestation = await readRuntimeAttestation('project-a', 1);
    await replaceAttestation('project-a', 1, change(attestation));

    await expectSafeEvidenceError(revisionService.getSnapshot('project-a', 1));
  });

  it('returns NOT_FOUND for a revision that exists only in another project', async () => {
    await expect(revisionService.getSnapshot('project-a', 2)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'The map revision was not found.',
    });
  });

  it('maps corrupt blob contents to a safe evidence error without leaking storage paths', async () => {
    const revision = repository.getRevision('project-a', 1)!;
    writeFileSync(blobPath(root, 'project-a', 'styles', revision.styleDigest), '{}');

    await expectSafeEvidenceError(revisionService.getSnapshot('project-a', 1));
  });

  it('maps corrupt semantics blob contents to a safe evidence error', async () => {
    const revision = repository.getRevision('project-a', 1)!;
    writeFileSync(blobPath(root, 'project-a', 'semantics', revision.semanticDigest), '{}');

    await expectSafeEvidenceError(revisionService.getSnapshot('project-a', 1));
  });

  it('maps corrupt source-manifest blob contents to a safe evidence error', async () => {
    const revision = repository.getRevision('project-a', 1)!;
    writeFileSync(blobPath(root, 'project-a', 'sources', revision.sourceManifestDigest), '{}');

    await expectSafeEvidenceError(revisionService.getSnapshot('project-a', 1));
  });

  it('rejects a stored style hash that does not match the immutable style blob', async () => {
    db.prepare(`UPDATE map_design_revisions SET style_hash = ?
      WHERE project_id = ? AND revision = ?`).run('9'.repeat(64), 'project-a', 1);

    await expectSafeEvidenceError(revisionService.getSnapshot('project-a', 1));
  });

  it('maps missing attestation evidence to a safe error without leaking storage paths', async () => {
    db.prepare(`UPDATE map_design_revisions SET attestation_digest = ?
      WHERE project_id = ? AND revision = ?`).run('f'.repeat(64), 'project-a', 1);

    await expectSafeEvidenceError(revisionService.getSnapshot('project-a', 1));
  });

  it('rejects a historical style whose resource URL belongs to another project', async () => {
    await replaceRevisionStyle('project-a', 1, style('project-b', '#123456'));

    await expect(revisionService.getSnapshot('project-a', 1)).rejects.toMatchObject({
      code: 'STYLE_INVALID',
      message: 'The historical map style contains an unsafe resource URL.',
    });
  });

  it('rejects an unavailable attested design-system ID', async () => {
    const attestation = await readRuntimeAttestation('project-a', 1);
    await replaceAttestation('project-a', 1, createMapRevisionAttestation({
      ...attestation,
      designSystem: { id: 'unavailable-system', digest: attestation.designSystem.digest },
    }));

    await expectSafeEvidenceError(revisionService.getSnapshot('project-a', 1));
    expect(requestedDesignSystems).toContainEqual({
      id: 'unavailable-system',
      digest: HISTORICAL_SYSTEM.digest,
    });
  });

  it.each([
    {
      mismatch: 'ID',
      loaded: { ...HISTORICAL_SYSTEM, id: 'wrong-system' },
    },
    {
      mismatch: 'digest',
      loaded: { ...HISTORICAL_SYSTEM, digest: '8'.repeat(64) },
    },
  ])('rejects a design-system loader returning the wrong $mismatch', async ({ loaded }) => {
    const mismatchedService = new MapRevisionService({
      db,
      blobStore,
      loadDesignSystem: async () => loaded,
      runStore: { get: () => null },
      eventBus: { publish: () => undefined },
    });

    await expectSafeEvidenceError(mismatchedService.getSnapshot('project-a', 1));
  });

  it('restores every historical draft environment pointer while preserving the committed pointer and history', async () => {
    const before = repository.get('project-a')!;
    const historical = repository.getRevision('project-a', 1)!;
    const revisionsBefore = repository.listRevisions('project-a');

    const output = await revisionService.restore(
      uiContext('request-restore-1'),
      1,
      restoreInput(),
    );

    expect(output).toMatchObject({
      draftRevision: before.draftRevision + 1,
      restoredRevision: 1,
      styleHash: historical.styleHash,
      semanticDigest: historical.semanticDigest,
      validationSummary: { status: 'valid', errors: 0 },
    });
    expect(repository.get('project-a')).toMatchObject({
      sourceKind: 'style',
      sourceManifestDigest: historical.sourceManifestDigest,
      designSystemId: HISTORICAL_SYSTEM.id,
      designSystemDigest: historical.designSystemDigest,
      draftRevision: before.draftRevision + 1,
      draftStyleDigest: historical.styleDigest,
      draftStyleHash: historical.styleHash,
      draftSemanticDigest: historical.semanticDigest,
      committedRevision: before.committedRevision,
    });
    expect(repository.listRevisions('project-a')).toEqual(revisionsBefore);

    const receipt = db.prepare(`SELECT operation, request_digest AS requestDigest,
      response_json AS responseJson FROM map_design_idempotency
      WHERE project_id = ? AND operation = 'revision.restore' AND idempotency_key = ?`).get(
      'project-a',
      'restore-ui-r8-v1',
    ) as { operation: string; requestDigest: string; responseJson: string };
    expect(receipt).toMatchObject({ operation: 'revision.restore', requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(JSON.parse(receipt.responseJson)).toEqual(output);

    const outbox = db.prepare(`SELECT event_json AS eventJson FROM map_design_event_outbox
      WHERE project_id = ? ORDER BY sequence DESC LIMIT 1`).get('project-a') as { eventJson: string };
    expect(JSON.parse(outbox.eventJson)).toEqual({
      type: 'draft.restored',
      occurredAt: NOW,
      payload: {
        draftRevision: before.draftRevision + 1,
        restoredRevision: 1,
        styleHash: historical.styleHash,
      },
    });
    expect(publishedEnvelopes).toEqual([expect.objectContaining({
      projectId: 'project-a',
      actor: { kind: 'ui', requestId: 'request-restore-1' },
      idempotencyKey: 'restore-ui-r8-v1',
      operation: 'revision.restore',
      event: expect.objectContaining({ type: 'draft.restored' }),
    })]);
  });

  it('discards a restored older revision back to the committed revision full environment', async () => {
    const committed = repository.getRevision('project-a', 1)!;
    const revisionsBefore = repository.listRevisions('project-a');
    await revisionService.restore(
      uiContext('request-restore-older'),
      0,
      restoreInput({
        idempotencyKey: 'restore-older-v0',
        intentSummary: 'Restore the imported revision 0 as a new draft',
      }),
    );
    expect(repository.get('project-a')).toMatchObject({
      sourceKind: 'geojson',
      designSystemId: IMPORT_SYSTEM.id,
      designSystemDigest: IMPORT_SYSTEM.digest,
      draftRevision: 8,
      committedRevision: 1,
    });

    const output = await mutationService(eventBus(publishedEnvelopes)).discard(
      { projectId: 'project-a', runId: 'run-discard' },
      {
        expectedRevision: 8,
        idempotencyKey: 'discard-restored-older',
        intentSummary: 'Discard the restored older draft',
      },
    );

    expect(output).toMatchObject({
      draftRevision: 9,
      restoredCommittedRevision: 1,
      styleHash: committed.styleHash,
      semanticDigest: committed.semanticDigest,
    });
    expect(repository.get('project-a')).toMatchObject({
      sourceKind: 'style',
      sourceManifestDigest: committed.sourceManifestDigest,
      designSystemId: HISTORICAL_SYSTEM.id,
      designSystemDigest: HISTORICAL_SYSTEM.digest,
      draftRevision: 9,
      draftStyleDigest: committed.styleDigest,
      draftStyleHash: committed.styleHash,
      draftSemanticDigest: committed.semanticDigest,
      committedRevision: 1,
    });
    expect(repository.listRevisions('project-a')).toEqual(revisionsBefore);
    expect(publishedEnvelopes.at(-1)).toMatchObject({
      actor: { kind: 'run', runId: 'run-discard' },
      operation: 'map_discard_draft',
      event: { type: 'draft.discarded' },
    });
  });

  it('does not partially discard when committed source evidence is unavailable', async () => {
    await revisionService.restore(
      uiContext('request-restore-before-corruption'),
      0,
      restoreInput({ idempotencyKey: 'restore-before-corruption' }),
    );
    const committed = repository.getRevision('project-a', 1)!;
    writeFileSync(blobPath(root, 'project-a', 'sources', committed.sourceManifestDigest), '{}');
    const before = storedState('project-a');

    await expect(mutationService(eventBus(publishedEnvelopes)).discard(
      { projectId: 'project-a', runId: 'run-discard' },
      {
        expectedRevision: 8,
        idempotencyKey: 'discard-corrupt-committed-source',
        intentSummary: 'Discard after committed source corruption',
      },
    )).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });

    expect(storedState('project-a')).toEqual(before);
    expect(publishedEnvelopes).toHaveLength(1);
  });

  it('rolls back full discard restoration and its receipt when outbox append fails', async () => {
    await revisionService.restore(
      uiContext('request-restore-before-discard-rollback'),
      0,
      restoreInput({ idempotencyKey: 'restore-before-discard-rollback' }),
    );
    const before = storedState('project-a');
    let appendAttempts = 0;
    const failingBus: MapRevisionEventBus = {
      appendInTransaction: () => {
        appendAttempts += 1;
        throw new Error('outbox unavailable');
      },
      publish: (envelope) => { publishedEnvelopes.push(envelope); },
    };

    await expect(mutationService(failingBus).discard(
      { projectId: 'project-a', runId: 'run-discard' },
      {
        expectedRevision: 8,
        idempotencyKey: 'discard-outbox-rollback',
        intentSummary: 'Discard with unavailable outbox',
      },
    )).rejects.toMatchObject({ code: 'INTERNAL' });

    expect(appendAttempts).toBe(1);
    expect(storedState('project-a')).toEqual(before);
    expect(publishedEnvelopes).toHaveLength(1);
  });

  it('rejects an active Run after historical evidence and before stale draft CAS or async mutation preparation', async () => {
    let checkpointReached = false;
    const service = restoreService(db, eventBus(publishedEnvelopes), () => {
      checkpointReached = true;
    });
    const before = storedState('project-a');

    await expect(service.restore(
      uiContext('request-active-run-before-cas', () => true),
      1,
      restoreInput({
        expectedDraftRevision: 6,
        idempotencyKey: 'restore-active-run-before-cas',
      }),
    )).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      message: 'A map run is active for this project.',
      retryable: true,
      details: { reason: 'ACTIVE_RUN' },
    });

    expect(checkpointReached).toBe(false);
    expect(storedState('project-a')).toEqual(before);
    expect(publishedEnvelopes).toEqual([]);
  });

  it('rejects restore when a project Run starts during beforeImmediate', async () => {
    let projectRunning = false;
    const service = restoreService(db, eventBus(publishedEnvelopes), async () => {
      projectRunning = true;
    });
    const before = storedState('project-a');

    await expect(service.restore(
      {
        kind: 'ui',
        projectId: 'project-a',
        requestId: 'request-run-race',
        isProjectRunning: () => projectRunning,
      },
      1,
      restoreInput({ idempotencyKey: 'restore-run-race' }),
    )).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      message: 'A map run is active for this project.',
      retryable: true,
      details: { reason: 'ACTIVE_RUN' },
    });

    expect(storedState('project-a')).toEqual(before);
    expect(publishedEnvelopes).toEqual([]);
  });

  it('rechecks project Run activity inside the synchronous restore transaction', async () => {
    let checks = 0;
    const before = storedState('project-a');

    await expect(revisionService.restore(
      {
        kind: 'ui',
        projectId: 'project-a',
        requestId: 'request-run-transaction-race',
        isProjectRunning: () => {
          checks += 1;
          return checks === 3;
        },
      },
      1,
      restoreInput({ idempotencyKey: 'restore-run-transaction-race' }),
    )).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      message: 'A map run is active for this project.',
      details: { reason: 'ACTIVE_RUN' },
    });

    expect(checks).toBe(3);
    expect(storedState('project-a')).toEqual(before);
    expect(publishedEnvelopes).toEqual([]);
  });

  it('replays the exact restore receipt before stale CAS without changing state or publishing twice', async () => {
    const input = restoreInput();
    const context = uiContext('request-restore-replay');
    const first = await revisionService.restore(context, 1, input);
    const stateAfterFirst = storedState('project-a');

    const replay = await revisionService.restore(context, 1, input);

    expect(replay).toEqual(first);
    expect(storedState('project-a')).toEqual(stateAfterFirst);
    expect(publishedEnvelopes).toHaveLength(1);
  });

  it('replays the exact restore receipt before rejecting an active Run', async () => {
    const input = restoreInput({ idempotencyKey: 'restore-active-replay' });
    const first = await revisionService.restore(uiContext('request-active-replay-first'), 1, input);
    const stateAfterFirst = storedState('project-a');

    const replay = await revisionService.restore(
      uiContext('request-active-replay-second', () => true),
      1,
      input,
    );

    expect(replay).toEqual(first);
    expect(storedState('project-a')).toEqual(stateAfterFirst);
    expect(publishedEnvelopes).toHaveLength(1);
  });

  it('rejects reuse of a restore key with different input before stale CAS', async () => {
    const input = restoreInput();
    const context = uiContext('request-restore-conflict');
    await revisionService.restore(context, 1, input);
    const stateAfterFirst = storedState('project-a');

    await expect(revisionService.restore(context, 1, {
      ...input,
      intentSummary: 'Restore revision 1 with a different request',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    expect(storedState('project-a')).toEqual(stateAfterFirst);
    expect(publishedEnvelopes).toHaveLength(1);
  });

  it('treats the target revision as part of the idempotent restore request identity', async () => {
    const input = restoreInput();
    const context = uiContext('request-restore-target');
    await revisionService.restore(context, 1, input);
    const stateAfterFirst = storedState('project-a');

    await expect(revisionService.restore(context, 0, input)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });

    expect(storedState('project-a')).toEqual(stateAfterFirst);
    expect(publishedEnvelopes).toHaveLength(1);
  });

  it('rejects stale restore CAS without writing a receipt, event, or project pointer', async () => {
    const before = storedState('project-a');

    await expect(revisionService.restore(
      uiContext('request-restore-stale'),
      1,
      restoreInput({ expectedDraftRevision: 6, idempotencyKey: 'restore-stale-r6' }),
    )).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      details: { currentRevision: 7 },
    });

    expect(storedState('project-a')).toEqual(before);
    expect(publishedEnvelopes).toEqual([]);
  });

  it('returns NOT_FOUND for a missing or cross-project restore revision without writes', async () => {
    const before = storedState('project-a');

    await expect(revisionService.restore(
      uiContext('request-restore-missing'),
      2,
      restoreInput({ idempotencyKey: 'restore-missing-v2' }),
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(storedState('project-a')).toEqual(before);
    expect(publishedEnvelopes).toEqual([]);
  });

  it('rejects historical validation errors before changing the current draft', async () => {
    await replaceRevisionSemantics('project-a', 1, {
      version: 1,
      groups: [{
        id: 'roads', label: 'Roads', role: 'roads', layerIds: ['missing-layer'], sourceIds: ['base'],
      }],
    });
    const before = storedState('project-a');

    await expect(revisionService.restore(
      uiContext('request-restore-invalid'),
      1,
      restoreInput({ idempotencyKey: 'restore-invalid-v1' }),
    )).rejects.toMatchObject({
      code: 'SEMANTIC_INVALID',
      message: 'The semantic mapping is invalid.',
    });

    expect(storedState('project-a')).toEqual(before);
    expect(publishedEnvelopes).toEqual([]);
  });

  it('rolls back the pointer update, receipt, and event when transactional outbox append fails', async () => {
    const before = storedState('project-a');
    const publish = publishedEnvelopes;
    const failingService = restoreService(db, {
      appendInTransaction: () => { throw new Error('outbox unavailable'); },
      publish: (envelope) => { publish.push(envelope); },
    });

    await expect(failingService.restore(
      uiContext('request-restore-rollback'),
      1,
      restoreInput({ idempotencyKey: 'restore-rollback-v1' }),
    )).rejects.toMatchObject({ code: 'INTERNAL' });

    expect(storedState('project-a')).toEqual(before);
    expect(publishedEnvelopes).toEqual([]);
  });

  it('fails closed without a transactional outbox appender', async () => {
    const before = storedState('project-a');
    const service = restoreService(db, {
      publish: (envelope) => { publishedEnvelopes.push(envelope); },
    });

    await expect(service.restore(
      uiContext('request-restore-no-outbox'),
      1,
      restoreInput({ idempotencyKey: 'restore-no-outbox-v1' }),
    )).rejects.toMatchObject({ code: 'INTERNAL' });

    expect(storedState('project-a')).toEqual(before);
    expect(publishedEnvelopes).toEqual([]);
  });

  it('linearizes two independently connected writers so only one different-key restore commits', async () => {
    const second = secondConnection();
    try {
      const barrier = createBarrier();
      const envelopes: MapRevisionEventEnvelope[] = [];
      const one = restoreService(db, eventBus(envelopes), barrier);
      const two = restoreService(second, eventBus(envelopes), barrier);

      const results = await Promise.allSettled([
        one.restore(
          uiContext('request-writer-a'),
          1,
          restoreInput({ idempotencyKey: 'restore-writer-a' }),
        ),
        two.restore(
          uiContext('request-writer-b'),
          1,
          restoreInput({ idempotencyKey: 'restore-writer-b' }),
        ),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.status).toBe('rejected');
      if (rejected?.status === 'rejected') {
        expect(rejected.reason).toMatchObject({ code: 'REVISION_CONFLICT', details: { currentRevision: 8 } });
      }
      expect(repository.get('project-a')?.draftRevision).toBe(8);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM map_design_idempotency
        WHERE project_id = ? AND operation = 'revision.restore'`).get('project-a')).toEqual({ count: 1 });
      expect(envelopes).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it('rechecks the receipt inside BEGIN IMMEDIATE when two connections race the same restore', async () => {
    const second = secondConnection();
    try {
      const barrier = createBarrier();
      const envelopes: MapRevisionEventEnvelope[] = [];
      const one = restoreService(db, eventBus(envelopes), barrier);
      const two = restoreService(second, eventBus(envelopes), barrier);
      const input = restoreInput({ idempotencyKey: 'restore-same-race' });

      const [left, right] = await Promise.all([
        one.restore(uiContext('request-same-a'), 1, input),
        two.restore(uiContext('request-same-b'), 1, input),
      ]);

      expect(left).toEqual(right);
      expect(repository.get('project-a')?.draftRevision).toBe(8);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM map_design_idempotency
        WHERE project_id = ? AND operation = 'revision.restore'`).get('project-a')).toEqual({ count: 1 });
      expect(envelopes).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it('rechecks immutable revision evidence after beforeImmediate without partially restoring', async () => {
    const second = secondConnection();
    const before = storedState('project-a');
    try {
      const service = restoreService(db, eventBus(publishedEnvelopes), async () => {
        second.prepare(`UPDATE map_design_revisions SET style_hash = ?
          WHERE project_id = ? AND revision = ?`).run('9'.repeat(64), 'project-a', 1);
      });

      await expect(service.restore(
        uiContext('request-evidence-race'),
        1,
        restoreInput({ idempotencyKey: 'restore-evidence-race' }),
      )).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });

      expect(repository.get('project-a')?.draftRevision).toBe(7);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM map_design_idempotency
        WHERE project_id = ? AND operation = 'revision.restore'`).get('project-a')).toEqual({ count: 0 });
      expect((storedState('project-a') as { project: unknown }).project)
        .toEqual((before as { project: unknown }).project);
      expect(publishedEnvelopes).toEqual([]);
    } finally {
      second.close();
    }
  });

  async function seedProject(projectId: string, currentColor: string): Promise<void> {
    const currentStyle = style(projectId, currentColor);
    const [styleBlob, semanticBlob, sourceBlob] = await Promise.all([
      blobStore.putJson(projectId, 'styles', currentStyle),
      blobStore.putJson(projectId, 'semantics', semantics),
      blobStore.putJson(projectId, 'sources', {
        kind: 'tilejson',
        digest: 'a'.repeat(64),
        mediaType: 'application/json',
        byteLength: 1,
        resourceCount: 1,
        capturedAt: NOW,
      }),
    ]);
    db.prepare(`INSERT INTO projects (id, title, runtime_json, created_at, updated_at)
      VALUES (?, ?, '{}', ?, ?)`).run(projectId, projectId, NOW, NOW);
    db.prepare(`INSERT INTO map_design_projects (
      project_id, lifecycle_state, source_kind, source_manifest_digest,
      design_system_id, design_system_digest, draft_revision, draft_style_digest,
      draft_style_hash, draft_semantic_digest, committed_revision, created_at, updated_at
    ) VALUES (?, 'ready', 'tilejson', ?, ?, ?, 7, ?, ?, ?, 1, ?, ?)`).run(
      projectId,
      sourceBlob.digest,
      CURRENT_SYSTEM.id,
      CURRENT_SYSTEM.digest,
      styleBlob.digest,
      await sha256CanonicalJson(currentStyle),
      semanticBlob.digest,
      NOW,
      NOW,
    );
    db.prepare(`INSERT INTO map_design_idempotency (
      project_id, operation, idempotency_key, request_digest, response_json, created_at
    ) VALUES (?, 'fixture.read-witness', ?, ?, '{}', ?)`).run(
      projectId,
      `${projectId}-fixture-key`,
      'f'.repeat(64),
      NOW,
    );
    db.prepare(`INSERT INTO map_design_event_outbox (project_id, event_json, occurred_at)
      VALUES (?, ?, ?)`).run(
      projectId,
      JSON.stringify({ type: 'fixture.seeded', occurredAt: NOW, payload: { projectId } }),
      NOW,
    );
  }

  async function seedImportRevision(projectId: string, color: string): Promise<void> {
    const importedStyle = style(projectId, color);
    const [styleBlob, semanticBlob, sourceBlob] = await Promise.all([
      blobStore.putJson(projectId, 'styles', importedStyle),
      blobStore.putJson(projectId, 'semantics', semantics),
      blobStore.putJson(projectId, 'sources', {
        kind: 'geojson',
        digest: 'c'.repeat(64),
        mediaType: 'application/json',
        byteLength: 1,
        resourceCount: 1,
        capturedAt: NOW,
      }),
    ]);
    const styleHash = await sha256CanonicalJson(importedStyle);
    const attestation = createMapImportAttestation({
      version: 1,
      kind: 'import',
      projectId,
      revision: 0,
      sourceManifestDigest: sourceBlob.digest,
      styleDigest: styleBlob.digest,
      styleHash,
      semanticDigest: semanticBlob.digest,
      designSystemId: 'quiet-atlas',
      designSystemDigest: IMPORT_SYSTEM.digest,
      importedAt: NOW,
    });
    const attestationBlob = await blobStore.putJson(projectId, 'attestations', attestation);
    db.prepare(`INSERT INTO map_design_revisions (
      project_id, revision, draft_revision, style_digest, style_hash, semantic_digest,
      source_manifest_digest, design_system_digest, preview_id, attestation_digest,
      run_id, created_at
    ) VALUES (?, 0, 0, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`).run(
      projectId,
      styleBlob.digest,
      styleHash,
      semanticBlob.digest,
      sourceBlob.digest,
      IMPORT_SYSTEM.digest,
      attestationBlob.digest,
      NOW,
    );
  }

  async function seedRuntimeRevision(projectId: string, revision: number, color: string): Promise<void> {
    const historicalStyle = style(projectId, color);
    const historicalSemantics = {
      version: 1 as const,
      groups: [{
        id: 'roads',
        label: `Historical roads ${revision}`,
        role: 'roads',
        layerIds: ['roads'],
        sourceIds: ['base'],
      }],
    };
    const [styleBlob, semanticBlob, sourceBlob] = await Promise.all([
      blobStore.putJson(projectId, 'styles', historicalStyle),
      blobStore.putJson(projectId, 'semantics', historicalSemantics),
      blobStore.putJson(projectId, 'sources', {
        kind: 'style',
        digest: 'b'.repeat(64),
        mediaType: 'application/json',
        byteLength: 1,
        resourceCount: 1,
        capturedAt: NOW,
      }),
    ]);
    const styleHash = await sha256CanonicalJson(historicalStyle);
    const attestation = createMapRevisionAttestation({
      schemaVersion: 1,
      kind: 'runtime',
      projectId,
      revision,
      draftRevision: revision,
      style: { digest: styleBlob.digest, hash: styleHash },
      semantics: { digest: semanticBlob.digest },
      source: { manifestDigest: sourceBlob.digest },
      designSystem: { id: HISTORICAL_SYSTEM.id, digest: HISTORICAL_SYSTEM.digest },
      preview: {
        id: `preview-${projectId}-${revision}`,
        pngDigest: '1'.repeat(64),
        reportDigest: '2'.repeat(64),
        validationDigest: '3'.repeat(64),
      },
      runtime: { id: 'codex', version: '1.0.0', adapter: 'Codex' },
      run: { id: `run-${projectId}-${revision}` },
      model: { id: 'gpt-5', provider: 'openai' },
      committedAt: NOW,
    });
    const attestationBlob = await blobStore.putJson(projectId, 'attestations', attestation);
    db.prepare(`INSERT INTO map_design_revisions (
      project_id, revision, draft_revision, style_digest, style_hash, semantic_digest,
      source_manifest_digest, design_system_digest, preview_id, attestation_digest,
      run_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      projectId,
      revision,
      revision,
      styleBlob.digest,
      styleHash,
      semanticBlob.digest,
      sourceBlob.digest,
      HISTORICAL_SYSTEM.digest,
      attestation.preview.id,
      attestationBlob.digest,
      attestation.run.id,
      NOW,
    );
  }

  async function replaceRevisionStyle(
    projectId: string,
    revisionNumber: number,
    replacement: ReturnType<typeof style>,
  ): Promise<void> {
    const revision = repository.getRevision(projectId, revisionNumber)!;
    const styleBlob = await blobStore.putJson(projectId, 'styles', replacement);
    const styleHash = await sha256CanonicalJson(replacement);
    const attestation = createMapRevisionAttestation({
      schemaVersion: 1,
      kind: 'runtime',
      projectId,
      revision: revisionNumber,
      draftRevision: revision.draftRevision,
      style: { digest: styleBlob.digest, hash: styleHash },
      semantics: { digest: revision.semanticDigest },
      source: { manifestDigest: revision.sourceManifestDigest },
      designSystem: { id: HISTORICAL_SYSTEM.id, digest: HISTORICAL_SYSTEM.digest },
      preview: {
        id: revision.previewId,
        pngDigest: '1'.repeat(64),
        reportDigest: '2'.repeat(64),
        validationDigest: '3'.repeat(64),
      },
      runtime: { id: 'codex', version: '1.0.0', adapter: 'Codex' },
      run: { id: revision.runId },
      model: { id: 'gpt-5', provider: 'openai' },
      committedAt: revision.createdAt,
    });
    const attestationBlob = await blobStore.putJson(projectId, 'attestations', attestation);
    db.prepare(`UPDATE map_design_revisions
      SET style_digest = ?, style_hash = ?, attestation_digest = ?
      WHERE project_id = ? AND revision = ?`).run(
      styleBlob.digest,
      styleHash,
      attestationBlob.digest,
      projectId,
      revisionNumber,
    );
  }

  async function replaceRevisionSemantics(
    projectId: string,
    revisionNumber: number,
    replacement: unknown,
  ): Promise<void> {
    const revision = repository.getRevision(projectId, revisionNumber)!;
    const semanticBlob = await blobStore.putJson(projectId, 'semantics', replacement);
    const attestation = await readRuntimeAttestation(projectId, revisionNumber);
    const attestationBlob = await blobStore.putJson(projectId, 'attestations', createMapRevisionAttestation({
      ...attestation,
      semantics: { digest: semanticBlob.digest },
    }));
    db.prepare(`UPDATE map_design_revisions
      SET semantic_digest = ?, attestation_digest = ?
      WHERE project_id = ? AND revision = ?`).run(
      semanticBlob.digest,
      attestationBlob.digest,
      projectId,
      revisionNumber,
    );
    expect(revision.semanticDigest).not.toBe(semanticBlob.digest);
  }

  async function readRuntimeAttestation(projectId: string, revisionNumber: number): Promise<RuntimeAttestation> {
    const revision = repository.getRevision(projectId, revisionNumber)!;
    return blobStore.getJson<RuntimeAttestation>(projectId, 'attestations', revision.attestationDigest);
  }

  async function replaceAttestation(
    projectId: string,
    revisionNumber: number,
    attestation: unknown,
  ): Promise<void> {
    const attestationBlob = await blobStore.putJson(projectId, 'attestations', attestation);
    db.prepare(`UPDATE map_design_revisions SET attestation_digest = ?
      WHERE project_id = ? AND revision = ?`).run(attestationBlob.digest, projectId, revisionNumber);
  }

  function storedState(projectId: string): unknown {
    return {
      project: db.prepare(`SELECT * FROM map_design_projects WHERE project_id = ?`).get(projectId),
      revisions: db.prepare(`SELECT * FROM map_design_revisions
        WHERE project_id = ? ORDER BY revision`).all(projectId),
      idempotency: db.prepare(`SELECT * FROM map_design_idempotency
        WHERE project_id = ? ORDER BY operation, idempotency_key`).all(projectId),
      outbox: db.prepare(`SELECT * FROM map_design_event_outbox
        WHERE project_id = ? ORDER BY sequence`).all(projectId),
    };
  }

  function restoreInput(overrides: Partial<MapRestoreRevisionInput> = {}): MapRestoreRevisionInput {
    return {
      expectedDraftRevision: 7,
      idempotencyKey: 'restore-ui-r8-v1',
      confirmReplaceDraft: true,
      intentSummary: 'Restore revision 1 as a new draft',
      ...overrides,
    };
  }

  function uiContext(requestId: string, isProjectRunning: () => boolean = () => false) {
    return {
      kind: 'ui' as const,
      projectId: 'project-a',
      requestId,
      isProjectRunning,
    };
  }

  function eventBus(envelopes: MapRevisionEventEnvelope[]): MapRevisionEventBus {
    return {
      appendInTransaction(database: Database.Database, projectId: string, event: MapStudioEvent): number {
        const result = database.prepare(`INSERT INTO map_design_event_outbox
          (project_id, event_json, occurred_at) VALUES (?, ?, ?)`).run(
          projectId,
          JSON.stringify(event),
          event.occurredAt,
        );
        return Number(result.lastInsertRowid);
      },
      publish(envelope): void {
        envelopes.push(envelope);
      },
    };
  }

  function restoreService(
    database: Database.Database,
    bus: MapRevisionEventBus,
    beforeImmediate?: (checkpoint: MapRevisionImmediateCheckpoint) => void | Promise<void>,
  ): MapRevisionService {
    return new MapRevisionService({
      db: database,
      blobStore,
      loadDesignSystem,
      runStore: { get: () => null },
      eventBus: bus,
      now: () => NOW,
      ...(beforeImmediate ? { beforeImmediate } : {}),
    });
  }

  function mutationService(bus: MapRevisionEventBus): MapRevisionService {
    return new MapRevisionService({
      db,
      blobStore,
      loadDesignSystem,
      runStore: {
        get: (runId) => runId === 'run-discard'
          ? {
              runId,
              projectId: 'project-a',
              runtime: { id: 'codex', version: '1.0.0', adapter: 'native' },
              model: { id: 'gpt-5', provider: 'openai' },
            }
          : null,
      },
      eventBus: bus,
      now: () => NOW,
    });
  }

  function secondConnection(): Database.Database {
    const second = new Database(join(root, 'map-design.sqlite'));
    second.pragma('journal_mode = WAL');
    second.pragma('foreign_keys = ON');
    return second;
  }

  function createBarrier(): (checkpoint: MapRevisionImmediateCheckpoint) => Promise<void> {
    let arrived = 0;
    let release!: () => void;
    const settled = new Promise<void>((resolve) => { release = resolve; });
    return async () => {
      arrived += 1;
      if (arrived === 2) release();
      await settled;
    };
  }

  async function expectSafeEvidenceError(operation: Promise<unknown>): Promise<void> {
    try {
      await operation;
      throw new Error('expected historical evidence loading to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(MapDraftError);
      expect(error).toMatchObject({ code: expect.stringMatching(/^(?:SOURCE_UNAVAILABLE|INTERNAL)$/u) });
      const publicText = JSON.stringify({
        message: (error as MapDraftError).message,
        details: (error as MapDraftError).details,
      });
      expect(publicText).not.toContain(root);
      expect(publicText).not.toContain('/styles/');
      expect(publicText).not.toContain('/attestations/');
    }
  }
});
