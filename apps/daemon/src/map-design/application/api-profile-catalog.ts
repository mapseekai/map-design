import { activeApiProfileId, apiProfileModelId, MAP_API_PROFILE_ID, isApiModelProfile,
  apiProfileIdFromModel, MAP_API_PROFILE_MODEL_PREFIX,
  type LocalAgentInfo, type MapDesignRuntimeSelectionInput, type MapDesignAppConfig } from '@mapseekai/contracts';
import type { ResolvedRuntimeChoice } from './runtime-catalog.js';
import { invalidInput } from './errors.js';
import { createApiModel } from '../agents/api-model.js';

/** Read configured profiles at access time; saving never waits for CLI probes. */
export function configuredApiCatalog(snapshot: readonly LocalAgentInfo[], config: MapDesignAppConfig): readonly LocalAgentInfo[] {
  const activeId = activeApiProfileId(config);
  const profiles = Object.entries(config.byokProviders ?? {}).filter(([id, provider]) => MAP_API_PROFILE_ID.test(id) && isApiModelProfile(provider));
  return snapshot.map((agent) => {
    if (agent.id !== 'api') return agent;
    const { modelCatalogWarning: _warning, ...base } = agent;
    return { ...base, modelCatalogSource: 'configured' as const,
      // Model changes are saved profiles so the endpoint/key association stays explicit.
      supportsCustomModel: false, models: profiles.map(([id, provider]) => {
        let enabled = true; try { createApiModel(provider); } catch { enabled = false; }
        const name = provider.name?.trim() || id;
        return { id: apiProfileModelId(id), label: `${name} · ${provider.model ?? '—'}`.slice(0, 256),
          description: `${provider.protocol} / ${provider.apiFormat ?? 'chat-completions'}`,
          enabled, default: id === activeId, reasoningOptions: [], serviceTierOptions: [] };
      }) };
  });
}


/** A saved API choice always identifies an account, never just a remote model name. */
export function resolveConfiguredApiChoice(
  agent: LocalAgentInfo | undefined,
  config: MapDesignAppConfig,
  input: MapDesignRuntimeSelectionInput,
): ResolvedRuntimeChoice {
  if (!agent?.available || !agent.mapDesign.nativeMapTools) throw invalidInput();
  const requested = input.model?.trim();
  let id: string | null;
  if (!requested || requested === 'default') {
    id = activeApiProfileId(config);
  } else if (requested.startsWith(MAP_API_PROFILE_MODEL_PREFIX)) {
    id = apiProfileIdFromModel(requested);
  } else {
    // Migrate legacy model-only choices only when the account can be resolved.
    const matches = Object.entries(config.byokProviders ?? {})
      .filter(([key, value]) => MAP_API_PROFILE_ID.test(key) && isApiModelProfile(value) && value.model === requested);
    const activeId = activeApiProfileId(config);
    id = matches.some(([key]) => key === activeId) ? activeId : matches.length === 1 ? matches[0]![0] : null;
  }
  const model = id ? agent.models?.find((item) => item.id === apiProfileModelId(id!) && item.enabled) : undefined;
  if (!model) throw invalidInput();
  return {
    agentId: 'api', model: model.id, modelOrigin: 'catalog', adapter: 'ai-sdk',
    ...(agent.version ? { agentVersion: agent.version } : {}),
  };
}
