import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  AgentModelCatalogSourceSchema,
  LocalAgentInfoSchema,
  type AgentModelCatalogSource,
  type LocalAgentInfo,
} from '../src/index.js';

describe('MapDesign agent catalog contracts', () => {
  // Mutation caught: allowing a daemon to publish a model catalog without its availability/default selection metadata.
  it('accepts a bounded agent model catalog with its explicit source', () => {
    const agent = {
      id: 'opencode',
      label: 'OpenCode',
      available: true,
      mapDesign: { nativeMapTools: true, publicReasoningSummary: true },
      models: [{
        id: 'openai/gpt-5.6-terra',
        label: 'GPT-5.6 Terra',
        enabled: true,
        default: true,
        reasoningOptions: ['low', 'high'],
        serviceTierOptions: ['standard', 'priority'],
        defaultReasoning: 'high',
        defaultServiceTier: 'standard',
      }],
      supportsCustomModel: true,
      modelCatalogSource: 'live',
    } satisfies LocalAgentInfo;

    expect(LocalAgentInfoSchema.parse(agent)).toEqual(agent);
    expect(LocalAgentInfoSchema.parse({ ...agent, modelCatalogSource: 'configured' }).modelCatalogSource).toBe('configured');
    expect(() => LocalAgentInfoSchema.parse({ ...agent, supportsCustomModel: 'yes' })).toThrow();
    expect(AgentModelCatalogSourceSchema.options).toEqual(['live', 'remembered', 'fallback', 'configured']);
    expectTypeOf<AgentModelCatalogSource>().toEqualTypeOf<'live' | 'remembered' | 'fallback' | 'configured'>();
  });

  // Mutation caught: accepting an unrecognized model-catalog provenance or unbounded warning from an unavailable runtime.
  it('rejects unsupported catalog sources and unknown catalog fields', () => {
    const agent = {
      id: 'opencode',
      label: 'OpenCode',
      available: false,
      mapDesign: { nativeMapTools: false, publicReasoningSummary: false, reason: 'model-catalog-unavailable' },
      models: [],
      modelCatalogSource: 'fallback',
      modelCatalogWarning: 'The live catalog is temporarily unavailable.',
    };

    expect(LocalAgentInfoSchema.parse(agent)).toEqual(agent);
    expect(LocalAgentInfoSchema.parse({ ...agent, modelCatalogSource: 'configured' }).modelCatalogSource).toBe('configured');
    expect(() => LocalAgentInfoSchema.parse({ ...agent, modelCatalogSource: 'cached' })).toThrow();
    expect(() => LocalAgentInfoSchema.parse({ ...agent, internalPath: '/private/catalog.json' })).toThrow();
  });
});
