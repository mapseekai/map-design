import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { migrateMapDesign } from '../../../src/map-design/migrate.js';
import { closeMapDesignDatabase, openMapDesignDatabase } from '../../../src/map-design/storage/database.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'map-design-storage-'));
  roots.push(root);
  return root;
}

function tableNames(db: { prepare(sql: string): { all(): Array<{ name: string }> } }): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(({ name }) => name);
}

function openLegacyDatabaseWithoutConversationTitleColumns(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, runtime_json TEXT NOT NULL,
      working_directory TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL, events_json TEXT,
      status TEXT, error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  return db;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('openMapDesignDatabase', () => {
  it('creates only the retained local and MapDesign tables in a clean data root', () => {
    const db = openMapDesignDatabase(tempRoot());
    try {
      expect(tableNames(db)).toEqual([
        'agent_sessions', 'cartography_documents', 'conversation_idempotency', 'conversations', 'map_design_cartography_migrations', 'map_design_cartography_snapshots', 'map_design_comments', 'map_design_event_outbox', 'map_design_event_retention',
        'map_design_idempotency', 'map_design_import_jobs', 'map_design_initial_runs', 'map_design_previews', 'map_design_projects',
        'map_design_resources', 'map_design_revisions', 'map_design_thumbnails', 'messages', 'project_cartography', 'projects', 'sqlite_sequence',
      ]);
      expect((db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(({ name }) => name))
        .not.toContain('activity_json');
    } finally {
      closeMapDesignDatabase(db);
    }
  });

  it('does not inspect a sibling legacy data directory', () => {
    const root = tempRoot();
    const fresh = join(root, 'fresh');
    const legacy = join(root, 'legacy');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'app.sqlite'), 'not sqlite');
    const db = openMapDesignDatabase(fresh);
    try {
      expect(existsSync(join(fresh, 'map-design.sqlite'))).toBe(true);
    } finally {
      closeMapDesignDatabase(db);
    }
  });

  it('backfills a legacy conversation title from its first user message', () => {
    const db = openLegacyDatabaseWithoutConversationTitleColumns();
    try {
      db.prepare('INSERT INTO projects (id, title, runtime_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('project-1', 'Map', '{"agentId":"claude"}', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z');
      db.prepare('INSERT INTO conversations (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('conversation-1', 'project-1', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z');
      db.prepare('INSERT INTO messages (id, conversation_id, role, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('message-1', 'conversation-1', 'user', '  Improve   highway labels  ', '2026-08-27T00:01:00.000Z', '2026-08-27T00:01:00.000Z');

      migrateMapDesign(db);

      expect(db.prepare('SELECT id, title, title_is_default AS titleIsDefault FROM conversations').get())
        .toEqual({ id: 'conversation-1', title: 'Improve highway labels', titleIsDefault: 0 });
    } finally {
      db.close();
    }
  });

  it('migrates legacy conversation columns when opening an existing database', () => {
    const root = tempRoot();
    const legacy = new Database(join(root, 'map-design.sqlite'));
    try {
      legacy.pragma('foreign_keys = ON');
      legacy.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, runtime_json TEXT NOT NULL,
          working_directory TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          run_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL, events_json TEXT,
          status TEXT, error_json TEXT, activity_json TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
      `);
      legacy.prepare('INSERT INTO projects (id, title, runtime_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('project-1', 'Map', '{"agentId":"claude"}', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z');
      legacy.prepare('INSERT INTO conversations (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('conversation-1', 'project-1', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z');
      legacy.prepare('INSERT INTO messages (id, conversation_id, role, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('message-1', 'conversation-1', 'user', '  Improve   highway labels  ', '2026-08-27T00:01:00.000Z', '2026-08-27T00:01:00.000Z');
    } finally {
      legacy.close();
    }

    const reopened = openMapDesignDatabase(root);
    try {
      const columns = reopened.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
        'events_json', 'content', 'run_status', 'started_at', 'ended_at',
      ]));
      expect(columns.map(({ name }) => name)).not.toContain('activity_json');
      expect(reopened.prepare('SELECT id, title, title_is_default AS titleIsDefault FROM conversations').get())
        .toEqual({ id: 'conversation-1', title: 'Improve highway labels', titleIsDefault: 0 });
    } finally {
      closeMapDesignDatabase(reopened);
    }
  });
});
