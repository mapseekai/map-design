import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createMapAgentSessionBroker,
} from '../../../src/map-design/agents/session-broker.js';
import {
  closeMapDesignDatabase,
  openMapDesignDatabase,
} from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'map-agent-session-broker-'));
  roots.push(value);
  return value;
}

function seedProject(store: ReturnType<typeof createMapDesignLocalStore>): void {
  store.createProject({
    project: {
      projectId: 'project-1',
      title: 'Map',
      runtime: { agentId: 'codex' },
      source: { url: 'https://example.com/style.json' },
      designRequirement: 'Keep labels readable',
      idempotencyKey: 'project-key-1',
    },
    primaryConversationId: 'conversation-1',
    verifiedWorkingDirectory: '/safe/project',
  });
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('MapAgentSessionBroker', () => {
  it('lazily resumes a validated handle after a real SQLite daemon restart', () => {
    const dataRoot = root();
    const firstDatabase = openMapDesignDatabase(dataRoot);
    const firstStore = createMapDesignLocalStore(firstDatabase);
    seedProject(firstStore);
    const firstBroker = createMapAgentSessionBroker(firstStore, () => '2026-09-03T00:00:00.000Z');
    const scope = {
      projectId: 'project-1',
      conversationId: 'conversation-1',
      agentId: 'codex',
      model: 'gpt-5.5',
      cwd: '/safe/project',
    };
    firstBroker.save(scope, 'thread-validated');
    closeMapDesignDatabase(firstDatabase);

    const restartedDatabase = openMapDesignDatabase(dataRoot);
    try {
      const restartedStore = createMapDesignLocalStore(restartedDatabase);
      const restartedBroker = createMapAgentSessionBroker(restartedStore);
      expect(restartedBroker.load(scope)).toBe('thread-validated');
      expect(restartedStore.getAgentSession('conversation-1', 'codex')).toMatchObject({
        sessionId: 'thread-validated',
        model: 'gpt-5.5',
        cwd: '/safe/project',
      });
    } finally {
      closeMapDesignDatabase(restartedDatabase);
    }
  });

  it('deletes malformed or metadata-mismatched handles without crossing project authority', () => {
    const dataRoot = root();
    const database = openMapDesignDatabase(dataRoot);
    try {
      const store = createMapDesignLocalStore(database);
      seedProject(store);
      const broker = createMapAgentSessionBroker(store);
      const scope = {
        projectId: 'project-1',
        conversationId: 'conversation-1',
        agentId: 'pi',
        model: 'provider/model',
        cwd: '/safe/project',
      };

      broker.save(scope, 'session\nmalformed');
      expect(store.getAgentSession('conversation-1', 'pi')).toBeNull();

      broker.save(scope, '/safe/sessions/pi.jsonl');
      expect(broker.load({ ...scope, projectId: 'foreign-project' })).toBeNull();
      expect(store.getAgentSession('conversation-1', 'pi')).not.toBeNull();

      expect(broker.load({ ...scope, model: 'provider/replacement' })).toBeNull();
      expect(store.getAgentSession('conversation-1', 'pi')).toBeNull();
    } finally {
      closeMapDesignDatabase(database);
    }
  });
});
