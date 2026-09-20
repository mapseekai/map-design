import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { MapDesignConversationService } from '../../../src/map-design/application/conversation-service.js';
import { closeMapDesignDatabase, createFreshMapDesignSchema, openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';

const serviceRoots: Array<{ db: Database.Database; root: string }> = [];

function openService(options: { ids: string[]; running?: Set<string> }) {
  const root = mkdtempSync(join(tmpdir(), 'map-conversation-service-'));
  const db = openMapDesignDatabase(root);
  const store = createMapDesignLocalStore(db);
  createProject(db, store, 'project-1', 'conversation-1', 'project-key-1');
  const ids = [...options.ids];
  const service = new MapDesignConversationService({
    store,
    isConversationRunning: (id) => options.running?.has(id) ?? false,
    randomId: () => ids.shift() ?? 'unexpected-id',
    now: () => '2026-08-27T00:00:00.000Z',
  });
  serviceRoots.push({ db, root });
  return { db, root, store, service };
}

function createProject(
  db: Database.Database,
  store: ReturnType<typeof createMapDesignLocalStore>,
  projectId: string,
  primaryConversationId: string,
  idempotencyKey: string,
): void {
  store.createProject({
    project: {
      projectId,
      title: 'Map',
      runtime: { agentId: 'claude' },
      source: { url: 'https://example.com/style.json' },
      designRequirement: 'Keep labels clear',
      idempotencyKey,
    },
    primaryConversationId,
    verifiedWorkingDirectory: null,
  });
  db.prepare(`INSERT INTO map_design_projects (
    project_id, lifecycle_state, design_system_id, design_system_digest,
    draft_revision, created_at, updated_at
  ) VALUES (?, 'importing', 'quiet-walking', ?, 0, ?, ?)`)
    .run(projectId, 'a'.repeat(64), '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z');
}

afterEach(() => {
  for (const { db, root } of serviceRoots.splice(0)) {
    closeMapDesignDatabase(db);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('MapDesignConversationService', () => {
  it('migrates legacy map conversation receipts without creating duplicate conversations', () => {
    const { db, service } = openService({ ids: ['conversation-2'] });
    const request = { idempotencyKey: 'legacy-receipt' };
    const original = service.create('project-1', request);
    db.exec(`INSERT INTO map_design_idempotency (project_id, operation, idempotency_key, request_digest, response_json, created_at)
      SELECT project_id, operation, idempotency_key, request_digest, response_json, created_at FROM conversation_idempotency;
      DELETE FROM conversation_idempotency;`);
    createFreshMapDesignSchema(db);
    createFreshMapDesignSchema(db);
    expect(service.create('project-1', request)).toEqual(original);
    expect(service.list('project-1').conversations).toHaveLength(2);
    expect(db.prepare('SELECT count(*) AS n FROM conversation_idempotency').get()).toEqual({ n: 1 });
  });
  it('deletes only the owned conversation and its messages and agent sessions', () => {
    const { db, store, service } = openService({ ids: [] });
    createProject(db, store, 'project-2', 'conversation-2', 'project-key-2');
    db.prepare("INSERT INTO messages (id, conversation_id, role, text, created_at, updated_at) VALUES ('m', 'conversation-1', 'user', 'hello', 'now', 'now')").run();
    db.prepare("INSERT INTO agent_sessions (conversation_id, agent_id, session_id, updated_at) VALUES ('conversation-1', 'codex', 's', 'now')").run();
    expect(() => service.delete('project-2', 'conversation-1')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    service.delete('project-1', 'conversation-1');
    expect(service.list('project-1').conversations).toEqual([]);
    expect(store.getProject('project-1')).not.toBeNull();
    expect(service.get('project-2', 'conversation-2')).toBeDefined();
    expect(db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM agent_sessions').get()).toEqual({ n: 0 });
    service.delete('project-1', 'conversation-1');
  });

  it('refuses to delete a conversation with an active run', () => {
    const { service } = openService({ ids: [], running: new Set(['conversation-1']) });
    expect(() => service.delete('project-1', 'conversation-1')).toThrow(expect.objectContaining({ code: 'RUNTIME_CONFLICT' }));
    expect(service.list('project-1').conversations).toHaveLength(1);
  });

  it('reads only a conversation owned by the requested project', () => {
    const { db, store, service } = openService({ ids: [] });
    createProject(db, store, 'project-2', 'conversation-2', 'project-key-2');

    expect(service.get('project-1', 'conversation-1')).toEqual({
      id: 'conversation-1',
      projectId: 'project-1',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      messages: [],
    });
    expect(() => service.get('project-1', 'missing-conversation')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND', message: 'The map conversation was not found.' }),
    );
    expect(() => service.get('project-1', 'conversation-2')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND', message: 'The map conversation was not found.' }),
    );
  });

  it('marks only the active conversation as running', () => {
    const { db, store, service } = openService({ ids: ['conversation-2'], running: new Set(['conversation-2']) });
    store.createConversation('project-1', 'conversation-2', 'New conversation');
    db.prepare("UPDATE conversations SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = 'conversation-2'").run();

    expect(service.list('project-1').conversations).toEqual([
      expect.objectContaining({ conversationId: 'conversation-2', runState: 'running' }),
      expect.objectContaining({ conversationId: 'conversation-1', runState: 'idle' }),
    ]);
  });

  it('replays the same conversation for a repeated idempotency key', () => {
    const { db, service } = openService({ ids: ['conversation-2'] });

    const first = service.create('project-1', { idempotencyKey: 'new-chat-1' });
    const replay = service.create('project-1', { idempotencyKey: 'new-chat-1' });

    expect(replay).toEqual(first);
    expect(replay.conversation).toMatchObject({
      conversationId: 'conversation-2',
      projectId: 'project-1',
      title: 'New conversation',
      titleIsDefault: true,
      messageCount: 0,
      runState: 'idle',
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE project_id = 'project-1'").get()).toEqual({ count: 2 });
    expect(db.prepare(`SELECT project_id AS projectId, operation, idempotency_key AS idempotencyKey,
      response_json AS responseJson, created_at AS createdAt
      FROM conversation_idempotency WHERE operation = 'conversation.create'`).get()).toEqual({
      projectId: 'project-1',
      operation: 'conversation.create',
      idempotencyKey: 'new-chat-1',
      responseJson: JSON.stringify({
        conversation: {
          conversationId: first.conversation.conversationId,
          createdAt: first.conversation.createdAt,
          lastActivityAt: first.conversation.lastActivityAt,
          messageCount: first.conversation.messageCount,
          projectId: first.conversation.projectId,
          runState: first.conversation.runState,
          title: first.conversation.title,
          titleIsDefault: first.conversation.titleIsDefault,
        },
      }),
      createdAt: '2026-08-27T00:00:00.000Z',
    });
  });

  it('normalizes a valid legacy create receipt that predates titleIsDefault without rewriting it', () => {
    const { db, service } = openService({ ids: ['conversation-2'] });
    service.create('project-1', { idempotencyKey: 'legacy-chat-1' });
    const row = db.prepare(`SELECT response_json AS responseJson FROM conversation_idempotency
      WHERE operation = 'conversation.create' AND idempotency_key = ?`)
      .get('legacy-chat-1') as { responseJson: string };
    const legacy = JSON.parse(row.responseJson) as { conversation: Record<string, unknown> };
    delete legacy.conversation.titleIsDefault;
    const legacyJson = JSON.stringify(legacy);
    db.prepare(`UPDATE conversation_idempotency SET response_json = ?
      WHERE operation = 'conversation.create' AND idempotency_key = ?`)
      .run(legacyJson, 'legacy-chat-1');

    expect(service.create('project-1', { idempotencyKey: 'legacy-chat-1' })).toMatchObject({
      conversation: {
        conversationId: 'conversation-2',
        projectId: 'project-1',
        title: 'New conversation',
        titleIsDefault: true,
        messageCount: 0,
        runState: 'idle',
      },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE project_id = 'project-1'").get())
      .toEqual({ count: 2 });
    expect((db.prepare(`SELECT response_json AS responseJson FROM conversation_idempotency
      WHERE operation = 'conversation.create' AND idempotency_key = ?`)
      .get('legacy-chat-1') as { responseJson: string }).responseJson).toBe(legacyJson);
  });

  it.each([
    ['a missing established field', (conversation: Record<string, unknown>) => { delete conversation.title; }],
    ['a wrong titleIsDefault type', (conversation: Record<string, unknown>) => { conversation.titleIsDefault = 'true'; }],
  ])('keeps rejecting a stored create receipt with %s', (_case, corrupt) => {
    const { db, service } = openService({ ids: ['conversation-2'] });
    service.create('project-1', { idempotencyKey: 'invalid-chat-1' });
    const row = db.prepare(`SELECT response_json AS responseJson FROM conversation_idempotency
      WHERE operation = 'conversation.create' AND idempotency_key = ?`)
      .get('invalid-chat-1') as { responseJson: string };
    const response = JSON.parse(row.responseJson) as { conversation: Record<string, unknown> };
    corrupt(response.conversation);
    db.prepare(`UPDATE conversation_idempotency SET response_json = ?
      WHERE operation = 'conversation.create' AND idempotency_key = ?`)
      .run(JSON.stringify(response), 'invalid-chat-1');

    expect(() => service.create('project-1', { idempotencyKey: 'invalid-chat-1' })).toThrow(
      expect.objectContaining({ code: 'INTERNAL', message: 'The stored conversation receipt is invalid.' }),
    );
  });

  it('keeps rejecting malformed stored create receipt JSON', () => {
    const { db, service } = openService({ ids: ['conversation-2'] });
    service.create('project-1', { idempotencyKey: 'malformed-chat-1' });
    db.prepare(`UPDATE conversation_idempotency SET response_json = ?
      WHERE operation = 'conversation.create' AND idempotency_key = ?`)
      .run('{', 'malformed-chat-1');

    expect(() => service.create('project-1', { idempotencyKey: 'malformed-chat-1' })).toThrow(
      expect.objectContaining({ code: 'INTERNAL', message: 'The stored conversation receipt is invalid.' }),
    );
  });

  it('rejects an idempotency key replayed for another project', () => {
    const { db, store, service } = openService({ ids: ['conversation-2'] });
    createProject(db, store, 'project-2', 'conversation-3', 'project-key-2');
    service.create('project-1', { idempotencyKey: 'new-chat-1' });

    expect(() => service.create('project-2', { idempotencyKey: 'new-chat-1' })).toThrow(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE project_id = 'project-2'").get()).toEqual({ count: 1 });
  });

  it('rejects unknown projects before listing or creating conversations', () => {
    const { service } = openService({ ids: ['conversation-2'] });

    expect(() => service.list('missing-project')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => service.create('missing-project', { idempotencyKey: 'new-chat-1' })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});
