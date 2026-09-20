import type Database from 'better-sqlite3';
import {
  MapDigestSchema,
  MapCommitRevisionInputSchema,
  MapCommitRevisionOutputSchema,
  MapDiscardDraftInputSchema,
  MapDiscardDraftOutputSchema,
  MapIdentifierSchema,
  MapRevisionSnapshotOutputSchema,
  MapRestoreRevisionInputSchema,
  MapRestoreRevisionOutputSchema,
  MapSourceManifestSchema,
  MapSafeRevisionSchema,
  MapStudioEventSchema,
  MapTimestampSchema,
  SemanticDocumentSchema,
  type MapCommitRevisionInput,
  type MapCommitRevisionOutput,
  type MapDiscardDraftInput,
  type MapDiscardDraftOutput,
  type MapRevisionSnapshotOutput,
  type MapRestoreRevisionInput,
  type MapRestoreRevisionOutput,
  type MapStudioEvent,
  type MapToolName,
} from '@mapseekai/map-design-contracts';
import { sha256CanonicalJson } from 'maplibre-style-tools/bridge';
import { validateStyleDocument, type StyleDocument } from 'maplibre-style-tools/core';

import { canonicalJson } from '../storage/canonical-json.js';
import type { MapDesignBlobStore, MapDesignProjectRepository } from '../storage/types.js';
import { MapDesignSqliteProjectRepository } from '../storage/project-repository.js';
import type { LoadedMapDesignSystem } from '../validation/design-system-loader.js';
import { validateMapDesign } from '../validation/map-validator.js';
import {
  createMapRevisionAttestation,
  parseMapRevisionProvenance,
} from './attestation.js';
import type { MapRunContext } from './draft-service.js';
import { MapDraftError, invalidInput, isMapDraftError } from './errors.js';
import { inspectMapStyleRoot } from './map-style-summary.js';
import type { MapDesignMutationActor } from './event-bus.js';
import { requestDigest } from './request-digest.js';
import {
  loadRevisionEvidence,
  publicRevisionFromRecord,
  type VerifiedRevisionEvidence,
  validationOutputForRevision,
} from './revision-evidence.js';

type SqliteDb = Database.Database;
type RevisionOperation = Extract<MapToolName, 'map_commit_revision' | 'map_discard_draft'> | 'revision.restore';
type RevisionEvent = Extract<MapStudioEvent, { type: 'revision.committed' | 'draft.discarded' | 'draft.restored' }>;

export type MapRevisionMutationContext =
  | { kind: 'run'; projectId: string; runId: string }
  | {
      kind: 'ui';
      projectId: string;
      requestId: string;
      isProjectRunning(): boolean;
    };

export interface MapTrustedRunRecord {
  runId: string;
  projectId: string;
  runtime: {
    id: string;
    version: string;
    adapter: string;
  };
  model: {
    id: string;
    provider: string;
  };
}

/** Adapter over MapDesign's durable run query (`design.runs.get/statusBody`). */
export interface MapTrustedRunStore {
  get(runId: string): MapTrustedRunRecord | null;
}

export interface MapRevisionEventEnvelope {
  projectId: string;
  actor: MapDesignMutationActor;
  idempotencyKey: string;
  requestDigest: string;
  operation: RevisionOperation;
  event: RevisionEvent;
}

export interface MapRevisionEventBus {
  appendInTransaction?(db: SqliteDb, projectId: string, event: MapStudioEvent): number;
  publish(envelope: MapRevisionEventEnvelope): Promise<void> | void;
}

export interface MapRevisionImmediateCheckpoint {
  projectId: string;
  operation: RevisionOperation;
  idempotencyKey: string;
  requestDigest: string;
}

export interface MapRevisionServiceDependencies {
  db: SqliteDb;
  blobStore: MapDesignBlobStore;
  repository?: Pick<MapDesignProjectRepository, 'getRevision'>;
  runStore: MapTrustedRunStore;
  eventBus: MapRevisionEventBus;
  loadDesignSystem(input: { id: string; digest: string }): Promise<LoadedMapDesignSystem>;
  now?: () => string;
  /** Test-only coordination hook between immutable blob creation and BEGIN IMMEDIATE. */
  beforeImmediate?(checkpoint: MapRevisionImmediateCheckpoint): void | Promise<void>;
}

interface ProjectRow {
  projectId: string;
  lifecycleState: string;
  sourceManifestDigest: string | null;
  designSystemId: string;
  designSystemDigest: string;
  draftRevision: number;
  draftStyleDigest: string | null;
  draftStyleHash: string | null;
  draftSemanticDigest: string | null;
  committedRevision: number | null;
}

interface PreviewRow {
  id: string;
  projectId: string;
  draftRevision: number;
  styleDigest: string;
  styleHash: string;
  status: string;
  pngDigest: string | null;
  reportDigest: string | null;
  validationDigest: string | null;
  expiresAt: string;
}

interface IdempotencyRow {
  requestDigest: string;
  responseJson: string;
}

interface PersistedResult<T> {
  replayed: boolean;
  output: T;
}

const UNKNOWN_VALIDATION_SUMMARY = {
  status: 'unknown' as const,
  errors: 0,
  warnings: 0,
  infos: 0,
  totalFindings: 0,
  returnedFindings: 0,
  omittedFindings: 0,
};

export class MapRevisionService {
  private readonly now: () => string;
  private readonly evidenceRepository: Pick<MapDesignProjectRepository, 'getRevision'>;

  constructor(private readonly deps: MapRevisionServiceDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.evidenceRepository = deps.repository ?? new MapDesignSqliteProjectRepository(deps.db);
  }

  async getSnapshot(projectId: string, revision: number): Promise<MapRevisionSnapshotOutput> {
    return this.mapUnexpectedFailure(async () => {
      const parsedProjectId = parseInput(MapIdentifierSchema, projectId);
      const parsedRevision = parseInput(MapSafeRevisionSchema, revision);
      const evidence = await loadRevisionEvidence(parsedProjectId, parsedRevision, {
        repository: this.evidenceRepository,
        blobStore: this.deps.blobStore,
        loadDesignSystem: this.deps.loadDesignSystem,
      });
      const validation = validateMapDesign({
        style: evidence.style,
        semantics: evidence.semantics,
        sourceManifest: evidence.sourceManifest,
        designSystem: evidence.designSystem,
      });
      return MapRevisionSnapshotOutputSchema.parse({
        revision: publicRevisionFromRecord(evidence.revision),
        style: evidence.style,
        semantics: evidence.semantics,
        validation: validationOutputForRevision(evidence, validation),
        inspect: inspectMapStyleRoot(evidence.style),
      });
    });
  }

  async restore(
    context: MapRevisionMutationContext,
    revision: number,
    input: unknown | MapRestoreRevisionInput,
  ): Promise<MapRestoreRevisionOutput> {
    return this.mapUnexpectedFailure(() => this.restoreUnchecked(context, revision, input));
  }

  private async restoreUnchecked(
    context: MapRevisionMutationContext,
    revision: number,
    input: unknown | MapRestoreRevisionInput,
  ): Promise<MapRestoreRevisionOutput> {
    const trustedContext = requireTrustedRestoreContext(context);
    const parsedRevision = parseInput(MapSafeRevisionSchema, revision);
    const parsed = parseInput(MapRestoreRevisionInputSchema, input);
    const digest = digestInput({ revision: parsedRevision, input: parsed });
    const operation = 'revision.restore' as const;
    const replay = this.replay(
      trustedContext.projectId,
      operation,
      parsed.idempotencyKey,
      digest,
      MapRestoreRevisionOutputSchema.parse,
    );
    if (replay) return replay;

    const evidence = await loadRevisionEvidence(trustedContext.projectId, parsedRevision, {
      repository: this.evidenceRepository,
      blobStore: this.deps.blobStore,
      loadDesignSystem: this.deps.loadDesignSystem,
    });
    assertProjectIdle(trustedContext);
    const validation = validateMapDesign({
      style: evidence.style,
      semantics: evidence.semantics,
      sourceManifest: evidence.sourceManifest,
      designSystem: evidence.designSystem,
    });
    assertValidRevision(validation.findings);

    const project = this.readProject(trustedContext.projectId);
    this.assertReady(project);
    this.assertDraftRevision(project, parsed.expectedDraftRevision);
    const occurredAt = this.timestamp();
    const output = parseOutput(MapRestoreRevisionOutputSchema.parse, {
      draftRevision: increment(project.draftRevision),
      restoredRevision: evidence.revision.revision,
      styleHash: evidence.revision.styleHash,
      semanticDigest: evidence.revision.semanticDigest,
      validationSummary: validation.summary,
    });

    await this.beforeImmediate({
      projectId: trustedContext.projectId,
      operation,
      idempotencyKey: parsed.idempotencyKey,
      requestDigest: digest,
    });
    assertProjectIdle(trustedContext);
    const persisted = this.persistRestore({
      context: trustedContext,
      parsed,
      digest,
      project,
      evidence,
      output,
      occurredAt,
    });
    if (!persisted.replayed) {
      this.publishAfterCommit({
        projectId: trustedContext.projectId,
        actor: { kind: 'ui', requestId: trustedContext.requestId },
        operation,
        key: parsed.idempotencyKey,
        digest,
        event: MapStudioEventSchema.parse({
          type: 'draft.restored',
          occurredAt,
          payload: {
            draftRevision: persisted.output.draftRevision,
            restoredRevision: persisted.output.restoredRevision,
            styleHash: persisted.output.styleHash,
          },
        }) as RevisionEvent,
      });
    }
    return persisted.output;
  }

  async commit(
    context: MapRunContext,
    input: unknown | MapCommitRevisionInput,
  ): Promise<MapCommitRevisionOutput> {
    return this.mapUnexpectedFailure(() => this.commitUnchecked(context, input));
  }

  private async commitUnchecked(
    context: MapRunContext,
    input: unknown | MapCommitRevisionInput,
  ): Promise<MapCommitRevisionOutput> {
    const parsed = parseInput(MapCommitRevisionInputSchema, input);
    const digest = digestInput(parsed);
    const operation = 'map_commit_revision' as const;
    const project = this.readProject(context.projectId);
    this.assertReady(project);
    const run = this.requireTrustedRun(context);
    const replay = this.replay(
      project.projectId,
      operation,
      parsed.idempotencyKey,
      digest,
      MapCommitRevisionOutputSchema.parse,
    );
    if (replay) return replay;
    this.assertDraftRevision(project, parsed.expectedRevision);

    const committedAt = this.timestamp();
    const preview = this.requireCurrentPassedPreview(parsed.previewId, project, committedAt);
    await this.validateCommitEvidence(project, preview);
    const revision = nextRevision(project.committedRevision);
    const attestation = this.attestation(project, preview, run, revision, committedAt);
    const attestationBlob = await this.putAttestation(project.projectId, attestation);
    const output = parseOutput(MapCommitRevisionOutputSchema.parse, {
      revision,
      draftRevision: project.draftRevision,
      styleHash: project.draftStyleHash,
      attestationDigest: attestationBlob.digest,
      committedAt,
    });

    await this.beforeImmediate({
      projectId: project.projectId,
      operation,
      idempotencyKey: parsed.idempotencyKey,
      requestDigest: digest,
    });
    const persisted = this.persistCommit({
      context,
      parsed,
      digest,
      project,
      preview,
      run,
      output,
      committedAt,
    });
    if (!persisted.replayed) {
      this.publishAfterCommit({
        projectId: context.projectId,
        actor: { kind: 'run', runId: context.runId },
        operation,
        key: parsed.idempotencyKey,
        digest,
        event: MapStudioEventSchema.parse({
          type: 'revision.committed',
          occurredAt: committedAt,
          payload: {
            draftRevision: persisted.output.draftRevision,
            styleHash: persisted.output.styleHash,
            revision: persisted.output.revision,
            committedAt: persisted.output.committedAt,
          },
        }) as RevisionEvent,
      });
    }
    return persisted.output;
  }

  async discard(
    context: MapRunContext,
    input: unknown | MapDiscardDraftInput,
  ): Promise<MapDiscardDraftOutput> {
    return this.mapUnexpectedFailure(() => this.discardUnchecked(context, input));
  }

  private async discardUnchecked(
    context: MapRunContext,
    input: unknown | MapDiscardDraftInput,
  ): Promise<MapDiscardDraftOutput> {
    const parsed = parseInput(MapDiscardDraftInputSchema, input);
    const digest = digestInput(parsed);
    const operation = 'map_discard_draft' as const;
    const project = this.readProject(context.projectId);
    this.assertReady(project);
    this.requireTrustedRun(context);
    const replay = this.replay(
      project.projectId,
      operation,
      parsed.idempotencyKey,
      digest,
      MapDiscardDraftOutputSchema.parse,
    );
    if (replay) return replay;
    this.assertDraftRevision(project, parsed.expectedRevision);
    if (project.committedRevision === null) throw noCommittedRevision();
    const committed = await loadRevisionEvidence(project.projectId, project.committedRevision, {
      repository: this.evidenceRepository,
      blobStore: this.deps.blobStore,
      loadDesignSystem: this.deps.loadDesignSystem,
    });
    assertValidRevision(validateMapDesign({
      style: committed.style,
      semantics: committed.semantics,
      sourceManifest: committed.sourceManifest,
      designSystem: committed.designSystem,
    }).findings);
    const occurredAt = this.timestamp();
    const output = parseOutput(MapDiscardDraftOutputSchema.parse, {
      draftRevision: increment(project.draftRevision),
      restoredCommittedRevision: committed.revision.revision,
      styleHash: committed.revision.styleHash,
      semanticDigest: committed.revision.semanticDigest,
      validationSummary: UNKNOWN_VALIDATION_SUMMARY,
    });

    await this.beforeImmediate({
      projectId: project.projectId,
      operation,
      idempotencyKey: parsed.idempotencyKey,
      requestDigest: digest,
    });
    const persisted = this.persistDiscard({ context, parsed, digest, project, committed, output, occurredAt });
    if (!persisted.replayed) {
      this.publishAfterCommit({
        projectId: context.projectId,
        actor: { kind: 'run', runId: context.runId },
        operation,
        key: parsed.idempotencyKey,
        digest,
        event: MapStudioEventSchema.parse({
          type: 'draft.discarded',
          occurredAt,
          payload: {
            draftRevision: persisted.output.draftRevision,
            styleHash: persisted.output.styleHash,
            restoredCommittedRevision: persisted.output.restoredCommittedRevision,
          },
        }) as RevisionEvent,
      });
    }
    return persisted.output;
  }

  private persistRestore(args: {
    context: Extract<MapRevisionMutationContext, { kind: 'ui' }>;
    parsed: MapRestoreRevisionInput;
    digest: string;
    project: ProjectRow;
    evidence: VerifiedRevisionEvidence;
    output: MapRestoreRevisionOutput;
    occurredAt: string;
  }): PersistedResult<MapRestoreRevisionOutput> {
    const transaction = this.deps.db.transaction((): PersistedResult<MapRestoreRevisionOutput> => {
      assertProjectIdle(args.context);
      const replay = this.replay(
        args.context.projectId,
        'revision.restore',
        args.parsed.idempotencyKey,
        args.digest,
        MapRestoreRevisionOutputSchema.parse,
      );
      if (replay) return { replayed: true, output: replay };
      const current = this.readProject(args.context.projectId);
      this.assertReady(current);
      this.assertDraftRevision(current, args.parsed.expectedDraftRevision);
      if (current.committedRevision !== args.project.committedRevision) {
        throw committedPointerConflict(current);
      }
      const revision = this.evidenceRepository.getRevision(
        current.projectId,
        args.evidence.revision.revision,
      );
      if (!revision || canonicalJson(revision) !== canonicalJson(args.evidence.revision)) {
        throw historicalEvidenceChanged();
      }
      const validation = validateMapDesign({
        style: args.evidence.style,
        semantics: args.evidence.semantics,
        sourceManifest: args.evidence.sourceManifest,
        designSystem: args.evidence.designSystem,
      });
      assertValidRevision(validation.findings);
      if (increment(current.draftRevision) !== args.output.draftRevision
        || canonicalJson(validation.summary) !== canonicalJson(args.output.validationSummary)) {
        throw new MapDraftError('INTERNAL', 'The map restore response is inconsistent.');
      }
      const appendEvent = this.deps.eventBus.appendInTransaction;
      if (!appendEvent) {
        throw new MapDraftError('INTERNAL', 'The map restore outbox is unavailable.');
      }

      const changed = this.deps.db.prepare(`UPDATE map_design_projects SET
        source_kind = ?, source_manifest_digest = ?,
        design_system_id = ?, design_system_digest = ?,
        draft_revision = ?, draft_style_digest = ?, draft_style_hash = ?,
        draft_semantic_digest = ?, updated_at = ?
        WHERE project_id = ? AND lifecycle_state = 'ready'
          AND draft_revision = ? AND committed_revision IS ?`).run(
        args.evidence.sourceManifest.kind,
        revision.sourceManifestDigest,
        args.evidence.designSystem.id,
        revision.designSystemDigest,
        args.output.draftRevision,
        revision.styleDigest,
        revision.styleHash,
        revision.semanticDigest,
        args.occurredAt,
        current.projectId,
        args.parsed.expectedDraftRevision,
        args.project.committedRevision,
      );
      if (changed.changes !== 1) throw draftConflict(this.readProject(current.projectId));
      this.insertReceipt(
        current.projectId,
        'revision.restore',
        args.parsed.idempotencyKey,
        args.digest,
        args.output,
        args.occurredAt,
      );
      appendEvent.call(this.deps.eventBus, this.deps.db, current.projectId, MapStudioEventSchema.parse({
        type: 'draft.restored',
        occurredAt: args.occurredAt,
        payload: {
          draftRevision: args.output.draftRevision,
          restoredRevision: args.output.restoredRevision,
          styleHash: args.output.styleHash,
        },
      }));
      return { replayed: false, output: args.output };
    });
    return this.runImmediate(transaction);
  }

  private persistCommit(args: {
    context: MapRunContext;
    parsed: MapCommitRevisionInput;
    digest: string;
    project: ProjectRow;
    preview: PreviewRow;
    run: MapTrustedRunRecord;
    output: MapCommitRevisionOutput;
    committedAt: string;
  }): PersistedResult<MapCommitRevisionOutput> {
    const transaction = this.deps.db.transaction((): PersistedResult<MapCommitRevisionOutput> => {
      const linearizedAt = this.timestamp();
      const current = this.readProject(args.context.projectId);
      this.assertReady(current);
      const run = this.requireTrustedRun(args.context);
      if (canonicalJson(run) !== canonicalJson(args.run)) throw runNotAuthorized();
      const replay = this.replay(
        current.projectId,
        'map_commit_revision',
        args.parsed.idempotencyKey,
        args.digest,
        MapCommitRevisionOutputSchema.parse,
      );
      if (replay) return { replayed: true, output: replay };
      this.assertDraftRevision(current, args.parsed.expectedRevision);
      if (!sameProjectSnapshot(current, args.project)) throw committedPointerConflict(current);
      const preview = this.requireCurrentPassedPreview(args.parsed.previewId, current, linearizedAt);
      if (!samePreview(preview, args.preview)) throw new MapDraftError('PREVIEW_STALE', 'The map preview is stale.');
      if (nextRevision(current.committedRevision) !== args.output.revision) throw committedPointerConflict(current);

      this.deps.db.prepare(`INSERT INTO map_design_revisions (
        project_id, revision, draft_revision, style_digest, style_hash,
        semantic_digest, source_manifest_digest, design_system_digest,
        preview_id, attestation_digest, run_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        current.projectId,
        args.output.revision,
        current.draftRevision,
        current.draftStyleDigest,
        current.draftStyleHash,
        current.draftSemanticDigest,
        current.sourceManifestDigest,
        current.designSystemDigest,
        preview.id,
        args.output.attestationDigest,
        run.runId,
        args.committedAt,
      );
      const changed = this.deps.db.prepare(`UPDATE map_design_projects SET
        committed_revision = ?, updated_at = ?
        WHERE project_id = ? AND lifecycle_state = 'ready'
          AND draft_revision = ? AND committed_revision IS ?`).run(
        args.output.revision,
        args.committedAt,
        current.projectId,
        args.parsed.expectedRevision,
        args.project.committedRevision,
      );
      if (changed.changes !== 1) throw committedPointerConflict(this.readProject(current.projectId));
      this.insertReceipt(
        current.projectId,
        'map_commit_revision',
        args.parsed.idempotencyKey,
        args.digest,
        args.output,
        args.committedAt,
      );
      this.deps.eventBus.appendInTransaction?.(this.deps.db, current.projectId, MapStudioEventSchema.parse({
        type: 'revision.committed',
        occurredAt: args.committedAt,
        payload: {
          draftRevision: args.output.draftRevision,
          styleHash: args.output.styleHash,
          revision: args.output.revision,
          committedAt: args.output.committedAt,
        },
      }));
      return { replayed: false, output: args.output };
    });
    return this.runImmediate(transaction);
  }

  private persistDiscard(args: {
    context: MapRunContext;
    parsed: MapDiscardDraftInput;
    digest: string;
    project: ProjectRow;
    committed: VerifiedRevisionEvidence;
    output: MapDiscardDraftOutput;
    occurredAt: string;
  }): PersistedResult<MapDiscardDraftOutput> {
    const transaction = this.deps.db.transaction((): PersistedResult<MapDiscardDraftOutput> => {
      const current = this.readProject(args.context.projectId);
      this.assertReady(current);
      this.requireTrustedRun(args.context);
      const replay = this.replay(
        current.projectId,
        'map_discard_draft',
        args.parsed.idempotencyKey,
        args.digest,
        MapDiscardDraftOutputSchema.parse,
      );
      if (replay) return { replayed: true, output: replay };
      this.assertDraftRevision(current, args.parsed.expectedRevision);
      if (current.committedRevision === null) throw noCommittedRevision();
      if (current.committedRevision !== args.project.committedRevision) throw committedPointerConflict(current);
      const committed = this.evidenceRepository.getRevision(current.projectId, current.committedRevision);
      if (!committed || canonicalJson(committed) !== canonicalJson(args.committed.revision)) {
        throw historicalEvidenceChanged();
      }
      assertValidRevision(validateMapDesign({
        style: args.committed.style,
        semantics: args.committed.semantics,
        sourceManifest: args.committed.sourceManifest,
        designSystem: args.committed.designSystem,
      }).findings);
      if (increment(current.draftRevision) !== args.output.draftRevision) throw draftConflict(current);

      const changed = this.deps.db.prepare(`UPDATE map_design_projects SET
        source_kind = ?, source_manifest_digest = ?,
        design_system_id = ?, design_system_digest = ?,
        draft_revision = ?, draft_style_digest = ?, draft_style_hash = ?,
        draft_semantic_digest = ?, updated_at = ?
        WHERE project_id = ? AND lifecycle_state = 'ready'
          AND draft_revision = ? AND committed_revision IS ?`).run(
        args.committed.sourceManifest.kind,
        committed.sourceManifestDigest,
        args.committed.designSystem.id,
        committed.designSystemDigest,
        args.output.draftRevision,
        committed.styleDigest,
        committed.styleHash,
        committed.semanticDigest,
        args.occurredAt,
        current.projectId,
        args.parsed.expectedRevision,
        current.committedRevision,
      );
      if (changed.changes !== 1) throw draftConflict(this.readProject(current.projectId));
      this.insertReceipt(
        current.projectId,
        'map_discard_draft',
        args.parsed.idempotencyKey,
        args.digest,
        args.output,
        args.occurredAt,
      );
      this.deps.eventBus.appendInTransaction?.(this.deps.db, current.projectId, MapStudioEventSchema.parse({
        type: 'draft.discarded',
        occurredAt: args.occurredAt,
        payload: {
          draftRevision: args.output.draftRevision,
          styleHash: args.output.styleHash,
          restoredCommittedRevision: args.output.restoredCommittedRevision,
        },
      }));
      return { replayed: false, output: args.output };
    });
    return this.runImmediate(transaction);
  }

  private readProject(projectId: string): ProjectRow {
    const row = this.deps.db.prepare(`SELECT
      project_id AS projectId, lifecycle_state AS lifecycleState,
      source_manifest_digest AS sourceManifestDigest,
      design_system_id AS designSystemId, design_system_digest AS designSystemDigest,
      draft_revision AS draftRevision, draft_style_digest AS draftStyleDigest,
      draft_style_hash AS draftStyleHash, draft_semantic_digest AS draftSemanticDigest,
      committed_revision AS committedRevision
      FROM map_design_projects WHERE project_id = ?`).get(projectId) as ProjectRow | undefined;
    if (!row) throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
    if (!storedRevision(row.draftRevision)
      || (row.committedRevision !== null && !storedRevision(row.committedRevision))) {
      throw new MapDraftError('INTERNAL', 'The stored map project is invalid.');
    }
    return row;
  }

  private readPreview(previewId: string): PreviewRow | null {
    const row = this.deps.db.prepare(`SELECT
      id, project_id AS projectId, draft_revision AS draftRevision,
      style_digest AS styleDigest, style_hash AS styleHash, status,
      png_digest AS pngDigest, report_digest AS reportDigest,
      validation_digest AS validationDigest, expires_at AS expiresAt
      FROM map_design_previews WHERE id = ?`).get(previewId) as PreviewRow | undefined;
    if (!row) return null;
    if (!storedRevision(row.draftRevision)) throw new MapDraftError('INTERNAL', 'The stored map preview is invalid.');
    return row;
  }

  private async validateCommitEvidence(project: ProjectRow, preview: PreviewRow): Promise<void> {
    let style: StyleDocument;
    let semantics: ReturnType<typeof SemanticDocumentSchema.parse>;
    let sourceManifest: ReturnType<typeof MapSourceManifestSchema.parse>;
    let designSystem: LoadedMapDesignSystem;
    try {
      const [styleValue, semanticValue, sourceValue, loadedDesignSystem] = await Promise.all([
        this.deps.blobStore.getJson<unknown>(project.projectId, 'styles', project.draftStyleDigest!),
        this.deps.blobStore.getJson<unknown>(project.projectId, 'semantics', project.draftSemanticDigest!),
        this.deps.blobStore.getJson<unknown>(project.projectId, 'sources', project.sourceManifestDigest!),
        this.deps.loadDesignSystem({ id: project.designSystemId, digest: project.designSystemDigest }),
      ]);
      const styleResult = validateStyleDocument(styleValue);
      if (!styleResult.ok) throw new TypeError('invalid canonical Style');
      style = styleResult.style;
      semantics = SemanticDocumentSchema.parse(semanticValue);
      sourceManifest = MapSourceManifestSchema.parse(sourceValue);
      designSystem = loadedDesignSystem;
      if (designSystem.id !== project.designSystemId || designSystem.digest !== project.designSystemDigest) {
        throw new TypeError('design system binding mismatch');
      }
      if (await sha256CanonicalJson(style) !== project.draftStyleHash) {
        throw new TypeError('canonical Style hash mismatch');
      }
    } catch {
      throw new MapDraftError('INTERNAL', 'The canonical map revision evidence is unavailable.');
    }

    let png: Uint8Array;
    let report: PreviewReport;
    try {
      [png, report] = await Promise.all([
        this.deps.blobStore.getBytes(project.projectId, 'previews', preview.pngDigest!),
        this.deps.blobStore.getJson<unknown>(project.projectId, 'reports', preview.reportDigest!)
          .then(parsePreviewReport),
      ]);
      if (!hasPngSignature(png)
        || report.previewId !== preview.id
        || report.validationDigest !== preview.validationDigest) {
        throw new TypeError('preview evidence binding mismatch');
      }
    } catch {
      throw previewEvidenceFailed();
    }

    let validation: ReturnType<typeof validateMapDesign>;
    try {
      validation = validateMapDesign({ style, semantics, sourceManifest, designSystem });
    } catch {
      throw new MapDraftError('INTERNAL', 'The canonical map validation evidence is invalid.');
    }
    if (!validation.ok || validation.validationDigest !== preview.validationDigest) {
      throw previewEvidenceFailed();
    }
  }

  private requireCurrentPassedPreview(previewId: string, project: ProjectRow, at: string): PreviewRow {
    const preview = this.readPreview(previewId);
    if (!preview) throw new MapDraftError('PREVIEW_FAILED', 'A passed map preview is required.');
    if (preview.status === 'expired') throw new MapDraftError('PREVIEW_STALE', 'The map preview is stale.');
    if (preview.status !== 'passed') throw new MapDraftError('PREVIEW_FAILED', 'A passed map preview is required.');
    if (preview.projectId !== project.projectId
      || preview.draftRevision !== project.draftRevision
      || preview.styleDigest !== project.draftStyleDigest
      || preview.styleHash !== project.draftStyleHash
      || expired(preview.expiresAt, at)) {
      throw new MapDraftError('PREVIEW_STALE', 'The map preview is stale.');
    }
    if (!digest(preview.pngDigest) || !digest(preview.reportDigest) || !digest(preview.validationDigest)) {
      throw new MapDraftError('INTERNAL', 'The passed map preview evidence is invalid.');
    }
    return preview;
  }

  private requireTrustedRun(context: MapRunContext): MapTrustedRunRecord {
    let run: MapTrustedRunRecord | null;
    try {
      run = this.deps.runStore.get(context.runId);
    } catch {
      throw new MapDraftError('INTERNAL', 'The trusted run record could not be loaded.');
    }
    if (!run || run.runId !== context.runId || run.projectId !== context.projectId) throw runNotAuthorized();
    try {
      const provenance = parseMapRevisionProvenance({ runtime: run.runtime, model: run.model });
      return { ...run, ...provenance };
    } catch {
      throw new MapDraftError('INTERNAL', 'The trusted run provenance is incomplete.');
    }
  }

  private attestation(
    project: ProjectRow,
    preview: PreviewRow,
    run: MapTrustedRunRecord,
    revision: number,
    committedAt: string,
  ) {
    try {
      return createMapRevisionAttestation({
        schemaVersion: 1,
        kind: 'runtime',
        projectId: project.projectId,
        revision,
        draftRevision: project.draftRevision,
        style: { digest: project.draftStyleDigest, hash: project.draftStyleHash },
        semantics: { digest: project.draftSemanticDigest },
        source: { manifestDigest: project.sourceManifestDigest },
        designSystem: { id: project.designSystemId, digest: project.designSystemDigest },
        preview: {
          id: preview.id,
          pngDigest: preview.pngDigest,
          reportDigest: preview.reportDigest,
          validationDigest: preview.validationDigest,
        },
        runtime: run.runtime,
        run: { id: run.runId },
        model: run.model,
        committedAt,
      });
    } catch {
      throw new MapDraftError('INTERNAL', 'The map revision attestation could not be created.');
    }
  }

  private async putAttestation(projectId: string, attestation: unknown) {
    try {
      return await this.deps.blobStore.putJson(projectId, 'attestations', attestation);
    } catch {
      throw new MapDraftError('INTERNAL', 'The map revision attestation could not be stored.');
    }
  }

  private assertReady(project: ProjectRow): void {
    if (project.lifecycleState !== 'ready'
      || !digest(project.sourceManifestDigest)
      || !nonEmpty(project.designSystemId)
      || !digest(project.designSystemDigest)
      || !digest(project.draftStyleDigest)
      || !digest(project.draftStyleHash)
      || !digest(project.draftSemanticDigest)) {
      throw new MapDraftError('PROJECT_NOT_READY', 'The map project is not ready.');
    }
  }

  private assertDraftRevision(project: ProjectRow, expectedRevision: number): void {
    if (project.draftRevision !== expectedRevision) throw draftConflict(project);
  }

  private replay<T>(
    projectId: string,
    operation: RevisionOperation,
    key: string,
    requestIdentity: string,
    parse: (value: unknown) => T,
  ): T | null {
    const row = this.deps.db.prepare(`SELECT
      request_digest AS requestDigest, response_json AS responseJson
      FROM map_design_idempotency
      WHERE project_id = ? AND operation = ? AND idempotency_key = ?`).get(
      projectId,
      operation,
      key,
    ) as IdempotencyRow | undefined;
    if (!row) return null;
    if (row.requestDigest !== requestIdentity) {
      throw new MapDraftError('IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.');
    }
    try {
      return parse(JSON.parse(row.responseJson));
    } catch {
      throw new MapDraftError('INTERNAL', 'The stored mutation receipt is invalid.');
    }
  }

  private insertReceipt(
    projectId: string,
    operation: RevisionOperation,
    key: string,
    requestIdentity: string,
    output: MapCommitRevisionOutput | MapDiscardDraftOutput | MapRestoreRevisionOutput,
    createdAt: string,
  ): void {
    this.deps.db.prepare(`INSERT INTO map_design_idempotency
      (project_id, operation, idempotency_key, request_digest, response_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      projectId,
      operation,
      key,
      requestIdentity,
      canonicalJson(output),
      createdAt,
    );
  }

  private runImmediate<T>(transaction: { immediate(): T }): T {
    try {
      return transaction.immediate();
    } catch (error) {
      if (isMapDraftError(error)) throw error;
      throw new MapDraftError('INTERNAL', 'The map revision operation failed.');
    }
  }

  private async mapUnexpectedFailure<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isMapDraftError(error)) throw error;
      throw new MapDraftError('INTERNAL', 'The map revision operation failed.');
    }
  }

  private timestamp(): string {
    try {
      return MapTimestampSchema.parse(this.now());
    } catch {
      throw new MapDraftError('INTERNAL', 'The map revision clock is invalid.');
    }
  }

  private async beforeImmediate(checkpoint: MapRevisionImmediateCheckpoint): Promise<void> {
    await this.deps.beforeImmediate?.(checkpoint);
  }

  private publishAfterCommit(args: {
    projectId: string;
    actor: MapDesignMutationActor;
    operation: RevisionOperation;
    key: string;
    digest: string;
    event: RevisionEvent;
  }): void {
    const envelope: MapRevisionEventEnvelope = {
      projectId: args.projectId,
      actor: args.actor,
      idempotencyKey: args.key,
      requestDigest: args.digest,
      operation: args.operation,
      event: args.event,
    };
    try {
      Promise.resolve(this.deps.eventBus.publish(envelope)).catch(() => undefined);
    } catch {
      // The durable mutation already committed; observer failures are non-transactional.
    }
  }
}

function parseInput<T>(schema: { parse(value: unknown): T }, input: unknown): T {
  try {
    return schema.parse(input);
  } catch {
    throw invalidInput();
  }
}

function parseOutput<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch {
    throw new MapDraftError('INTERNAL', 'The map revision response is invalid.');
  }
}

function requireTrustedRestoreContext(
  context: MapRevisionMutationContext,
): Extract<MapRevisionMutationContext, { kind: 'ui' }> {
  try {
    const value = exactStoredObject(context, ['kind', 'projectId', 'requestId', 'isProjectRunning']);
    if (value.kind !== 'ui') throw new TypeError('restore context is not local UI');
    if (typeof value.isProjectRunning !== 'function') throw new TypeError('restore Run predicate is unavailable');
    return {
      kind: 'ui',
      projectId: exactIdentifier(value.projectId),
      requestId: exactIdentifier(value.requestId),
      isProjectRunning: value.isProjectRunning as () => boolean,
    };
  } catch {
    throw invalidInput();
  }
}

function assertProjectIdle(
  context: Extract<MapRevisionMutationContext, { kind: 'ui' }>,
): void {
  let running: boolean;
  try {
    running = context.isProjectRunning();
  } catch {
    throw new MapDraftError('INTERNAL', 'The map project Run state is unavailable.');
  }
  if (typeof running !== 'boolean') {
    throw new MapDraftError('INTERNAL', 'The map project Run state is invalid.');
  }
  if (running) {
    throw new MapDraftError(
      'REVISION_CONFLICT',
      'A map run is active for this project.',
      { retryable: true, details: { reason: 'ACTIVE_RUN' } },
    );
  }
}

function assertValidRevision(findings: Array<{ severity: string; code: string }>): void {
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (errors.length === 0) return;
  const code = errors.some((finding) => finding.code === 'DESIGN_SYSTEM_VIOLATION')
    ? 'DESIGN_SYSTEM_VIOLATION'
    : errors.some((finding) => finding.code === 'SEMANTIC_INVALID')
      ? 'SEMANTIC_INVALID'
      : errors.some((finding) => finding.code === 'STYLE_INVALID')
        ? 'STYLE_INVALID'
        : 'SOURCE_UNAVAILABLE';
  throw new MapDraftError(
    code,
    code === 'DESIGN_SYSTEM_VIOLATION'
      ? 'The map violates the selected design system.'
      : code === 'SEMANTIC_INVALID'
        ? 'The semantic mapping is invalid.'
        : code === 'STYLE_INVALID'
          ? 'The map style is invalid.'
          : 'The map source is unavailable.',
  );
}

function digestInput(input: unknown): string {
  try {
    return requestDigest(input);
  } catch {
    throw invalidInput();
  }
}

function nextRevision(committedRevision: number | null): number {
  return increment(committedRevision ?? 0);
}

function increment(value: number): number {
  if (!storedRevision(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new MapDraftError('INTERNAL', 'The map revision limit has been reached.');
  }
  return value + 1;
}

function storedRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

interface PreviewReport {
  previewId: string;
  validationDigest: string;
}

const PREVIEW_REPORT_KEYS = ['previewId', 'validationDigest'] as const;

function parsePreviewReport(input: unknown): PreviewReport {
  const report = exactStoredObject(input, PREVIEW_REPORT_KEYS);
  return {
    previewId: exactIdentifier(report.previewId),
    validationDigest: MapDigestSchema.parse(report.validationDigest),
  };
}

function hasPngSignature(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10] as const;
  return bytes.byteLength >= signature.length
    && signature.every((byte, index) => bytes[index] === byte);
}

function exactStoredObject(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new TypeError('invalid row');
  const row = input as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('invalid row shape');
  }
  return row;
}

function exactIdentifier(input: unknown): string {
  const parsed = MapIdentifierSchema.parse(input);
  if (parsed !== input) throw new TypeError('non-canonical identifier');
  return parsed;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function expired(expiresAt: string, at: string): boolean {
  const expiry = Date.parse(expiresAt);
  const snapshot = Date.parse(at);
  if (!Number.isFinite(expiry) || !Number.isFinite(snapshot)) {
    throw new MapDraftError('INTERNAL', 'The stored map preview expiry is invalid.');
  }
  return expiry <= snapshot;
}

function samePreview(left: PreviewRow, right: PreviewRow): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameProjectSnapshot(left: ProjectRow, right: ProjectRow): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function noCommittedRevision(): MapDraftError {
  return new MapDraftError('INVALID_INPUT', 'The map project has no committed revision.');
}

function previewEvidenceFailed(): MapDraftError {
  return new MapDraftError('PREVIEW_FAILED', 'The passed map preview evidence is unavailable.');
}

function historicalEvidenceChanged(): MapDraftError {
  return new MapDraftError(
    'SOURCE_UNAVAILABLE',
    'The historical map revision evidence is unavailable.',
  );
}

function runNotAuthorized(): MapDraftError {
  return new MapDraftError('RUN_NOT_AUTHORIZED', 'The run is not authorized for this map project.');
}

function draftConflict(project: ProjectRow): MapDraftError {
  return new MapDraftError('REVISION_CONFLICT', 'The map draft revision has changed.', {
    retryable: true,
    details: { currentRevision: project.draftRevision },
  });
}

function committedPointerConflict(project: ProjectRow): MapDraftError {
  return new MapDraftError('REVISION_CONFLICT', 'The committed map revision has changed.', {
    retryable: true,
    details: {
      currentRevision: project.draftRevision,
      ...(project.committedRevision === null ? {} : { currentCommittedRevision: project.committedRevision }),
    },
  });
}
