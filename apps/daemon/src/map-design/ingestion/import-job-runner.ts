import type Database from 'better-sqlite3';
import { MapProjectImportInputSchema, MapStudioEventSchema } from '@mapseekai/map-design-contracts';

import { requestDigest } from '../application/request-digest.js';
import type { MapDesignEventOutbox } from '../application/event-outbox.js';
import { canonicalJson } from '../storage/canonical-json.js';
import type { MapImportJobExecutor } from './source-import-service.js';

type SqliteDb = Database.Database;

export interface MapImportJobRunner {
  enqueue(projectId: string): boolean;
  recoverAbandoned(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface MapImportJobRunnerDependencies {
  db: SqliteDb;
  executor: MapImportJobExecutor;
  concurrency?: number;
  onImported?(projectId: string): Promise<void>;
  now?: () => string;
  outbox?: Pick<MapDesignEventOutbox, 'appendInTransaction'>;
}

interface JobRow {
  projectId: string;
  status: string;
  importRequestJson: string;
  importRequestDigest: string;
}

export function createMapImportJobRunner(deps: MapImportJobRunnerDependencies): MapImportJobRunner {
  const concurrency = Math.min(2, Math.max(1, deps.concurrency ?? 2));
  const now = deps.now ?? (() => new Date().toISOString());
  const queued = new Set<string>();
  const pendingRetries = new Set<string>();
  const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  let shutdownRequested = false;
  let scheduled = false;
  let unhealthy: unknown = null;

  const markUnhealthy = (error: unknown) => {
    unhealthy = error;
    queued.clear();
    pendingRetries.clear();
    for (const entry of active.values()) entry.controller.abort(new Error('MapDesign import runner unhealthy'));
  };

  const schedule = () => {
    if (scheduled || shutdownRequested || unhealthy) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      while (!shutdownRequested && !unhealthy && active.size < concurrency) {
        const projectId = queued.values().next().value as string | undefined;
        if (!projectId) break;
        queued.delete(projectId);
        if (active.has(projectId)) continue;
        const controller = new AbortController();
        const promise = (async () => {
          try {
            try {
              await deps.executor.executeImportJob(projectId, controller.signal);
            } catch {
              failClosed(
                deps.db, deps.outbox, projectId, now(), 'IMPORT_INTERNAL',
                'The import stopped unexpectedly and can be retried.',
              );
            }
            if (!shutdownRequested) await deps.onImported?.(projectId);
            if (pendingRetries.delete(projectId) && !unhealthy) {
              const prepared = await deps.executor.preparePendingRetry(projectId);
              if (prepared && !shutdownRequested && !unhealthy) queued.add(projectId);
            }
          } catch (error) {
            markUnhealthy(error);
          } finally {
            active.delete(projectId);
            schedule();
          }
        })();
        active.set(projectId, { controller, promise });
      }
    });
  };

  return {
    enqueue(projectId: string): boolean {
      if (shutdownRequested || unhealthy) return false;
      if (active.has(projectId)) {
        pendingRetries.add(projectId);
        return true;
      }
      queued.add(projectId);
      schedule();
      return true;
    },

    async recoverAbandoned(): Promise<void> {
      if (shutdownRequested || unhealthy) return;
      const rows = deps.db.prepare(`SELECT project_id AS projectId, status,
        import_request_json AS importRequestJson, import_request_digest AS importRequestDigest
        FROM map_design_import_jobs WHERE status IN ('queued','running') ORDER BY queued_at, project_id`)
        .all() as JobRow[];
      for (const row of rows) {
        if (!validCanonicalRequest(row)) {
          failClosed(deps.db, deps.outbox, row.projectId, now(), 'IMPORT_REQUEST_INVALID', 'The canonical import request is invalid.');
          continue;
        }
        if (row.status === 'running') {
          failClosed(deps.db, deps.outbox, row.projectId, now(), 'IMPORT_ABANDONED', 'The import was interrupted and can be retried.');
          continue;
        }
        queued.add(row.projectId);
      }
      schedule();
    },

    async shutdown(): Promise<void> {
      shutdownRequested = true;
      for (const { controller } of active.values()) controller.abort(new Error('MapDesign import runner shutting down'));
      await Promise.all([...active.values()].map(({ promise }) => promise));
      queued.clear();
      pendingRetries.clear();
      if (unhealthy) throw new Error('MapDesign import runner persistence failed', { cause: unhealthy });
    },
  };
}

function validCanonicalRequest(row: JobRow): boolean {
  try {
    const parsed = MapProjectImportInputSchema.parse(JSON.parse(row.importRequestJson));
    return canonicalJson(parsed) === row.importRequestJson && requestDigest(parsed) === row.importRequestDigest;
  } catch {
    return false;
  }
}

function failClosed(
  db: SqliteDb,
  outbox: Pick<MapDesignEventOutbox, 'appendInTransaction'> | undefined,
  projectId: string,
  at: string,
  code: string,
  message: string,
): void {
  const transaction = db.transaction(() => {
    const changed = db.prepare(`UPDATE map_design_import_jobs SET status = 'failed', finished_at = ?,
      failure_code = ?, failure_message = ? WHERE project_id = ? AND status IN ('queued','running')`)
      .run(at, code, message, projectId);
    if (changed.changes !== 1) return;
    db.prepare(`UPDATE map_design_projects SET lifecycle_state = 'failed', failure_code = ?,
      failure_message = ?, updated_at = ? WHERE project_id = ? AND lifecycle_state = 'importing'`)
      .run(code, message, at, projectId);
    outbox?.appendInTransaction(db, projectId, MapStudioEventSchema.parse({
      type: 'project.lifecycle.updated',
      occurredAt: at,
      payload: { lifecycle: 'failed', failure: { code, message } },
    }));
  });
  transaction.immediate();
}
