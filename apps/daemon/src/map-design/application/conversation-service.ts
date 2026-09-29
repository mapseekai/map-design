import type Database from 'better-sqlite3';
import type {
  CreateMapDesignConversationInput,
  CreateMapDesignConversationResponse,
  MapDesignConversationResponse,
  MapDesignRunResponse,
  MapDesignConversationListResponse,
  MapDesignConversationSummary,
} from '@mapseekai/contracts';

import { MapDraftError } from './errors.js';
import { requestDigest } from './request-digest.js';
import { canonicalJson } from '../storage/canonical-json.js';
import type { MapDesignLocalStore, StoredConversationSummary } from '../storage/local-store.js';

const OPERATION = 'conversation.create';
const DEFAULT_TITLE = 'New conversation';

type ConversationCreateWitness = {
  projectId: string;
  requestDigest: string;
  responseJson: string;
};

export class MapDesignConversationService {
  constructor(private readonly deps: {
    store: MapDesignLocalStore;
    isConversationRunning(conversationId: string): boolean;
    getActiveConversationRun(conversationId: string): MapDesignRunResponse | null;
    randomId(): string;
    now(): string;
  }) {}

  list(projectId: string): MapDesignConversationListResponse {
    this.requireProject(projectId);
    return {
      conversations: this.deps.store.listConversations(projectId)
        .map((conversation) => this.withRunState(conversation)),
    };
  }

  get(projectId: string, conversationId: string): MapDesignConversationResponse {
    this.requireProject(projectId);
    const conversation = this.deps.store.getConversation(conversationId);
    if (!conversation || conversation.projectId !== projectId) {
      throw new MapDraftError('NOT_FOUND', 'The map conversation was not found.');
    }
    return { ...conversation, activeRun: this.deps.getActiveConversationRun(conversationId) };
  }

  create(projectId: string, input: CreateMapDesignConversationInput): CreateMapDesignConversationResponse {
    this.requireProject(projectId);
    const request = { projectId };
    const digest = requestDigest(request);

    return this.deps.store.inTransaction((db) => {
      const witness = this.findWitness(db, input.idempotencyKey);
      if (witness) return this.replay(witness, projectId, digest);

      const conversationId = this.deps.randomId();
      this.deps.store.createConversation(projectId, conversationId, DEFAULT_TITLE);
      const conversation = this.deps.store.listConversations(projectId)
        .find((summary) => summary.conversationId === conversationId);
      if (!conversation) throw new MapDraftError('INTERNAL', 'The map conversation could not be created.');

      const response: CreateMapDesignConversationResponse = {
        conversation: this.withRunState(conversation),
      };
      db.prepare(`INSERT INTO conversation_idempotency (
        project_id, operation, idempotency_key, request_digest, response_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(projectId, OPERATION, input.idempotencyKey, digest, canonicalJson(response), this.deps.now());
      return response;
    });
  }

  delete(projectId: string, conversationId: string): void {
    this.requireProject(projectId);
    this.deps.store.inTransaction((db) => {
      const conversation = db.prepare('SELECT project_id AS projectId FROM conversations WHERE id = ?').get(conversationId) as { projectId: string } | undefined;
      if (!conversation) return;
      if (conversation.projectId !== projectId) throw new MapDraftError('NOT_FOUND', 'The map conversation was not found.');
      if (this.deps.isConversationRunning(conversationId)) {
        throw new MapDraftError('RUNTIME_CONFLICT', 'Stop the active run before deleting this conversation.');
      }
      db.prepare('DELETE FROM conversations WHERE id = ? AND project_id = ?').run(conversationId, projectId);
    });
  }

  private requireProject(projectId: string): void {
    if (!this.deps.store.getProject(projectId)) {
      throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
    }
  }

  private findWitness(db: Database.Database, idempotencyKey: string): ConversationCreateWitness | null {
    const row = db.prepare(`SELECT project_id AS projectId, request_digest AS requestDigest, response_json AS responseJson
      FROM conversation_idempotency WHERE operation = ? AND idempotency_key = ?`)
      .get(OPERATION, idempotencyKey) as ConversationCreateWitness | undefined;
    return row ?? null;
  }

  private replay(
    witness: ConversationCreateWitness,
    projectId: string,
    digest: string,
  ): CreateMapDesignConversationResponse {
    if (witness.projectId !== projectId || witness.requestDigest !== digest) {
      throw new MapDraftError('IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.');
    }
    try {
      const response = normalizeLegacyConversationResponse(JSON.parse(witness.responseJson));
      if (!isConversationResponse(response)) throw new Error('invalid response');
      return response;
    } catch {
      throw new MapDraftError('INTERNAL', 'The stored conversation receipt is invalid.');
    }
  }

  private withRunState(conversation: StoredConversationSummary): MapDesignConversationSummary {
    return {
      ...conversation,
      runState: this.deps.isConversationRunning(conversation.conversationId) ? 'running' : 'idle',
    };
  }
}

function normalizeLegacyConversationResponse(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const conversation = (value as { conversation?: unknown }).conversation;
  if (!conversation || typeof conversation !== 'object'
    || Object.prototype.hasOwnProperty.call(conversation, 'titleIsDefault')) return value;
  return {
    ...value,
    conversation: { ...conversation, titleIsDefault: true },
  };
}

function isConversationResponse(value: unknown): value is CreateMapDesignConversationResponse {
  if (!value || typeof value !== 'object') return false;
  const conversation = (value as { conversation?: unknown }).conversation;
  return !!conversation && typeof conversation === 'object'
    && typeof (conversation as { conversationId?: unknown }).conversationId === 'string'
    && typeof (conversation as { projectId?: unknown }).projectId === 'string'
    && typeof (conversation as { title?: unknown }).title === 'string'
    && typeof (conversation as { titleIsDefault?: unknown }).titleIsDefault === 'boolean'
    && typeof (conversation as { messageCount?: unknown }).messageCount === 'number'
    && typeof (conversation as { createdAt?: unknown }).createdAt === 'string'
    && typeof (conversation as { lastActivityAt?: unknown }).lastActivityAt === 'string'
    && ((conversation as { runState?: unknown }).runState === 'idle' || (conversation as { runState?: unknown }).runState === 'running');
}
