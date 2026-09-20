import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  DEFAULT_MAP_PREVIEW_VIEWPORT,
  MapIdentifierSchema,
  MapRenderPreviewInputSchema,
  MapRenderPreviewOutputSchema,
  MapStudioEventSchema,
  type MapRenderPreviewInput,
  type MapRenderPreviewOutput,
} from '@mapseekai/map-design-contracts';

import type { MapDesignEventOutbox } from './event-outbox.js';
import type { MapRunContext } from './draft-service.js';
import { MapDraftError, invalidInput } from './errors.js';
import { requestDigest } from './request-digest.js';

type SqliteDb = Database.Database;

export interface MapPreviewRequestService {
  requestAndWait(context: MapRunContext, input: MapRenderPreviewInput): Promise<MapRenderPreviewOutput>;
  complete(previewId: string, output: MapRenderPreviewOutput): void;
  shutdown(): void;
}

export interface MapPreviewRequestServiceDependencies {
  db: SqliteDb;
  outbox: Pick<MapDesignEventOutbox, 'appendInTransaction' | 'drainPending'>;
  now?: () => string;
  createId?: () => string;
  deadlineMs?: number;
}

interface ProjectRow {
  projectId: string;
  lifecycleState: string;
  draftRevision: number;
  styleDigest: string | null;
  styleHash: string | null;
}

interface PreviewRow {
  id: string;
  projectId: string;
  runId: string;
  draftRevision: number;
  styleDigest: string;
  styleHash: string;
  status: 'requested' | 'rendering' | 'passed' | 'failed' | 'expired';
  requestJson: string;
  pngDigest: string | null;
  reportDigest: string | null;
  expiresAt: string;
}

interface ReceiptRow { requestDigest: string; responseJson: string; }

interface Waiter {
  resolve(value: MapRenderPreviewOutput): void;
  reject(error: MapDraftError): void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_DEADLINE_MS = 60_000;

export class MapPreviewRequestServiceImpl implements MapPreviewRequestService {
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly deadlineMs: number;
  private readonly waiters = new Map<string, Set<Waiter>>();
  private closed = false;

  constructor(private readonly deps: MapPreviewRequestServiceDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.createId = deps.createId ?? randomUUID;
    this.deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
    if (!Number.isSafeInteger(this.deadlineMs) || this.deadlineMs < 1) throw new TypeError('invalid preview deadline');
  }

  async requestAndWait(context: MapRunContext, input: MapRenderPreviewInput): Promise<MapRenderPreviewOutput> {
    if (this.closed) throw unavailable('The map preview service is shutting down.');
    const parsed = parseRequest(input);
    const normalized = normalizeRequest({
      ...parsed,
      viewport: parsed.viewport ?? DEFAULT_MAP_PREVIEW_VIEWPORT,
    });
    const digest = digestRequest(normalized);
    const project = this.readReadyProject(context.projectId);
    const existing = this.findByIdempotencyKey(context.projectId, normalized.idempotencyKey);
    const receipt = this.readReceipt(context.projectId, normalized.idempotencyKey);
    if (receipt) {
      if (!existing) throw invalidStoredPreview();
      assertRequestIdentity(existing, context, normalized, digest);
      return replayReceipt(receipt, digest);
    }
    if (project.draftRevision !== normalized.expectedRevision) throw revisionConflict(project.draftRevision);

    let previewId: string;
    let shouldDrain = false;
    if (existing) {
      assertRequestIdentity(existing, context, normalized, digest);
      if (existing.draftRevision !== project.draftRevision
        || existing.styleDigest !== project.styleDigest
        || existing.styleHash !== project.styleHash) {
        throw new MapDraftError('PREVIEW_STALE', 'The map preview request is stale.');
      }
      if (existing.status === 'expired' || expired(existing.expiresAt, this.now())) {
        throw new MapDraftError('PREVIEW_STALE', 'The map preview request is stale.');
      }
      previewId = existing.id;
    } else {
      throwIfCancelled(context.signal);
      const inserted = this.insertRequest(context, project, normalized);
      if (typeof inserted !== 'string') return inserted;
      previewId = inserted;
      shouldDrain = true;
    }
    const preview = this.readPreview(previewId);
    if (!preview) throw invalidStoredPreview();
    // The enqueue transaction is the cancellation commit point. Once its row
    // and outbox event are durable, only the bounded terminal receipt is truthful.
    const pending = this.wait(previewId, preview.expiresAt);
    this.reconcileStoredReceipt(previewId, context, normalized, digest);
    if (shouldDrain) void this.deps.outbox.drainPending().catch(() => undefined);
    return pending;
  }

  complete(previewId: string, rawOutput: MapRenderPreviewOutput): void {
    if (this.closed) return;
    let output: MapRenderPreviewOutput;
    try {
      output = MapRenderPreviewOutputSchema.parse(rawOutput);
    } catch {
      return;
    }
    const row = this.readPreview(previewId);
    if (!row || output.previewId !== row.id
      || output.draftRevision !== row.draftRevision
      || output.styleHash !== row.styleHash
      || (row.status === 'passed' && output.status !== 'succeeded')
      || (row.status === 'failed' && output.status !== 'failed')
      || (row.status !== 'passed' && row.status !== 'failed')
      || row.reportDigest !== output.report.digest
      || (output.status === 'succeeded' && row.pngDigest !== output.png.digest)) return;

    let project: ProjectRow;
    try {
      project = this.readReadyProject(row.projectId);
    } catch (error) {
      this.rejectAll(previewId, error instanceof MapDraftError ? error : unavailable());
      return;
    }
    if (project.draftRevision !== row.draftRevision
      || project.styleDigest !== row.styleDigest
      || project.styleHash !== row.styleHash) {
      this.rejectAll(previewId, new MapDraftError('PREVIEW_STALE', 'The map preview is stale.'));
      return;
    }

    const request = parseStoredRequest(row.requestJson);
    const receipt = this.readReceipt(row.projectId, request.idempotencyKey);
    if (!receipt) return;
    try {
      const stored = replayReceipt(receipt, digestRequest(request));
      if (JSON.stringify(stored) !== JSON.stringify(output)) return;
    } catch { return; }
    this.resolveAll(previewId, output);
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const previewId of [...this.waiters.keys()]) {
      this.rejectAll(previewId, unavailable('The map preview service is shutting down.'));
    }
  }

  private insertRequest(context: MapRunContext, project: ProjectRow, input: MapRenderPreviewInput & { viewport: NonNullable<MapRenderPreviewInput['viewport']> }): string | MapRenderPreviewOutput {
    const previewId = this.createId();
    const occurredAt = timestamp(this.now());
    const expiresAt = new Date(Date.parse(occurredAt) + this.deadlineMs).toISOString();
    const event = MapStudioEventSchema.parse({
      type: 'preview.requested',
      occurredAt,
      payload: {
        draftRevision: project.draftRevision,
        styleHash: project.styleHash,
        previewId,
        viewport: input.viewport,
        expiresAt,
      },
    });
    const transaction = this.deps.db.transaction(() => {
      throwIfCancelled(context.signal);
      const current = this.readReadyProject(context.projectId);
      if (current.draftRevision !== project.draftRevision
        || current.styleDigest !== project.styleDigest
        || current.styleHash !== project.styleHash) throw revisionConflict(current.draftRevision);
      const raced = this.findByIdempotencyKey(context.projectId, input.idempotencyKey);
      const receipt = this.readReceipt(context.projectId, input.idempotencyKey);
      if (receipt) {
        if (!raced) throw invalidStoredPreview();
        assertRequestIdentity(raced, context, input, digestRequest(input));
        return replayReceipt(receipt, digestRequest(input));
      }
      if (raced) {
        assertRequestIdentity(raced, context, input, digestRequest(input));
        if (raced.draftRevision !== current.draftRevision
          || raced.styleDigest !== current.styleDigest
          || raced.styleHash !== current.styleHash) {
          throw new MapDraftError('PREVIEW_STALE', 'The map preview request is stale.');
        }
        return raced.id;
      }
      this.deps.db.prepare(`INSERT INTO map_design_previews (
        id, project_id, run_id, draft_revision, style_digest, style_hash, status,
        request_json, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?)`).run(
        previewId,
        context.projectId,
        context.runId,
        current.draftRevision,
        current.styleDigest,
        current.styleHash,
        JSON.stringify(input),
        expiresAt,
        occurredAt,
        occurredAt,
      );
      this.deps.outbox.appendInTransaction(this.deps.db, context.projectId, event);
      throwIfCancelled(context.signal);
      return previewId;
    });
    return transaction.immediate() as string | MapRenderPreviewOutput;
  }

  private findByIdempotencyKey(projectId: string, key: string): PreviewRow | null {
    const rows = this.deps.db.prepare(`SELECT
      id, project_id AS projectId, run_id AS runId, draft_revision AS draftRevision,
      style_digest AS styleDigest, style_hash AS styleHash, status,
      request_json AS requestJson, png_digest AS pngDigest, report_digest AS reportDigest,
      expires_at AS expiresAt
      FROM map_design_previews WHERE project_id = ? ORDER BY created_at ASC, id ASC`).all(projectId) as PreviewRow[];
    for (const row of rows) {
      const request = parseStoredRequest(row.requestJson);
      if (request.idempotencyKey === key) return row;
    }
    return null;
  }

  private readPreview(previewId: string): PreviewRow | null {
    return (this.deps.db.prepare(`SELECT
      id, project_id AS projectId, run_id AS runId, draft_revision AS draftRevision,
      style_digest AS styleDigest, style_hash AS styleHash, status,
      request_json AS requestJson, png_digest AS pngDigest, report_digest AS reportDigest,
      expires_at AS expiresAt
      FROM map_design_previews WHERE id = ?`).get(previewId) as PreviewRow | undefined) ?? null;
  }

  private readReadyProject(projectId: string): ProjectRow {
    const row = this.deps.db.prepare(`SELECT project_id AS projectId, lifecycle_state AS lifecycleState,
      draft_revision AS draftRevision, draft_style_digest AS styleDigest, draft_style_hash AS styleHash
      FROM map_design_projects WHERE project_id = ?`).get(projectId) as ProjectRow | undefined;
    if (!row) throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
    if (row.lifecycleState !== 'ready' || !row.styleDigest || !row.styleHash) {
      throw new MapDraftError('PROJECT_NOT_READY', 'The map project is not ready.');
    }
    return row;
  }

  private readReceipt(projectId: string, key: string): ReceiptRow | null {
    return (this.deps.db.prepare(`SELECT request_digest AS requestDigest, response_json AS responseJson
      FROM map_design_idempotency
      WHERE project_id = ? AND operation = 'map_render_preview' AND idempotency_key = ?`).get(
      projectId,
      key,
    ) as ReceiptRow | undefined) ?? null;
  }

  private wait(previewId: string, expiresAt: string): Promise<MapRenderPreviewOutput> {
    const remainingMs = remainingDuration(expiresAt, this.now());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.deps.db.prepare(`UPDATE map_design_previews SET status = 'expired', updated_at = ?
          WHERE id = ? AND status IN ('requested','rendering')`).run(timestamp(this.now()), previewId);
        this.rejectAll(previewId, new MapDraftError('PREVIEW_FAILED', 'The map preview request timed out.', { retryable: true }));
      }, remainingMs);
      timer.unref?.();
      const waiter: Waiter = { resolve, reject, timer };
      const set = this.waiters.get(previewId) ?? new Set<Waiter>();
      set.add(waiter);
      this.waiters.set(previewId, set);
    });
  }

  private reconcileStoredReceipt(
    previewId: string,
    context: MapRunContext,
    input: MapRenderPreviewInput,
    digest: string,
  ): void {
    try {
      const row = this.readPreview(previewId);
      if (!row) throw invalidStoredPreview();
      assertRequestIdentity(row, context, input, digest);
      const receipt = this.readReceipt(row.projectId, input.idempotencyKey);
      if (receipt) this.resolveAll(previewId, replayReceipt(receipt, digest));
    } catch (error) {
      this.rejectAll(previewId, error instanceof MapDraftError ? error : invalidStoredPreview());
    }
  }

  private resolveAll(previewId: string, output: MapRenderPreviewOutput): void {
    const set = this.waiters.get(previewId);
    if (!set) return;
    this.waiters.delete(previewId);
    for (const waiter of set) {
      cleanup(waiter);
      waiter.resolve(output);
    }
  }

  private rejectAll(previewId: string, error: MapDraftError): void {
    const set = this.waiters.get(previewId);
    if (!set) return;
    this.waiters.delete(previewId);
    for (const waiter of set) {
      cleanup(waiter);
      waiter.reject(error);
    }
  }

}

export function createMapPreviewRequestService(deps: MapPreviewRequestServiceDependencies): MapPreviewRequestServiceImpl {
  return new MapPreviewRequestServiceImpl(deps);
}

export const createMapDesignPreviewRequestService = createMapPreviewRequestService;

function parseRequest(input: unknown): MapRenderPreviewInput {
  try {
    return MapRenderPreviewInputSchema.parse(input);
  } catch {
    throw invalidInput();
  }
}

function normalizeRequest(input: unknown): ReturnType<typeof MapRenderPreviewInputSchema.parse> & { viewport: NonNullable<MapRenderPreviewInput['viewport']> } {
  const parsed = MapRenderPreviewInputSchema.parse(input);
  if (!parsed.viewport) throw invalidInput();
  return parsed as ReturnType<typeof MapRenderPreviewInputSchema.parse> & { viewport: NonNullable<MapRenderPreviewInput['viewport']> };
}

function parseStoredRequest(json: string): ReturnType<typeof MapRenderPreviewInputSchema.parse> & { viewport: NonNullable<MapRenderPreviewInput['viewport']> } {
  try {
    const parsed = MapRenderPreviewInputSchema.parse(JSON.parse(json));
    if (!parsed.viewport) throw new TypeError('stored preview viewport missing');
    return parsed as ReturnType<typeof MapRenderPreviewInputSchema.parse> & { viewport: NonNullable<MapRenderPreviewInput['viewport']> };
  } catch {
    throw new MapDraftError('INTERNAL', 'The stored map preview request is invalid.');
  }
}

function digestRequest(input: unknown): string {
  try {
    return requestDigest(input);
  } catch {
    throw invalidInput();
  }
}

function replayReceipt(receipt: ReceiptRow, digest: string): MapRenderPreviewOutput {
  if (receipt.requestDigest !== digest) throw idempotencyConflict();
  try {
    return MapRenderPreviewOutputSchema.parse(JSON.parse(receipt.responseJson));
  } catch {
    throw new MapDraftError('INTERNAL', 'The stored map preview receipt is invalid.');
  }
}

function timestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new MapDraftError('INTERNAL', 'The map preview clock is invalid.');
  return new Date(parsed).toISOString();
}

function revisionConflict(currentRevision: number): MapDraftError {
  return new MapDraftError('REVISION_CONFLICT', 'The map draft revision has changed.', {
    retryable: true,
    details: { currentRevision },
  });
}

function idempotencyConflict(): MapDraftError {
  return new MapDraftError('IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.');
}

function invalidStoredPreview(): MapDraftError {
  return new MapDraftError('INTERNAL', 'The stored map preview request is invalid.');
}

function assertRequestIdentity(
  row: PreviewRow,
  context: MapRunContext,
  input: MapRenderPreviewInput,
  digest: string,
): void {
  const stored = parseStoredRequest(row.requestJson);
  if (!MapIdentifierSchema.safeParse(row.runId).success) throw invalidStoredPreview();
  if (row.projectId !== context.projectId
    || row.runId !== context.runId
    || stored.idempotencyKey !== input.idempotencyKey
    || digestRequest(stored) !== digest) throw idempotencyConflict();
}

function cancelled(): MapDraftError {
  return new MapPreviewRequestCancellationError();
}

class MapPreviewRequestCancellationError extends MapDraftError {
  constructor() {
    super('INTERNAL', 'The map preview request was cancelled.', { retryable: true });
    this.name = 'MapPreviewRequestCancellationError';
  }
}

export function isMapPreviewRequestCancellation(error: unknown): boolean {
  return error instanceof MapPreviewRequestCancellationError;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

function unavailable(message = 'The map preview service is unavailable.'): MapDraftError {
  return new MapDraftError('PREVIEW_FAILED', message, { retryable: true });
}

function cleanup(waiter: Waiter): void {
  clearTimeout(waiter.timer);
}

function expired(expiresAt: string, now: string): boolean {
  const expires = Date.parse(expiresAt);
  const current = Date.parse(now);
  return !Number.isFinite(expires) || !Number.isFinite(current) || expires <= current;
}

function remainingDuration(expiresAt: string, now: string): number {
  const expires = Date.parse(expiresAt);
  const current = Date.parse(now);
  if (!Number.isFinite(expires) || !Number.isFinite(current)) throw invalidStoredPreview();
  return Math.max(0, expires - current);
}
