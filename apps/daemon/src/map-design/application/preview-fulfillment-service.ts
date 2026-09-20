import type Database from 'better-sqlite3';
import {
  MapIdentifierSchema,
  MapCurrentPreviewOutputSchema,
  MapPreviewFulfillRequestSchema,
  MapRenderPreviewInputSchema,
  MapRenderPreviewOutputSchema,
  MapStudioEventSchema,
  MapTimestampSchema,
  type MapPreviewFulfillRequest,
  type MapCurrentPreviewOutput,
  type MapRenderPreviewOutput,
  type MapStudioEvent,
  type MapValidateOutput,
} from '@mapseekai/map-design-contracts';

import type { MapDesignBlobStore, StoredBlob } from '../storage/types.js';
import { blake3Digest, canonicalJson, canonicalJsonBytes } from '../storage/canonical-json.js';
import { MapDraftError, invalidInput, isMapDraftError } from './errors.js';
import type { MapPreviewRequestService } from './preview-request-service.js';
import { requestDigest } from './request-digest.js';

interface PreviewRow {
  id: string; projectId: string; runId: string; draftRevision: number; styleDigest: string; styleHash: string;
  status: 'requested' | 'rendering' | 'passed' | 'failed' | 'expired'; requestJson: string;
  pngDigest: string | null; reportDigest: string | null; validationDigest: string | null; expiresAt: string;
}

interface ProjectRow {
  projectId: string; lifecycleState: string; draftRevision: number; styleDigest: string | null; styleHash: string | null;
}

interface ReceiptRow { requestDigest: string; responseJson: string }

export interface MapPreviewFulfillmentServiceDependencies {
  db: Database.Database;
  blobStore: Pick<MapDesignBlobStore, 'putJson' | 'putBytes'>;
  validationService: { validate(projectId: string, input: { expectedRevision: number }): Promise<MapValidateOutput> };
  eventBus: {
    appendInTransaction?(db: Database.Database, projectId: string, event: MapStudioEvent): number;
    publish(...args: unknown[]): Promise<void> | void;
  };
  previewService: Pick<MapPreviewRequestService, 'complete'>;
  now?: () => string;
  beforeImmediate?(): Promise<void> | void;
}

export class MapPreviewFulfillmentService {
  private readonly now: () => string;

  constructor(private readonly deps: MapPreviewFulfillmentServiceDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async fulfill(projectIdValue: string, previewIdValue: string, value: unknown | MapPreviewFulfillRequest): Promise<MapRenderPreviewOutput> {
    try {
      const projectId = MapIdentifierSchema.parse(projectIdValue);
      const previewId = MapIdentifierSchema.parse(previewIdValue);
      const input = MapPreviewFulfillRequestSchema.parse(value);
      if (input.previewId !== previewId) throw invalidInput();
      const row = this.readPreview(projectId, previewId);
      const replay = this.replayTerminal(row, input);
      if (replay) return replay;
      this.assertRequestedEvidence(row, input, this.timestamp());
      const project = this.readProject(projectId);
      this.assertCurrent(project, row);
      const validation = await this.deps.validationService.validate(projectId, { expectedRevision: row.draftRevision });
      if (validation.styleHash !== row.styleHash || validation.validationDigest !== input.report.validationDigest) {
        throw new MapDraftError('PREVIEW_STALE', 'The map preview validation evidence is stale.');
      }
      const request = this.parseStoredRequest(row.requestJson);
      let png: { bytes: Uint8Array; width: number; height: number } | null = null;
      if (input.status === 'succeeded') {
        png = decodePng(input.pngBase64, request.viewport.width, request.viewport.height);
      }
      const reportBlobPromise = this.deps.blobStore.putJson(projectId, 'reports', input.report);
      const [reportBlob, pngBlob] = await Promise.all([
        reportBlobPromise,
        png ? this.deps.blobStore.putBytes(projectId, 'previews', png.bytes, 'image/png') : Promise.resolve(null),
      ]);
      const output = this.output(input, validation, reportBlob, pngBlob, png);
      await this.deps.beforeImmediate?.();
      const persisted = this.persist(row, input, output);
      if (!persisted.replayed) {
        try { this.deps.previewService.complete(previewId, persisted.output); } catch { /* receipt is durable; replay wakes later waiters */ }
        try { Promise.resolve(this.deps.eventBus.publish()).catch(() => undefined); } catch { /* durable outbox owns retry */ }
      }
      return persisted.output;
    } catch (error) {
      if (isMapDraftError(error)) throw error;
      if (isContractFailure(error)) throw invalidInput();
      throw new MapDraftError('INTERNAL', 'The map preview fulfillment failed.');
    }
  }

  getCurrent(projectIdValue: string): MapCurrentPreviewOutput {
    try {
      const projectId = MapIdentifierSchema.parse(projectIdValue);
      const project = this.readProject(projectId);
      const row = this.deps.db.prepare(`SELECT id, project_id AS projectId, run_id AS runId,
        draft_revision AS draftRevision, style_digest AS styleDigest, style_hash AS styleHash,
        status, request_json AS requestJson, png_digest AS pngDigest, report_digest AS reportDigest,
        validation_digest AS validationDigest, expires_at AS expiresAt
        FROM map_design_previews
        WHERE project_id = ? AND draft_revision = ? AND style_digest = ? AND style_hash = ?
          AND status IN ('passed','failed')
        ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 1`).get(
        projectId, project.draftRevision, project.styleDigest, project.styleHash,
      ) as PreviewRow | undefined;
      if (!row) return MapCurrentPreviewOutputSchema.parse({ preview: null });
      const output = this.readStoredOutput(row);
      if (!output || !storedOutputMatchesRow(row, output)) {
        throw new MapDraftError('INTERNAL', 'The stored map preview result is invalid.');
      }
      return MapCurrentPreviewOutputSchema.parse({ preview: output });
    } catch (error) {
      if (isMapDraftError(error)) throw error;
      if (isContractFailure(error)) throw invalidInput();
      throw new MapDraftError('INTERNAL', 'The current map preview could not be read.');
    }
  }

  private persist(row: PreviewRow, input: MapPreviewFulfillRequest, output: MapRenderPreviewOutput): {
    replayed: boolean; output: MapRenderPreviewOutput;
  } {
    const transaction = this.deps.db.transaction(() => {
      const occurredAt = this.timestamp();
      const current = this.readPreview(row.projectId, row.id);
      if (current.status === 'passed' || current.status === 'failed') {
        const stored = this.readStoredOutput(current);
        if (!stored || canonicalJson(stored) !== canonicalJson(output)) {
          throw new MapDraftError('IDEMPOTENCY_CONFLICT', 'The map preview was already fulfilled differently.');
        }
        return { replayed: true, output: stored };
      }
      if (current.status !== 'requested' || !sameRequestSnapshot(current, row)) {
        throw new MapDraftError('PREVIEW_STALE', 'The map preview request is stale.');
      }
      this.assertRequestedEvidence(current, input, occurredAt);
      this.assertCurrent(this.readProject(row.projectId), current);
      const status = input.status === 'succeeded' ? 'passed' : 'failed';
      const changed = this.deps.db.prepare(`UPDATE map_design_previews SET
        status = ?, png_digest = ?, report_digest = ?, validation_digest = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND status = 'requested'
          AND draft_revision = ? AND style_digest = ? AND style_hash = ?`).run(
        status,
        output.status === 'succeeded' ? output.png.digest : null,
        output.report.digest,
        input.report.validationDigest,
        occurredAt,
        row.id,
        row.projectId,
        row.draftRevision,
        row.styleDigest,
        row.styleHash,
      );
      if (changed.changes !== 1) throw new MapDraftError('PREVIEW_STALE', 'The map preview request is stale.');
      this.persistReceiptInTransaction(current, output, occurredAt);
      this.deps.eventBus.appendInTransaction?.(this.deps.db, row.projectId, MapStudioEventSchema.parse({
        type: 'preview.updated', occurredAt,
        payload: { draftRevision: row.draftRevision, styleHash: row.styleHash, previewId: row.id, status: input.status },
      }));
      return { replayed: false, output };
    });
    return transaction.immediate();
  }

  private replayTerminal(row: PreviewRow, input: MapPreviewFulfillRequest): MapRenderPreviewOutput | null {
    if (row.status !== 'passed' && row.status !== 'failed') return null;
    const stored = this.readStoredOutput(row);
    if (!stored || row.validationDigest !== input.report.validationDigest
      || (row.status === 'passed') !== (input.status === 'succeeded')) {
      throw new MapDraftError('IDEMPOTENCY_CONFLICT', 'The map preview was already fulfilled differently.');
    }
    const request = this.parseStoredRequest(row.requestJson);
    const reportBytes = canonicalJsonBytes(input.report);
    const report = { digest: blake3Digest(reportBytes), mediaType: 'application/json' as const, byteLength: reportBytes.byteLength };
    let candidate: MapRenderPreviewOutput;
    if (input.status === 'succeeded') {
      const png = decodePng(input.pngBase64, request.viewport.width, request.viewport.height);
      candidate = MapRenderPreviewOutputSchema.parse({ ...stored, status: 'succeeded',
        report,
        png: { digest: blake3Digest(png.bytes), mediaType: 'image/png', byteLength: png.bytes.byteLength,
          width: png.width, height: png.height } });
    } else {
      candidate = MapRenderPreviewOutputSchema.parse({ ...stored, status: 'failed', png: null,
        report });
    }
    if (canonicalJson(candidate) !== canonicalJson(stored)) {
      throw new MapDraftError('IDEMPOTENCY_CONFLICT', 'The map preview was already fulfilled differently.');
    }
    return stored;
  }

  private output(input: MapPreviewFulfillRequest, validation: MapValidateOutput, report: StoredBlob,
    pngBlob: StoredBlob | null, png: { width: number; height: number } | null): MapRenderPreviewOutput {
    const base = {
      previewId: input.previewId, draftRevision: input.draftRevision, styleHash: input.styleHash,
      report: { digest: report.digest, mediaType: 'application/json' as const, byteLength: report.byteLength },
      validationSummary: validation.summary,
    };
    return MapRenderPreviewOutputSchema.parse(input.status === 'succeeded' && png && pngBlob
      ? { ...base, status: 'succeeded', png: { digest: pngBlob.digest, mediaType: 'image/png', byteLength: pngBlob.byteLength,
          width: png.width, height: png.height } }
      : { ...base, status: 'failed', png: null });
  }

  private readPreview(projectId: string, previewId: string): PreviewRow {
    const row = this.deps.db.prepare(`SELECT id, project_id AS projectId, run_id AS runId,
      draft_revision AS draftRevision, style_digest AS styleDigest, style_hash AS styleHash,
      status, request_json AS requestJson, png_digest AS pngDigest, report_digest AS reportDigest,
      validation_digest AS validationDigest, expires_at AS expiresAt
      FROM map_design_previews WHERE id = ? AND project_id = ?`).get(previewId, projectId) as PreviewRow | undefined;
    if (!row) throw new MapDraftError('NOT_FOUND', 'The map preview was not found.');
    return row;
  }

  private readProject(projectId: string): ProjectRow {
    const row = this.deps.db.prepare(`SELECT project_id AS projectId, lifecycle_state AS lifecycleState,
      draft_revision AS draftRevision, draft_style_digest AS styleDigest, draft_style_hash AS styleHash
      FROM map_design_projects WHERE project_id = ?`).get(projectId) as ProjectRow | undefined;
    if (!row) throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
    if (row.lifecycleState !== 'ready' || !row.styleDigest || !row.styleHash) {
      throw new MapDraftError('PROJECT_NOT_READY', 'The map project is not ready.');
    }
    return row;
  }

  private assertRequestedEvidence(row: PreviewRow, input: MapPreviewFulfillRequest, now: string): void {
    if (row.draftRevision !== input.draftRevision || row.styleHash !== input.styleHash) {
      throw new MapDraftError('PREVIEW_STALE', 'The map preview evidence does not match the request.');
    }
    if (Date.parse(row.expiresAt) <= Date.parse(now) || row.status === 'expired') {
      throw new MapDraftError('PREVIEW_STALE', 'The map preview request expired.');
    }
  }

  private assertCurrent(project: ProjectRow, row: PreviewRow): void {
    if (project.draftRevision !== row.draftRevision || project.styleDigest !== row.styleDigest || project.styleHash !== row.styleHash) {
      throw new MapDraftError('PREVIEW_STALE', 'The map preview request is stale.');
    }
  }

  private parseStoredRequest(value: string) {
    try {
      const parsed = MapRenderPreviewInputSchema.parse(JSON.parse(value));
      if (!parsed.viewport) throw new TypeError('missing viewport');
      return { ...parsed, viewport: parsed.viewport };
    } catch { throw new MapDraftError('INTERNAL', 'The stored map preview request is invalid.'); }
  }

  private readStoredOutput(row: PreviewRow): MapRenderPreviewOutput | null {
    const request = this.parseStoredRequest(row.requestJson);
    const receipt = this.deps.db.prepare(`SELECT request_digest AS requestDigest, response_json AS responseJson FROM map_design_idempotency
      WHERE project_id = ? AND operation = 'map_render_preview' AND idempotency_key = ?`)
      .get(row.projectId, request.idempotencyKey) as ReceiptRow | undefined;
    if (!receipt || receipt.requestDigest !== requestDigest(request)) return null;
    try { return MapRenderPreviewOutputSchema.parse(JSON.parse(receipt.responseJson)); } catch { return null; }
  }

  private persistReceiptInTransaction(row: PreviewRow, output: MapRenderPreviewOutput, occurredAt: string): void {
    const request = this.parseStoredRequest(row.requestJson);
    const digest = requestDigest(request);
    const existing = this.deps.db.prepare(`SELECT request_digest AS requestDigest, response_json AS responseJson
      FROM map_design_idempotency
      WHERE project_id = ? AND operation = 'map_render_preview' AND idempotency_key = ?`).get(
      row.projectId, request.idempotencyKey,
    ) as ReceiptRow | undefined;
    if (existing) {
      if (existing.requestDigest !== digest || canonicalJson(JSON.parse(existing.responseJson)) !== canonicalJson(output)) {
        throw new MapDraftError('IDEMPOTENCY_CONFLICT', 'The map preview receipt conflicts with the fulfillment.');
      }
      return;
    }
    this.deps.db.prepare(`INSERT INTO map_design_idempotency (
      project_id, operation, idempotency_key, request_digest, response_json, created_at
    ) VALUES (?, 'map_render_preview', ?, ?, ?, ?)`).run(
      row.projectId, request.idempotencyKey, digest, JSON.stringify(output), occurredAt,
    );
  }

  private timestamp(): string {
    try { return MapTimestampSchema.parse(this.now()); } catch { throw new MapDraftError('INTERNAL', 'The map preview clock is invalid.'); }
  }
}

function decodePng(encoded: string, expectedWidth: number, expectedHeight: number): {
  bytes: Uint8Array; width: number; height: number;
} {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength > 8 * 1024 * 1024 || bytes.byteLength < 24) throw invalidInput();
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((byte, index) => bytes[index] !== byte) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw invalidInput();
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  if (width !== expectedWidth || height !== expectedHeight) throw invalidInput();
  return { bytes: new Uint8Array(bytes), width, height };
}

function sameRequestSnapshot(left: PreviewRow, right: PreviewRow): boolean {
  return left.id === right.id && left.projectId === right.projectId && left.runId === right.runId
    && left.draftRevision === right.draftRevision && left.styleDigest === right.styleDigest
    && left.styleHash === right.styleHash && left.requestJson === right.requestJson && left.expiresAt === right.expiresAt;
}

function storedOutputMatchesRow(row: PreviewRow, output: MapRenderPreviewOutput): boolean {
  return output.previewId === row.id
    && output.draftRevision === row.draftRevision
    && output.styleHash === row.styleHash
    && output.report.digest === row.reportDigest
    && ((row.status === 'passed' && output.status === 'succeeded' && output.png.digest === row.pngDigest)
      || (row.status === 'failed' && output.status === 'failed' && row.pngDigest === null));
}

function isContractFailure(error: unknown): boolean {
  return error instanceof TypeError || (typeof error === 'object' && error !== null && 'issues' in error);
}
