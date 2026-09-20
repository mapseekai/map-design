import type Database from 'better-sqlite3';
import {
  MapDesignConversationRuntimeResponseSchema,
  MapDesignRuntimeSelectionInputSchema,
  type MapDesignConversationRuntimeChoice,
  type MapDesignConversationRuntimeResponse,
  type MapDesignRuntimeSelectionInput,
  type UpdateMapDesignConversationRuntimeRequest,
} from '@mapseekai/contracts';

import { invalidInput, isMapDraftError, MapDraftError } from './errors.js';
import { requestDigest } from './request-digest.js';
import { canonicalJson } from '../storage/canonical-json.js';
import type { MapDesignLocalStore } from '../storage/local-store.js';

const OPERATION = 'conversation.runtime.update';

export interface ConversationRuntimeChoicePolicy {
  validate(input: MapDesignRuntimeSelectionInput): MapDesignRuntimeSelectionInput;
  normalizeSaved(input: MapDesignRuntimeSelectionInput): {
    runtime: MapDesignRuntimeSelectionInput;
    normalizationNotice?: string;
  };
}

type RuntimeUpdateWitness = {
  projectId: string;
  requestDigest: string;
  responseJson: string;
};

export class MapDesignConversationRuntimeService {
  constructor(private readonly deps: {
    store: MapDesignLocalStore;
    policy: ConversationRuntimeChoicePolicy;
    isProjectRunning(projectId: string): boolean;
    now(): string;
  }) {}

  get(projectId: string, conversationId: string): MapDesignConversationRuntimeResponse {
    return this.responseFor(this.requireConversation(projectId, conversationId));
  }

  update(
    projectId: string,
    conversationId: string,
    request: UpdateMapDesignConversationRuntimeRequest,
  ): MapDesignConversationRuntimeResponse {
    const currentRuntime = this.requireConversation(projectId, conversationId);
    const digest = requestDigest({ projectId, conversationId, ...request });
    return this.deps.store.inTransaction((db) => {
      const witness = this.findWitness(db, request.clientRequestId);
      if (witness) return this.replay(witness, projectId, digest);
      if (this.deps.isProjectRunning(projectId)) {
        throw runtimeConflict(currentRuntime, 'A map run is active for this project.', {
          retryable: true,
          reason: 'ACTIVE_RUN',
        });
      }
      const runtime = this.validateRuntime(request.runtime);
      let updatedRuntime: MapDesignConversationRuntimeChoice;
      try {
        updatedRuntime = this.deps.store.updateConversationRuntime({
          projectId, conversationId, expectedRevision: request.expectedRevision, runtime, updatedAt: this.deps.now(),
        });
      } catch (error) {
        if (isMapDraftError(error) && error.code === 'RUNTIME_CONFLICT') {
          throw runtimeConflict(
            this.requireConversation(projectId, conversationId),
            'The conversation runtime changed in another client.',
          );
        }
        throw error;
      }
      const response = this.responseFor(updatedRuntime);
      MapDesignConversationRuntimeResponseSchema.parse(response);
      db.prepare(`INSERT INTO conversation_idempotency (
        project_id, operation, idempotency_key, request_digest, response_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`).run(
        projectId, OPERATION, request.clientRequestId, digest, canonicalJson(response), this.deps.now(),
      );
      return response;
    });
  }

  requireCurrent(projectId: string, conversationId: string, expectedRevision: number): MapDesignConversationRuntimeChoice {
    const runtime = this.requireConversation(projectId, conversationId);
    if (runtime.revision !== expectedRevision) {
      throw runtimeConflict(runtime, 'The conversation runtime changed in another client.');
    }
    return runtime;
  }

  private requireConversation(projectId: string, conversationId: string): MapDesignConversationRuntimeChoice {
    if (!this.deps.store.getProject(projectId)) {
      throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
    }
    const conversation = this.deps.store.getConversation(conversationId);
    if (!conversation || conversation.projectId !== projectId) {
      throw new MapDraftError('NOT_FOUND', 'The map conversation was not found.');
    }
    const runtime = this.deps.store.getConversationRuntime(conversationId);
    if (!runtime) throw new MapDraftError('NOT_FOUND', 'The map conversation was not found.');
    return runtime;
  }

  private findWitness(db: Database.Database, idempotencyKey: string): RuntimeUpdateWitness | null {
    const row = db.prepare(`SELECT project_id AS projectId, request_digest AS requestDigest, response_json AS responseJson
      FROM conversation_idempotency WHERE operation = ? AND idempotency_key = ?`)
      .get(OPERATION, idempotencyKey) as RuntimeUpdateWitness | undefined;
    return row ?? null;
  }

  private validateRuntime(input: MapDesignRuntimeSelectionInput): MapDesignRuntimeSelectionInput {
    try {
      const parsed = MapDesignRuntimeSelectionInputSchema.parse(this.deps.policy.validate(input));
      return {
        agentId: parsed.agentId,
        ...(parsed.model === undefined ? {} : { model: parsed.model }),
        ...(parsed.model === undefined
          ? {}
          : { modelOrigin: parsed.modelOrigin ?? 'catalog' as const }),
        ...(parsed.reasoning === undefined ? {} : { reasoning: parsed.reasoning }),
        ...(parsed.serviceTier === undefined ? {} : { serviceTier: parsed.serviceTier }),
      };
    } catch (error) {
      if (isMapDraftError(error)) throw error;
      throw invalidInput();
    }
  }

  private responseFor(runtime: MapDesignConversationRuntimeChoice): MapDesignConversationRuntimeResponse {
    const normalized = this.deps.policy.normalizeSaved({
      agentId: runtime.agentId,
      ...(runtime.model === undefined ? {} : { model: runtime.model }),
      ...(runtime.modelOrigin === undefined ? {} : { modelOrigin: runtime.modelOrigin }),
      ...(runtime.reasoning === undefined ? {} : { reasoning: runtime.reasoning }),
      ...(runtime.serviceTier === undefined ? {} : { serviceTier: runtime.serviceTier }),
    });
    const effective = MapDesignRuntimeSelectionInputSchema.parse(normalized.runtime);
    const response: MapDesignConversationRuntimeResponse = {
      runtime,
      effectiveRuntime: {
        agentId: effective.agentId,
        ...(effective.model === undefined ? {} : { model: effective.model }),
        ...(effective.model === undefined
          ? {}
          : { modelOrigin: effective.modelOrigin ?? 'catalog' as const }),
        ...(effective.reasoning === undefined ? {} : { reasoning: effective.reasoning }),
        ...(effective.serviceTier === undefined ? {} : { serviceTier: effective.serviceTier }),
        revision: runtime.revision,
        updatedAt: runtime.updatedAt,
      },
      ...(normalized.normalizationNotice
        ? { normalizationNotice: normalized.normalizationNotice }
        : {}),
    };
    MapDesignConversationRuntimeResponseSchema.parse(response);
    return response;
  }

  private replay(
    witness: RuntimeUpdateWitness,
    projectId: string,
    digest: string,
  ): MapDesignConversationRuntimeResponse {
    if (witness.projectId !== projectId || witness.requestDigest !== digest) {
      throw new MapDraftError('IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.');
    }
    try {
      const parsed = MapDesignConversationRuntimeResponseSchema.parse(JSON.parse(witness.responseJson));
      return {
        runtime: copyRuntimeChoice(parsed.runtime),
        effectiveRuntime: copyRuntimeChoice(parsed.effectiveRuntime),
        ...(parsed.normalizationNotice === undefined
          ? {}
          : { normalizationNotice: parsed.normalizationNotice }),
      };
    } catch {
      throw new MapDraftError('INTERNAL', 'The stored conversation runtime receipt is invalid.');
    }
  }
}

function copyRuntimeChoice(
  runtime: {
    agentId: string;
    model?: string | undefined;
    modelOrigin?: MapDesignConversationRuntimeChoice['modelOrigin'];
    reasoning?: string | undefined;
    serviceTier?: string | undefined;
    revision: number;
    updatedAt: string;
  },
): MapDesignConversationRuntimeChoice {
  return {
    agentId: runtime.agentId,
    ...(runtime.model === undefined ? {} : { model: runtime.model }),
    ...(runtime.model === undefined
      ? {}
      : { modelOrigin: runtime.modelOrigin ?? 'catalog' as const }),
    ...(runtime.reasoning === undefined ? {} : { reasoning: runtime.reasoning }),
    ...(runtime.serviceTier === undefined ? {} : { serviceTier: runtime.serviceTier }),
    revision: runtime.revision,
    updatedAt: runtime.updatedAt,
  };
}

function runtimeConflict(
  currentRuntime: MapDesignConversationRuntimeChoice,
  message: string,
  options: { retryable?: boolean; reason?: string } = {},
): MapDraftError {
  return new MapDraftError('RUNTIME_CONFLICT', message, {
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
    details: {
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      currentRuntime: {
        agentId: currentRuntime.agentId,
        ...(currentRuntime.model === undefined ? {} : { model: currentRuntime.model }),
        ...(currentRuntime.modelOrigin === undefined ? {} : { modelOrigin: currentRuntime.modelOrigin }),
        ...(currentRuntime.reasoning === undefined ? {} : { reasoning: currentRuntime.reasoning }),
        ...(currentRuntime.serviceTier === undefined ? {} : { serviceTier: currentRuntime.serviceTier }),
        revision: currentRuntime.revision,
        updatedAt: currentRuntime.updatedAt,
      },
    },
  });
}
