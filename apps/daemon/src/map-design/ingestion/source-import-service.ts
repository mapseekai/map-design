import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';
import {
  DEFAULT_MAP_DESIGN_SYSTEM_ID,
  MapDesignProjectReadSchema,
  MapProjectImportInputSchema,
  MapProjectRetryInputSchema,
  MapSourcePreflightInputSchema,
  MapSourcePreflightOutputSchema,
  MapStudioEventSchema,
  assertMapDesignStyleResourceUrls,
  type MapDesignProjectRead,
  type MapDesignResourceScope,
  type MapProjectImportInput,
  type MapProjectRetryInput,
  type MapSourcePreflightInput,
  type MapSourcePreflightOutput,
} from '@mapseekai/map-design-contracts';
import { sha256CanonicalJson } from 'maplibre-style-tools/bridge';
import type { StyleDocument } from 'maplibre-style-tools/core';

import { createMapImportAttestation } from '../application/attestation.js';
import { MapDraftError, invalidInput } from '../application/errors.js';
import { requestDigest } from '../application/request-digest.js';
import type { MapDesignEventOutbox } from '../application/event-outbox.js';
import { blake3Digest, canonicalJson } from '../storage/canonical-json.js';
import type { MapDesignBlobStore } from '../storage/types.js';
import type { LoadedMapDesignSystem } from '../validation/design-system-loader.js';
import { buildGeoJsonSource } from './geojson-source-builder.js';
import { buildPmtilesSource } from './pmtiles-source-builder.js';
import type { PinnedTransport } from './pinned-transport.js';
import type { InitialMapBuild, ResourceDescriptor } from './resource-manifest-builder.js';
import {
  createMapDesignResourceServiceFromLookup,
  MapDesignResourceError,
  type MapDesignResolvedResource,
  type MapDesignResourceService,
} from '../resources/resource-service.js';
import { detectMapSource, type DetectedMapSource } from './source-detector.js';
import { buildStyleSource } from './style-source-builder.js';
import { buildTileJsonSource } from './tilejson-source-builder.js';

type SqliteDb = Database.Database;

export interface MapSourceImportService {
  preflight(input: MapSourcePreflightInput, signal: AbortSignal): Promise<MapSourcePreflightOutput>;
  prepareImportInTransaction(
    db: SqliteDb,
    projectId: string,
    input: MapProjectImportInput,
    now: string,
  ): MapDesignProjectRead;
  retryImport(projectId: string, input: MapProjectRetryInput): Promise<MapDesignProjectRead>;
  failRetryEnqueue(projectId: string, input: MapProjectRetryInput): Promise<MapDesignProjectRead>;
}

export interface MapSourcePreviewService extends MapDesignResourceService {
  getPreviewStyle(previewId: string): StyleDocument;
  deletePreview(previewId: string): void;
}

export interface MapImportJobExecutor {
  executeImportJob(projectId: string, signal: AbortSignal): Promise<void>;
  preparePendingRetry(projectId: string): Promise<boolean>;
}

export interface MapSourceImportServiceDependencies {
  db: SqliteDb;
  blobStore: MapDesignBlobStore;
  transport: PinnedTransport;
  designSystem: { id: typeof DEFAULT_MAP_DESIGN_SYSTEM_ID; digest: string };
  loadDesignSystem(input: { id: string; digest: string }): Promise<LoadedMapDesignSystem>;
  outbox?: Pick<MapDesignEventOutbox, 'appendInTransaction' | 'drainPending'>;
  now?: () => string;
}

interface SourcePreviewSession {
  style: StyleDocument;
  resources: ReadonlyMap<string, ResourceDescriptor>;
  captured: ReadonlyMap<string, Uint8Array>;
  expiresAtMs: number;
}

interface ImportJobRow {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  importRequestJson: string;
  importRequestDigest: string;
}

const SOURCE_PREVIEW_TTL_MS = 10 * 60 * 1_000;
const MAX_SOURCE_PREVIEWS = 16;

export class MapSourceImportServiceImpl implements MapSourceImportService, MapImportJobExecutor, MapSourcePreviewService {
  private readonly now: () => string;
  private readonly sourcePreviews = new Map<string, SourcePreviewSession>();
  private readonly previewResources: MapDesignResourceService;

  constructor(private readonly deps: MapSourceImportServiceDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.previewResources = createMapDesignResourceServiceFromLookup({
      lookup: {
        find: (ownerId, resourceId) => this.findPreviewResource(ownerId, resourceId),
        readCaptured: async (ownerId, digest) => this.readPreviewBytes(ownerId, digest),
      },
      transport: deps.transport,
    });
  }

  async preflight(input: MapSourcePreflightInput, signal: AbortSignal): Promise<MapSourcePreflightOutput> {
    let parsed: MapSourcePreflightInput;
    try { parsed = MapSourcePreflightInputSchema.parse(input); } catch { throw invalidInput(); }
    try {
      const previewTransport = bindJobTransport(this.deps.transport, signal);
      const { response, source: detected } = await fetchInitialSource(
        previewTransport, new URL(parsed.source.url), signal,
      );
      const designSystem = await this.deps.loadDesignSystem(this.deps.designSystem);
      if (designSystem.id !== this.deps.designSystem.id || designSystem.digest !== this.deps.designSystem.digest) {
        throw new TypeError('design system binding mismatch');
      }
      const previewId = randomUUID();
      const captured = new Map<string, Uint8Array>();
      const previewBlobStore: Pick<MapDesignBlobStore, 'putBytes'> = {
        putBytes: async (_ownerId, kind, bytes, mediaType) => {
          const snapshot = new Uint8Array(bytes);
          const digest = blake3Digest(snapshot);
          captured.set(digest, snapshot);
          return { digest, byteLength: snapshot.byteLength, kind, mediaType };
        },
      };
      const capturedAt = this.timestamp();
      const build = await this.build(
        previewId,
        detected,
        response.finalUrl,
        response.headers.etag ?? null,
        capturedAt,
        designSystem,
        previewTransport,
        { blobStore: previewBlobStore, resourceScope: 'source-previews' },
      );
      signal.throwIfAborted();
      assertMapDesignStyleResourceUrls(build.style, previewId, { scope: 'source-previews' });
      const createdAtMs = Date.parse(capturedAt);
      const expiresAtMs = createdAtMs + SOURCE_PREVIEW_TTL_MS;
      this.cleanupSourcePreviews(createdAtMs);
      while (this.sourcePreviews.size >= MAX_SOURCE_PREVIEWS) {
        const oldest = this.sourcePreviews.keys().next().value as string | undefined;
        if (!oldest) break;
        this.sourcePreviews.delete(oldest);
      }
      this.sourcePreviews.set(previewId, {
        style: structuredClone(build.style),
        resources: new Map(build.resources.map((resource) => [resource.id, resource])),
        captured,
        expiresAtMs,
      });

      const contentLength = response.headers['content-length'];
      const contentRangeTotal = response.status === 206
        ? parseInitialProbeContentRange(response.headers['content-range'])
        : null;
      const byteLength = contentRangeTotal !== null
        ? contentRangeTotal
        : contentLength !== undefined && /^\d+$/u.test(contentLength)
          ? Number(contentLength)
          : response.body.byteLength;
      return MapSourcePreflightOutputSchema.parse({
        kind: detected.kind,
        requestedHost: response.requestedUrl.hostname,
        finalHost: response.finalUrl.hostname,
        redirectCount: response.redirects.length,
        reachability: 'reachable',
        security: {
          scheme: response.finalUrl.protocol.slice(0, -1),
          allResolvedAddressesPublic: true,
          credentialsPresent: false,
        },
        mediaType: detected.mediaType,
        byteLength: Number.isSafeInteger(byteLength) ? byteLength : null,
        preview: {
          previewId,
          styleUrl: `/api/map-design/source-previews/${encodeURIComponent(previewId)}/style`,
          expiresAt: new Date(expiresAtMs).toISOString(),
        },
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new MapDraftError('SOURCE_UNAVAILABLE', 'The public map source is unavailable.', { retryable: true });
    }
  }

  getPreviewStyle(previewId: string): StyleDocument {
    return structuredClone(this.requireSourcePreview(previewId).style);
  }

  deletePreview(previewId: string): void {
    this.sourcePreviews.delete(previewId);
  }

  getResource(
    previewId: string,
    resourceId: string,
    suffix: readonly string[],
    signal?: AbortSignal,
  ) {
    return this.previewResources.getResource(previewId, resourceId, suffix, signal);
  }

  getPmtilesArchiveRange(
    previewId: string,
    resourceId: string,
    range: { start: number; endInclusive: number },
    ifMatch?: string,
    signal?: AbortSignal,
  ) {
    return this.previewResources.getPmtilesArchiveRange(
      previewId,
      resourceId,
      range,
      ifMatch,
      signal,
    );
  }

  prepareImportInTransaction(
    db: SqliteDb,
    projectId: string,
    input: MapProjectImportInput,
    now: string,
  ): MapDesignProjectRead {
    let parsed: MapProjectImportInput;
    try { parsed = MapProjectImportInputSchema.parse(input); } catch { throw invalidInput(); }
    const sourceUrl = new URL(parsed.source.url);
    if (sourceUrl.username || sourceUrl.password) throw invalidInput();
    const json = canonicalJson(parsed);
    const digest = requestDigest(parsed);
    db.prepare(`INSERT INTO map_design_projects (
      project_id, lifecycle_state, design_system_id, design_system_digest,
      draft_revision, created_at, updated_at
    ) VALUES (?, 'importing', ?, ?, 0, ?, ?)`).run(
      projectId, this.deps.designSystem.id, this.deps.designSystem.digest, now, now,
    );
    db.prepare(`INSERT INTO map_design_import_jobs (
      project_id, status, import_request_json, import_request_digest, attempt, queued_at
    ) VALUES (?, 'queued', ?, ?, 1, ?)`).run(projectId, json, digest, now);
    const receipt = this.readProject(db, projectId);
    this.insertReceipt(db, projectId, 'import.start', parsed.idempotencyKey, digest, receipt, now);
    this.appendLifecycle(db, projectId, receipt, now);
    return receipt;
  }

  async retryImport(projectId: string, input: MapProjectRetryInput): Promise<MapDesignProjectRead> {
    let parsed: MapProjectRetryInput;
    try { parsed = MapProjectRetryInputSchema.parse(input); } catch { throw invalidInput(); }
    const digest = requestDigest(parsed);
    const transaction = this.deps.db.transaction(() => {
      const replay = this.replay(projectId, 'import.retry', parsed.idempotencyKey, digest);
      if (replay) return replay;
      const project = this.readProject(this.deps.db, projectId);
      if (project.lifecycle === 'ready') {
        throw new MapDraftError('INVALID_INPUT', 'A ready map project cannot be retried.');
      }
      const now = this.timestamp();
      if (project.lifecycle === 'failed') {
        const changed = this.deps.db.prepare(`UPDATE map_design_import_jobs SET
          status = 'queued', attempt = attempt + 1, queued_at = ?, started_at = NULL,
          finished_at = NULL, failure_code = NULL, failure_message = NULL
          WHERE project_id = ? AND status = 'failed'`).run(now, projectId);
        if (changed.changes !== 1) throw new MapDraftError('REVISION_CONFLICT', 'The import state changed.', { retryable: true });
        this.deps.db.prepare(`UPDATE map_design_projects SET lifecycle_state = 'importing',
          failure_code = NULL, failure_message = NULL, updated_at = ? WHERE project_id = ? AND lifecycle_state = 'failed'`)
          .run(now, projectId);
      }
      const receipt = this.readProject(this.deps.db, projectId);
      this.insertReceipt(this.deps.db, projectId, 'import.retry', parsed.idempotencyKey, digest, receipt, now);
      if (project.lifecycle === 'failed') this.appendLifecycle(this.deps.db, projectId, receipt, now);
      return receipt;
    });
    try {
      const output = transaction.immediate();
      void this.deps.outbox?.drainPending().catch(() => undefined);
      return output;
    } catch (error) {
      if (error instanceof MapDraftError) throw error;
      throw new MapDraftError('INTERNAL', 'The map import retry failed.');
    }
  }

  async failRetryEnqueue(projectId: string, input: MapProjectRetryInput): Promise<MapDesignProjectRead> {
    let parsed: MapProjectRetryInput;
    try { parsed = MapProjectRetryInputSchema.parse(input); } catch { throw invalidInput(); }
    const digest = requestDigest(parsed);
    const transaction = this.deps.db.transaction(() => {
      const now = this.timestamp();
      const changed = this.deps.db.prepare(`UPDATE map_design_import_jobs SET
        status = 'failed', finished_at = ?, failure_code = 'IMPORT_RUNNER_UNAVAILABLE',
        failure_message = 'The import runner is unavailable and the import can be retried.'
        WHERE project_id = ? AND status = 'queued'`).run(now, projectId);
      if (changed.changes !== 1) throw new MapDraftError('REVISION_CONFLICT', 'The import state changed.', { retryable: true });
      const project = this.deps.db.prepare(`UPDATE map_design_projects SET lifecycle_state = 'failed',
        failure_code = 'IMPORT_RUNNER_UNAVAILABLE',
        failure_message = 'The import runner is unavailable and the import can be retried.', updated_at = ?
        WHERE project_id = ? AND lifecycle_state = 'importing'`).run(now, projectId);
      if (project.changes !== 1) throw new MapDraftError('REVISION_CONFLICT', 'The import state changed.', { retryable: true });
      const receipt = this.readProject(this.deps.db, projectId);
      const updated = this.deps.db.prepare(`UPDATE map_design_idempotency SET response_json = ?
        WHERE project_id = ? AND operation = 'import.retry' AND idempotency_key = ? AND request_digest = ?`)
        .run(canonicalJson(receipt), projectId, parsed.idempotencyKey, digest);
      if (updated.changes !== 1) throw new MapDraftError('REVISION_CONFLICT', 'The import receipt changed.', { retryable: true });
      this.appendLifecycle(this.deps.db, projectId, receipt, now);
      return receipt;
    });
    try {
      const output = transaction.immediate();
      void this.deps.outbox?.drainPending().catch(() => undefined);
      return output;
    } catch (error) {
      if (error instanceof MapDraftError) throw error;
      throw new MapDraftError('INTERNAL', 'The map import retry failed.');
    }
  }

  async executeImportJob(projectId: string, signal: AbortSignal): Promise<void> {
    const startedAt = this.timestamp();
    const claimed = this.deps.db.prepare(`UPDATE map_design_import_jobs SET
      status = 'running', started_at = ?, finished_at = NULL
      WHERE project_id = ? AND status = 'queued'`).run(startedAt, projectId);
    if (claimed.changes !== 1) return;
    try {
      const transport = bindJobTransport(this.deps.transport, signal);
      const request = this.readCanonicalJob(projectId);
      const { response, source } = await fetchInitialSource(
        transport, new URL(request.source.url), signal,
      );
      const designSystem = await this.deps.loadDesignSystem(this.deps.designSystem);
      if (designSystem.id !== this.deps.designSystem.id || designSystem.digest !== this.deps.designSystem.digest) {
        throw new TypeError('design system binding mismatch');
      }
      const capturedAt = this.timestamp();
      const build = await this.build(
        projectId, source, response.finalUrl, response.headers.etag ?? null,
        capturedAt, designSystem, transport,
      );
      signal.throwIfAborted();
      assertMapDesignStyleResourceUrls(build.style, projectId);
      const [styleBlob, semanticBlob, sourceBlob, validationBlob] = await Promise.all([
        this.deps.blobStore.putJson(projectId, 'styles', build.style),
        this.deps.blobStore.putJson(projectId, 'semantics', build.semantics),
        this.deps.blobStore.putJson(projectId, 'sources', build.sourceManifest),
        this.deps.blobStore.putJson(projectId, 'reports', build.validation),
      ]);
      const styleHash = await sha256CanonicalJson(build.style);
      const attestation = createMapImportAttestation({
        version: 1, kind: 'import', projectId, revision: 0,
        sourceManifestDigest: sourceBlob.digest,
        styleDigest: styleBlob.digest,
        styleHash,
        semanticDigest: semanticBlob.digest,
        designSystemId: this.deps.designSystem.id,
        designSystemDigest: this.deps.designSystem.digest,
        importedAt: capturedAt,
      });
      const attestationBlob = await this.deps.blobStore.putJson(projectId, 'attestations', attestation);
      signal.throwIfAborted();
      this.commitReady({
        projectId, build, capturedAt, styleDigest: styleBlob.digest, styleHash,
        semanticDigest: semanticBlob.digest, sourceDigest: sourceBlob.digest,
        attestationDigest: attestationBlob.digest, validationDigest: validationBlob.digest,
        validationStatus: build.validation.summary.status === 'invalid' ? 'invalid' : 'valid',
      });
    } catch (error) {
      try { this.commitFailed(projectId, error); }
      catch { throw new MapDraftError('INTERNAL', 'The map import failure could not be persisted.'); }
    }
    void this.deps.outbox?.drainPending().catch(() => undefined);
  }
  async preparePendingRetry(projectId: string): Promise<boolean> {
    const transaction = this.deps.db.transaction(() => {
      const row = this.deps.db.prepare(`SELECT job.status AS jobStatus, project.lifecycle_state AS lifecycle
        FROM map_design_import_jobs AS job JOIN map_design_projects AS project USING (project_id)
        WHERE job.project_id = ?`).get(projectId) as { jobStatus: string; lifecycle: string } | undefined;
      if (!row) return false;
      if (row.jobStatus === 'queued') return true;
      if (row.jobStatus !== 'failed' || row.lifecycle !== 'failed') return false;
      const now = this.timestamp();
      const job = this.deps.db.prepare(`UPDATE map_design_import_jobs SET
        status = 'queued', attempt = attempt + 1, queued_at = ?, started_at = NULL, finished_at = NULL,
        failure_code = NULL, failure_message = NULL WHERE project_id = ? AND status = 'failed'`)
        .run(now, projectId);
      const project = this.deps.db.prepare(`UPDATE map_design_projects SET lifecycle_state = 'importing',
        failure_code = NULL, failure_message = NULL, updated_at = ?
        WHERE project_id = ? AND lifecycle_state = 'failed'`).run(now, projectId);
      if (job.changes !== 1 || project.changes !== 1) return false;
      this.appendLifecycle(this.deps.db, projectId, this.readProject(this.deps.db, projectId), now);
      return true;
    });
    const prepared = transaction.immediate();
    if (prepared) void this.deps.outbox?.drainPending().catch(() => undefined);
    return prepared;
  }


  private requireSourcePreview(previewId: string): SourcePreviewSession {
    const preview = this.liveSourcePreview(previewId);
    if (!preview) throw new MapDraftError('NOT_FOUND', 'The source preview was not found.');
    return preview;
  }

  private liveSourcePreview(previewId: string): SourcePreviewSession | null {
    const nowMs = Date.parse(this.timestamp());
    this.cleanupSourcePreviews(nowMs);
    return this.sourcePreviews.get(previewId) ?? null;
  }

  private cleanupSourcePreviews(nowMs: number): void {
    for (const [previewId, preview] of this.sourcePreviews) {
      if (preview.expiresAtMs <= nowMs) this.sourcePreviews.delete(previewId);
    }
  }

  private findPreviewResource(previewId: string, resourceId: string): MapDesignResolvedResource | null {
    const resource = this.liveSourcePreview(previewId)?.resources.get(resourceId);
    if (!resource) return null;
    const { id, ...resolved } = resource;
    return { ownerId: previewId, resourceId: id, ...resolved };
  }

  private readPreviewBytes(previewId: string, digest: string): Uint8Array {
    const bytes = this.liveSourcePreview(previewId)?.captured.get(digest);
    if (!bytes) throw new MapDesignResourceError(404, 'Map resource not found');
    return new Uint8Array(bytes);
  }

  private async build(
    projectId: string,
    source: DetectedMapSource,
    approvedFinalUrl: URL,
    etag: string | null,
    capturedAt: string,
    designSystem: LoadedMapDesignSystem,
    transport: PinnedTransport,
    options: {
      blobStore?: Pick<MapDesignBlobStore, 'putBytes'>;
      resourceScope?: MapDesignResourceScope;
    } = {},
  ): Promise<InitialMapBuild> {
    const common = {
      projectId,
      source,
      approvedFinalUrl,
      etag,
      capturedAt,
      designSystem,
      ...(options.resourceScope ? { resourceScope: options.resourceScope } : {}),
    };
    const blobStore = options.blobStore ?? this.deps.blobStore;
    if (source.kind === 'style') return buildStyleSource({ ...common, blobStore, transport });
    if (source.kind === 'tilejson') return buildTileJsonSource(common);
    if (source.kind === 'geojson') return buildGeoJsonSource({ ...common, blobStore });
    return buildPmtilesSource({ ...common, transport });
  }

  private commitReady(input: {
    projectId: string; build: InitialMapBuild; capturedAt: string; styleDigest: string;
    styleHash: string; semanticDigest: string; sourceDigest: string; attestationDigest: string;
    validationDigest: string; validationStatus: 'valid' | 'invalid';
  }): void {
    const transaction = this.deps.db.transaction(() => {
      const jobStatus = this.deps.db.prepare(`SELECT status FROM map_design_import_jobs WHERE project_id = ?`)
        .get(input.projectId) as { status: string } | undefined;
      if (jobStatus?.status !== 'running') throw new TypeError('import job is not running');
      for (const resource of input.build.resources) this.insertResource(input.projectId, resource);
      this.deps.db.prepare(`INSERT INTO map_design_revisions (
        project_id, revision, draft_revision, style_digest, style_hash, semantic_digest,
        source_manifest_digest, design_system_digest, preview_id, attestation_digest, run_id, created_at
      ) VALUES (?, 0, 0, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`).run(
        input.projectId, input.styleDigest, input.styleHash, input.semanticDigest, input.sourceDigest,
        this.deps.designSystem.digest, input.attestationDigest, input.capturedAt,
      );
      const project = this.deps.db.prepare(`UPDATE map_design_projects SET
        lifecycle_state = 'ready', source_kind = ?, source_manifest_digest = ?,
        draft_style_digest = ?, draft_style_hash = ?, draft_semantic_digest = ?,
        initial_validation_status = ?, initial_validation_digest = ?,
        committed_revision = 0, failure_code = NULL, failure_message = NULL, updated_at = ?
        WHERE project_id = ? AND lifecycle_state = 'importing'`).run(
        input.build.sourceManifest.kind, input.sourceDigest, input.styleDigest, input.styleHash,
        input.semanticDigest, input.validationStatus, input.validationDigest,
        input.capturedAt, input.projectId,
      );
      const jobUpdate = this.deps.db.prepare(`UPDATE map_design_import_jobs SET
        status = 'succeeded', finished_at = ?, failure_code = NULL, failure_message = NULL
        WHERE project_id = ? AND status = 'running'`).run(input.capturedAt, input.projectId);
      if (project.changes !== 1 || jobUpdate.changes !== 1) throw new TypeError('import CAS failed');
      this.appendLifecycle(this.deps.db, input.projectId, this.readProject(this.deps.db, input.projectId), input.capturedAt);
    });
    transaction.immediate();
  }

  private commitFailed(projectId: string, error: unknown): void {
    const now = this.timestamp();
    const message = redactedFailure(error);
    const transaction = this.deps.db.transaction(() => {
      const changed = this.deps.db.prepare(`UPDATE map_design_import_jobs SET
        status = 'failed', finished_at = ?, failure_code = 'IMPORT_FAILED', failure_message = ?
        WHERE project_id = ? AND status = 'running'`).run(now, message, projectId);
      if (changed.changes !== 1) return;
      this.deps.db.prepare(`UPDATE map_design_projects SET lifecycle_state = 'failed',
        failure_code = 'IMPORT_FAILED', failure_message = ?, updated_at = ?
        WHERE project_id = ? AND lifecycle_state = 'importing'`).run(message, now, projectId);
      this.appendLifecycle(this.deps.db, projectId, this.readProject(this.deps.db, projectId), now);
    });
    transaction.immediate();
  }

  private readCanonicalJob(projectId: string): MapProjectImportInput {
    const row = this.deps.db.prepare(`SELECT status, import_request_json AS importRequestJson,
      import_request_digest AS importRequestDigest FROM map_design_import_jobs WHERE project_id = ?`)
      .get(projectId) as ImportJobRow | undefined;
    if (!row || row.status !== 'running') throw new TypeError('import job unavailable');
    const value = JSON.parse(row.importRequestJson) as unknown;
    const parsed = MapProjectImportInputSchema.parse(value);
    if (canonicalJson(parsed) !== row.importRequestJson || requestDigest(parsed) !== row.importRequestDigest) {
      throw new TypeError('canonical import request mismatch');
    }
    return parsed;
  }

  private readProject(db: SqliteDb, projectId: string): MapDesignProjectRead {
    const row = db.prepare(`SELECT project_id AS projectId, lifecycle_state AS lifecycle,
      source_kind AS sourceKind, design_system_id AS designSystemId,
      design_system_digest AS designSystemDigest, draft_revision AS draftRevision,
      committed_revision AS committedRevision, failure_code AS failureCode,
      failure_message AS failureMessage, created_at AS createdAt, updated_at AS updatedAt
      FROM map_design_projects WHERE project_id = ?`).get(projectId) as Record<string, unknown> | undefined;
    if (!row) throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
    return MapDesignProjectReadSchema.parse({
      projectId: row.projectId, lifecycle: row.lifecycle, sourceKind: row.sourceKind,
      designSystemId: row.designSystemId, designSystemDigest: row.designSystemDigest,
      draftRevision: row.draftRevision, committedRevision: row.committedRevision,
      failure: row.failureCode === null ? null : { code: row.failureCode, message: row.failureMessage },
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    });
  }

  private replay(projectId: string, operation: string, key: string, digest: string): MapDesignProjectRead | null {
    const row = this.deps.db.prepare(`SELECT request_digest AS requestDigest, response_json AS responseJson
      FROM map_design_idempotency WHERE project_id = ? AND operation = ? AND idempotency_key = ?`)
      .get(projectId, operation, key) as { requestDigest: string; responseJson: string } | undefined;
    if (!row) return null;
    if (row.requestDigest !== digest) throw new MapDraftError('IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.');
    try { return MapDesignProjectReadSchema.parse(JSON.parse(row.responseJson)); }
    catch { throw new MapDraftError('INTERNAL', 'The stored import receipt is invalid.'); }
  }

  private insertReceipt(db: SqliteDb, projectId: string, operation: string, key: string, digest: string, response: unknown, now: string): void {
    db.prepare(`INSERT INTO map_design_idempotency
      (project_id, operation, idempotency_key, request_digest, response_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(projectId, operation, key, digest, canonicalJson(response), now);
  }

  private insertResource(projectId: string, resource: ResourceDescriptor): void {
    this.deps.db.prepare(`INSERT INTO map_design_resources
      (project_id, resource_id, kind, storage_kind, media_type, byte_length, content_digest, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      projectId, resource.id, resource.kind, resource.mode, resource.mediaType,
      resource.byteLength, resource.contentDigest,
      canonicalJson({ sourceUrl: resource.sourceUrl, etag: resource.etag }),
    );
  }

  private appendLifecycle(db: SqliteDb, projectId: string, project: MapDesignProjectRead, now: string): void {
    this.deps.outbox?.appendInTransaction(db, projectId, MapStudioEventSchema.parse({
      type: 'project.lifecycle.updated', occurredAt: now,
      payload: { lifecycle: project.lifecycle, failure: project.failure },
    }));
  }

  private timestamp(): string {
    const now = this.now();
    if (!Number.isFinite(Date.parse(now))) throw new MapDraftError('INTERNAL', 'The map import clock is invalid.');
    return now;
  }
}

async function fetchInitialSource(
  transport: PinnedTransport,
  url: URL,
  signal: AbortSignal,
): Promise<{ response: Awaited<ReturnType<PinnedTransport['fetch']>>; source: DetectedMapSource }> {
  const probe = await transport.fetch({
    url, purpose: 'pmtiles-range', range: { start: 0, endInclusive: 7 }, signal,
  });
  if (probe.status === 200) {
    const source = detectMapSource(probe);
    if (source.kind === 'pmtiles') throw new TypeError('PMTiles range request was ignored');
    return { response: probe, source };
  }
  if (probe.status !== 206) {
    throw new TypeError('invalid source range probe');
  }
  if (probe.body.byteLength === 8
    && parseInitialProbeContentRange(probe.headers['content-range']) !== null) {
    try {
      const source = detectMapSource(probe);
      if (source.kind === 'pmtiles') return { response: probe, source };
    } catch { /* a JSON document is fetched in full below */ }
  }
  const response = await transport.fetch({
    url, purpose: 'document',
    accept: ['application/json', 'application/geo+json', 'application/octet-stream'], signal,
  });
  if (response.status !== 200) throw new TypeError('source document did not return 200');
  return { response, source: detectMapSource(response) };
}

function parseInitialProbeContentRange(value: string | undefined): number | null {
  const match = value?.match(/^bytes 0-7\/(\d+)$/u);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total >= 8 ? total : null;
}

function bindJobTransport(transport: PinnedTransport, jobSignal: AbortSignal): PinnedTransport {
  return {
    fetch(request) {
      jobSignal.throwIfAborted();
      const signal = request.signal && request.signal !== jobSignal
        ? AbortSignal.any([jobSignal, request.signal])
        : jobSignal;
      return transport.fetch({ ...request, signal });
    },
  };
}

function redactedFailure(error: unknown): string {
  void error;
  return 'The public map source could not be imported.';
}
