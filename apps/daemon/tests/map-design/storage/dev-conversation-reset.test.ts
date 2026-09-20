import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { closeMapDesignDatabase, openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { resetMapDesignDevelopmentConversations } from '../../../src/map-design/storage/dev-conversation-reset.js';
import { createMapDesignLocalStore, type MapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';
import { MapDesignSqliteProjectRepository } from '../../../src/map-design/storage/project-repository.js';

const roots: string[] = [];
const now = '2026-08-31T00:00:00.000Z';
const startedAt = Date.parse(now);

function openFixture() {
  const root = mkdtempSync(join(tmpdir(), 'map-design-reset-'));
  roots.push(root);
  const db = openMapDesignDatabase(root);
  return { db, store: createMapDesignLocalStore(db) };
}

function message(id: string, conversationId: string, role: 'user' | 'assistant', content: string) {
  return {
    id,
    conversationId,
    role,
    content,
    events: role === 'assistant'
      ? [
          { kind: 'status' as const, label: 'analyzing' as const },
          { kind: 'text' as const, text: content },
          { kind: 'run_finished' as const, status: 'succeeded' as const },
        ]
      : [{ kind: 'text' as const, text: content }],
    runStatus: 'succeeded' as const,
    startedAt,
    endedAt: startedAt + 1_000,
  };
}

function seedMapDesignProject(
  db: Database.Database,
  store: MapDesignLocalStore,
  projectId: string,
  conversationId: string,
): void {
  store.createProject({
    project: {
      projectId,
      title: projectId,
      runtime: { agentId: 'codex' },
      source: { url: `https://example.test/${projectId}.json` },
      designRequirement: 'Keep the hierarchy clear',
      idempotencyKey: `${projectId}-create`,
    },
    primaryConversationId: conversationId,
    verifiedWorkingDirectory: null,
  });
  db.prepare(`INSERT INTO map_design_projects (
    project_id, lifecycle_state, design_system_id, design_system_digest,
    draft_revision, created_at, updated_at
  ) VALUES (?, 'importing', 'quiet-walking', ?, 0, ?, ?)`).run(projectId, `${projectId}-design`, now, now);
  db.prepare(`INSERT INTO map_design_resources (
    project_id, resource_id, kind, storage_kind, media_type,
    byte_length, content_digest, metadata_json
  ) VALUES (?, 'source-style', 'style', 'captured', 'application/json', 2, ?, '{}')`)
    .run(projectId, `${projectId}-resource`);
  db.prepare(`INSERT INTO map_design_revisions (
    project_id, revision, draft_revision, style_digest, style_hash,
    semantic_digest, source_manifest_digest, design_system_digest,
    preview_id, attestation_digest, run_id, created_at
  ) VALUES (?, 0, 0, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`).run(
    projectId,
    `${projectId}-style`, `${projectId}-hash`, `${projectId}-semantic`,
    `${projectId}-manifest`, `${projectId}-design`, `${projectId}-attestation`, now,
  );
  db.prepare(`INSERT INTO map_design_previews (
    id, project_id, run_id, draft_revision, style_digest, style_hash, status,
    request_json, expires_at, created_at, updated_at
  ) VALUES (?, ?, ?, 0, ?, ?, 'requested', '{}', ?, ?, ?)`).run(
    `${projectId}-preview`, projectId, `${projectId}-preview-run`,
    `${projectId}-style`, `${projectId}-hash`, '2026-09-01T00:00:00.000Z', now, now,
  );
  db.prepare(`INSERT INTO map_design_idempotency (
    project_id, operation, idempotency_key, request_digest, response_json, created_at
  ) VALUES (?, 'create', ?, ?, '{}', ?)`).run(projectId, `${projectId}-key`, `${projectId}-request`, now);
  db.prepare(`INSERT INTO map_design_import_jobs (
    project_id, status, import_request_json, import_request_digest, attempt, queued_at
  ) VALUES (?, 'queued', '{}', ?, 1, ?)`).run(projectId, `${projectId}-import`, now);
  db.prepare(`INSERT INTO map_design_event_outbox (
    project_id, event_json, occurred_at
  ) VALUES (?, '{"type":"project.updated"}', ?)`).run(projectId, now);
  db.prepare(`INSERT INTO map_design_event_retention (
    project_id, deleted_through_sequence
  ) VALUES (?, 7)`).run(projectId);

  store.appendMessage({ message: message(`${conversationId}-user`, conversationId, 'user', 'Improve the map'), runId: `${projectId}-run` });
  store.appendMessage({ message: message(`${conversationId}-assistant`, conversationId, 'assistant', 'Map updated.'), runId: `${projectId}-run` });
  store.upsertAgentSession({
    conversationId,
    agentId: 'codex',
    sessionId: `${conversationId}-session`,
    stablePromptHash: null,
    model: 'gpt-5.6',
    cwd: null,
    lastMessageId: `${conversationId}-assistant`,
    updatedAt: now,
  });
}

function seedOrdinaryProject(db: Database.Database, store: MapDesignLocalStore): void {
  store.createProject({
    project: {
      projectId: 'ordinary-project',
      title: 'Ordinary project',
      runtime: { agentId: 'claude' },
      source: { url: 'https://example.test/ordinary.json' },
      designRequirement: 'Do not reset this project',
      idempotencyKey: 'ordinary-create',
    },
    primaryConversationId: 'ordinary-conversation',
    verifiedWorkingDirectory: null,
  });
  store.appendMessage({
    message: message('ordinary-message', 'ordinary-conversation', 'user', 'Keep me'),
    runId: 'ordinary-run',
  });
  store.upsertAgentSession({
    conversationId: 'ordinary-conversation', agentId: 'claude', sessionId: 'ordinary-session',
    stablePromptHash: null, model: null, cwd: null, lastMessageId: 'ordinary-message', updatedAt: now,
  });
  expect(db.prepare('SELECT COUNT(*) AS count FROM map_design_projects WHERE project_id = ?').get('ordinary-project'))
    .toEqual({ count: 0 });
}

function countRows(db: Database.Database, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function listRunReplayRows(db: Database.Database): Array<{ messageId: string; runId: string | null; eventsJson: string | null }> {
  return db.prepare(`
    SELECT m.id AS messageId, m.run_id AS runId, m.events_json AS eventsJson
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN map_design_projects p ON p.project_id = c.project_id
    WHERE m.run_id IS NOT NULL OR m.events_json IS NOT NULL
    ORDER BY m.id
  `).all() as Array<{ messageId: string; runId: string | null; eventsJson: string | null }>;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resetMapDesignDevelopmentConversations', () => {
  it('idempotently removes only MapDesign conversation replay state while preserving project data', () => {
    const { db, store } = openFixture();
    try {
      seedMapDesignProject(db, store, 'map-project-1', 'map-conversation-1');
      seedMapDesignProject(db, store, 'map-project-2', 'map-conversation-2');
      store.createConversation('map-project-1', 'map-conversation-extra', 'Extra');
      store.appendMessage({
        message: message('map-extra-message', 'map-conversation-extra', 'assistant', 'Extra replay'),
        runId: 'map-extra-run',
      });
      seedOrdinaryProject(db, store);

      const repository = new MapDesignSqliteProjectRepository(db);
      const retainedTables = [
        'projects', 'map_design_projects', 'map_design_resources', 'map_design_previews',
        'map_design_revisions', 'map_design_idempotency', 'map_design_import_jobs',
        'map_design_event_outbox', 'map_design_event_retention',
      ] as const;
      const retainedCounts = Object.fromEntries(retainedTables.map((table) => [table, countRows(db, table)]));
      expect(store.listProjects()).toHaveLength(2);
      expect(repository.listRevisions('map-project-1')).toHaveLength(1);
      expect(listRunReplayRows(db)).not.toEqual([]);

      resetMapDesignDevelopmentConversations(db);
      resetMapDesignDevelopmentConversations(db);

      expect(store.listProjects()).toHaveLength(2);
      expect(repository.listRevisions('map-project-1')).toHaveLength(1);
      expect(store.listConversations('map-project-1')).toEqual([]);
      expect(store.listConversations('map-project-2')).toEqual([]);
      expect(store.getAgentSession('map-conversation-1', 'codex')).toBeNull();
      expect(listRunReplayRows(db)).toEqual([]);
      expect(Object.fromEntries(retainedTables.map((table) => [table, countRows(db, table)])))
        .toEqual(retainedCounts);
      expect(store.getConversation('ordinary-conversation')?.messages).toHaveLength(1);
      expect(store.getAgentSession('ordinary-conversation', 'claude')).toMatchObject({ sessionId: 'ordinary-session' });
    } finally {
      closeMapDesignDatabase(db);
    }
  });

  it('rolls back sessions, messages, and conversations when a scoped delete fails', () => {
    const { db, store } = openFixture();
    try {
      seedMapDesignProject(db, store, 'map-project-1', 'map-conversation-1');
      seedMapDesignProject(db, store, 'map-project-2', 'map-conversation-2');
      const before = {
        conversations: countRows(db, 'conversations'),
        messages: countRows(db, 'messages'),
        sessions: countRows(db, 'agent_sessions'),
      };
      db.exec(`
        CREATE TRIGGER reject_development_reset
        BEFORE DELETE ON conversations
        WHEN OLD.id = 'map-conversation-2'
        BEGIN
          SELECT RAISE(ABORT, 'reject reset');
        END
      `);

      expect(() => resetMapDesignDevelopmentConversations(db)).toThrow(/reject reset/i);

      expect({
        conversations: countRows(db, 'conversations'),
        messages: countRows(db, 'messages'),
        sessions: countRows(db, 'agent_sessions'),
      }).toEqual(before);
    } finally {
      closeMapDesignDatabase(db);
    }
  });
});
