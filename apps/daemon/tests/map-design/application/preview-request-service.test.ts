import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MapDesignEventOutbox } from '../../../src/map-design/application/event-outbox.js';
import { MapPreviewRequestServiceImpl } from '../../../src/map-design/application/preview-request-service.js';
import { requestDigest } from '../../../src/map-design/application/request-digest.js';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';

const PROJECT_ID = 'preview-cancellation-project';
const RUN_ID = 'preview-cancellation-run';
const NOW = '2026-08-31T00:00:00.000Z';
const STYLE_DIGEST = 'a'.repeat(64);
const STYLE_HASH = 'b'.repeat(64);
const OUTPUT = {
  status: 'failed' as const,
  previewId: 'preview-1',
  draftRevision: 4,
  styleHash: STYLE_HASH,
  png: null,
  report: { digest: 'c'.repeat(64), mediaType: 'application/json' as const, byteLength: 42 },
  validationSummary: {
    status: 'valid' as const,
    errors: 0,
    warnings: 0,
    infos: 0,
    totalFindings: 0,
    returnedFindings: 0,
    omittedFindings: 0,
  },
};

describe('MapPreviewRequestServiceImpl cancellation commit point', () => {
  let tempDir: string;
  let database: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'map-design-preview-cancel-'));
    database = openMapDesignDatabase(tempDir);
    database.prepare(`INSERT INTO projects (id, title, runtime_json, created_at, updated_at)
      VALUES (?, ?, '{}', ?, ?)`).run(PROJECT_ID, PROJECT_ID, NOW, NOW);
    database.prepare(`INSERT INTO map_design_projects (
      project_id, lifecycle_state, source_kind, source_manifest_digest,
      design_system_id, design_system_digest, draft_revision,
      draft_style_digest, draft_style_hash, draft_semantic_digest, created_at, updated_at
    ) VALUES (?, 'ready', 'style', ?, 'quiet-atlas', ?, 4, ?, ?, ?, ?, ?)`).run(
      PROJECT_ID,
      'd'.repeat(64),
      'e'.repeat(64),
      STYLE_DIGEST,
      STYLE_HASH,
      'f'.repeat(64),
      NOW,
      NOW,
    );
  });

  afterEach(() => {
    database.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rolls back the preview row and outbox event when cancellation is observed before commit', async () => {
    const controller = new AbortController();
    const durableOutbox = createOutbox(database);
    const service = new MapPreviewRequestServiceImpl({
      db: database,
      outbox: {
        appendInTransaction(db, projectId, event) {
          const sequence = durableOutbox.appendInTransaction(db, projectId, event);
          controller.abort();
          return sequence;
        },
        drainPending: () => durableOutbox.drainPending(),
      },
      now: () => NOW,
      createId: () => 'preview-1',
    });

    await expect(service.requestAndWait(
      { projectId: PROJECT_ID, runId: RUN_ID, signal: controller.signal },
      { expectedRevision: 4, idempotencyKey: 'preview-cancel-before-commit' },
    )).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'The map preview request was cancelled.',
      retryable: true,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM map_design_previews').get())
      .toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM map_design_event_outbox').get())
      .toEqual({ count: 0 });
    service.shutdown();
  });

  it('ignores cancellation after durable enqueue and returns the bounded terminal receipt', async () => {
    const controller = new AbortController();
    const outbox = createOutbox(database);
    const service = new MapPreviewRequestServiceImpl({
      db: database,
      outbox,
      now: () => NOW,
      createId: () => 'preview-1',
    });
    const idempotencyKey = 'preview-cancel-after-commit';

    const pending = service.requestAndWait(
      { projectId: PROJECT_ID, runId: RUN_ID, signal: controller.signal },
      { expectedRevision: 4, idempotencyKey },
    );
    controller.abort();
    database.prepare(`UPDATE map_design_previews
      SET status = 'failed', report_digest = ?, validation_digest = ?, updated_at = ?
      WHERE id = ?`).run(OUTPUT.report.digest, 'd'.repeat(64), NOW, OUTPUT.previewId);
    persistReceipt(database, idempotencyKey);
    service.complete(OUTPUT.previewId, OUTPUT);

    await expect(pending).resolves.toEqual(OUTPUT);
    expect(database.prepare('SELECT COUNT(*) AS count FROM map_design_previews').get())
      .toEqual({ count: 1 });
    service.shutdown();
  });
});

function createOutbox(database: Database.Database): MapDesignEventOutbox {
  return new MapDesignEventOutbox({
    db: database,
    now: () => NOW,
    ownerId: 'preview-cancellation-test',
    publish: async () => undefined,
  });
}

function persistReceipt(database: Database.Database, idempotencyKey: string): void {
  const requestJson = (database.prepare(`SELECT request_json AS requestJson
    FROM map_design_previews WHERE id = ?`).get(OUTPUT.previewId) as { requestJson: string }).requestJson;
  database.prepare(`INSERT INTO map_design_idempotency (
    project_id, operation, idempotency_key, request_digest, response_json, created_at
  ) VALUES (?, 'map_render_preview', ?, ?, ?, ?)`).run(
    PROJECT_ID,
    idempotencyKey,
    requestDigest(JSON.parse(requestJson)),
    JSON.stringify(OUTPUT),
    NOW,
  );
}
