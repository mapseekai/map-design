import type Database from 'better-sqlite3';
import {
  MapApplyTransactionInputSchema,
  MapStyleDocumentInputSchema,
  type MapStyleDocumentInput,
  MapApplyTransactionOutputSchema,
  MapSourceManifestSchema,
  MapUpdateSemanticsInputSchema,
  MapUpdateSemanticsOutputSchema,
  assertMapDesignStyleResourceUrls,
  type MapApplyTransactionInput,
  type MapApplyTransactionOutput,
  type MapSemanticSummary,
  type MapSourceManifest,
  type MapToolName,
  type MapUpdateSemanticsInput,
  type MapUpdateSemanticsOutput,
  type SemanticDocument,
} from '@mapseekai/map-design-contracts';
import { applyStyleTransaction, finalizeStyleReplacement, STYLE_TOOL_ERROR_CODES, type StyleDocument } from 'maplibre-style-tools/core';
import { sha256CanonicalJson } from 'maplibre-style-tools/bridge';

import { canonicalJson } from '../storage/canonical-json.js';
import type { MapDesignBlobStore } from '../storage/types.js';
import { validateMapDesign } from '../validation/map-validator.js';
import type { LoadedMapDesignSystem } from '../validation/design-system-loader.js';
import type { MapDraftEventBus, MapDraftUpdatedEnvelope } from './event-bus.js';
import { MapDraftError, invalidInput, isMapDraftError } from './errors.js';
import { requestDigest } from './request-digest.js';

type SqliteDb = Database.Database;
type MutationOperation = Extract<MapToolName, 'map_apply_transaction' | 'map_update_semantics'>;

export interface MapRunContext { projectId: string; runId: string; signal?: AbortSignal; }
export type MapDraftMutationContext =
  | ({ kind?: 'run' } & MapRunContext)
  | { kind: 'ui'; projectId: string; requestId: string; isProjectRunning(): boolean;
      requestWitness: { digest: string; json: string }; signal?: AbortSignal };

export interface MapDraftImmediateCheckpoint {
  projectId: string;
  operation: MutationOperation;
  idempotencyKey: string;
  requestDigest: string;
}

export interface MapDraftServiceDependencies {
  db: SqliteDb;
  blobStore: MapDesignBlobStore;
  loadDesignSystem(input: { id: string; digest: string }): Promise<LoadedMapDesignSystem>;
  eventBus: MapDraftEventBus;
  now?: () => string;
  /** Test-only coordination hook between optimistic reads and the immediate transaction. */
  beforeImmediate?(checkpoint: MapDraftImmediateCheckpoint): void | Promise<void>;
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
}

interface IdempotencyRow { requestDigest: string; responseJson: string; }

export class MapDraftService {
  private readonly now: () => string;

  constructor(private readonly deps: MapDraftServiceDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async applyTransaction(context: MapDraftMutationContext, input: unknown | MapApplyTransactionInput): Promise<MapApplyTransactionOutput> {
    const parsed = parseInput(MapApplyTransactionInputSchema, input);
    return this.applyStyleMutation(context, parsed);
  }

  async replaceStyle(context: Extract<MapDraftMutationContext, { kind: 'ui' }>, input: unknown): Promise<MapApplyTransactionOutput> {
    return this.applyStyleMutation(context, parseInput(MapStyleDocumentInputSchema, input));
  }

  private async applyStyleMutation(context: MapDraftMutationContext, parsed: MapApplyTransactionInput | MapStyleDocumentInput): Promise<MapApplyTransactionOutput> {
    const digest = digestInput(parsed);
    const operation: MutationOperation = 'map_apply_transaction';
    const project = this.readProject(context.projectId);
    this.assertReady(project);
    const replay = this.replay<MapApplyTransactionOutput>(project, operation, parsed.idempotencyKey, digest, MapApplyTransactionOutputSchema.parse);
    if (replay) return replay;
    assertUiMutationAllowed(context);
    this.assertRevision(project, parsed.expectedRevision);

    if ('styleHash' in parsed && parsed.styleHash !== project.draftStyleHash) {
      throw new MapDraftError('REVISION_CONFLICT', 'The map draft has changed.', { retryable: true });
    }

    const current = await this.loadCurrent(project, context.projectId);
    const transaction = 'transaction' in parsed ? parsed.transaction : null;
    const applied = 'style' in parsed
      ? finalizeStyleReplacement(current.style, parsed.style)
      : applyStyleTransaction(current.style, parsed.transaction);
    if (!applied.ok) {
      const error = libraryError(applied.error);
      if ('style' in parsed) throw new MapDraftError('STYLE_INVALID', 'The style document is invalid.', error.details === undefined ? {} : { details: error.details });
      throw error;
    }
    try {
      assertMapDesignStyleResourceUrls(applied.style, context.projectId);
    } catch {
      throw new MapDraftError('STYLE_INVALID', 'The map style contains an unsafe resource URL.');
    }
    const validation = validateMapDesign({ style: applied.style, semantics: current.semantics, sourceManifest: current.sourceManifest, designSystem: current.designSystem });
    assertValid(validation.findings);
    const noOp = applied.diff.length === 0 && canonicalJson(applied.style) === canonicalJson(current.style);
    const nextRevision = noOp ? project.draftRevision : project.draftRevision + 1;
    const styleHash = noOp ? project.draftStyleHash! : await sha256CanonicalJson(applied.style);
    const styleBlob = noOp ? null : await this.deps.blobStore.putJson(context.projectId, 'styles', applied.style);
    const output = MapApplyTransactionOutputSchema.parse({
      draftRevision: nextRevision,
      styleHash,
      changedLayers: uniqueSorted(applied.changedLayers),
      changedSources: uniqueSorted(applied.changedSources),
      diff: applied.diff,
      warnings: applied.warnings.map((warning) => ({ code: warning.code, message: warning.message, ...(warning.path ? { jsonPointer: warning.path } : {}) })),
      validationSummary: validation.summary,
    });
    await this.beforeImmediate({ projectId: context.projectId, operation, idempotencyKey: parsed.idempotencyKey, requestDigest: digest });
    const persisted = this.persist({ context, project, operation, input: parsed, digest, output, parseOutput: MapApplyTransactionOutputSchema.parse, noOp, styleDigest: styleBlob?.digest ?? project.draftStyleDigest!, styleHash, semanticDigest: project.draftSemanticDigest!, transaction });
    if (persisted.replayed) return persisted.output;
    if (!noOp) this.publishAfterCommit({ context, operation, key: parsed.idempotencyKey, digest, output, transaction });
    return output;
  }

  async updateSemantics(context: MapRunContext, input: unknown | MapUpdateSemanticsInput): Promise<MapUpdateSemanticsOutput> {
    const parsed = parseInput(MapUpdateSemanticsInputSchema, input);
    const digest = digestInput(parsed);
    const operation: MutationOperation = 'map_update_semantics';
    const project = this.readProject(context.projectId);
    this.assertReady(project);
    const replay = this.replay<MapUpdateSemanticsOutput>(project, operation, parsed.idempotencyKey, digest, MapUpdateSemanticsOutputSchema.parse);
    if (replay) return replay;
    this.assertRevision(project, parsed.expectedRevision);

    const current = await this.loadCurrent(project, context.projectId);
    const validation = validateMapDesign({ style: current.style, semantics: parsed.semantics, sourceManifest: current.sourceManifest, designSystem: current.designSystem });
    assertValid(validation.findings);
    const noOp = canonicalJson(parsed.semantics) === canonicalJson(current.semantics);
    const semanticBlob = noOp ? null : await this.deps.blobStore.putJson(context.projectId, 'semantics', parsed.semantics);
    const output = MapUpdateSemanticsOutputSchema.parse({
      draftRevision: noOp ? project.draftRevision : project.draftRevision + 1,
      semanticDigest: semanticBlob?.digest ?? project.draftSemanticDigest,
      semanticSummary: semanticSummary(parsed.semantics),
      validationSummary: validation.summary,
    });
    const descriptor = { operation: 'update_semantics', semanticDigest: output.semanticDigest };
    await this.beforeImmediate({ projectId: context.projectId, operation, idempotencyKey: parsed.idempotencyKey, requestDigest: digest });
    const persisted = this.persist({ context, project, operation, input: parsed, digest, output, parseOutput: MapUpdateSemanticsOutputSchema.parse, noOp, styleDigest: project.draftStyleDigest!, styleHash: project.draftStyleHash!, semanticDigest: output.semanticDigest, transaction: descriptor });
    if (persisted.replayed) return persisted.output;
    if (!noOp) this.publishAfterCommit({ context, operation, key: parsed.idempotencyKey, digest, output, transaction: descriptor });
    return output;
  }

  private async loadCurrent(project: ProjectRow, projectId: string): Promise<{ style: StyleDocument; semantics: SemanticDocument; sourceManifest: MapSourceManifest; designSystem: LoadedMapDesignSystem }> {
    try {
      const [style, semantics, manifest, designSystem] = await Promise.all([
        this.deps.blobStore.getJson<StyleDocument>(projectId, 'styles', project.draftStyleDigest!),
        this.deps.blobStore.getJson<SemanticDocument>(projectId, 'semantics', project.draftSemanticDigest!),
        this.deps.blobStore.getJson<unknown>(projectId, 'sources', project.sourceManifestDigest!),
        this.deps.loadDesignSystem({ id: project.designSystemId, digest: project.designSystemDigest }),
      ]);
      if (designSystem.id !== project.designSystemId || designSystem.digest !== project.designSystemDigest) {
        throw new MapDraftError('DESIGN_SYSTEM_VIOLATION', 'The project design system is unavailable.');
      }
      return { style, semantics, sourceManifest: MapSourceManifestSchema.parse(manifest), designSystem };
    } catch (error) {
      if (isMapDraftError(error)) throw error;
      throw new MapDraftError('SOURCE_UNAVAILABLE', 'The current map draft could not be loaded.');
    }
  }

  private persist<T extends MapApplyTransactionOutput | MapUpdateSemanticsOutput>(args: {
    context: MapDraftMutationContext; project: ProjectRow; operation: MutationOperation; input: { expectedRevision: number; idempotencyKey: string };
    digest: string; output: T; parseOutput: (value: unknown) => T; noOp: boolean; styleDigest: string; styleHash: string; semanticDigest: string; transaction: unknown;
  }): { replayed: boolean; output: T } {
    const commit = this.deps.db.transaction(() => {
      const current = this.readProject(args.context.projectId);
      this.assertReady(current);
      const replay = this.replay<T>(current, args.operation, args.input.idempotencyKey, args.digest, args.parseOutput);
      if (replay) return { replayed: true, output: replay };
      assertUiMutationAllowed(args.context);
      this.assertRevision(current, args.input.expectedRevision);
      if (!args.noOp) {
        const result = this.deps.db.prepare(`UPDATE map_design_projects SET
          draft_revision = ?, draft_style_digest = ?, draft_style_hash = ?, draft_semantic_digest = ?, updated_at = ?
          WHERE project_id = ? AND lifecycle_state = 'ready' AND draft_revision = ?`)
          .run(args.output.draftRevision, args.styleDigest, args.styleHash, args.semanticDigest, this.now(), args.context.projectId, args.input.expectedRevision);
        if (result.changes !== 1) throw new MapDraftError('REVISION_CONFLICT', 'The map draft revision has changed.', { retryable: true, details: { currentRevision: this.currentRevision(args.context.projectId) } });
      }
      const witness = args.context.kind === 'ui' ? args.context.requestWitness : null;
      this.deps.db.prepare(`INSERT INTO map_design_idempotency
        (project_id, operation, idempotency_key, request_digest, canonical_request_json, canonical_request_digest, response_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          args.context.projectId, args.operation, args.input.idempotencyKey, args.digest,
          witness?.json ?? null, witness?.digest ?? null, canonicalJson(args.output), this.now(),
        );
      if (!args.noOp) {
        this.deps.eventBus.appendInTransaction?.(this.deps.db, args.context.projectId, {
          type: 'draft.updated', occurredAt: this.now(), payload: {
            draftRevision: args.output.draftRevision,
            styleHash: args.styleHash,
            transaction: args.transaction,
            changedLayers: 'changedLayers' in args.output ? args.output.changedLayers : [],
            changedSources: 'changedSources' in args.output ? args.output.changedSources : [],
          },
        });
      }
      return { replayed: false, output: args.output };
    });
    return commit.immediate();
  }

  private async beforeImmediate(checkpoint: MapDraftImmediateCheckpoint): Promise<void> {
    await this.deps.beforeImmediate?.(checkpoint);
  }

  private publishAfterCommit(args: { context: MapDraftMutationContext; operation: MutationOperation; key: string; digest: string; output: MapApplyTransactionOutput | MapUpdateSemanticsOutput; transaction: unknown }): void {
    const identity = args.context.kind === 'ui'
      ? { actor: { kind: 'ui' as const, requestId: args.context.requestId }, requestId: args.context.requestId }
      : { actor: { kind: 'run' as const, runId: args.context.runId }, runId: args.context.runId };
    const envelope: MapDraftUpdatedEnvelope = {
      projectId: args.context.projectId, ...identity, idempotencyKey: args.key, requestDigest: args.digest, operation: args.operation,
      event: {
        type: 'draft.updated', occurredAt: this.now(), payload: {
          draftRevision: args.output.draftRevision,
          styleHash: 'styleHash' in args.output ? args.output.styleHash : this.readProject(args.context.projectId).draftStyleHash!,
          transaction: args.transaction,
          changedLayers: 'changedLayers' in args.output ? args.output.changedLayers : [],
          changedSources: 'changedSources' in args.output ? args.output.changedSources : [],
        },
      },
    };
    // Publication is observational: the durable response remains replayable even when an observer fails.
    try {
      Promise.resolve(this.deps.eventBus.publish(envelope)).catch(() => undefined);
    } catch {
      // The mutation is already durable; observer failures never change its receipt.
    }
  }

  private readProject(projectId: string): ProjectRow {
    const row = this.deps.db.prepare(`SELECT project_id AS projectId, lifecycle_state AS lifecycleState,
      source_manifest_digest AS sourceManifestDigest, design_system_id AS designSystemId, design_system_digest AS designSystemDigest,
      draft_revision AS draftRevision, draft_style_digest AS draftStyleDigest, draft_style_hash AS draftStyleHash,
      draft_semantic_digest AS draftSemanticDigest FROM map_design_projects WHERE project_id = ?`).get(projectId) as ProjectRow | undefined;
    if (!row) throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
    return row;
  }

  private replay<T>(project: ProjectRow, operation: MutationOperation, key: string, digest: string, parse: (value: unknown) => T): T | null {
    const row = this.deps.db.prepare(`SELECT request_digest AS requestDigest, response_json AS responseJson FROM map_design_idempotency
      WHERE project_id = ? AND operation = ? AND idempotency_key = ?`).get(project.projectId, operation, key) as IdempotencyRow | undefined;
    if (!row) return null;
    if (row.requestDigest !== digest) throw new MapDraftError('IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.');
    try { return parse(JSON.parse(row.responseJson)); } catch { throw new MapDraftError('INTERNAL', 'The stored mutation receipt is invalid.'); }
  }

  private assertReady(project: ProjectRow): void {
    if (project.lifecycleState !== 'ready' || !project.draftStyleDigest || !project.draftStyleHash || !project.draftSemanticDigest || !project.sourceManifestDigest) {
      throw new MapDraftError('PROJECT_NOT_READY', 'The map project is not ready.');
    }
  }

  private assertRevision(project: ProjectRow, expectedRevision: number): void {
    if (project.draftRevision !== expectedRevision) {
      throw new MapDraftError('REVISION_CONFLICT', 'The map draft revision has changed.', { retryable: true, details: { currentRevision: project.draftRevision } });
    }
  }

  private currentRevision(projectId: string): number {
    return this.readProject(projectId).draftRevision;
  }
}

function assertUiMutationAllowed(context: MapDraftMutationContext): void {
  if (context.kind !== 'ui') return;
  let running: boolean;
  try { running = context.isProjectRunning(); } catch { throw new MapDraftError('INTERNAL', 'The map run state is unavailable.'); }
  if (running) throw new MapDraftError('RUN_NOT_AUTHORIZED', 'A map run is active for this project.', {
    retryable: true, details: { reason: 'ACTIVE_RUN' },
  });
}

function parseInput<T extends { parse(value: unknown): unknown }>(schema: T, input: unknown): ReturnType<T['parse']> {
  try { return schema.parse(input) as ReturnType<T['parse']>; } catch { throw invalidInput(); }
}

function digestInput(input: unknown): string {
  try { return requestDigest(input); } catch { throw invalidInput(); }
}

function libraryError(error: { code: string; path?: string; message?: string; details?: unknown }): MapDraftError {
  const styleInvalid = error.code === 'STYLE_INVALID' || hasStyleByteLimit(error.details);
  const details: Record<string, string | number> = {
    category: STYLE_TOOL_ERROR_CODES.some((code) => code === error.code) ? error.code : 'INTERNAL',
  };
  // Keep structural locations only: custom IDs, property names and values may
  // contain secrets. Never forward the SDK's arbitrary message or details.
  const operation = error.path?.match(/^\/operations\/(\d{1,2})(?=\/|$)(?:\/(op|sourceId|layerId|source|layer|data|type|paint|layout|filter|mode|properties|sourceOptions|beforeId|afterId|overrides)(?=\/|$))?/);
  if (operation) {
    details.operationIndex = Number(operation[1]);
    details.firstPath = `transaction.operations.${details.operationIndex}${operation[2] ? `.${operation[2]}` : ''}`;
  } else if (styleInvalid) {
    // SDK style-validation errors currently carry the location only in their
    // message. Extract the fixed prefix, never the message or custom key.
    const layer = error.message?.match(/^layers\[(\d{1,4})\]\.(paint|layout)(?=\.|:|\[|\s)/);
    if (layer) details.firstPath = `layers.${Number(layer[1])}.${layer[2]}`;
    else if (error.message?.startsWith('sources.')) details.firstPath = 'sources';
  }
  return new MapDraftError(styleInvalid ? 'STYLE_INVALID' : 'INVALID_INPUT', styleInvalid ? 'The map style is invalid.' : 'The style transaction is invalid.', { details });
}

function hasStyleByteLimit(details: unknown): boolean {
  return typeof details === 'object' && details !== null && 'reason' in details && details.reason === 'maxStyleBytes';
}

function assertValid(findings: Array<{ severity: string; code: string }>): void {
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (errors.length === 0) return;
  const code = errors.some((finding) => finding.code === 'DESIGN_SYSTEM_VIOLATION') ? 'DESIGN_SYSTEM_VIOLATION'
    : errors.some((finding) => finding.code === 'SEMANTIC_INVALID') ? 'SEMANTIC_INVALID'
      : errors.some((finding) => finding.code === 'STYLE_INVALID') ? 'STYLE_INVALID' : 'SOURCE_UNAVAILABLE';
  throw new MapDraftError(code, code === 'DESIGN_SYSTEM_VIOLATION' ? 'The map violates the selected design system.' : code === 'SEMANTIC_INVALID' ? 'The semantic mapping is invalid.' : code === 'STYLE_INVALID' ? 'The map style is invalid.' : 'The map source is unavailable.');
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function semanticSummary(semantics: SemanticDocument): MapSemanticSummary {
  return {
    version: 1,
    groupCount: semantics.groups.length,
    mappedLayerCount: new Set(semantics.groups.flatMap((group) => group.layerIds)).size,
    mappedSourceCount: new Set(semantics.groups.flatMap((group) => group.sourceIds)).size,
  };
}
