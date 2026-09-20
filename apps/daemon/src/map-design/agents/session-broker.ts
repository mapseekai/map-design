import type { MapDesignLocalStore } from '../storage/local-store.js';

export interface MapAgentSessionScope {
  projectId: string;
  conversationId: string;
  agentId: string;
  model: string | null;
  cwd: string;
}

export interface MapAgentSessionBroker {
  load(scope: MapAgentSessionScope): string | null;
  save(scope: MapAgentSessionScope, sessionId: string): void;
  delete(scope: MapAgentSessionScope): void;
}

type MemorySession = {
  projectId: string;
  model: string | null;
  cwd: string;
  sessionId: string;
};

export function createMapAgentSessionBroker(
  store: Pick<
    MapDesignLocalStore,
    'getConversation' | 'getAgentSession' | 'upsertAgentSession' | 'deleteAgentSession'
  >,
  now: () => string = () => new Date().toISOString(),
): MapAgentSessionBroker {
  const ownsConversation = (scope: MapAgentSessionScope): boolean => (
    validScope(scope)
    && store.getConversation(scope.conversationId)?.projectId === scope.projectId
  );
  const remove = (scope: MapAgentSessionScope): void => {
    if (!ownsConversation(scope)) return;
    store.deleteAgentSession(scope.conversationId, scope.agentId);
  };
  return {
    load(scope) {
      if (!ownsConversation(scope)) return null;
      const stored = store.getAgentSession(scope.conversationId, scope.agentId);
      if (!stored) return null;
      if (
        stored.conversationId !== scope.conversationId
        || stored.agentId !== scope.agentId
        || stored.model !== scope.model
        || stored.cwd !== scope.cwd
        || !validSessionId(stored.sessionId)
      ) {
        store.deleteAgentSession(scope.conversationId, scope.agentId);
        return null;
      }
      return stored.sessionId;
    },
    save(scope, sessionId) {
      if (!ownsConversation(scope)) return;
      if (!validSessionId(sessionId)) {
        store.deleteAgentSession(scope.conversationId, scope.agentId);
        return;
      }
      store.upsertAgentSession({
        conversationId: scope.conversationId,
        agentId: scope.agentId,
        sessionId,
        stablePromptHash: null,
        model: scope.model,
        cwd: scope.cwd,
        lastMessageId: null,
        updatedAt: now(),
      });
    },
    delete: remove,
  };
}

export function createMemoryMapAgentSessionBroker(): MapAgentSessionBroker {
  const sessions = new Map<string, MemorySession>();
  const key = (scope: MapAgentSessionScope) => (
    `${scope.projectId}\u0000${scope.conversationId}\u0000${scope.agentId}`
  );
  return {
    load(scope) {
      if (!validScope(scope)) return null;
      const stored = sessions.get(key(scope));
      if (!stored) return null;
      if (stored.model !== scope.model || stored.cwd !== scope.cwd || !validSessionId(stored.sessionId)) {
        sessions.delete(key(scope));
        return null;
      }
      return stored.sessionId;
    },
    save(scope, sessionId) {
      if (!validScope(scope) || !validSessionId(sessionId)) {
        if (validScope(scope)) sessions.delete(key(scope));
        return;
      }
      sessions.set(key(scope), {
        projectId: scope.projectId,
        model: scope.model,
        cwd: scope.cwd,
        sessionId,
      });
    },
    delete(scope) {
      if (validScope(scope)) sessions.delete(key(scope));
    },
  };
}

export function mapAgentSessionScope(
  input: Pick<MapAgentSessionScope, 'projectId' | 'conversationId' | 'model' | 'cwd'>,
  agentId: string,
): MapAgentSessionScope {
  return {
    projectId: input.projectId,
    conversationId: input.conversationId,
    agentId,
    model: input.model,
    cwd: input.cwd,
  };
}

function validScope(scope: MapAgentSessionScope): boolean {
  return validIdentifier(scope.projectId)
    && validIdentifier(scope.conversationId)
    && validIdentifier(scope.agentId)
    && (scope.model === null || validIdentifier(scope.model))
    && typeof scope.cwd === 'string'
    && scope.cwd.length > 0
    && scope.cwd.length <= 4_096
    && !/\p{Cc}/u.test(scope.cwd);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/\s|\p{Cc}/u.test(value);
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4_096
    && !/\p{Cc}/u.test(value);
}
