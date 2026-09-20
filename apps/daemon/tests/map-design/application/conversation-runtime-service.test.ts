import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { MapDesignConversationRuntimeService, type ConversationRuntimeChoicePolicy } from '../../../src/map-design/application/conversation-runtime-service.js';
import { closeMapDesignDatabase, openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';

const roots: Array<{ db: Database.Database; root: string }> = [];
const NOW = '2026-09-02T00:00:00.000Z';

const choicePolicy: ConversationRuntimeChoicePolicy = {
  validate(input) {
    if (!['codex', 'opencode', 'pi'].includes(input.agentId)) throw new Error('unsupported runtime');
    return input;
  },
  normalizeSaved(input) {
    return { runtime: input };
  },
};

function setup(options: { running?: boolean; policy?: ConversationRuntimeChoicePolicy } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'map-conversation-runtime-'));
  const db = openMapDesignDatabase(root);
  const store = createMapDesignLocalStore(db);
  store.createProject({
    project: { projectId: 'project-1', title: 'Map', runtime: { agentId: 'codex', model: 'openai/gpt-5.6-terra' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Keep labels clear', idempotencyKey: 'project-key-1' },
    primaryConversationId: 'conversation-1', verifiedWorkingDirectory: null,
  });
  db.prepare(`INSERT INTO map_design_projects (project_id, lifecycle_state, design_system_id, design_system_digest, draft_revision, created_at, updated_at)
    VALUES (?, 'importing', 'quiet-walking', ?, 0, ?, ?)`).run('project-1', 'a'.repeat(64), NOW, NOW);
  roots.push({ db, root });
  return {
    db, store,
    service: new MapDesignConversationRuntimeService({
      store, policy: options.policy ?? choicePolicy, isProjectRunning: () => options.running ?? false, now: () => NOW,
    }),
  };
}

afterEach(() => {
  for (const { db, root } of roots.splice(0)) {
    closeMapDesignDatabase(db);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('MapDesignConversationRuntimeService', () => {
  it('reads an inherited project runtime and updates it once with a CAS revision', () => {
    const { service } = setup();
    const inherited = {
      agentId: 'codex', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog' as const,
      revision: 0, updatedAt: expect.any(String),
    };
    expect(service.get('project-1', 'conversation-1')).toEqual({
      runtime: inherited,
      effectiveRuntime: inherited,
    });

    const updated = service.update('project-1', 'conversation-1', {
      expectedRevision: 0, clientRequestId: 'runtime-update-1',
      runtime: { agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog' },
    });
    expect(updated).toEqual({
      runtime: { agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 1, updatedAt: NOW },
      effectiveRuntime: { agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 1, updatedAt: NOW },
    });
    expect(service.requireCurrent('project-1', 'conversation-1', 1)).toEqual(updated.runtime);
  });

  it('returns a normalized effective choice without mutating stored CAS state', () => {
    const policy: ConversationRuntimeChoicePolicy = {
      validate: choicePolicy.validate,
      normalizeSaved: () => ({
        runtime: { agentId: 'opencode', model: 'openai/gpt-5.6-luna' },
        normalizationNotice: 'The saved runtime is no longer selectable; a safe current choice was selected.',
      }),
    };
    const { service, store } = setup({ policy });

    const response = service.get('project-1', 'conversation-1');

    expect(response).toEqual({
      runtime: {
        agentId: 'codex', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 0, updatedAt: expect.any(String),
      },
      effectiveRuntime: {
        agentId: 'opencode', model: 'openai/gpt-5.6-luna', modelOrigin: 'catalog', revision: 0, updatedAt: expect.any(String),
      },
      normalizationNotice: 'The saved runtime is no longer selectable; a safe current choice was selected.',
    });
    expect(service.requireCurrent('project-1', 'conversation-1', 0)).toMatchObject({
      agentId: 'codex', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 0,
    });
    expect(store.getConversationRuntime('conversation-1')).toMatchObject({
      agentId: 'codex', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 0,
    });
  });

  it('defaults legacy stored models to catalog origin and persists deliberate custom origin through CAS', () => {
    const { service, store } = setup();

    expect(service.get('project-1', 'conversation-1').runtime).toMatchObject({
      model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 0,
    });
    const updated = service.update('project-1', 'conversation-1', {
      expectedRevision: 0,
      clientRequestId: 'runtime-custom-origin',
      runtime: { agentId: 'opencode', model: 'provider/deliberate', modelOrigin: 'custom' },
    });

    expect(updated.runtime).toMatchObject({
      model: 'provider/deliberate', modelOrigin: 'custom', revision: 1,
    });
    expect(store.getConversationRuntime('conversation-1')).toMatchObject({
      model: 'provider/deliberate', modelOrigin: 'custom', revision: 1,
    });
    expect(() => service.update('project-1', 'conversation-1', {
      expectedRevision: 0,
      clientRequestId: 'runtime-custom-conflict',
      runtime: { agentId: 'opencode', model: 'provider/other', modelOrigin: 'custom' },
    })).toThrow(expect.objectContaining({
      code: 'RUNTIME_CONFLICT',
      details: { currentRuntime: expect.objectContaining({ modelOrigin: 'custom' }) },
    }));
  });

  it('replays an identical runtime update but rejects stale or changed requests', () => {
    const { service } = setup();
    const request = {
      expectedRevision: 0, clientRequestId: 'runtime-update-1',
      runtime: { agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog' as const },
    };
    const updated = service.update('project-1', 'conversation-1', request);
    expect(service.update('project-1', 'conversation-1', request)).toEqual(updated);
    expect(() => service.update('project-1', 'conversation-1', {
      expectedRevision: 0, clientRequestId: 'runtime-update-2', runtime: { agentId: 'pi' },
    })).toThrow(expect.objectContaining({
      code: 'RUNTIME_CONFLICT',
      details: {
        currentRuntime: {
          agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 1, updatedAt: NOW,
        },
      },
    }));
    expect(() => service.update('project-1', 'conversation-1', {
      expectedRevision: 1, clientRequestId: 'runtime-update-1', runtime: { agentId: 'pi' },
    })).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(() => service.requireCurrent('project-1', 'conversation-1', 0))
      .toThrow(expect.objectContaining({
        code: 'RUNTIME_CONFLICT',
        details: {
          currentRuntime: {
            agentId: 'opencode', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 1, updatedAt: NOW,
          },
        },
      }));
  });

  it('does not expose cross-project runtime choices and rejects active project updates before validation', () => {
    const { db, store, service } = setup({ running: true });
    store.createProject({
      project: { projectId: 'project-2', title: 'Other', runtime: { agentId: 'pi' }, source: { url: 'https://example.com/other.json' }, designRequirement: 'Other map', idempotencyKey: 'project-key-2' },
      primaryConversationId: 'conversation-2', verifiedWorkingDirectory: null,
    });
    db.prepare(`INSERT INTO map_design_projects (project_id, lifecycle_state, design_system_id, design_system_digest, draft_revision, created_at, updated_at)
      VALUES (?, 'importing', 'quiet-walking', ?, 0, ?, ?)`).run('project-2', 'b'.repeat(64), NOW, NOW);

    expect(() => service.get('project-1', 'conversation-2')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => service.update('project-1', 'conversation-1', {
      expectedRevision: 0, clientRequestId: 'runtime-update-1', runtime: { agentId: 'unsupported' },
    })).toThrow(expect.objectContaining({
      code: 'RUNTIME_CONFLICT',
      details: { reason: 'ACTIVE_RUN', currentRuntime: { agentId: 'codex', model: 'openai/gpt-5.6-terra', modelOrigin: 'catalog', revision: 0, updatedAt: expect.any(String) } },
    }));

    const { service: idleService } = setup();
    expect(() => idleService.update('project-1', 'conversation-1', {
      expectedRevision: 0, clientRequestId: 'runtime-update-2', runtime: { agentId: 'unsupported' },
    })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});
