import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { MapStudioEventSchema, type MapStudioEvent } from '@mapseekai/map-design-contracts';

import { canonicalJson } from '../storage/canonical-json.js';
import type { MapStudioEventPublisher } from './event-bus.js';

type SqliteDb = Database.Database;

interface OutboxRow {
  sequence: number;
  projectId: string;
  eventJson: string;
}

export interface MapDesignEventOutboxDependencies {
  db: SqliteDb;
  publish: MapStudioEventPublisher['publish'];
  now?: () => string;
  ownerId?: string;
  reportError?: (error: unknown) => void;
}

export class MapDesignEventOutbox {
  private readonly now: () => string;
  private readonly ownerId: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(private readonly deps: MapDesignEventOutboxDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.ownerId = deps.ownerId ?? randomUUID();
  }

  appendInTransaction(db: SqliteDb, projectId: string, event: MapStudioEvent): number {
    const parsed = MapStudioEventSchema.parse(event);
    const result = db.prepare(`INSERT INTO map_design_event_outbox
      (project_id, event_json, occurred_at) VALUES (?, ?, ?)`).run(
      projectId,
      canonicalJson(parsed),
      parsed.occurredAt,
    );
    return Number(result.lastInsertRowid);
  }

  start(intervalMs = 250): void {
    if (this.timer) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new TypeError('invalid outbox interval');
    this.timer = setInterval(() => {
      void this.drainPending().catch((error) => (this.deps.reportError ?? console.error)(error));
    }, intervalMs);
    this.timer.unref();
    void this.drainPending().catch((error) => (this.deps.reportError ?? console.error)(error));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.drainPromise;
  }

  drainPending(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    const pending = this.drainOnce().finally(() => {
      if (this.drainPromise === pending) this.drainPromise = null;
    });
    this.drainPromise = pending;
    return pending;
  }

  listAfter(projectId: string, sequence: number, limit: number): {
    events: readonly { sequence: number; event: MapStudioEvent }[];
    oldestAvailableSequence: number | null;
    latestSequence: number | null;
    gap: boolean;
  } {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError('invalid outbox cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError('invalid outbox limit');
    const bounds = this.deps.db.prepare(`SELECT MIN(sequence) AS oldest, MAX(sequence) AS latest
      FROM map_design_event_outbox WHERE project_id = ?`).get(projectId) as {
        oldest: number | null; latest: number | null;
      };
    const retention = this.deps.db.prepare(`SELECT deleted_through_sequence AS deletedThrough
      FROM map_design_event_retention WHERE project_id = ?`).get(projectId) as {
        deletedThrough: number;
      } | undefined;
    const rows = this.deps.db.prepare(`SELECT sequence, event_json AS eventJson
      FROM map_design_event_outbox WHERE project_id = ? AND sequence > ?
      ORDER BY sequence ASC LIMIT ?`).all(projectId, sequence, limit) as Array<{
        sequence: number; eventJson: string;
      }>;
    return {
      events: rows.map((row) => ({ sequence: row.sequence, event: parseEvent(row.eventJson) })),
      oldestAvailableSequence: bounds.oldest,
      latestSequence: bounds.latest,
      gap: sequence < (retention?.deletedThrough ?? 0),
    };
  }

  private async drainOnce(): Promise<void> {
    for (;;) {
      const row = this.claim();
      if (!row) break;
      let event: MapStudioEvent;
      try {
        event = parseEvent(row.eventJson);
        await this.deps.publish(row.projectId, row.sequence, event);
      } catch {
        this.deps.db.prepare(`UPDATE map_design_event_outbox
          SET lease_owner = NULL, lease_expires_at = NULL WHERE sequence = ? AND lease_owner = ?`)
          .run(row.sequence, this.ownerId);
        break;
      }
      const publishedAt = this.timestamp();
      this.deps.db.prepare(`UPDATE map_design_event_outbox
        SET published_at = ?, lease_owner = NULL, lease_expires_at = NULL
        WHERE sequence = ? AND lease_owner = ?`).run(publishedAt, row.sequence, this.ownerId);
      this.retain(row.projectId, publishedAt);
    }
    this.sweepRetention(this.timestamp());
  }

  private claim(): OutboxRow | null {
    const transaction = this.deps.db.transaction(() => {
      const now = this.timestamp();
      const row = this.deps.db.prepare(`SELECT sequence, project_id AS projectId, event_json AS eventJson
        FROM map_design_event_outbox
        WHERE published_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY sequence ASC LIMIT 1`).get(now) as OutboxRow | undefined;
      if (!row) return null;
      const expiresAt = new Date(Date.parse(now) + 30_000).toISOString();
      const changed = this.deps.db.prepare(`UPDATE map_design_event_outbox
        SET attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?
        WHERE sequence = ? AND published_at IS NULL
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`)
        .run(this.ownerId, expiresAt, row.sequence, now);
      return changed.changes === 1 ? row : null;
    });
    return transaction.immediate();
  }

  private retain(projectId: string, now: string): void {
    const transaction = this.deps.db.transaction(() => {
      this.retainInTransaction(projectId, now);
    });
    transaction.immediate();
  }

  private retainInTransaction(projectId: string, now: string): void {
    const cutoff = new Date(Date.parse(now) - 7 * 24 * 60 * 60 * 1_000).toISOString();
    const expired = this.deps.db.prepare(`SELECT MAX(sequence) AS sequence FROM map_design_event_outbox
      WHERE project_id = ? AND published_at IS NOT NULL AND published_at < ?`)
      .get(projectId, cutoff) as { sequence: number | null };
    if (expired.sequence !== null) this.recordDeletion(projectId, expired.sequence);
    this.deps.db.prepare(`DELETE FROM map_design_event_outbox
      WHERE project_id = ? AND published_at IS NOT NULL AND published_at < ?`).run(projectId, cutoff);
    const overflow = this.deps.db.prepare(`SELECT MAX(sequence) AS sequence FROM (
      SELECT sequence FROM map_design_event_outbox
      WHERE project_id = ? AND published_at IS NOT NULL
      ORDER BY sequence DESC LIMIT -1 OFFSET 10000
    )`).get(projectId) as { sequence: number | null };
    if (overflow.sequence !== null) this.recordDeletion(projectId, overflow.sequence);
    this.deps.db.prepare(`DELETE FROM map_design_event_outbox WHERE sequence IN (
      SELECT sequence FROM map_design_event_outbox
      WHERE project_id = ? AND published_at IS NOT NULL
      ORDER BY sequence DESC LIMIT -1 OFFSET 10000
    )`).run(projectId);
  }

  private sweepRetention(now: string): void {
    const projects = this.deps.db.prepare(`SELECT DISTINCT project_id AS projectId
      FROM map_design_event_outbox WHERE published_at IS NOT NULL`).all() as Array<{ projectId: string }>;
    const transaction = this.deps.db.transaction(() => {
      for (const { projectId } of projects) this.retainInTransaction(projectId, now);
    });
    transaction.immediate();
  }

  private recordDeletion(projectId: string, sequence: number): void {
    this.deps.db.prepare(`INSERT INTO map_design_event_retention
      (project_id, deleted_through_sequence) VALUES (?, ?)
      ON CONFLICT(project_id) DO UPDATE SET deleted_through_sequence =
        MAX(deleted_through_sequence, excluded.deleted_through_sequence)`).run(projectId, sequence);
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(Date.parse(value))) throw new TypeError('invalid outbox clock');
    return value;
  }
}

function parseEvent(json: string): MapStudioEvent {
  const value = JSON.parse(json) as unknown;
  const event = MapStudioEventSchema.parse(value);
  if (canonicalJson(event) !== json) throw new TypeError('invalid canonical outbox event');
  return event;
}
