import { createHash } from 'node:crypto';
import { APICallError, generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import {
  activeApiProfileId, apiProfileIdFromModel, isApiModelProfile, MAP_API_PROFILE_ID, MAP_API_PROFILE_MODEL_PREFIX,
  type ByokProviderSelection, type MapApiProfile, type MapApiProfilesResponse, type MapApiConnectionTest,
  type MapDesignAppConfig,
} from '@mapseekai/contracts';
import { createApiModel, apiModelFailure } from '../agents/api-model.js';
import type { MapDesignConfigStore } from '../storage/config-store.js';
import { apiKeyForProviderUpdate } from './provider-credentials.js';

const profileInput = z.object({
  name: z.string().trim().min(1).max(120), protocol: z.enum(['openai', 'anthropic']),
  apiFormat: z.enum(['chat-completions', 'responses']), baseUrl: z.string().trim().max(4096),
  model: z.string().trim().min(1).max(256).refine((value) => value !== 'default' && !/[\u0000-\u001f\u007f]/u.test(value)),
  apiKey: z.string().trim().max(16384).optional(), requiresApiKey: z.boolean(),
}).strict();
export class ApiProfileError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
function requireId(id: string): void {
  if (!MAP_API_PROFILE_ID.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new ApiProfileError('INVALID_INPUT');
}
function publicProfile(id: string, profile: ByokProviderSelection): MapApiProfile {
  return { id, name: profile.name || profile.model || id, protocol: profile.protocol as 'openai' | 'anthropic',
    apiFormat: profile.apiFormat ?? 'chat-completions', baseUrl: safeEndpoint(profile.baseUrl), model: profile.model ?? '',
    hasApiKey: Boolean(profile.apiKey.trim()), requiresApiKey: profile.requiresApiKey !== false,
    ...(profile.connectionTest ? { connectionTest: profile.connectionTest } : {}) };
}
function safeEndpoint(value: string | undefined): string {
  if (!value) return '';
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href.replace(/\/$/u, ''); }
  catch { return ''; }
}
export function profileFingerprint(profile: ByokProviderSelection): string {
  return createHash('sha256').update(JSON.stringify([profile.protocol, profile.apiFormat ?? 'chat-completions',
    profile.baseUrl ?? '', profile.model ?? '', profile.apiKey, profile.requiresApiKey !== false])).digest('hex');
}
/** Explicit profile IDs fail closed after deletion, instead of using another account. */
export function resolveApiProfile(config: MapDesignAppConfig, model?: string | null): ByokProviderSelection | undefined {
  const explicit = apiProfileIdFromModel(model);
  if (model?.startsWith(MAP_API_PROFILE_MODEL_PREFIX) && !explicit) throw new ApiProfileError('API_PROFILE_NOT_FOUND', 404);
  const id = explicit ?? activeApiProfileId(config);
  const value = id && Object.hasOwn(config.byokProviders ?? {}, id) ? config.byokProviders?.[id] : undefined;
  if (explicit && !value) throw new ApiProfileError('API_PROFILE_NOT_FOUND', 404);
  return value && isApiModelProfile(value) ? { ...value } : undefined;
}

export class ApiProfileService {
  private readonly inFlight = new Set<string>();
  private readonly lastStarted = new Map<string, number>();
  constructor(private readonly config: MapDesignConfigStore,
    private readonly model: (profile: ByokProviderSelection) => LanguageModel = (profile) => createApiModel(profile)) {}
  list(): MapApiProfilesResponse {
    const config = this.config.read();
    return { profiles: Object.entries(config.byokProviders ?? {}).filter(([id, value]) => MAP_API_PROFILE_ID.test(id) && isApiModelProfile(value))
      .map(([id, value]) => publicProfile(id, value)), activeProfileId: activeApiProfileId(config) };
  }
  save(id: string, value: unknown): MapApiProfilesResponse {
    requireId(id);
    const parsed = profileInput.safeParse(value);
    if (!parsed.success || parsed.data.apiKey === '[REDACTED]') throw new ApiProfileError('INVALID_INPUT');
    const input = parsed.data;
    const config = this.config.read();
    const previous = Object.hasOwn(config.byokProviders ?? {}, id) ? config.byokProviders?.[id] : undefined;
    if (!previous && Object.keys(config.byokProviders ?? {}).length >= 32) throw new ApiProfileError('API_PROFILE_LIMIT');
    const apiKey = apiKeyForProviderUpdate(previous, input, input.apiKey);
    if (apiKey === null) {
      throw new ApiProfileError('API_KEY_REQUIRED_FOR_ENDPOINT');
    }
    const profile: ByokProviderSelection = { name: input.name, protocol: input.protocol, apiFormat: input.apiFormat,
      model: input.model, baseUrl: input.baseUrl, requiresApiKey: input.requiresApiKey,
      apiKey };
    // Construction validates endpoint/model/key without making a network request.
    try { createApiModel(profile); } catch { throw new ApiProfileError('API_CONFIGURATION_REQUIRED'); }
    if (previous?.connectionTest && profileFingerprint(previous) === profileFingerprint(profile)) profile.connectionTest = previous.connectionTest;
    const initial = activeApiProfileId(config) === null;
    this.config.update({ byokProviders: { ...config.byokProviders, [id]: profile },
      ...(initial ? { activeApiProfileId: id, agentId: 'api' } : {}) });
    return this.list();
  }
  activate(id: string): MapApiProfilesResponse {
    requireId(id);
    const config = this.config.read();
    const profile = config.byokProviders?.[id];
    if (!profile || !isApiModelProfile(profile)) throw new ApiProfileError('API_PROFILE_NOT_FOUND', 404);
    try { createApiModel(profile); } catch { throw new ApiProfileError('API_CONFIGURATION_REQUIRED'); }
    this.config.update({ activeApiProfileId: id, agentId: 'api' });
    return this.list();
  }
  delete(id: string): MapApiProfilesResponse {
    requireId(id);
    const config = this.config.read();
    if (!Object.hasOwn(config.byokProviders ?? {}, id)) throw new ApiProfileError('API_PROFILE_NOT_FOUND', 404);
    const providers = { ...config.byokProviders }; delete providers[id];
    this.config.update({ byokProviders: providers, ...(activeApiProfileId(config) === id ? { activeApiProfileId: null } : {}) });
    this.lastStarted.delete(id);
    return this.list();
  }
  async test(id: string, signal: AbortSignal): Promise<MapApiConnectionTest> {
    requireId(id);
    const profile = this.config.read().byokProviders?.[id];
    if (!profile || !isApiModelProfile(profile)) throw new ApiProfileError('API_PROFILE_NOT_FOUND', 404);
    const started = Date.now();
    if (this.inFlight.has(id) || this.inFlight.size >= 2 || started - (this.lastStarted.get(id) ?? 0) < 5000) {
      throw new ApiProfileError('API_TEST_BUSY', 429);
    }
    this.lastStarted.set(id, started);
    while (this.lastStarted.size > 32) this.lastStarted.delete(this.lastStarted.keys().next().value!);
    this.inFlight.add(id);
    const timeout = AbortSignal.timeout(30_000);
    let check: MapApiConnectionTest;
    try {
      const result = await generateText({ model: this.model(profile), prompt: 'Reply with OK only.',
        maxOutputTokens: 512, maxRetries: 0, abortSignal: AbortSignal.any([signal, timeout]) });
      if (!result.text.trim() || result.finishReason !== 'stop') throw new ApiProfileError('API_TEST_INCOMPLETE');
      check = { status: 'passed', testedAt: new Date().toISOString(), latencyMs: Date.now() - started };
    } catch (error) {
      if (signal.aborted) throw new ApiProfileError('API_TEST_CANCELED', 409);
      const code = timeout.aborted ? 'API_TEST_TIMEOUT' : error instanceof ApiProfileError ? error.code
        : APICallError.isInstance(error) && error.statusCode === 404 ? 'API_MODEL_NOT_FOUND' : apiModelFailure(error).code;
      check = { status: 'failed', testedAt: new Date().toISOString(), latencyMs: Date.now() - started, code };
    } finally { this.inFlight.delete(id); }
    const latest = this.config.read();
    const current = latest.byokProviders?.[id];
    // Never attach stale results to an edited/deleted profile or recreate it.
    if (!current || profileFingerprint(current) !== profileFingerprint(profile)) throw new ApiProfileError('API_PROFILE_CHANGED', 409);
    this.config.update({ byokProviders: { ...latest.byokProviders, [id]: { ...current, connectionTest: check } } });
    return check;
  }
}
