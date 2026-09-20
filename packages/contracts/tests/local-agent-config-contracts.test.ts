import { describe, expect, it } from 'vitest';
import type {
  AgentCliEnvIntentPrefs,
  AgentModelPrefs,
  ByokProtocol,
  ByokProviderSelection,
  LocalAgentInfo,
  LocalAgentListResponse,
  LocalAgentModelOption,
  MapDesignAppConfig,
  MapDesignAppConfigResponse,
  UpdateMapDesignAppConfigRequest,
} from '../src/index';

type Equal<Actual, Expected> = (
  <Value>() => Value extends Actual ? 1 : 2
) extends <Value>() => Value extends Expected ? 1 : 2
  ? (<Value>() => Value extends Expected ? 1 : 2) extends <Value>() => Value extends Actual ? 1 : 2
    ? true
    : false
  : false;
type Expect<T extends true> = T;
type ExactKeys<Shape, Keys extends PropertyKey> = Equal<keyof Shape, Keys>;

type _LocalAgentModelOptionKeys = Expect<
  ExactKeys<
    LocalAgentModelOption,
    | 'id'
    | 'label'
    | 'description'
    | 'enabled'
    | 'default'
    | 'reasoningOptions'
    | 'serviceTierOptions'
    | 'defaultReasoning'
    | 'defaultServiceTier'
  >
>;
type _LocalAgentInfoKeys = Expect<
  ExactKeys<
    LocalAgentInfo,
    | 'id'
    | 'label'
    | 'available'
    | 'executable'
    | 'version'
    | 'models'
    | 'supportsReasoning'
    | 'supportsServiceTier'
    | 'supportsCustomModel'
    | 'mapDesign'
    | 'modelCatalogSource'
    | 'modelCatalogWarning'
  >
>;
type _LocalAgentListResponseKeys = Expect<ExactKeys<LocalAgentListResponse, 'agents'>>;
type _AgentModelPrefsKeys = Expect<
  ExactKeys<AgentModelPrefs, 'model' | 'reasoning' | 'serviceTier'>
>;
type _AgentCliEnvIntentEntryKeys = Expect<
  ExactKeys<AgentCliEnvIntentPrefs[string], 'apiKeyOverride'>
>;
type _ByokProviderSelectionKeys = Expect<
  ExactKeys<
    ByokProviderSelection,
    'protocol' | 'apiKey' | 'baseUrl' | 'apiVersion' | 'apiFormat' | 'model' | 'requiresApiKey'
  >
>;
type _ByokProtocolValues = Expect<
  Equal<ByokProtocol, 'anthropic' | 'openai' | 'azure' | 'google' | 'ollama' | 'aihubmix'>
>;
type _MapDesignAppConfigKeys = Expect<
  ExactKeys<
    MapDesignAppConfig,
    | 'agentId'
    | 'agentModels'
    | 'agentCliEnv'
    | 'agentCliEnvIntent'
    | 'byokProviders'
    | 'customInstructions'
    | 'recentLinkedDirs'
  >
>;
type _MapDesignAppConfigResponseKeys = Expect<
  ExactKeys<MapDesignAppConfigResponse, 'config'>
>;
type _UpdateMapDesignAppConfigRequestKeys = Expect<
  ExactKeys<
    UpdateMapDesignAppConfigRequest,
    | 'agentId'
    | 'agentModels'
    | 'agentCliEnv'
    | 'agentCliEnvIntent'
    | 'byokProviders'
    | 'customInstructions'
    | 'recentLinkedDirs'
  >
>;

describe('local MapDesign agent contracts', () => {
  it('retains only installed local agent discovery fields', () => {
    const agent = {
      id: 'claude',
      label: 'Claude Code',
      available: true,
      executable: 'claude',
      version: '1.0.0',
      models: [{ id: 'claude-sonnet', label: 'Claude Sonnet', enabled: true, default: true, reasoningOptions: [], serviceTierOptions: [] }],
      supportsReasoning: true,
      supportsServiceTier: true,
      modelCatalogSource: 'live',
      mapDesign: { nativeMapTools: true, publicReasoningSummary: true },
    } satisfies LocalAgentInfo;
    const response = { agents: [agent] } satisfies LocalAgentListResponse;

    expect(Object.keys(response)).toEqual(['agents']);
    expect(Object.keys(agent).sort()).toEqual([
      'available',
      'executable',
      'id',
      'label',
      'mapDesign',
      'modelCatalogSource',
      'models',
      'supportsReasoning',
      'supportsServiceTier',
      'version',
    ]);
  });

  it('retains only local runtime configuration', () => {
    const config = {
      agentId: 'claude',
      agentModels: { claude: { model: 'claude-sonnet' } },
      agentCliEnv: { claude: { ANTHROPIC_BASE_URL: 'https://api.example.com' } },
      agentCliEnvIntent: { claude: { apiKeyOverride: true } },
      byokProviders: {
        anthropic: {
          protocol: 'anthropic',
          apiKey: 'test-key',
          model: 'claude-sonnet',
        },
      },
      customInstructions: 'Prefer restrained labels.',
      recentLinkedDirs: ['/workspace/maps'],
    } satisfies MapDesignAppConfig;
    const response = { config } satisfies MapDesignAppConfigResponse;
    const update = { customInstructions: null } satisfies UpdateMapDesignAppConfigRequest;

    expect(Object.keys(response)).toEqual(['config']);
    expect(Object.keys(update)).toEqual(['customInstructions']);
    expect(Object.keys(config).sort()).toEqual([
      'agentCliEnv',
      'agentCliEnvIntent',
      'agentId',
      'agentModels',
      'byokProviders',
      'customInstructions',
      'recentLinkedDirs',
    ]);
  });
});
