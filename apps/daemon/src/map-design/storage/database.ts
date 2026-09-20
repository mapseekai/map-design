import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { migrateMapDesign } from '../migrate.js';

export function createFreshMapDesignSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cartography_documents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      version TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS project_cartography (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      cartography_id TEXT NOT NULL REFERENCES cartography_documents(id)
    );
    CREATE TABLE IF NOT EXISTS map_design_projects (
      project_id TEXT NOT NULL PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('importing','ready','failed')),
      source_kind TEXT CHECK (source_kind IN ('style','tilejson','pmtiles','geojson')),
      source_manifest_digest TEXT, design_system_id TEXT NOT NULL, design_system_digest TEXT NOT NULL,
      draft_revision INTEGER NOT NULL CHECK (draft_revision >= 0), draft_style_digest TEXT, draft_style_hash TEXT,
      draft_semantic_digest TEXT, committed_revision INTEGER, initial_validation_status TEXT CHECK (initial_validation_status IN ('valid','invalid')),
      initial_validation_digest TEXT, failure_code TEXT, failure_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK ((initial_validation_status IS NULL) = (initial_validation_digest IS NULL)),
      CHECK ((lifecycle_state = 'ready' AND source_kind IS NOT NULL AND draft_style_digest IS NOT NULL AND draft_style_hash IS NOT NULL AND draft_semantic_digest IS NOT NULL) OR lifecycle_state IN ('importing','failed'))
    );
    CREATE TABLE IF NOT EXISTS map_design_initial_runs (
      project_id TEXT PRIMARY KEY REFERENCES map_design_projects(project_id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','started','failed'))
    );
    CREATE TABLE IF NOT EXISTS map_design_thumbnails (
      project_id TEXT PRIMARY KEY REFERENCES map_design_projects(project_id) ON DELETE CASCADE,
      png BLOB NOT NULL, captured_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS map_design_idempotency (
      project_id TEXT NOT NULL REFERENCES map_design_projects(project_id) ON DELETE CASCADE, operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL, canonical_request_json TEXT, canonical_request_digest TEXT,
      response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (project_id, operation, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS conversation_idempotency (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL,
      response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (project_id, operation, idempotency_key)
    );
    INSERT OR IGNORE INTO conversation_idempotency
      SELECT project_id, operation, idempotency_key, request_digest, response_json, created_at
      FROM map_design_idempotency WHERE operation IN ('conversation.create', 'conversation.runtime.update');
    CREATE TABLE IF NOT EXISTS map_design_comments (
      project_id TEXT NOT NULL REFERENCES map_design_projects(project_id) ON DELETE CASCADE,
      id TEXT NOT NULL, version INTEGER NOT NULL CHECK (version >= 1), body_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','submitted','succeeded','failed','canceled')),
      run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_map_design_comments_run ON map_design_comments(project_id, run_id, status);
    CREATE TABLE IF NOT EXISTS map_design_revisions (
      project_id TEXT NOT NULL REFERENCES map_design_projects(project_id) ON DELETE CASCADE, revision INTEGER NOT NULL CHECK (revision >= 0),
      draft_revision INTEGER NOT NULL CHECK (draft_revision >= 0), style_digest TEXT NOT NULL, style_hash TEXT NOT NULL,
      semantic_digest TEXT NOT NULL, source_manifest_digest TEXT NOT NULL, design_system_digest TEXT NOT NULL, preview_id TEXT,
      attestation_digest TEXT NOT NULL, run_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY (project_id, revision),
      CHECK ((revision = 0 AND preview_id IS NULL AND run_id IS NULL) OR (revision > 0 AND preview_id IS NOT NULL AND run_id IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS map_design_previews (
      id TEXT NOT NULL PRIMARY KEY, project_id TEXT NOT NULL REFERENCES map_design_projects(project_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL, draft_revision INTEGER NOT NULL, style_digest TEXT NOT NULL, style_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('requested','rendering','passed','failed','expired')), request_json TEXT NOT NULL,
      png_digest TEXT, report_digest TEXT, validation_digest TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS map_design_resources (
      project_id TEXT NOT NULL REFERENCES map_design_projects(project_id) ON DELETE CASCADE, resource_id TEXT NOT NULL, kind TEXT NOT NULL,
      storage_kind TEXT NOT NULL CHECK (storage_kind IN ('captured','remote')), media_type TEXT NOT NULL,
      byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0), content_digest TEXT, metadata_json TEXT NOT NULL,
      PRIMARY KEY (project_id, resource_id), CHECK ((storage_kind = 'captured' AND byte_length IS NOT NULL AND content_digest IS NOT NULL) OR (storage_kind = 'remote' AND content_digest IS NULL))
    );
    CREATE TABLE IF NOT EXISTS map_design_import_jobs (
      project_id TEXT NOT NULL PRIMARY KEY REFERENCES map_design_projects(project_id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')), import_request_json TEXT NOT NULL,
      import_request_digest TEXT NOT NULL, attempt INTEGER NOT NULL CHECK (attempt >= 1), queued_at TEXT NOT NULL, started_at TEXT,
      finished_at TEXT, failure_code TEXT, failure_message TEXT,
      CHECK ((status = 'queued' AND started_at IS NULL AND finished_at IS NULL AND failure_code IS NULL AND failure_message IS NULL) OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND failure_code IS NULL AND failure_message IS NULL) OR (status = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND failure_code IS NULL AND failure_message IS NULL) OR (status = 'failed' AND finished_at IS NOT NULL AND failure_code IS NOT NULL AND failure_message IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS map_design_event_outbox (
      sequence INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES map_design_projects(project_id) ON DELETE CASCADE,
      event_json TEXT NOT NULL, occurred_at TEXT NOT NULL, published_at TEXT, attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      lease_owner TEXT, lease_expires_at TEXT, CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS map_design_event_retention (
      project_id TEXT NOT NULL PRIMARY KEY REFERENCES map_design_projects(project_id) ON DELETE CASCADE,
      deleted_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (deleted_through_sequence >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_map_design_previews_project_draft_status ON map_design_previews(project_id, draft_revision, status);
    CREATE INDEX IF NOT EXISTS idx_map_design_revisions_project_revision ON map_design_revisions(project_id, revision DESC);
    CREATE INDEX IF NOT EXISTS idx_map_design_resources_content_digest ON map_design_resources(content_digest);
    CREATE INDEX IF NOT EXISTS idx_map_design_import_jobs_status_queued ON map_design_import_jobs(status, queued_at);
    CREATE INDEX IF NOT EXISTS idx_map_design_event_outbox_pending_claim ON map_design_event_outbox(published_at, lease_expires_at, sequence);
    CREATE INDEX IF NOT EXISTS idx_map_design_event_outbox_project_sequence ON map_design_event_outbox(project_id, sequence);
  `);
  // Existing documents predate timestamp tracking; keep their unknown dates null.
  const columns = db.prepare('PRAGMA table_info(cartography_documents)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'updated_at')) db.exec('ALTER TABLE cartography_documents ADD COLUMN updated_at TEXT');
  if (!columns.some((column) => column.name === 'sample_bindings_json')) db.exec('ALTER TABLE cartography_documents ADD COLUMN sample_bindings_json TEXT');

}

function createLocalTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, runtime_json TEXT NOT NULL, working_directory TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'New conversation',
      title_is_default INTEGER NOT NULL DEFAULT 1 CHECK (title_is_default IN (0,1)),
      runtime_json TEXT, runtime_revision INTEGER NOT NULL DEFAULT 0, runtime_updated_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL, events_json TEXT, status TEXT, error_json TEXT,
      runtime_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_sessions (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL, stable_prompt_hash TEXT, model TEXT, cwd TEXT, last_message_id TEXT,
      updated_at TEXT NOT NULL, PRIMARY KEY (conversation_id, agent_id)
    );
  `);
}

export function openMapDesignDatabase(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, 'map-design.sqlite'));
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  createLocalTables(db);
  createFreshMapDesignSchema(db);
  migrateMapDesign(db);
  return db;
}

export function closeMapDesignDatabase(db: Database.Database): void { db.close(); }
