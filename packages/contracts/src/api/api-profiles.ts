import type { ByokProviderSelection, MapDesignAppConfig } from './app-config.js';

export interface MapApiConnectionTest {
  status: 'passed' | 'failed';
  testedAt: string;
  latencyMs: number;
  code?: string;
}
export interface MapApiProfile {
  id: string;
  name: string;
  protocol: 'openai' | 'anthropic';
  apiFormat: 'chat-completions' | 'responses';
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  requiresApiKey: boolean;
  connectionTest?: MapApiConnectionTest;
}
export interface MapApiProfilesResponse { profiles: MapApiProfile[]; activeProfileId: string | null }
export interface MapApiProfileInput {
  name: string;
  protocol: 'openai' | 'anthropic';
  apiFormat: 'chat-completions' | 'responses';
  baseUrl: string;
  model: string;
  apiKey?: string;
  requiresApiKey: boolean;
}
export const MAP_API_PROFILE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
export const MAP_API_PROFILE_UNAVAILABLE_NOTICE = 'API_PROFILE_UNAVAILABLE';
export const MAP_API_PROFILE_MODEL_PREFIX = 'api-profile:';
export function apiProfileModelId(id: string): string { return `${MAP_API_PROFILE_MODEL_PREFIX}${id}`; }
export function apiProfileIdFromModel(model: string | null | undefined): string | null {
  if (!model?.startsWith(MAP_API_PROFILE_MODEL_PREFIX)) return null;
  const id = model.slice(MAP_API_PROFILE_MODEL_PREFIX.length);
  return MAP_API_PROFILE_ID.test(id) ? id : null;
}
export function isApiModelProfile(provider: ByokProviderSelection): boolean {
  return provider.protocol === 'openai' || provider.protocol === 'anthropic';
}
export function activeApiProfileId(config: MapDesignAppConfig): string | null {
  if (config.activeApiProfileId !== undefined) {
    const id = config.activeApiProfileId;
    return id && Object.hasOwn(config.byokProviders ?? {}, id) && isApiModelProfile(config.byokProviders![id]!) ? id : null;
  }
  if (config.byokProviders?.default && isApiModelProfile(config.byokProviders.default)) return 'default';
  return Object.entries(config.byokProviders ?? {}).find(([id, value]) => MAP_API_PROFILE_ID.test(id) && isApiModelProfile(value))?.[0] ?? null;
}
