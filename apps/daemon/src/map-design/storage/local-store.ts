import type Database from 'better-sqlite3';
import {
  MapDesignConversationRuntimeChoiceSchema,
  MapDesignMessageSchema,
  MapDesignRuntimeSelectionInputSchema,
  type MapDesignConversation,
  type MapDesignConversationRuntimeChoice,
  type MapDesignMessage,
  type MapDesignRuntimeSelectionInput,
} from '@mapseekai/contracts';
import type { MapDesignProjectCreateInput, MapDesignProjectSummary, MapDesignRuntimeSelection } from '@mapseekai/map-design-contracts';

import { titleFromFirstMessage } from './conversation-title.js';
import { MapDraftError } from '../application/errors.js';

export interface StoredMapDesignProject { id: string; title: string; runtime: MapDesignRuntimeSelection; workingDirectory: string | null; primaryConversationId: string | null; createdAt: string; updatedAt: string; }
export interface StoredConversationSummary { conversationId: string; projectId: string; title: string; titleIsDefault: boolean; messageCount: number; createdAt: string; lastActivityAt: string; }
export interface StoredAgentSession { conversationId: string; agentId: string; sessionId: string; stablePromptHash: string | null; model: string | null; cwd: string | null; lastMessageId: string | null; updatedAt: string; }
export interface StoredMapDesignMessageInput { message: MapDesignMessage; runId?: string | null; }
export interface RunMessagePatch {
  runId?: string | null;
  content?: string;
  events?: MapDesignMessage['events'];
  runStatus?: MapDesignMessage['runStatus'];
  endedAt?: number;
}
export interface UpdateConversationRuntimeInput {
  projectId: string;
  conversationId: string;
  expectedRevision: number;
  runtime: MapDesignRuntimeSelectionInput;
  updatedAt: string;
}
export interface MapDesignLocalStore {
  createProjectInTransaction(input: { project: MapDesignProjectCreateInput; primaryConversationId: string; verifiedWorkingDirectory: string | null }): void;
  inTransaction<T>(callback: (db: Database.Database) => T): T;
  createProject(input: { project: MapDesignProjectCreateInput; primaryConversationId: string; verifiedWorkingDirectory: string | null }): void;
  listProjects(): MapDesignProjectSummary[];
  getProject(projectId: string): StoredMapDesignProject | null;
  deleteProject(projectId: string): boolean;
  listConversations(projectId: string): StoredConversationSummary[];
  createConversation(projectId: string, conversationId: string, title: string): MapDesignConversation;
  getConversation(conversationId: string): MapDesignConversation | null;
  getConversationRuntime(conversationId: string): MapDesignConversationRuntimeChoice | null;
  updateConversationRuntime(input: UpdateConversationRuntimeInput): MapDesignConversationRuntimeChoice;
  appendMessage(input: StoredMapDesignMessageInput): void;
  updateRunMessage(messageId: string, patch: RunMessagePatch): void;
  getAgentSession(conversationId: string, agentId: string): StoredAgentSession | null;
  upsertAgentSession(session: StoredAgentSession): void;
  deleteAgentSession(conversationId: string, agentId: string): boolean;
}

type Row = Record<string, unknown>;

export function createMapDesignLocalStore(db: Database.Database): MapDesignLocalStore {
  const createProjectInTransaction = (input: { project: MapDesignProjectCreateInput; primaryConversationId: string; verifiedWorkingDirectory: string | null }) => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO projects (id, title, runtime_json, working_directory, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(input.project.projectId, input.project.title, JSON.stringify(input.project.runtime), input.verifiedWorkingDirectory, now, now);
    db.prepare('INSERT INTO conversations (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run(input.primaryConversationId, input.project.projectId, now, now);
  };
  const createProject = db.transaction(createProjectInTransaction);
  const getConversation = (conversationId: string): MapDesignConversation | null => {
    const conversation = db.prepare('SELECT id, project_id AS projectId, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE id = ?').get(conversationId) as Row | undefined;
    if (!conversation) return null;
    const messages = db.prepare(`
      SELECT id, conversation_id AS conversationId, role, content,
        events_json AS eventsJson, run_status AS runStatus,
        started_at AS startedAt, ended_at AS endedAt, runtime_json AS runtimeJson, screenshots_json AS screenshotsJson, attachments_json AS attachmentsJson
      FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid
    `).all(conversationId) as Row[];
    return {
      id: String(conversation.id),
      projectId: String(conversation.projectId),
      createdAt: String(conversation.createdAt),
      updatedAt: String(conversation.updatedAt),
      messages: messages.map(parseStoredMessage),
    };
  };
  return {
    createProjectInTransaction,
    inTransaction: <T>(callback: (database: Database.Database) => T): T => db.transaction(callback).immediate(db),
    createProject,
    listProjects: () => db.prepare(`SELECT p.id AS projectId, p.title, m.lifecycle_state AS lifecycle, m.source_kind AS sourceKind, m.draft_revision AS draftRevision, m.committed_revision AS committedRevision, COALESCE(m.initial_validation_status, 'unknown') AS validationStatus, m.updated_at AS updatedAt FROM projects p JOIN map_design_projects m ON m.project_id = p.id ORDER BY m.updated_at DESC LIMIT 100`).all() as MapDesignProjectSummary[],
    getProject: (projectId) => {
      const row = db.prepare('SELECT p.id, p.title, p.runtime_json AS runtimeJson, p.working_directory AS workingDirectory, c.id AS primaryConversationId, p.created_at AS createdAt, p.updated_at AS updatedAt FROM projects p LEFT JOIN conversations c ON c.project_id = p.id WHERE p.id = ? ORDER BY c.created_at LIMIT 1').get(projectId) as Row | undefined;
      return row ? { id: String(row.id), title: String(row.title), runtime: JSON.parse(String(row.runtimeJson)), workingDirectory: row.workingDirectory as string | null, primaryConversationId: row.primaryConversationId == null ? null : String(row.primaryConversationId), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) } : null;
    },
    deleteProject: (projectId) => db.prepare('DELETE FROM projects WHERE id = ?').run(projectId).changes > 0,
    listConversations: (projectId) => db.prepare(`
      SELECT c.id AS conversationId, c.project_id AS projectId, c.title,
        c.title_is_default AS titleIsDefault,
        COUNT(m.id) AS messageCount, c.created_at AS createdAt, c.updated_at AS lastActivityAt
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.project_id = ?
      GROUP BY c.id
      ORDER BY c.updated_at DESC, c.id
    `).all(projectId).map((row) => {
      const summary = row as Row;
      return {
        conversationId: String(summary.conversationId),
        projectId: String(summary.projectId),
        title: String(summary.title),
        titleIsDefault: Number(summary.titleIsDefault) === 1,
        messageCount: Number(summary.messageCount),
        createdAt: String(summary.createdAt),
        lastActivityAt: String(summary.lastActivityAt),
      };
    }),
    createConversation: (projectId, conversationId, title) => {
      const now = new Date().toISOString();
      const project = db.prepare('SELECT runtime_json AS runtimeJson FROM projects WHERE id = ?').get(projectId) as Row | undefined;
      if (!project) throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
      const runtime = parseRuntimeSelection(JSON.parse(String(project.runtimeJson)));
      db.prepare(`INSERT INTO conversations (
        id, project_id, title, runtime_json, runtime_revision, runtime_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`).run(
        conversationId, projectId, title, JSON.stringify(runtime), now, now, now,
      );
      return { id: conversationId, projectId, createdAt: now, updatedAt: now, messages: [] };
    },
    getConversation,
    getConversationRuntime: (conversationId) => {
      const row = db.prepare(`SELECT c.runtime_json AS runtimeJson, c.runtime_revision AS runtimeRevision,
        c.runtime_updated_at AS runtimeUpdatedAt, c.created_at AS createdAt, p.runtime_json AS projectRuntimeJson
        FROM conversations c JOIN projects p ON p.id = c.project_id WHERE c.id = ?`).get(conversationId) as Row | undefined;
      if (!row) return null;
      try {
        if (typeof row.runtimeJson === 'string') {
          return parseConversationRuntimeChoice({
            ...JSON.parse(row.runtimeJson), revision: Number(row.runtimeRevision), updatedAt: row.runtimeUpdatedAt,
          });
        }
        return parseConversationRuntimeChoice({
          ...parseRuntimeSelection(JSON.parse(String(row.projectRuntimeJson))),
          revision: Number(row.runtimeRevision), updatedAt: row.runtimeUpdatedAt ?? row.createdAt,
        });
      } catch {
        throw new Error('Invalid persisted MapDesign conversation runtime.');
      }
    },
    updateConversationRuntime: (input) => {
      const runtime = parseRuntimeSelection(input.runtime);
      const result = db.prepare(`UPDATE conversations
        SET runtime_json = ?, runtime_revision = runtime_revision + 1, runtime_updated_at = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND runtime_revision = ?`).run(
        JSON.stringify(runtime), input.updatedAt, input.updatedAt,
        input.conversationId, input.projectId, input.expectedRevision,
      );
      if (result.changes !== 1) {
        throw new MapDraftError('RUNTIME_CONFLICT', 'The conversation runtime changed in another client.');
      }
      return parseConversationRuntimeChoice({
        ...runtime, revision: input.expectedRevision + 1, updatedAt: input.updatedAt,
      });
    },
    appendMessage: (input) => db.transaction((value: StoredMapDesignMessageInput) => {
      const message = MapDesignMessageSchema.parse(value.message);
      const timestamp = messageTimestamp(message.startedAt);
      db.prepare(`INSERT INTO messages (
        id, conversation_id, run_id, role, text, content, events_json,
        run_status, started_at, ended_at, runtime_json, screenshots_json, attachments_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        message.id, message.conversationId, value.runId ?? null, message.role,
        message.content, message.content, JSON.stringify(message.events),
        message.runStatus, message.startedAt, message.endedAt,
        message.role === 'assistant' && message.runtime ? JSON.stringify(message.runtime) : null,
        message.role === 'user' && message.screenshots?.length ? JSON.stringify(message.screenshots) : null,
        message.role === 'user' && message.attachments?.length ? JSON.stringify(message.attachments) : null,
        timestamp, timestamp,
      );
      if (message.role === 'user') {
        db.prepare('UPDATE conversations SET title = ?, title_is_default = 0 WHERE id = ? AND title_is_default = 1')
          .run(titleFromFirstMessage(message.content), message.conversationId);
      }
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(timestamp, message.conversationId);
    })(input),
    updateRunMessage: (messageId, patch) => {
      const current = db.prepare(`
        SELECT id, conversation_id AS conversationId, role, content,
        events_json AS eventsJson, run_status AS runStatus,
        started_at AS startedAt, ended_at AS endedAt, run_id AS runId, runtime_json AS runtimeJson, screenshots_json AS screenshotsJson, attachments_json AS attachmentsJson
        FROM messages WHERE id = ?
      `).get(messageId) as Row | undefined;
      if (!current) return;
      const message = parseStoredMessage(current);
      const updated = MapDesignMessageSchema.parse({
        ...message,
        content: patch.content ?? message.content,
        events: patch.events ?? message.events,
        runStatus: patch.runStatus ?? message.runStatus,
        endedAt: patch.endedAt ?? message.endedAt,
      });
      db.prepare(`UPDATE messages SET
        run_id = ?, content = ?, events_json = ?, run_status = ?, ended_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        patch.runId === undefined ? current.runId : patch.runId,
        updated.content, JSON.stringify(updated.events), updated.runStatus, updated.endedAt,
        messageTimestamp(updated.endedAt || updated.startedAt), messageId,
      );
    },
    getAgentSession: (conversationId, agentId) => {
      const row = db.prepare('SELECT conversation_id AS conversationId, agent_id AS agentId, session_id AS sessionId, stable_prompt_hash AS stablePromptHash, model, cwd, last_message_id AS lastMessageId, updated_at AS updatedAt FROM agent_sessions WHERE conversation_id = ? AND agent_id = ?').get(conversationId, agentId) as Row | undefined;
      return row as StoredAgentSession | undefined ?? null;
    },
    upsertAgentSession: (session) => db.prepare('INSERT INTO agent_sessions (conversation_id, agent_id, session_id, stable_prompt_hash, model, cwd, last_message_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id, agent_id) DO UPDATE SET session_id = excluded.session_id, stable_prompt_hash = excluded.stable_prompt_hash, model = excluded.model, cwd = excluded.cwd, last_message_id = excluded.last_message_id, updated_at = excluded.updated_at').run(session.conversationId, session.agentId, session.sessionId, session.stablePromptHash, session.model, session.cwd, session.lastMessageId, session.updatedAt),
    deleteAgentSession: (conversationId, agentId) => db.prepare(
      'DELETE FROM agent_sessions WHERE conversation_id = ? AND agent_id = ?',
    ).run(conversationId, agentId).changes > 0,
  };
}

function parseStoredMessage(row: Row): MapDesignMessage {
  try {
    if (typeof row.eventsJson !== 'string') throw new Error('missing events');
    return MapDesignMessageSchema.parse({
      id: row.id,
      conversationId: row.conversationId,
      role: row.role,
      content: row.content,
      events: JSON.parse(row.eventsJson),
      runStatus: row.runStatus,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      ...(typeof row.runtimeJson === 'string' ? { runtime: JSON.parse(row.runtimeJson) } : {}),
      ...(typeof row.screenshotsJson === 'string' ? { screenshots: JSON.parse(row.screenshotsJson) } : {}),
      ...(typeof row.attachmentsJson === 'string' ? { attachments: JSON.parse(row.attachmentsJson) } : {}),
    });
  } catch {
    throw new Error('Invalid persisted MapDesign message.');
  }
}

function parseRuntimeSelection(value: unknown): MapDesignRuntimeSelectionInput {
  const parsed = MapDesignRuntimeSelectionInputSchema.parse(value);
  return {
    agentId: parsed.agentId,
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    ...(parsed.model === undefined
      ? {}
      : { modelOrigin: parsed.modelOrigin ?? 'catalog' as const }),
    ...(parsed.reasoning === undefined ? {} : { reasoning: parsed.reasoning }),
    ...(parsed.serviceTier === undefined ? {} : { serviceTier: parsed.serviceTier }),
  };
}

function parseConversationRuntimeChoice(value: unknown): MapDesignConversationRuntimeChoice {
  const parsed = MapDesignConversationRuntimeChoiceSchema.parse(value);
  return {
    agentId: parsed.agentId,
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    ...(parsed.model === undefined
      ? {}
      : { modelOrigin: parsed.modelOrigin ?? 'catalog' as const }),
    ...(parsed.reasoning === undefined ? {} : { reasoning: parsed.reasoning }),
    ...(parsed.serviceTier === undefined ? {} : { serviceTier: parsed.serviceTier }),
    revision: parsed.revision,
    updatedAt: parsed.updatedAt,
  };
}

function messageTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString();
}
