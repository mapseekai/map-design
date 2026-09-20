import type { MapAgentCapability, MapDesignRuntimeSelectionInput } from '@mapseekai/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  createMapDesignRuntimeCatalog,
  type RuntimeCatalogInspection,
} from '../../../src/map-design/application/runtime-catalog.js';
import { isMapDraftError } from '../../../src/map-design/application/errors.js';
import {
  deepseekHarnessAgentDef,
  parseDeepSeekHarnessVersion,
} from '../../../src/runtimes/defs/deepseek-harness.js';
import { ohMyPiAgentDef, parseOhMyPiModels } from '../../../src/runtimes/defs/oh-my-pi.js';
import { AGENT_DEFS } from '../../../src/runtimes/registry.js';
import type { RuntimeAgentDef, RuntimeModelOption } from '../../../src/runtimes/types.js';

const supported: MapAgentCapability = {
  nativeMapTools: true,
  publicReasoningSummary: true,
};

function definition(overrides: Partial<RuntimeAgentDef> & Pick<RuntimeAgentDef, 'id'>): RuntimeAgentDef {
  const { id, ...rest } = overrides;
  return {
    id,
    name: overrides.name ?? id,
    bin: overrides.bin ?? process.execPath,
    versionArgs: overrides.versionArgs ?? ['--version'],
    fallbackModels: overrides.fallbackModels ?? [{ id: 'default', label: 'Default' }],
    buildArgs: overrides.buildArgs ?? (() => []),
    streamFormat: overrides.streamFormat ?? 'test',
    mapDesign: overrides.mapDesign ?? {
      nativeToolAdapter: 'codex-app-server',
      publicReasoningSummary: true,
    },
    ...rest,
  };
}

function inspection(
  agent: RuntimeAgentDef,
  mapDesign: MapAgentCapability = supported,
): RuntimeCatalogInspection {
  return {
    definition: agent,
    available: true,
    executable: process.execPath,
    environment: { PATH: process.env.PATH ?? '' },
    mapDesign,
  };
}

describe('MapDesign runtime catalog', () => {
  it('prefers valid fresh models, merges fallback controls, and projects safe versions', async () => {
    const liveModels: RuntimeModelOption[] = [{
      id: 'openai/gpt-5.6-terra',
      label: 'GPT 5.6 Terra',
    }];
    const opencode = definition({
      id: 'opencode',
      fetchModels: async () => liveModels,
      fallbackModels: [{
        id: 'openai/gpt-5.6-terra',
        label: 'Static label',
        reasoningOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High', default: true }],
        serviceTierOptions: [{ id: 'priority', label: 'Priority', default: true }],
      }],
      supportsCustomModel: false,
    });
    const claude = definition({
      id: 'claude',
      mapDesign: {
        nativeToolAdapter: null,
        publicReasoningSummary: false,
        unsupportedReason: 'map-tools-policy-unsupported',
      },
    });
    const invalid = definition({
      id: 'invalid-live',
      fetchModels: async () => [{ id: '--unsafe', label: 'Unsafe' }],
      fallbackModels: [{ id: 'safe-fallback', label: 'Safe fallback' }],
    });
    const execFile = vi.fn(async () => ({ stdout: '2.4.1\n', stderr: '' }));
    const catalog = createMapDesignRuntimeCatalog({
      definitions: [opencode, claude, invalid],
      inspect: (agent) => inspection(
        agent,
        agent.id === 'claude'
          ? { nativeMapTools: false, publicReasoningSummary: false, reason: 'map-tools-policy-unsupported' }
          : supported,
      ),
      execFile,
    });

    await catalog.refresh();

    expect(catalog.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'opencode',
        version: '2.4.1',
        modelCatalogSource: 'live',
        supportsReasoning: true,
        supportsServiceTier: true,
        models: [expect.objectContaining({
          id: 'openai/gpt-5.6-terra',
          label: 'GPT 5.6 Terra',
          enabled: true,
          default: false,
          reasoningOptions: ['low', 'high'],
          serviceTierOptions: ['priority'],
          defaultReasoning: 'high',
          defaultServiceTier: 'priority',
        })],
      }),
      expect.objectContaining({
        id: 'claude',
        mapDesign: {
          nativeMapTools: false,
          publicReasoningSummary: false,
          reason: 'map-tools-policy-unsupported',
        },
      }),
      expect.objectContaining({
        id: 'invalid-live',
        modelCatalogSource: 'fallback',
        modelCatalogWarning: expect.stringMatching(/^Live model catalog unavailable.{1,200}$/u),
        models: [expect.objectContaining({ id: 'safe-fallback' })],
      }),
    ]));
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it('uses remembered live models after a failed refresh and keeps the prior snapshot while probing', async () => {
    let mode: 'live' | 'pending' | 'failed' = 'live';
    let releasePending: (() => void) | undefined;
    const fetchModels = vi.fn(async () => {
      if (mode === 'live') return [{ id: 'provider/live', label: 'Live' }];
      if (mode === 'pending') await new Promise<void>((resolve) => { releasePending = resolve; });
      return null;
    });
    const agent = definition({ id: 'remembered-agent', fetchModels });
    const catalog = createMapDesignRuntimeCatalog({
      definitions: [agent],
      inspect: (candidate) => inspection(candidate),
      execFile: async () => ({ stdout: '1.0.0', stderr: '' }),
    });
    await catalog.refresh();
    expect(catalog.list()[0]).toMatchObject({
      modelCatalogSource: 'live',
      models: [{ id: 'provider/live' }],
    });

    mode = 'pending';
    const firstRefresh = catalog.refresh();
    const secondRefresh = catalog.refresh();
    await vi.waitFor(() => expect(fetchModels).toHaveBeenCalledTimes(2));
    expect(catalog.list()[0]).toMatchObject({ modelCatalogSource: 'live' });
    releasePending?.();
    await Promise.all([firstRefresh, secondRefresh]);

    expect(catalog.list()[0]).toMatchObject({
      modelCatalogSource: 'remembered',
      modelCatalogWarning: expect.stringMatching(/^Live model catalog unavailable.{1,200}$/u),
      models: [{ id: 'provider/live' }],
    });
    expect(Object.isFrozen(catalog.list())).toBe(true);
    expect(Object.isFrozen(catalog.list()[0]?.models)).toBe(true);

    mode = 'failed';
    await catalog.refresh();
    expect(catalog.list()[0]?.modelCatalogSource).toBe('remembered');
  });

  it('shares strict Agent, custom-model, reasoning, and tier rules across validate and resolveChoice', () => {
    const strict = definition({
      id: 'strict-agent',
      supportsCustomModel: false,
      fallbackModels: [{
        id: 'provider/model',
        label: 'Model',
        default: true,
        reasoningOptions: [{ id: 'high', label: 'High' }],
        serviceTierOptions: [{ id: 'priority', label: 'Priority' }],
      }],
    });
    const custom = definition({ id: 'custom-agent', supportsCustomModel: true });
    const implicitCustom = definition({ id: 'implicit-custom-agent' });
    const unavailable = definition({ id: 'unavailable-agent' });
    const catalog = createMapDesignRuntimeCatalog({
      definitions: [strict, custom, implicitCustom, unavailable],
      inspect: (agent) => agent.id === 'unavailable-agent'
        ? {
            definition: agent,
            available: false,
            environment: {},
            mapDesign: { ...supported, nativeMapTools: false, reason: 'agent-unavailable' },
          }
        : inspection(agent),
      execFile: async () => ({ stdout: '1.0.0', stderr: '' }),
    });

    const valid: MapDesignRuntimeSelectionInput = {
      agentId: 'strict-agent',
      model: 'provider/model',
      modelOrigin: 'catalog',
      reasoning: 'high',
      serviceTier: 'priority',
    };
    expect(catalog.validate(valid)).toEqual(valid);
    expect(catalog.resolveChoice('strict-agent', valid)).toEqual({
      agentId: 'strict-agent',
      model: 'provider/model',
      modelOrigin: 'catalog',
      reasoning: 'high',
      serviceTier: 'priority',
      adapter: 'codex-app-server',
    });
    expect(catalog.resolveChoice('custom-agent', {
      agentId: 'custom-agent', model: 'provider/new-model:2026-09-02', modelOrigin: 'custom',
    })).toMatchObject({ model: 'provider/new-model:2026-09-02' });

    for (const input of [
      { ...valid, model: '--unsafe' },
      { ...valid, model: 'unknown/model' },
      { ...valid, reasoning: 'ultra' },
      { ...valid, serviceTier: 'batch' },
      { agentId: 'custom-agent', model: 'bad model' },
      { agentId: 'implicit-custom-agent', model: 'provider/unknown' },
      { agentId: 'unavailable-agent' },
    ] satisfies MapDesignRuntimeSelectionInput[]) {
      expect(() => catalog.validate(input)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }

    const normalized = catalog.resolveChoice('strict-agent', {
      agentId: 'strict-agent', model: 'retired/model',
    });
    expect(normalized).toMatchObject({
      model: 'provider/model',
      normalizationNotice: expect.stringMatching(/^The saved model.{1,200}$/u),
    });
    expect(() => catalog.resolveChoice('other-agent', valid)).toThrow();
    expect(isMapDraftError(expectInvalid(() => catalog.validate({ agentId: 'missing-agent' })))).toBe(true);
  });

  it('normalizes each removed saved dimension and applies refreshed catalogs to effective choices', async () => {
    let liveModels: RuntimeModelOption[] = [{
      id: 'provider/retired',
      label: 'Retired',
      default: true,
      reasoningOptions: [{ id: 'legacy', label: 'Legacy', default: true }],
      serviceTierOptions: [{ id: 'legacy-tier', label: 'Legacy tier', default: true }],
    }];
    const safe = definition({
      id: 'safe-agent',
      fetchModels: async () => liveModels,
      supportsCustomModel: false,
      fallbackModels: [{
        id: 'provider/current',
        label: 'Current',
        default: true,
        reasoningOptions: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High', default: true },
        ],
        serviceTierOptions: [
          { id: 'standard', label: 'Standard', default: true },
          { id: 'priority', label: 'Priority' },
        ],
      }],
    });
    const unavailable = definition({ id: 'retired-agent' });
    const catalog = createMapDesignRuntimeCatalog({
      definitions: [unavailable, safe],
      inspect: (agent) => agent.id === 'retired-agent'
        ? {
            definition: agent,
            available: false,
            environment: {},
            mapDesign: { nativeMapTools: false, publicReasoningSummary: false, reason: 'agent-unavailable' },
          }
        : inspection(agent),
      execFile: async () => ({ stdout: '1.0.0', stderr: '' }),
    });
    await catalog.refresh();
    expect(catalog.resolveChoice('safe-agent', {
      agentId: 'safe-agent',
      model: 'provider/retired',
      reasoning: 'legacy',
      serviceTier: 'legacy-tier',
    })).toMatchObject({ model: 'provider/retired', reasoning: 'legacy', serviceTier: 'legacy-tier' });

    liveModels = [{
      id: 'provider/current',
      label: 'Current live',
      default: true,
    }];
    await catalog.refresh();

    expect(catalog.resolveChoice('safe-agent', {
      agentId: 'safe-agent',
      model: 'provider/retired',
      reasoning: 'legacy',
      serviceTier: 'legacy-tier',
    })).toMatchObject({
      agentId: 'safe-agent',
      model: 'provider/current',
      reasoning: 'high',
      serviceTier: 'standard',
      normalizationNotice: expect.any(String),
    });
    expect(catalog.resolveChoice('safe-agent', {
      agentId: 'safe-agent',
      model: 'provider/current',
      reasoning: 'removed',
      serviceTier: 'removed',
    })).toMatchObject({
      reasoning: 'high',
      serviceTier: 'standard',
      normalizationNotice: expect.any(String),
    });
    expect(catalog.resolveChoice('retired-agent', {
      agentId: 'retired-agent',
      model: 'provider/retired',
    })).toMatchObject({
      agentId: 'safe-agent',
      model: 'provider/current',
      normalizationNotice: expect.any(String),
    });
    expect(() => catalog.validate({
      agentId: 'safe-agent', model: 'provider/current', reasoning: 'removed',
    })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('distinguishes retired catalog models from deliberate custom models across refresh', async () => {
    let liveModels: RuntimeModelOption[] = [{
      id: 'provider/retired', label: 'Retired', default: true,
    }];
    const definitionWithCustomModels = definition({
      id: 'custom-agent',
      supportsCustomModel: true,
      fetchModels: async () => liveModels,
      fallbackModels: [{ id: 'provider/current', label: 'Current', default: true }],
    });
    const catalog = createMapDesignRuntimeCatalog({
      definitions: [definitionWithCustomModels],
      inspect: inspection,
      execFile: async () => ({ stdout: '1.0.0', stderr: '' }),
    });
    await catalog.refresh();

    expect(catalog.list()[0]).toMatchObject({ supportsCustomModel: true });
    expect(catalog.validate({
      agentId: 'custom-agent', model: 'provider/retired', modelOrigin: 'catalog',
    })).toMatchObject({ modelOrigin: 'catalog' });

    liveModels = [{ id: 'provider/current', label: 'Current', default: true }];
    await catalog.refresh();

    expect(catalog.resolveChoice('custom-agent', {
      agentId: 'custom-agent', model: 'provider/retired', modelOrigin: 'catalog',
    })).toMatchObject({
      model: 'provider/current',
      modelOrigin: 'catalog',
      normalizationNotice: expect.any(String),
    });
    expect(catalog.resolveChoice('custom-agent', {
      agentId: 'custom-agent', model: 'provider/retired', modelOrigin: 'custom',
    })).toMatchObject({
      model: 'provider/retired',
      modelOrigin: 'custom',
    });
    expect(catalog.resolveChoice('custom-agent', {
      agentId: 'custom-agent', model: 'provider/retired',
    })).toMatchObject({
      model: 'provider/current',
      modelOrigin: 'catalog',
      normalizationNotice: expect.any(String),
    });
    expect(() => catalog.validate({
      agentId: 'custom-agent', model: 'bad model', modelOrigin: 'custom',
    })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('omits absolute executable paths and deterministically bounds public catalog arrays', async () => {
    const oversizedReasoning = Array.from({ length: 70 }, (_, index) => ({
      id: `reasoning-${index}`,
      label: `Reasoning ${index}`,
    }));
    const oversizedTiers = Array.from({ length: 70 }, (_, index) => ({
      id: `tier-${index}`,
      label: `Tier ${index}`,
    }));
    const oversizedModels = Array.from({ length: 1_030 }, (_, index) => ({
      id: `provider/model-${index}`,
      label: `Model ${index}`,
      reasoningOptions: oversizedReasoning,
      serviceTierOptions: oversizedTiers,
    }));
    const absoluteBin = '/private/operator/tools/local-profile-agent';
    const agent = definition({
      id: 'bounded-local-profile',
      bin: absoluteBin,
      fetchModels: async () => oversizedModels,
    });
    const catalog = createMapDesignRuntimeCatalog({
      definitions: [agent],
      inspect: (candidate) => ({
        ...inspection(candidate),
        executable: absoluteBin,
      }),
      execFile: async () => ({ stdout: '1.0.0', stderr: '' }),
    });

    await catalog.refresh();

    const projected = catalog.list()[0];
    expect(projected).toMatchObject({ modelCatalogSource: 'live' });
    expect(projected?.models).toHaveLength(1_024);
    expect(projected?.models?.[0]).toMatchObject({
      id: 'provider/model-0',
      reasoningOptions: expect.arrayContaining(['reasoning-0', 'reasoning-63']),
      serviceTierOptions: expect.arrayContaining(['tier-0', 'tier-63']),
    });
    expect(projected?.models?.[0]?.reasoningOptions).toHaveLength(64);
    expect(projected?.models?.[0]?.serviceTierOptions).toHaveLength(64);
    expect(projected?.models?.at(-1)?.id).toBe('provider/model-1023');
    expect(projected).not.toHaveProperty('executable');
    expect(JSON.stringify(projected)).not.toContain(absoluteBin);
  });

  it('keeps every registered Agent visible and declares the new adapter transports exactly', () => {
    const catalog = createMapDesignRuntimeCatalog({
      definitions: AGENT_DEFS,
      inspect: (agent) => inspection(agent, {
        nativeMapTools: false,
        publicReasoningSummary: agent.mapDesign?.publicReasoningSummary === true,
        ...(agent.mapDesign?.unsupportedReason
          ? { reason: agent.mapDesign.unsupportedReason }
          : { reason: 'native-tools-unavailable' as const }),
      }),
      execFile: async () => ({ stdout: '1.0.0', stderr: '' }),
    });

    expect(catalog.list().map((agent) => agent.id)).toEqual(AGENT_DEFS.map((agent) => agent.id));
    expect(catalog.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'oh-my-pi' }),
      expect.objectContaining({ id: 'deepseek-harness' }),
    ]));
    expect(ohMyPiAgentDef.mapDesign.nativeToolAdapter).toBe('omp-rpc');
    expect(ohMyPiAgentDef.listModels.args).toEqual(['models', 'ls']);
    expect(ohMyPiAgentDef.buildArgs()).toEqual(['--mode', 'rpc']);
    expect(deepseekHarnessAgentDef.mapDesign.nativeToolAdapter).toBe('deepseek-profile');
    expect(deepseekHarnessAgentDef.buildArgs()).toEqual(['--profile', 'map-design', '--stdio']);
  });

  it('parses Oh My Pi and MapDesign DeepSeek profile model metadata', () => {
    expect(parseDeepSeekHarnessVersion('v0.1.1-rc.2\n')).toBe('0.1.1-rc.2');
    expect(parseDeepSeekHarnessVersion('DeepSeek Harness dev')).toBeNull();
    expect(parseOhMyPiModels(`anthropic (1)\n┌───────┬─────────┬─────────┬──────────┬────────┐\n│ model │ context │ max-out │ thinking │ images │\n├───────┼─────────┼─────────┼──────────┼────────┤\n│ opus  │ 200K    │ 32K     │ low,high │ yes    │\n└───────┴─────────┴─────────┴──────────┴────────┘`)).toEqual([
      expect.objectContaining({ id: 'default' }),
      expect.objectContaining({
        id: 'anthropic/opus',
        reasoningOptions: [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }],
      }),
    ]);
    expect(deepseekHarnessAgentDef.listModels.parse(JSON.stringify({
      v: 1,
      type: 'models',
      runtime: 'map-design',
      models: [{
        provider: 'deepseek', provider_name: 'DeepSeek', id: 'reasoner', name: 'Reasoner',
        reasoning_options: [{ id: 'high', name: 'High', default: true }],
      }],
    }))).toEqual([
      expect.objectContaining({ id: 'default' }),
      expect.objectContaining({
        id: 'deepseek/reasoner',
        reasoningOptions: [{ id: 'high', label: 'High', default: true }],
      }),
    ]);
  });
});

function expectInvalid(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected action to throw.');
}
