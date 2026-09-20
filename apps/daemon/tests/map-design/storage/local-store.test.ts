import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { openMapDesignDatabase, closeMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';

const roots: string[] = [];
function openStore() {
  const root = mkdtempSync(join(tmpdir(), 'map-design-local-'));
  roots.push(root);
  const db = openMapDesignDatabase(root);
  return { db, store: createMapDesignLocalStore(db) };
}
function message<Role extends 'user' | 'assistant'>(id: string, role: Role, content: string, startedAt = Date.parse('2026-08-24T00:00:00.000Z')) {
  return {
    id,
    conversationId: 'conversation-1',
    role,
    content,
    events: [],
    runStatus: 'succeeded' as const,
    startedAt,
    endedAt: startedAt,
  };
}
function columns(db: ReturnType<typeof openMapDesignDatabase>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('MapDesignLocalStore', () => {
  it('migrates a legacy local database without replacing its inherited project runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'map-design-legacy-runtime-'));
    roots.push(root);
    const legacy = new Database(join(root, 'map-design.sqlite'));
    legacy.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, runtime_json TEXT NOT NULL, working_directory TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL, events_json TEXT, status TEXT, error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE agent_sessions (conversation_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, stable_prompt_hash TEXT, model TEXT, cwd TEXT, last_message_id TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (conversation_id, agent_id));
    `);
    legacy.prepare('INSERT INTO projects (id, title, runtime_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('project-1', 'Map', JSON.stringify({ agentId: 'codex' }), '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    legacy.prepare('INSERT INTO conversations (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('conversation-1', 'project-1', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    legacy.close();

    const db = openMapDesignDatabase(root);
    try {
      const store = createMapDesignLocalStore(db);
      expect(columns(db, 'conversations')).toEqual(expect.arrayContaining([
        'runtime_json', 'runtime_revision', 'runtime_updated_at',
      ]));
      expect(columns(db, 'messages')).toContain('runtime_json');
      expect(store.getConversationRuntime('conversation-1')).toMatchObject({ agentId: 'codex', revision: 0 });
    } finally { closeMapDesignDatabase(db); }
  });

  it('adds conversation runtime and message provenance columns for a fresh database', () => {
    const { db } = openStore();
    try {
      expect(columns(db, 'conversations')).toEqual(expect.arrayContaining([
        'runtime_json', 'runtime_revision', 'runtime_updated_at',
      ]));
      expect(columns(db, 'messages')).toContain('runtime_json');
    } finally { closeMapDesignDatabase(db); }
  });

  it('inherits project runtime for legacy and newly created conversations', () => {
    const { db, store } = openStore();
    try {
      store.createProject({ project: { projectId: 'project-1', title: 'Map', runtime: { agentId: 'codex', model: 'openai/gpt-5.6-terra' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Make it clear', idempotencyKey: 'key-1' }, primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null });
      store.createConversation('project-1', 'conversation-2', 'New conversation');

      expect(store.getConversationRuntime('conversation-1')).toMatchObject({
        agentId: 'codex', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 0,
      });
      expect(store.getConversationRuntime('conversation-2')).toMatchObject({
        agentId: 'codex', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 0,
      });
    } finally { closeMapDesignDatabase(db); }
  });

  it('updates runtime with a compare-and-swap and leaves the original choice after a stale write', () => {
    const { db, store } = openStore();
    try {
      store.createProject({ project: { projectId: 'project-1', title: 'Map', runtime: { agentId: 'codex' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Make it clear', idempotencyKey: 'key-1' }, primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null });

      expect(store.updateConversationRuntime({
        projectId: 'project-1', conversationId: 'conversation-1', expectedRevision: 0,
        runtime: { agentId: 'opencode', model: 'provider/deliberate', modelOrigin: 'custom' },
        updatedAt: '2026-09-02T00:00:00.000Z',
      })).toEqual({
        agentId: 'opencode', model: 'provider/deliberate', modelOrigin: 'custom', revision: 1,
        updatedAt: '2026-09-02T00:00:00.000Z',
      });
      expect(() => store.updateConversationRuntime({
        projectId: 'project-1', conversationId: 'conversation-1', expectedRevision: 0,
        runtime: { agentId: 'pi' }, updatedAt: '2026-09-02T00:01:00.000Z',
      })).toThrow(expect.objectContaining({ code: 'RUNTIME_CONFLICT' }));
      expect(store.getConversationRuntime('conversation-1')).toMatchObject({
        agentId: 'opencode', model: 'provider/deliberate', modelOrigin: 'custom', revision: 1,
      });
    } finally { closeMapDesignDatabase(db); }
  });

  it('keeps runtime updates project-owned and rolls them back with their surrounding transaction', () => {
    const { db, store } = openStore();
    try {
      store.createProject({ project: { projectId: 'project-1', title: 'Map', runtime: { agentId: 'codex' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Make it clear', idempotencyKey: 'key-1' }, primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null });
      store.createProject({ project: { projectId: 'project-2', title: 'Other', runtime: { agentId: 'pi' }, source: { url: 'https://example.com/other.json' }, designRequirement: 'Make it distinct', idempotencyKey: 'key-2' }, primaryConversationId: 'conversation-2', verifiedWorkingDirectory: null });

      expect(() => store.updateConversationRuntime({
        projectId: 'project-2', conversationId: 'conversation-1', expectedRevision: 0,
        runtime: { agentId: 'pi' }, updatedAt: '2026-09-02T00:00:00.000Z',
      })).toThrow(expect.objectContaining({ code: 'RUNTIME_CONFLICT' }));
      expect(() => store.inTransaction(() => {
        store.updateConversationRuntime({
          projectId: 'project-1', conversationId: 'conversation-1', expectedRevision: 0,
          runtime: { agentId: 'opencode' }, updatedAt: '2026-09-02T00:00:00.000Z',
        });
        throw new Error('abort runtime update');
      })).toThrow('abort runtime update');
      expect(store.getConversationRuntime('conversation-1')).toMatchObject({ agentId: 'codex', revision: 0 });
    } finally { closeMapDesignDatabase(db); }
  });

  it('round-trips assistant runtime provenance with an event snapshot', () => {
    const { db, store } = openStore();
    try {
      store.createProject({ project: { projectId: 'project-1', title: 'Map', runtime: { agentId: 'codex' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Make it clear', idempotencyKey: 'key-1' }, primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null });
      store.appendMessage({ message: {
        ...message('assistant-1', 'assistant', 'Done.'),
        runtime: { agentId: 'opencode', agentVersion: '1.2.3', model: 'openai/gpt-5.6-terra', reasoning: 'high', serviceTier: 'priority', adapter: 'local-cli' },
      } });

      expect(store.getConversation('conversation-1')?.messages).toEqual([expect.objectContaining({
        id: 'assistant-1', runtime: {
          agentId: 'opencode', agentVersion: '1.2.3', model: 'openai/gpt-5.6-terra',
          reasoning: 'high', serviceTier: 'priority', adapter: 'local-cli',
        },
      })]);
    } finally { closeMapDesignDatabase(db); }
  });

  it('persists and reloads the event-only message shape without legacy activity fields', () => {
    const { db, store } = openStore();
    try {
      store.createProject({ project: { projectId: 'project-1', title: 'Map', runtime: { agentId: 'claude' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Make it clear', idempotencyKey: 'key-1' }, primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null });
      store.appendMessage({ message: {
        id: 'assistant-1', conversationId: 'conversation-1', role: 'assistant',
        content: 'The map is ready.',
        events: [
          { kind: 'status', label: 'analyzing' },
          { kind: 'tool_use', id: 'call-1', name: 'map_inspect', summary: { target: 'root' } },
          { kind: 'tool_result', toolUseId: 'call-1', status: 'succeeded', summary: { returned: 12 } },
          { kind: 'text', text: 'The map is ready.' },
          { kind: 'run_finished', status: 'succeeded' },
        ],
        runStatus: 'succeeded', startedAt: 1_788_100_000_000, endedAt: 1_788_100_002_000,
      }, runId: 'run-1' });

      const stored = store.getConversation('conversation-1')?.messages[0];
      expect(stored).toEqual({
        id: 'assistant-1', conversationId: 'conversation-1', role: 'assistant',
        content: 'The map is ready.',
        events: [
          { kind: 'status', label: 'analyzing' },
          { kind: 'tool_use', id: 'call-1', name: 'map_inspect', summary: { target: 'root' } },
          { kind: 'tool_result', toolUseId: 'call-1', status: 'succeeded', summary: { returned: 12 } },
          { kind: 'text', text: 'The map is ready.' },
          { kind: 'run_finished', status: 'succeeded' },
        ],
        runStatus: 'succeeded', startedAt: 1_788_100_000_000, endedAt: 1_788_100_002_000,
      });
      expect(stored).not.toHaveProperty('activity');
      expect(stored).not.toHaveProperty('toolCalls');
    } finally { closeMapDesignDatabase(db); }
  });

  it('rejects legacy tool-call rows instead of interpreting them as ordered events', () => {
    const { db, store } = openStore();
    try {
      store.createProject({ project: { projectId: 'project-1', title: 'Map', runtime: { agentId: 'claude' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Make it clear', idempotencyKey: 'key-1' }, primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null });
      db.prepare(`INSERT INTO messages (
        id, conversation_id, role, text, events_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        'legacy-1', 'conversation-1', 'assistant', '',
        JSON.stringify([{ id: 'call-1', name: 'map_inspect', status: 'succeeded' }]),
        '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z',
      );

      expect(() => store.getConversation('conversation-1')).toThrow('Invalid persisted MapDesign message.');
    } finally { closeMapDesignDatabase(db); }
  });

  it('persists a project, primary conversation, messages, and agent session', () => {
    const { db, store } = openStore();
    try {
      store.createProject({ project: { projectId: 'project-1', title: 'Map', runtime: { agentId: 'claude' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Make it clear', idempotencyKey: 'key-1' }, primaryConversationId: 'conversation-1', verifiedWorkingDirectory: '/tmp/map' });
      store.appendMessage({ message: message('message-1', 'user', 'Hello') });
      store.upsertAgentSession({ conversationId: 'conversation-1', agentId: 'claude', sessionId: 'session-1', stablePromptHash: null, model: null, cwd: '/tmp/map', lastMessageId: 'message-1', updatedAt: '2026-08-24T00:00:00.000Z' });
      expect(store.getProject('project-1')).toMatchObject({ id: 'project-1', title: 'Map', primaryConversationId: 'conversation-1' });
      expect(store.getConversation('conversation-1')?.messages).toEqual([message('message-1', 'user', 'Hello')]);
      expect(store.getAgentSession('conversation-1', 'claude')).toMatchObject({ sessionId: 'session-1', lastMessageId: 'message-1' });
    } finally { closeMapDesignDatabase(db); }
  });

  it('rolls back every project-create write performed in one transaction', () => {
    const { db, store } = openStore();
    try {
      expect(() => store.inTransaction(() => {
        store.createProjectInTransaction({
          project: { projectId: 'project-atomic', title: 'Map', runtime: { agentId: 'claude' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Make it clear', idempotencyKey: 'key-atomic' },
          primaryConversationId: 'conversation-atomic',
          verifiedWorkingDirectory: null,
        });
        throw new Error('abort project create');
      })).toThrow('abort project create');
      expect(db.prepare('SELECT COUNT(*) AS count FROM projects WHERE id = ?').get('project-atomic')).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE project_id = ?').get('project-atomic')).toEqual({ count: 0 });
    } finally { closeMapDesignDatabase(db); }
  });

  it('retains a run id when a run message is inserted and patched', () => {
    const { db, store } = openStore();
    try {
      store.createProject({ project: { projectId: 'project-1', title: 'Map', runtime: { agentId: 'claude' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Make it clear', idempotencyKey: 'key-1' }, primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null });
      store.appendMessage({ message: message('message-1', 'assistant', 'Running'), runId: 'run-1' });
      store.updateRunMessage('message-1', { runId: 'run-2' });
      expect(db.prepare('SELECT run_id AS runId FROM messages WHERE id = ?').get('message-1')).toEqual({ runId: 'run-2' });
    } finally { closeMapDesignDatabase(db); }
  });

  it('loads same-turn messages in insertion order with the persisted run failure', () => {
    const { db, store } = openStore();
    try {
      store.createProject({ project: { projectId: 'project-1', title: 'Map', runtime: { agentId: 'codex' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Make it clear', idempotencyKey: 'key-1' }, primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null });
      const startedAt = Date.parse('2026-08-30T00:28:37.053Z');
      store.appendMessage({ message: message('user-1', 'user', '重写设计一下地图', startedAt), runId: 'run-1' });
      store.appendMessage({ message: message('assistant-1', 'assistant', '', startedAt), runId: 'run-1' });
      store.updateRunMessage('assistant-1', {
        events: [{ kind: 'run_finished', status: 'failed' }],
        runStatus: 'failed',
        endedAt: startedAt + 2_000,
      });

      expect(store.getConversation('conversation-1')?.messages).toEqual([
        message('user-1', 'user', '重写设计一下地图', startedAt),
        {
          ...message('assistant-1', 'assistant', '', startedAt),
          events: [{ kind: 'run_finished', status: 'failed' }],
          runStatus: 'failed',
          endedAt: startedAt + 2_000,
        },
      ]);
    } finally { closeMapDesignDatabase(db); }
  });

  it('rejects unsafe event payloads at the storage boundary', () => {
    const { db, store } = openStore();
    try {
      store.createProject({ project: { projectId: 'project-1', title: 'Map', runtime: { agentId: 'claude' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Make it clear', idempotencyKey: 'key-1' }, primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null });
      expect(() => store.appendMessage({ message: {
        ...message('assistant-1', 'assistant', ''),
        events: [{ kind: 'tool_use', id: 'call-1', name: 'map_inspect', summary: { path: '/Users/alice/private' } }],
      } })).toThrow();
      expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    } finally { closeMapDesignDatabase(db); }
  });

  it('migrates the primary conversation without changing its id and promotes its title once', () => {
    const { db, store } = openStore();
    try {
      store.createProject({
        project: {
          projectId: 'project-1', title: 'Map', runtime: { agentId: 'claude' },
          source: { url: 'https://example.com/style.json' },
          designRequirement: 'Keep labels clear', idempotencyKey: 'project-key-1',
        },
        primaryConversationId: 'conversation-1',
        verifiedWorkingDirectory: null,
      });
      store.appendMessage({ message: message('message-1', 'user', '  Improve   highway labels beyond the current hierarchy  ', Date.parse('2026-08-27T00:00:00.000Z')) });

      expect(store.listConversations('project-1')).toEqual([expect.objectContaining({
        conversationId: 'conversation-1',
        title: 'Improve highway labels beyond the current hierar…',
        titleIsDefault: false,
        messageCount: 1,
      })]);
      expect(db.prepare('SELECT id FROM conversations').all()).toEqual([{ id: 'conversation-1' }]);
    } finally { closeMapDesignDatabase(db); }
  });

  it('exposes the durable default-title marker until the first user message promotes the title', () => {
    const { db, store } = openStore();
    try {
      store.createProject({
        project: {
          projectId: 'project-1', title: 'Map', runtime: { agentId: 'claude' },
          source: { url: 'https://example.com/style.json' },
          designRequirement: 'Keep labels clear', idempotencyKey: 'project-key-1',
        },
        primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null,
      });

      expect(store.listConversations('project-1')[0]).toMatchObject({
        title: 'New conversation', titleIsDefault: true,
      });

      store.appendMessage({ message: message('message-1', 'user', 'Neue Straßenfarben', Date.parse('2026-08-27T00:00:00.000Z')) });

      expect(store.listConversations('project-1')[0]).toMatchObject({
        title: 'Neue Straßenfarben', titleIsDefault: false,
      });
    } finally { closeMapDesignDatabase(db); }
  });

  it('truncates a first-message title at 48 Unicode code points and never renames it twice', () => {
    const { db, store } = openStore();
    try {
      store.createProject({
        project: {
          projectId: 'project-1', title: 'Map', runtime: { agentId: 'claude' },
          source: { url: 'https://example.com/style.json' },
          designRequirement: 'Keep labels clear', idempotencyKey: 'project-key-1',
        },
        primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null,
      });
      store.appendMessage({ message: message('message-1', 'user', '一'.repeat(60), Date.parse('2026-08-27T00:00:00.000Z')) });
      const promoted = store.listConversations('project-1')[0]?.title;
      expect(promoted).toBe(`${'一'.repeat(48)}…`);
      store.appendMessage({ message: message('message-2', 'user', 'This must not rename the conversation', Date.parse('2026-08-27T00:01:00.000Z')) });
      expect(store.listConversations('project-1')[0]?.title).toBe(promoted);
    } finally { closeMapDesignDatabase(db); }
  });

  it('rolls back an inserted message when updating its conversation aborts', () => {
    const { db, store } = openStore();
    try {
      store.createProject({ project: { projectId: 'project-1', title: 'Map', runtime: { agentId: 'claude' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Make it clear', idempotencyKey: 'key-1' }, primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null });
      db.exec(`CREATE TRIGGER reject_conversation_update BEFORE UPDATE ON conversations BEGIN SELECT RAISE(ABORT, 'reject update'); END`);
      expect(() => store.appendMessage({ message: message('message-1', 'user', 'Hello') })).toThrow(/reject update/i);
      expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE id = ?').get('message-1')).toEqual({ count: 0 });
    } finally { closeMapDesignDatabase(db); }
  });

  it('orders summaries by map lifecycle updates rather than generic project timestamps', () => {
    const { db, store } = openStore();
    try {
      for (let index = 0; index < 101; index += 1) {
        const id = `project-${index}`;
        db.prepare('INSERT INTO projects (id, title, runtime_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, id, '{"agentId":"claude"}', String(index), String(index));
        const offset = 100 - index;
        const lifecycleUpdatedAt = `2026-08-25T00:${String(Math.floor(offset / 60)).padStart(2, '0')}:${String(offset % 60).padStart(2, '0')}.000Z`;
        db.prepare(`INSERT INTO map_design_projects (project_id, lifecycle_state, design_system_id, design_system_digest, draft_revision, created_at, updated_at) VALUES (?, 'importing', 'quiet-atlas', 'digest', 0, ?, ?)`).run(id, String(index), lifecycleUpdatedAt);
      }
      const projects = store.listProjects();
      expect(projects).toHaveLength(100);
      expect(projects[0]).toMatchObject({ projectId: 'project-0', updatedAt: '2026-08-25T00:01:40.000Z', lifecycle: 'importing', validationStatus: 'unknown', draftRevision: 0 });
      expect(projects.at(-1)).toMatchObject({ projectId: 'project-99', updatedAt: '2026-08-25T00:00:01.000Z' });
    } finally { closeMapDesignDatabase(db); }
  });

  it('cascades conversations, messages, and agent sessions when deleting a project', () => {
    const { db, store } = openStore();
    try {
      store.createProject({ project: { projectId: 'project-1', title: 'Map', runtime: { agentId: 'claude' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Make it clear', idempotencyKey: 'key-1' }, primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null });
      store.appendMessage({ message: message('message-1', 'user', 'Hello') });
      store.upsertAgentSession({ conversationId: 'conversation-1', agentId: 'claude', sessionId: 'session-1', stablePromptHash: null, model: null, cwd: null, lastMessageId: null, updatedAt: '2026-08-24T00:00:00.000Z' });
      expect(store.deleteProject('project-1')).toBe(true);
      expect(store.getConversation('conversation-1')).toBeNull();
      expect(store.getAgentSession('conversation-1', 'claude')).toBeNull();
    } finally { closeMapDesignDatabase(db); }
  });
});
