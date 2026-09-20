import { describe, expect, it } from 'vitest';

import { aiderAgentDef } from '../../../src/runtimes/defs/aider.js';
import { ampAgentDef } from '../../../src/runtimes/defs/amp.js';
import { antigravityAgentDef } from '../../../src/runtimes/defs/antigravity.js';
import { atomcodeAgentDef } from '../../../src/runtimes/defs/atomcode.js';
import { byokOpenCodeAgentDef } from '../../../src/runtimes/defs/byok-opencode.js';
import { claudeAgentDef } from '../../../src/runtimes/defs/claude.js';
import { codebuddyAgentDef } from '../../../src/runtimes/defs/codebuddy.js';
import { codexAgentDef } from '../../../src/runtimes/defs/codex.js';
import { copilotAgentDef } from '../../../src/runtimes/defs/copilot.js';
import { cursorAgentDef } from '../../../src/runtimes/defs/cursor-agent.js';
import { deepseekAgentDef } from '../../../src/runtimes/defs/deepseek.js';
import { deepseekHarnessAgentDef } from '../../../src/runtimes/defs/deepseek-harness.js';
import { devinAgentDef } from '../../../src/runtimes/defs/devin.js';
import { grokBuildAgentDef } from '../../../src/runtimes/defs/grok-build.js';
import { hermesAgentDef } from '../../../src/runtimes/defs/hermes.js';
import { kiloAgentDef } from '../../../src/runtimes/defs/kilo.js';
import { kimiAgentDef } from '../../../src/runtimes/defs/kimi.js';
import { kiroAgentDef } from '../../../src/runtimes/defs/kiro.js';
import { mimoAgentDef } from '../../../src/runtimes/defs/mimo.js';
import { opencodeAgentDef } from '../../../src/runtimes/defs/opencode.js';
import { ohMyPiAgentDef } from '../../../src/runtimes/defs/oh-my-pi.js';
import { piAgentDef } from '../../../src/runtimes/defs/pi.js';
import { qoderAgentDef } from '../../../src/runtimes/defs/qoder.js';
import { qwenAgentDef } from '../../../src/runtimes/defs/qwen.js';
import { reasonixAgentDef } from '../../../src/runtimes/defs/reasonix.js';
import { traeCliAgentDef } from '../../../src/runtimes/defs/trae-cli.js';
import { vibeAgentDef } from '../../../src/runtimes/defs/vibe.js';
import {
  createMapAgentAdapterRegistry,
  type MapAgentAdapterFactories,
  type MapAgentAdapterRegistry,
} from '../../../src/map-design/agents/registry.js';
import type {
  MapAgentAdapter,
  MapAgentEvent,
  MapRunInput,
} from '../../../src/map-design/agents/types.js';
import type { RuntimeAgentDef } from '../../../src/runtimes/types.js';

const RUNTIME_DEFINITIONS = [
  aiderAgentDef,
  ampAgentDef,
  antigravityAgentDef,
  atomcodeAgentDef,
  byokOpenCodeAgentDef,
  claudeAgentDef,
  codebuddyAgentDef,
  codexAgentDef,
  copilotAgentDef,
  cursorAgentDef,
  deepseekAgentDef,
  deepseekHarnessAgentDef,
  devinAgentDef,
  grokBuildAgentDef,
  hermesAgentDef,
  kiloAgentDef,
  kimiAgentDef,
  kiroAgentDef,
  mimoAgentDef,
  opencodeAgentDef,
  ohMyPiAgentDef,
  piAgentDef,
  qoderAgentDef,
  qwenAgentDef,
  reasonixAgentDef,
  traeCliAgentDef,
  vibeAgentDef,
] as const;

function definition(
  id: string,
  mapDesign: NonNullable<RuntimeAgentDef['mapDesign']>,
): RuntimeAgentDef {
  return {
    id,
    name: id,
    bin: process.execPath,
    versionArgs: ['--version'],
    fallbackModels: [],
    buildArgs: () => [],
    streamFormat: 'test',
    mapDesign,
  };
}

function runInput(): MapRunInput {
  return {
    runId: 'run-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    prompt: 'Inspect the map.',
    resumePrompt: 'Inspect the map.',
    cwd: '/safe/project',
    model: null,
    reasoning: null,
    serviceTier: null,
    toolRuntime: {
      execute: async (call) => ({
        ok: false,
        toolUseId: call.toolUseId,
        error: { code: 'UNKNOWN_TOOL', message: 'The map tool call is not registered.', retryable: false },
      }),
      closeRun: () => undefined,
    },
    toolCallback: {
      url: 'http://127.0.0.1:8787/api/map-design/tools',
      token: 'test-only-token',
      close: () => undefined,
    },
    signal: new AbortController().signal,
  };
}

describe('Map Agent adapter registry', () => {
  it('requires an explicit MapDesign declaration on every shipped runtime definition', () => {
    expect(RUNTIME_DEFINITIONS).toHaveLength(27);
    for (const agent of RUNTIME_DEFINITIONS) {
      expect(agent).toMatchObject({
        mapDesign: {
          publicReasoningSummary: expect.any(Boolean),
        },
      });
      expect(agent.mapDesign).toHaveProperty('nativeToolAdapter');
      expect(['codex-app-server', 'omp-rpc', 'pi-sdk', 'opencode-plugin', 'deepseek-profile', null])
        .toContain(agent.mapDesign.nativeToolAdapter);
    }
  });

  it('declares the approved native Map adapter kind for each first-release runtime', () => {
    const nativeAdapters = RUNTIME_DEFINITIONS
      .filter((agent) => agent.mapDesign?.nativeToolAdapter !== null)
      .map((agent) => ({
        id: agent.id,
        nativeToolAdapter: agent.mapDesign?.nativeToolAdapter,
      }));

    expect(nativeAdapters).toEqual([
      { id: 'codex', nativeToolAdapter: 'codex-app-server' },
      { id: 'deepseek-harness', nativeToolAdapter: 'deepseek-profile' },
      { id: 'opencode', nativeToolAdapter: 'opencode-plugin' },
      { id: 'oh-my-pi', nativeToolAdapter: 'omp-rpc' },
      { id: 'pi', nativeToolAdapter: 'pi-sdk' },
    ]);
  });

  it('does not infer native Map tools from an adapter-looking Agent id', () => {
    const registry = createMapAgentAdapterRegistry();
    const agent = definition('codex-app-server-native', {
      nativeToolAdapter: null,
      publicReasoningSummary: false,
    });

    expect(registry.get(agent)).toBeNull();
    expect(registry.capability(agent, true)).toEqual({
      nativeMapTools: false,
      publicReasoningSummary: false,
      reason: 'native-tools-unavailable',
    });
  });

  it('keeps a declared adapter unsupported until a concrete factory is registered', () => {
    const registry = createMapAgentAdapterRegistry();
    const agent = definition('codex', {
      nativeToolAdapter: 'codex-app-server',
      publicReasoningSummary: true,
    });

    expect(registry.get(agent)).toBeNull();
    expect(registry.capability(agent, true)).toEqual({
      nativeMapTools: false,
      publicReasoningSummary: true,
      reason: 'native-tools-unavailable',
    });
  });

  it('reports native support only for a registered host-callable adapter path', async () => {
    const adapter: MapAgentAdapter = {
      id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      async startMapRun(_input, tools, onEvent) {
        onEvent({
          kind: 'tool_use',
          id: 'tool-1',
          name: tools[0]!.name,
          summary: { registered: true },
        });
        return {
          done: Promise.resolve({ status: 'succeeded' }),
          cancel: async () => undefined,
        };
      },
    };
    const registry: MapAgentAdapterRegistry = createMapAgentAdapterRegistry({
      'codex-app-server': () => adapter,
    });
    const agent = definition('codex', {
      nativeToolAdapter: 'codex-app-server',
      publicReasoningSummary: true,
    });
    const events: MapAgentEvent[] = [];
    const resolved = registry.get(agent);

    const handle = await resolved!.startMapRun(runInput(), [{
      name: 'map_inspect',
      description: 'Inspect the current map.',
      inputSchema: { type: 'object' },
    }], (event) => events.push(event));

    expect(await handle.done).toEqual({ status: 'succeeded' });
    expect(events).toEqual([{
      kind: 'tool_use',
      id: 'tool-1',
      name: 'map_inspect',
      summary: { registered: true },
    }]);
    expect(registry.capability(agent, true)).toEqual({
      nativeMapTools: true,
      publicReasoningSummary: true,
    });
  });

  it('reports an unavailable executable without exposing adapter internals', () => {
    const registry = createMapAgentAdapterRegistry({
      'omp-rpc': () => ({
        id: 'oh-my-pi',
        capabilities: { nativeMapTools: true, publicReasoningSummary: true },
        startMapRun: async () => ({
          done: Promise.resolve({ status: 'succeeded' }),
          cancel: async () => undefined,
        }),
      }),
    });
    const agent = definition('oh-my-pi', {
      nativeToolAdapter: 'omp-rpc',
      publicReasoningSummary: true,
    });

    expect(registry.capability(agent, false)).toEqual({
      nativeMapTools: false,
      publicReasoningSummary: true,
      reason: 'agent-unavailable',
    });
  });

  it('routes the declared OMP adapter kind through a concrete factory only for Oh My Pi', () => {
    const factories: MapAgentAdapterFactories = {
      'omp-rpc': (agent) => agent.id === 'oh-my-pi'
        ? {
            id: agent.id,
            capabilities: { nativeMapTools: true, publicReasoningSummary: true },
            startMapRun: async () => ({ done: Promise.resolve({ status: 'succeeded' }), cancel: async () => undefined }),
          }
        : null,
    };
    const registry = createMapAgentAdapterRegistry(factories);

    expect(registry.get(ohMyPiAgentDef)).toMatchObject({ id: 'oh-my-pi' });
    expect(registry.get(definition('not-omp', {
      nativeToolAdapter: 'omp-rpc',
      publicReasoningSummary: true,
    }))).toBeNull();
  });

  it('routes the declared Pi adapter kind through a concrete factory only for Pi', () => {
    const factories: MapAgentAdapterFactories = {
      'pi-sdk': (agent) => agent.id === 'pi'
        ? {
            id: agent.id,
            capabilities: { nativeMapTools: true, publicReasoningSummary: false },
            startMapRun: async () => ({ done: Promise.resolve({ status: 'succeeded' }), cancel: async () => undefined }),
          }
        : null,
    };
    const registry = createMapAgentAdapterRegistry(factories);

    expect(registry.get(piAgentDef)).toMatchObject({ id: 'pi' });
    expect(registry.get(definition('not-pi', {
      nativeToolAdapter: 'pi-sdk',
      publicReasoningSummary: false,
    }))).toBeNull();
  });
});
