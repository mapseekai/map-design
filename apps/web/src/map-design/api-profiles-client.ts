import { activeApiProfileId, isApiModelProfile, MAP_API_PROFILE_ID,
  type MapDesignAppConfig, type MapApiProfilesResponse } from '@mapseekai/contracts';
export const API_PROFILES_CHANGED = 'map-design:api-profiles-changed';
export class ApiProfileClientError extends Error { constructor(readonly code: string) { super(code); } }
export async function apiProfilesRequest<T>(suffix: string, method: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(`/api/map-design/api-profiles${suffix}`, { method, signal, credentials: 'same-origin',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new ApiProfileClientError(typeof result?.error?.code === 'string' && /^[A-Z_]{1,64}$/u.test(result.error.code)
    ? result.error.code : 'API_PROFILE_SAVE_FAILED');
  return result as T;
}
/** Only the redacted /api/config payload is used to initialize the editor. */
export function profilesFromConfig(config: MapDesignAppConfig): MapApiProfilesResponse {
  return { activeProfileId: activeApiProfileId(config), profiles: Object.entries(config.byokProviders ?? {})
    .filter(([id, provider]) => MAP_API_PROFILE_ID.test(id) && isApiModelProfile(provider))
    .map(([id, provider]) => ({ id, name: provider.name || provider.model || id,
      protocol: provider.protocol as 'openai' | 'anthropic', apiFormat: provider.apiFormat ?? 'chat-completions',
      baseUrl: provider.baseUrl ?? '', model: provider.model ?? '', hasApiKey: Boolean(provider.apiKey),
      requiresApiKey: provider.requiresApiKey !== false,
      ...(provider.connectionTest ? { connectionTest: provider.connectionTest } : {}) })) };
}
