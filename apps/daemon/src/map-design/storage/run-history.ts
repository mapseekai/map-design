import type Database from 'better-sqlite3';
import { MapDesignMessageSchema, MapDesignRunEventSchema, type MapDesignMessage, type MapDesignRunResponse } from '@mapseekai/contracts';
import { z } from 'zod';
import type { MapTrustedRunRecord } from '../application/revision-service.js';

export interface StoredRun {
  response: MapDesignRunResponse; trusted: MapTrustedRunRecord; message: MapDesignMessage | null;
  clientRequestId: string; requestDigest: string;
}
export interface MapRunHistory {
  start(input: StoredRun): void;
  finish(response: MapDesignRunResponse, message: MapDesignMessage): void;
  get(runId: string): StoredRun | null;
  findRequest(clientRequestId: string): StoredRun | null;
  recoverInterrupted(now?: number): number;
}
const trustedSchema = z.object({ runId: z.string(), projectId: z.string(),
  runtime: z.object({ id: z.string(), version: z.string(), adapter: z.string() }).strict(),
  model: z.object({ id: z.string(), provider: z.string() }).strict(),
}).strict();

/** Durable bounded messages and provenance; no credentials or raw request prompts. */
export function createMapRunHistory(db: Database.Database): MapRunHistory {
  db.exec(`CREATE TABLE IF NOT EXISTS map_design_run_history (
    run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    client_request_id TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL,
    response_json TEXT NOT NULL, trusted_json TEXT NOT NULL, message_json TEXT,
    status TEXT NOT NULL CHECK(status IN ('queued','running','awaiting_input','succeeded','failed','canceled'))
  ); CREATE INDEX IF NOT EXISTS idx_map_design_run_history_project ON map_design_run_history(project_id);`);
  const parse = (row: unknown): StoredRun | null => {
    if (!row) return null;
    const value = row as { response_json: string; trusted_json: string; message_json: string | null; client_request_id: string; request_digest: string };
    const event = MapDesignRunEventSchema.parse({ type: 'run_finished', run: JSON.parse(value.response_json) });
    if (event.type !== 'run_finished') throw new Error('Invalid stored run response');
    const trusted = trustedSchema.parse(JSON.parse(value.trusted_json));
    if (trusted.runId !== event.run.runId || trusted.projectId !== event.run.projectId) throw new Error('Stored run provenance mismatch');
    return { response: event.run, trusted, message: value.message_json ? MapDesignMessageSchema.parse(JSON.parse(value.message_json)) : null,
      clientRequestId: value.client_request_id, requestDigest: value.request_digest };
  };
  const get = (id: string) => parse(db.prepare('SELECT * FROM map_design_run_history WHERE run_id = ?').get(id));
  const finish = (response: MapDesignRunResponse, message: MapDesignMessage) => {
    MapDesignRunEventSchema.parse({ type: 'run_finished', run: response });
    const bounded = MapDesignMessageSchema.parse(message);
    db.prepare('UPDATE map_design_run_history SET response_json = ?, message_json = ?, status = ? WHERE run_id = ?')
      .run(JSON.stringify(response), JSON.stringify(bounded), response.status, response.runId);
  };
  return {
    start(input) {
      trustedSchema.parse(input.trusted);
      MapDesignRunEventSchema.parse({ type: 'run_finished', run: input.response });
      db.prepare('INSERT INTO map_design_run_history VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.response.runId, input.response.projectId, input.clientRequestId, input.requestDigest,
          JSON.stringify(input.response), JSON.stringify(input.trusted), input.message ? JSON.stringify(MapDesignMessageSchema.parse(input.message)) : null, input.response.status);
    },
    finish, get,
    findRequest(id) { return parse(db.prepare('SELECT * FROM map_design_run_history WHERE client_request_id = ?').get(id)); },
    recoverInterrupted(now = Date.now()) {
      // Invoke once during startup, before adapters can start new work.
      return db.transaction(() => {
        const rows = db.prepare("SELECT run_id FROM map_design_run_history WHERE status IN ('queued','running','awaiting_input')").all() as { run_id: string }[];
        for (const row of rows) {
          const run = get(row.run_id)!;
          const response: MapDesignRunResponse = { ...run.response, status: 'failed', finishedAt: new Date(now).toISOString(),
            error: { code: 'RUN_INTERRUPTED', message: 'The application stopped during this run. Inspect the saved draft before continuing.' } };
          const latest = db.prepare('SELECT content, events_json AS eventsJson FROM messages WHERE run_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1')
            .get(row.run_id, 'assistant') as { content: string; eventsJson: string | null } | undefined;
          const message = run.message ? MapDesignMessageSchema.parse({ ...run.message,
            ...(latest ? { content: latest.content, events: latest.eventsJson ? JSON.parse(latest.eventsJson) : [] } : {}),
            runStatus: 'failed', endedAt: now,
          }) : null;
          db.prepare('UPDATE map_design_run_history SET response_json = ?, message_json = ?, status = ? WHERE run_id = ?')
            .run(JSON.stringify(response), message ? JSON.stringify(message) : null, 'failed', row.run_id);
          db.prepare("UPDATE messages SET run_status = 'failed', ended_at = ? WHERE run_id = ? AND role = 'assistant' AND run_status = 'running'").run(now, row.run_id);
        }
        return rows.length;
      }).immediate();
    },
  };
}
