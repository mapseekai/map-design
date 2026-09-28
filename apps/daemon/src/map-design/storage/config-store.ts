import { MAP_API_PROFILE_ID } from '@mapseekai/contracts';
import { resolveMapApiExecutionSettings } from '@mapseekai/contracts';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentCliEnvIntentPrefs,
  AgentCliEnvPrefs,
  AgentModelPrefs,
  ByokProtocol,
  ByokProviderSelection,
  MapDesignAppConfig,
  UpdateMapDesignAppConfigRequest,
} from '@mapseekai/contracts';

export interface MapDesignConfigStore {
  read(): MapDesignAppConfig;
  update(patch: UpdateMapDesignAppConfigRequest): MapDesignAppConfig;
}

export interface MapDesignConfigFileIO {
  writeFile?: typeof writeFileSync;
  rename?: typeof renameSync;
}

export class MapDesignConfigValidationError extends Error {}

const KEYS: Record<keyof MapDesignAppConfig, true> = {
  runtimePreferences: true,
  apiExecution: true,
  agentId: true,
  activeApiProfileId: true,
  agentModels: true,
  agentCliEnv: true,
  agentCliEnvIntent: true,
  byokProviders: true,
  customInstructions: true,
  recentLinkedDirs: true,
};
const PROTOCOLS: readonly ByokProtocol[] = ['anthropic', 'openai', 'azure', 'google', 'ollama', 'aihubmix'];
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isProtocol(value: unknown): value is ByokProtocol {
  return typeof value === 'string' && PROTOCOLS.some((protocol) => protocol === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isErrnoException(value: unknown): value is { code?: unknown } {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function requireRecord(value: unknown, name: string, maxKeys: number): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length > maxKeys) throw new MapDesignConfigValidationError(`Invalid ${name}`);
  return value;
}

function requireIdentifier(value: string, name: string): void {
  if (value.length === 0 || value.length > 256) throw new MapDesignConfigValidationError(`Invalid ${name}`);
}

function optionalString(record: Record<string, unknown>, key: string, maximumLength: number, name: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== 'string' || value.length > maximumLength) throw new MapDesignConfigValidationError(`Invalid ${name}`);
  return value;
}

function sanitizeAgentModels(value: unknown): Record<string, AgentModelPrefs> {
  const models: Record<string, AgentModelPrefs> = {};
  for (const [agentId, preferences] of Object.entries(requireRecord(value, 'agentModels', 64))) {
    requireIdentifier(agentId, 'agentModels');
    const record = requireRecord(preferences, 'agentModels', 3);
    for (const key of Object.keys(record)) if (!['model', 'reasoning', 'serviceTier'].includes(key)) throw new MapDesignConfigValidationError('Invalid agentModels');
    const sanitized: AgentModelPrefs = {};
    const model = optionalString(record, 'model', 256, 'agentModels');
    const reasoning = optionalString(record, 'reasoning', 64, 'agentModels');
    const serviceTier = optionalString(record, 'serviceTier', 64, 'agentModels');
    if (model && model !== 'default') sanitized.model = model;
    if (reasoning !== undefined) sanitized.reasoning = reasoning;
    if (serviceTier !== undefined) sanitized.serviceTier = serviceTier;
    if (Object.keys(sanitized).length > 0) models[agentId] = sanitized;
  }
  return models;
}

function sanitizeAgentCliEnv(value: unknown): AgentCliEnvPrefs {
  const environments: AgentCliEnvPrefs = {};
  for (const [agentId, environment] of Object.entries(requireRecord(value, 'agentCliEnv', 64))) {
    requireIdentifier(agentId, 'agentCliEnv');
    const record = requireRecord(environment, 'agentCliEnv', 64);
    const sanitized: Record<string, string> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (!ENVIRONMENT_KEY.test(key) || key.length > 128 || typeof entry !== 'string' || entry.length > 16_384) throw new MapDesignConfigValidationError('Invalid agentCliEnv');
      sanitized[key] = entry;
    }
    environments[agentId] = sanitized;
  }
  return environments;
}

function sanitizeAgentCliEnvIntent(value: unknown): AgentCliEnvIntentPrefs {
  const intents: AgentCliEnvIntentPrefs = {};
  for (const [agentId, intent] of Object.entries(requireRecord(value, 'agentCliEnvIntent', 64))) {
    requireIdentifier(agentId, 'agentCliEnvIntent');
    const record = requireRecord(intent, 'agentCliEnvIntent', 1);
    for (const key of Object.keys(record)) if (key !== 'apiKeyOverride') throw new MapDesignConfigValidationError('Invalid agentCliEnvIntent');
    const sanitized: { apiKeyOverride?: boolean } = {};
    if (Object.hasOwn(record, 'apiKeyOverride')) {
      if (typeof record.apiKeyOverride !== 'boolean') throw new MapDesignConfigValidationError('Invalid agentCliEnvIntent');
      sanitized.apiKeyOverride = record.apiKeyOverride;
    }
    intents[agentId] = sanitized;
  }
  return intents;
}

function sanitizeByokProviders(value: unknown): Record<string, ByokProviderSelection> {
  const providers: Record<string, ByokProviderSelection> = {};
  for (const [providerId, provider] of Object.entries(requireRecord(value, 'byokProviders', 32))) {
    requireIdentifier(providerId, 'byokProviders');
    const record = requireRecord(provider, 'byokProviders', 9);
    if (!Object.hasOwn(record, 'protocol') || !isProtocol(record.protocol)) throw new MapDesignConfigValidationError('Invalid byokProviders');
    for (const key of Object.keys(record)) if (!['protocol', 'apiKey', 'baseUrl', 'apiVersion', 'apiFormat', 'model', 'requiresApiKey', 'name', 'connectionTest'].includes(key)) throw new MapDesignConfigValidationError('Invalid byokProviders');
    if (!Object.hasOwn(record, 'apiKey') || typeof record.apiKey !== 'string' || record.apiKey.length > 16_384) throw new MapDesignConfigValidationError('Invalid byokProviders');
    const sanitized: ByokProviderSelection = { protocol: record.protocol, apiKey: record.apiKey };
    const baseUrl = optionalString(record, 'baseUrl', 4_096, 'byokProviders');
    const apiVersion = optionalString(record, 'apiVersion', 256, 'byokProviders');
    const model = optionalString(record, 'model', 256, 'byokProviders');
    if (baseUrl !== undefined) sanitized.baseUrl = baseUrl;
    if (apiVersion !== undefined) sanitized.apiVersion = apiVersion;
    if (model !== undefined) sanitized.model = model;
    if (record.apiFormat !== undefined) {
      if (record.apiFormat !== 'chat-completions' && record.apiFormat !== 'responses') throw new MapDesignConfigValidationError('Invalid byokProviders');
      sanitized.apiFormat = record.apiFormat;
    }
    if (Object.hasOwn(record, 'requiresApiKey')) {
      if (typeof record.requiresApiKey !== 'boolean') throw new MapDesignConfigValidationError('Invalid byokProviders');
      sanitized.requiresApiKey = record.requiresApiKey;
    }
    const name = optionalString(record, 'name', 120, 'byokProviders');
    if (name !== undefined) sanitized.name = name;
    if (record.connectionTest !== undefined) {
      const check = requireRecord(record.connectionTest, 'connectionTest', 4);
      if (Object.keys(check).some((key) => !['status', 'testedAt', 'latencyMs', 'code'].includes(key))
        || !['passed', 'failed'].includes(String(check.status)) || typeof check.testedAt !== 'string'
        || !Number.isFinite(Date.parse(check.testedAt)) || !Number.isSafeInteger(check.latencyMs)
        || Number(check.latencyMs) < 0 || (check.code !== undefined && (typeof check.code !== 'string' || !/^[A-Z_]{1,64}$/u.test(check.code)))) {
        throw new MapDesignConfigValidationError('Invalid connectionTest');
      }
      sanitized.connectionTest = { status: check.status as 'passed' | 'failed', testedAt: check.testedAt,
        latencyMs: Number(check.latencyMs), ...(typeof check.code === 'string' ? { code: check.code } : {}) };
    }
    providers[providerId] = sanitized;
  }
  return providers;
}

function validate(config: unknown): MapDesignAppConfig {
  const record = requireRecord(config, 'MapDesign configuration', 64);
  for (const key of Object.keys(record)) if (!Object.hasOwn(KEYS, key)) throw new MapDesignConfigValidationError(`Unknown config key: ${key}`);
  const sanitized: MapDesignAppConfig = {};
  if (Object.hasOwn(record, 'runtimePreferences')) {
    sanitized.runtimePreferences = Object.fromEntries(Object.entries(requireRecord(record.runtimePreferences, 'runtimePreferences', 64)).map(([id, value]) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(id)) throw new MapDesignConfigValidationError('Invalid runtimePreferences');
      const preference = requireRecord(value, 'runtimePreferences', 2);
      if (Object.keys(preference).some(key => !['enabled', 'disabledModels'].includes(key))
        || (preference.enabled !== undefined && typeof preference.enabled !== 'boolean')
        || (preference.disabledModels !== undefined && (!Array.isArray(preference.disabledModels)
          || preference.disabledModels.length > 1024 || preference.disabledModels.some(model => typeof model !== 'string'
            || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(model))))) {
        throw new MapDesignConfigValidationError('Invalid runtimePreferences');
      }
      return [id, { ...(typeof preference.enabled === 'boolean' ? { enabled: preference.enabled } : {}),
        ...(Array.isArray(preference.disabledModels) ? { disabledModels: [...new Set(preference.disabledModels as string[])] } : {}) }];
    }));
  }
  if (Object.hasOwn(record, 'activeApiProfileId')) {
    if (record.activeApiProfileId !== null && (typeof record.activeApiProfileId !== 'string' || !MAP_API_PROFILE_ID.test(record.activeApiProfileId))) {
      throw new MapDesignConfigValidationError('Invalid activeApiProfileId');
    }
    sanitized.activeApiProfileId = record.activeApiProfileId as string | null;
  }
  if (Object.hasOwn(record, 'apiExecution')) {
    try {
      const supplied = requireRecord(record.apiExecution, 'apiExecution', 4);
      const resolved = resolveMapApiExecutionSettings(supplied);
      sanitized.apiExecution = Object.fromEntries(Object.entries(resolved).filter(([key]) => Object.hasOwn(supplied, key)));
    }
    catch { throw new MapDesignConfigValidationError('Invalid API execution budget'); }
  }
  if (Object.hasOwn(record, 'agentId')) {
    if (record.agentId !== null && (typeof record.agentId !== 'string' || record.agentId.length === 0 || record.agentId.length > 256)) throw new MapDesignConfigValidationError('Invalid agentId');
    sanitized.agentId = record.agentId;
  }
  if (Object.hasOwn(record, 'agentModels')) {
    const agentModels = sanitizeAgentModels(record.agentModels);
    if (Object.keys(agentModels).length > 0) sanitized.agentModels = agentModels;
  }
  if (Object.hasOwn(record, 'agentCliEnv')) sanitized.agentCliEnv = sanitizeAgentCliEnv(record.agentCliEnv);
  if (Object.hasOwn(record, 'agentCliEnvIntent')) sanitized.agentCliEnvIntent = sanitizeAgentCliEnvIntent(record.agentCliEnvIntent);
  if (Object.hasOwn(record, 'byokProviders')) sanitized.byokProviders = sanitizeByokProviders(record.byokProviders);
  if (Object.hasOwn(record, 'customInstructions')) {
    if (record.customInstructions !== null && (typeof record.customInstructions !== 'string' || record.customInstructions.length > 16_384)) throw new MapDesignConfigValidationError('Invalid customInstructions');
    sanitized.customInstructions = record.customInstructions;
  }
  if (Object.hasOwn(record, 'recentLinkedDirs')) {
    if (!Array.isArray(record.recentLinkedDirs) || record.recentLinkedDirs.length > 32 || record.recentLinkedDirs.some((directory) => typeof directory !== 'string' || directory.length > 4_096)) throw new MapDesignConfigValidationError('Invalid recentLinkedDirs');
    sanitized.recentLinkedDirs = [...record.recentLinkedDirs];
  }
  return sanitized;
}

export function createMapDesignConfigStore(dataDir: string, io: MapDesignConfigFileIO = {}): MapDesignConfigStore {
  const file = join(dataDir, 'map-design-config.json');
  const read = (): MapDesignAppConfig => {
    try {
      return validate(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return {};
      throw new Error('Unable to read MapDesign configuration');
    }
  };
  const write = (config: MapDesignAppConfig): void => {
    mkdirSync(dataDir, { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      (io.writeFile ?? writeFileSync)(temp, `${JSON.stringify(config)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const fd = openSync(temp, 'r+');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      (io.rename ?? renameSync)(temp, file);
    } catch {
      try { unlinkSync(temp); } catch { /* no temporary file to remove */ }
      throw new Error('Unable to write MapDesign configuration');
    }
  };
  return {
    read,
    update(patch) {
      const current = read();
      const sanitizedPatch = validate(patch);
      const next: Record<string, unknown> = { ...current };
      if (Object.hasOwn(patch, 'agentModels') && !Object.hasOwn(sanitizedPatch, 'agentModels')) {
        delete next.agentModels;
      }
      for (const [key, value] of Object.entries(sanitizedPatch)) {
        if ((key === 'agentId' || key === 'customInstructions') && value === null) delete next[key];
        else next[key] = value;
      }
      const validated = validate(next);
      write(validated);
      return validated;
    },
  };
}
