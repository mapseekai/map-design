import type Database from 'better-sqlite3';

import { titleFromFirstMessage } from './storage/conversation-title.js';

type SqliteDb = Database.Database;

function ensureValidationColumns(db: SqliteDb): void {
  const columns = new Set((db.prepare(`PRAGMA table_info(map_design_projects)`).all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!columns.has('initial_validation_status')) {
    db.exec(`
      ALTER TABLE map_design_projects
        ADD COLUMN initial_validation_status TEXT
        CHECK (initial_validation_status IN ('valid','invalid'))
    `);
  }
  if (!columns.has('initial_validation_digest')) {
    db.exec(`
      ALTER TABLE map_design_projects
        ADD COLUMN initial_validation_digest TEXT
    `);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS map_design_projects_validation_pair_insert
    BEFORE INSERT ON map_design_projects
    WHEN (NEW.initial_validation_status IS NULL) <> (NEW.initial_validation_digest IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'initial validation status and digest must be set together');
    END;
    CREATE TRIGGER IF NOT EXISTS map_design_projects_validation_pair_update
    BEFORE UPDATE OF initial_validation_status, initial_validation_digest ON map_design_projects
    WHEN (NEW.initial_validation_status IS NULL) <> (NEW.initial_validation_digest IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'initial validation status and digest must be set together');
    END;
  `);
}

function ensureIdempotencyCanonicalRequestColumns(db: SqliteDb): void {
  const columns = new Set((db.prepare(`PRAGMA table_info(map_design_idempotency)`).all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (!columns.has('canonical_request_json')) {
    db.exec(`
      ALTER TABLE map_design_idempotency
        ADD COLUMN canonical_request_json TEXT
    `);
  }
  if (!columns.has('canonical_request_digest')) {
    db.exec(`
      ALTER TABLE map_design_idempotency
        ADD COLUMN canonical_request_digest TEXT
    `);
  }
}

function ensurePreviewRunIdColumn(db: SqliteDb): void {
  const columns = new Set((db.prepare(`PRAGMA table_info(map_design_previews)`).all() as Array<{ name: string }>)
    .map((column) => column.name));
  if (columns.has('run_id')) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_map_design_previews_project_draft_status;
    ALTER TABLE map_design_previews RENAME TO map_design_previews_legacy;
    CREATE TABLE map_design_previews (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES map_design_projects(project_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      draft_revision INTEGER NOT NULL,
      style_digest TEXT NOT NULL,
      style_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('requested','rendering','passed','failed','expired')),
      request_json TEXT NOT NULL,
      png_digest TEXT,
      report_digest TEXT,
      validation_digest TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO map_design_previews (
      id, project_id, run_id, draft_revision, style_digest, style_hash, status,
      request_json, png_digest, report_digest, validation_digest,
      expires_at, created_at, updated_at
    ) SELECT
      id, project_id, '', draft_revision, style_digest, style_hash, 'expired',
      request_json, png_digest, report_digest, validation_digest,
      expires_at, created_at, updated_at
    FROM map_design_previews_legacy;
    DROP TABLE map_design_previews_legacy;
  `);
}

function ensureConversationTitleColumns(db: SqliteDb): void {
  const columns = new Set((db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>)
    .map(({ name }) => name));
  if (!columns.has('title')) db.exec("ALTER TABLE conversations ADD COLUMN title TEXT NOT NULL DEFAULT 'New conversation'");
  if (!columns.has('title_is_default')) db.exec('ALTER TABLE conversations ADD COLUMN title_is_default INTEGER NOT NULL DEFAULT 1 CHECK (title_is_default IN (0,1))');

  const conversations = db.prepare(`
    SELECT id FROM conversations
    WHERE title_is_default = 1
  `).all() as Array<{ id: string }>;
  const firstUserMessage = db.prepare(`
    SELECT COALESCE(content, text) AS content FROM messages
    WHERE conversation_id = ? AND role = 'user'
    ORDER BY created_at, id
    LIMIT 1
  `);
  const promoteTitle = db.prepare('UPDATE conversations SET title = ?, title_is_default = 0 WHERE id = ?');
  for (const conversation of conversations) {
    const message = firstUserMessage.get(conversation.id) as { content: string } | undefined;
    if (message) promoteTitle.run(titleFromFirstMessage(message.content), conversation.id);
  }
}

function ensureConversationRuntimeColumns(db: SqliteDb): void {
  const conversationColumns = new Set(
    (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(({ name }) => name),
  );
  if (!conversationColumns.has('runtime_json')) db.exec('ALTER TABLE conversations ADD COLUMN runtime_json TEXT');
  if (!conversationColumns.has('runtime_revision')) db.exec('ALTER TABLE conversations ADD COLUMN runtime_revision INTEGER NOT NULL DEFAULT 0');
  if (!conversationColumns.has('runtime_updated_at')) db.exec('ALTER TABLE conversations ADD COLUMN runtime_updated_at TEXT');

  const messageColumns = new Set(
    (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(({ name }) => name),
  );
  if (!messageColumns.has('runtime_json')) db.exec('ALTER TABLE messages ADD COLUMN runtime_json TEXT');
  if (!messageColumns.has('screenshots_json')) db.exec('ALTER TABLE messages ADD COLUMN screenshots_json TEXT');
  if (!messageColumns.has('attachments_json')) db.exec('ALTER TABLE messages ADD COLUMN attachments_json TEXT');
}

function ensureMessageEventColumns(db: SqliteDb): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(({ name }) => name),
  );
  if (!columns.has('content')) db.exec('ALTER TABLE messages ADD COLUMN content TEXT');
  if (!columns.has('run_status')) db.exec('ALTER TABLE messages ADD COLUMN run_status TEXT');
  if (!columns.has('started_at')) db.exec('ALTER TABLE messages ADD COLUMN started_at INTEGER');
  if (!columns.has('ended_at')) db.exec('ALTER TABLE messages ADD COLUMN ended_at INTEGER');
}

function dropLegacyMessageActivityColumn(db: SqliteDb): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(({ name }) => name),
  );
  if (columns.has('activity_json')) db.exec('ALTER TABLE messages DROP COLUMN activity_json');
}

export function migrateMapDesign(db: SqliteDb): void {
  const migrate = db.transaction(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS map_design_projects (
      project_id TEXT NOT NULL PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('importing','ready','failed')),
      source_kind TEXT CHECK (source_kind IN ('style','tilejson','pmtiles','geojson')),
      source_manifest_digest TEXT,
      design_system_id TEXT NOT NULL,
      design_system_digest TEXT NOT NULL,
      draft_revision INTEGER NOT NULL CHECK (draft_revision >= 0),
      draft_style_digest TEXT,
      draft_style_hash TEXT,
      draft_semantic_digest TEXT,
      committed_revision INTEGER,
      initial_validation_status TEXT CHECK (initial_validation_status IN ('valid','invalid')),
      initial_validation_digest TEXT,
      failure_code TEXT,
      failure_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((initial_validation_status IS NULL) = (initial_validation_digest IS NULL)),
      CHECK (
        (lifecycle_state = 'ready' AND source_kind IS NOT NULL AND draft_style_digest IS NOT NULL AND draft_style_hash IS NOT NULL AND draft_semantic_digest IS NOT NULL)
        OR lifecycle_state IN ('importing','failed')
      )
    );

    CREATE TABLE IF NOT EXISTS map_design_idempotency (
      project_id TEXT NOT NULL REFERENCES map_design_projects(project_id) ON DELETE CASCADE,
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      canonical_request_json TEXT,
      canonical_request_digest TEXT,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, operation, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS map_design_revisions (
      project_id TEXT NOT NULL REFERENCES map_design_projects(project_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      draft_revision INTEGER NOT NULL CHECK (draft_revision >= 0),
      style_digest TEXT NOT NULL,
      style_hash TEXT NOT NULL,
      semantic_digest TEXT NOT NULL,
      source_manifest_digest TEXT NOT NULL,
      design_system_digest TEXT NOT NULL,
      preview_id TEXT,
      attestation_digest TEXT NOT NULL,
      run_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, revision),
      CHECK (
        (revision = 0 AND preview_id IS NULL AND run_id IS NULL)
        OR (revision > 0 AND preview_id IS NOT NULL AND run_id IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS map_design_previews (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES map_design_projects(project_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      draft_revision INTEGER NOT NULL,
      style_digest TEXT NOT NULL,
      style_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('requested','rendering','passed','failed','expired')),
      request_json TEXT NOT NULL,
      png_digest TEXT,
      report_digest TEXT,
      validation_digest TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS map_design_resources (
      project_id TEXT NOT NULL REFERENCES map_design_projects(project_id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      storage_kind TEXT NOT NULL CHECK (storage_kind IN ('captured','remote')),
      media_type TEXT NOT NULL,
      byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
      content_digest TEXT,
      metadata_json TEXT NOT NULL,
      PRIMARY KEY (project_id, resource_id),
      CHECK (
        (storage_kind = 'captured' AND byte_length IS NOT NULL AND content_digest IS NOT NULL)
        OR (storage_kind = 'remote' AND content_digest IS NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS map_design_import_jobs (
      project_id TEXT NOT NULL PRIMARY KEY REFERENCES map_design_projects(project_id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
      import_request_json TEXT NOT NULL,
      import_request_digest TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      queued_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      failure_code TEXT,
      failure_message TEXT,
      CHECK (
        (status = 'queued' AND started_at IS NULL AND finished_at IS NULL AND failure_code IS NULL AND failure_message IS NULL)
        OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND failure_code IS NULL AND failure_message IS NULL)
        OR (status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND failure_code IS NULL AND failure_message IS NULL)
        OR (status = 'failed' AND finished_at IS NOT NULL AND failure_code IS NOT NULL AND failure_message IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS map_design_event_outbox (
      sequence INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES map_design_projects(project_id) ON DELETE CASCADE,
      event_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      published_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      lease_owner TEXT,
      lease_expires_at TEXT,
      CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS map_design_event_retention (
      project_id TEXT NOT NULL PRIMARY KEY REFERENCES map_design_projects(project_id) ON DELETE CASCADE,
      deleted_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (deleted_through_sequence >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_map_design_previews_project_draft_status
      ON map_design_previews(project_id, draft_revision, status);
    CREATE INDEX IF NOT EXISTS idx_map_design_revisions_project_revision
      ON map_design_revisions(project_id, revision DESC);
    CREATE INDEX IF NOT EXISTS idx_map_design_resources_content_digest
      ON map_design_resources(content_digest);
    CREATE INDEX IF NOT EXISTS idx_map_design_import_jobs_status_queued
      ON map_design_import_jobs(status, queued_at);
    CREATE INDEX IF NOT EXISTS idx_map_design_event_outbox_pending_claim
      ON map_design_event_outbox(published_at, lease_expires_at, sequence);
    CREATE INDEX IF NOT EXISTS idx_map_design_event_outbox_project_sequence
      ON map_design_event_outbox(project_id, sequence);
    `);
    ensureValidationColumns(db);
    ensureIdempotencyCanonicalRequestColumns(db);
    ensurePreviewRunIdColumn(db);
    ensureMessageEventColumns(db);
    dropLegacyMessageActivityColumn(db);
    ensureConversationTitleColumns(db);
    ensureConversationRuntimeColumns(db);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_map_design_previews_project_draft_status
      ON map_design_previews(project_id, draft_revision, status)`);
  });
  migrate.immediate();
}
