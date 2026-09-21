import type { ByokProviderSelection } from '@mapseekai/contracts';

/** Provider namespaces and wire-field names differ between Responses and compatible Chat APIs. */
export function apiProviderOptions(provider: { protocol: ByokProviderSelection['protocol']; apiFormat?: 'chat-completions' | 'responses' | undefined } | undefined,
  reasoning: string | null, serviceTier: string | null) {
  const effort = reasoning && reasoning !== 'default' ? reasoning : undefined;
  const tier = serviceTier && serviceTier !== 'default' ? serviceTier : undefined;
  if (provider?.protocol === 'anthropic') return { anthropic: {
    disableParallelToolUse: true,
    ...(effort ? { effort } : {}), ...(tier ? { serviceTier: tier } : {}),
  } };
  if (provider?.apiFormat === 'responses') return { openai: {
    strictJsonSchema: false, parallelToolCalls: false,
    ...(effort ? { reasoningEffort: effort } : {}), ...(tier ? { serviceTier: tier } : {}),
  } };
  return { mapDesignApi: {
    strictJsonSchema: false, parallel_tool_calls: false,
    ...(effort ? { reasoningEffort: effort } : {}), ...(tier ? { service_tier: tier } : {}),
  } };
}
