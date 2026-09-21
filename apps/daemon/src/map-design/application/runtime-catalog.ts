import { MAP_API_PROFILE_UNAVAILABLE_NOTICE, MAP_RUNTIME_DISABLED_NOTICE, type MapDesignAppConfig } from '@mapseekai/contracts';
import { configuredApiCatalog, resolveConfiguredApiChoice } from './api-profile-catalog.js';
import type {
  LocalAgentInfo,
  LocalAgentModelOption,
  MapAgentCapability,
  MapDesignRuntimeSelectionInput,
} from '@mapseekai/contracts';

import { execAgentFile } from '../../runtimes/invocation.js';
import {
  getRememberedLiveModels,
  mergeFallbackModelMetadata,
  rememberLiveModels,
  sanitizeCustomModel,
} from '../../runtimes/models.js';
import type { RuntimeAgentDef, RuntimeEnv, RuntimeModelOption } from '../../runtimes/types.js';
import type { ConversationRuntimeChoicePolicy } from './conversation-runtime-service.js';
import { invalidInput } from './errors.js';

const FALLBACK_WARNING = 'Live model catalog unavailable; showing static fallback models.';
const REMEMBERED_WARNING = 'Live model catalog unavailable; showing the last successful catalog.';
const NORMALIZED_MODEL_NOTICE = 'The saved model is no longer selectable; a safe default was selected.';
const NORMALIZED_RUNTIME_NOTICE = 'The saved runtime is no longer selectable; a safe current choice was selected.';
const DEFAULT_MODEL_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 5_000;
const MAX_VERSION_LENGTH = 256;
const MAX_PUBLIC_MODELS = 1_024;
const MAX_PUBLIC_MODEL_OPTIONS = 64;

export interface ResolvedRuntimeChoice {
  agentId: string;
  agentVersion?: string;
  model: string;
  modelOrigin: 'catalog' | 'custom';
  reasoning?: string;
  serviceTier?: string;
  adapter: string;
  normalizationNotice?: string;
}

export interface MapDesignRuntimeCatalog extends ConversationRuntimeChoicePolicy {
  refresh(): Promise<void>;
  list(): readonly LocalAgentInfo[];
  resolveChoice(agentId: string, input: MapDesignRuntimeSelectionInput): ResolvedRuntimeChoice;
}

export interface RuntimeCatalogInspection {
  definition: RuntimeAgentDef;
  available: boolean;
  executable?: string;
  environment: RuntimeEnv;
  mapDesign: MapAgentCapability;
}

type RuntimeCatalogExecFile = (
  command: string,
  args: string[],
  options: { env: RuntimeEnv; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export function createMapDesignRuntimeCatalog(options: {
  definitions: readonly RuntimeAgentDef[];
  apiConfig?(): MapDesignAppConfig;
  inspect(definition: RuntimeAgentDef): RuntimeCatalogInspection;
  execFile?: RuntimeCatalogExecFile;
}): MapDesignRuntimeCatalog {
  const definitions = [...options.definitions];
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
  const execFile = options.execFile ?? execAgentFile;
  let snapshot = freezeSnapshot(definitions.map((definition) => fallbackEntry(definition, safeInspect(options.inspect, definition))));
  let refreshPromise: Promise<void> | null = null;
  let started = false;

  const refresh = (): Promise<void> => {
    if (refreshPromise) return refreshPromise;
    if (!started) {
      started = true;
      snapshot = freezeSnapshot(definitions.map((definition) => fallbackEntry(definition, safeInspect(options.inspect, definition))));
    }
    const previousById = new Map(snapshot.map((agent) => [agent.id, agent]));
    const pending = Promise.all(definitions.map(async (definition) => probeEntry({
      definition,
      inspection: safeInspect(options.inspect, definition),
      ...(previousById.get(definition.id)
        ? { previous: previousById.get(definition.id)! }
        : {}),
      execFile,
    }))).then((entries) => {
      snapshot = freezeSnapshot(entries);
    }).finally(() => {
      if (refreshPromise === pending) refreshPromise = null;
    });
    refreshPromise = pending;
    return pending;
  };

  const currentSnapshot = () => {
    const config = options.apiConfig?.();
    const catalog = config ? configuredApiCatalog(snapshot, config) : snapshot;
    return freezeSnapshot(catalog.map(agent => {
      const preference = config?.runtimePreferences?.[agent.id];
      return { ...agent, enabled: preference?.enabled !== false,
        ...(agent.models ? { models: agent.models.map(model => ({ ...model,
          enabled: model.enabled && !preference?.disabledModels?.includes(model.id),
        })) } : {}) };
    }));
  };

  const resolveChoice = (
    agentId: string,
    input: MapDesignRuntimeSelectionInput,
  ): ResolvedRuntimeChoice => {
    if (agentId !== input.agentId) throw invalidInput();
    let definition = definitionsById.get(agentId);
    const current = currentSnapshot();
    let agent = current.find((candidate) => candidate.id === agentId);
    if (agent?.enabled === false || options.apiConfig?.().runtimePreferences?.[agentId]?.disabledModels?.includes(input.model ?? '')) throw invalidInput();
    if (agentId === 'api' && options.apiConfig) {
      return resolveConfiguredApiChoice(agent, options.apiConfig(), input);
    }
    let normalized = false;
    let normalizationNotice: string | undefined;
    if (!definition || !agent?.available || !agent.mapDesign.nativeMapTools) {
      agent = current.find((candidate) => candidate.available
        && candidate.enabled !== false
        && candidate.mapDesign.nativeMapTools
        && (candidate.models ?? []).some((model) => model.enabled));
      definition = agent ? definitionsById.get(agent.id) : undefined;
      normalized = true;
      normalizationNotice = NORMALIZED_RUNTIME_NOTICE;
    }
    if (!definition || !agent) throw invalidInput();
    const adapter = definition.mapDesign?.nativeToolAdapter;
    if (!adapter) throw invalidInput();
    const models = agent.models ?? [];
    const defaultModel = models.find((model) => model.enabled && model.default)
      ?? models.find((model) => model.enabled);
    if (!defaultModel) throw invalidInput();

    const requestedModel = input.model?.trim();
    const requestedOrigin = requestedModel ? input.modelOrigin ?? 'catalog' : undefined;
    if (input.modelOrigin !== undefined && !requestedModel) throw invalidInput();
    if (!normalized && requestedOrigin === 'custom' && definition.supportsCustomModel !== true) {
      throw invalidInput();
    }
    let modelOrigin: 'catalog' | 'custom' = !normalized && requestedOrigin === 'custom'
      ? 'custom'
      : 'catalog';
    let model = normalized
      ? defaultModel
      : requestedModel
        ? models.find((candidate) => candidate.id === requestedModel && candidate.enabled)
        : defaultModel;
    if (!model && requestedModel) {
      const custom = sanitizeCustomModel(requestedModel);
      if (modelOrigin === 'custom' && custom && isCatalogIdentifier(custom, 256)) {
        const reasoningOptions = normalizeOptionIds(definition.reasoningOptions);
        model = {
          id: custom,
          label: custom,
          enabled: true,
          default: false,
          reasoningOptions,
          serviceTierOptions: [],
          ...optionalDefault('defaultReasoning', defaultOptionId(definition.reasoningOptions, reasoningOptions)),
        };
      } else if (custom && isCatalogIdentifier(custom, 256)) {
        model = defaultModel;
        modelOrigin = 'catalog';
        normalized = true;
        normalizationNotice ??= NORMALIZED_MODEL_NOTICE;
      } else {
        throw invalidInput();
      }
    }
    if (!model) throw invalidInput();

    let reasoning = input.reasoning;
    if (reasoning !== undefined && !model.reasoningOptions.includes(reasoning)) {
      reasoning = model.defaultReasoning;
      normalized = true;
      normalizationNotice ??= NORMALIZED_RUNTIME_NOTICE;
    }
    let serviceTier = input.serviceTier;
    if (serviceTier !== undefined && !model.serviceTierOptions.includes(serviceTier)) {
      serviceTier = model.defaultServiceTier;
      normalized = true;
      normalizationNotice ??= NORMALIZED_RUNTIME_NOTICE;
    }

    return {
      agentId: agent.id,
      ...(agent.version ? { agentVersion: agent.version } : {}),
      model: model.id,
      modelOrigin,
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(serviceTier === undefined ? {} : { serviceTier }),
      adapter,
      ...(normalized ? { normalizationNotice: normalizationNotice ?? NORMALIZED_RUNTIME_NOTICE } : {}),
    };
  };

  return {
    refresh,
    list: currentSnapshot,
    resolveChoice,
    normalizeSaved(input) {
      if (currentSnapshot().find(agent => agent.id === input.agentId)?.enabled === false
        || options.apiConfig?.().runtimePreferences?.[input.agentId]?.disabledModels?.includes(input.model ?? '')) {
        return { runtime: input, normalizationNotice: MAP_RUNTIME_DISABLED_NOTICE };
      }
      if (input.agentId === 'api' && options.apiConfig) {
        try {
          const resolved = resolveChoice(input.agentId, input);
          return { runtime: { agentId: 'api', model: resolved.model, modelOrigin: 'catalog' as const } };
        } catch {
          // Keep the picker reachable; never select another account after deletion.
          return { runtime: input, normalizationNotice: MAP_API_PROFILE_UNAVAILABLE_NOTICE };
        }
      }
      const resolved = resolveChoice(input.agentId, input);
      return {
        runtime: {
          agentId: resolved.agentId,
          model: resolved.model,
          modelOrigin: resolved.modelOrigin,
          ...(resolved.reasoning === undefined ? {} : { reasoning: resolved.reasoning }),
          ...(resolved.serviceTier === undefined ? {} : { serviceTier: resolved.serviceTier }),
        },
        ...(resolved.normalizationNotice
          ? { normalizationNotice: resolved.normalizationNotice }
          : {}),
      };
    },
    validate(input) {
      const resolved = resolveChoice(input.agentId, input);
      if (resolved.normalizationNotice) throw invalidInput();
      if (input.agentId === 'api' && options.apiConfig) {
        return { agentId: 'api', model: resolved.model, modelOrigin: 'catalog' as const };
      }
      return {
        agentId: input.agentId,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.model === undefined
          ? {}
          : { modelOrigin: input.modelOrigin ?? 'catalog' as const }),
        ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
        ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
      };
    },
  };
}

async function probeEntry(options: {
  definition: RuntimeAgentDef;
  inspection: RuntimeCatalogInspection;
  previous?: LocalAgentInfo;
  execFile: RuntimeCatalogExecFile;
}): Promise<LocalAgentInfo> {
  const { definition, inspection, previous, execFile } = options;
  const version = inspection.available
    ? await probeVersion(definition, inspection, execFile) ?? previous?.version
    : undefined;
  const fresh = inspection.available
    ? await probeModels(definition, inspection, execFile)
    : null;
  let runtimeModels: RuntimeModelOption[];
  let source: LocalAgentInfo['modelCatalogSource'];
  let warning: string | undefined;
  if (fresh && fresh.length > 0) {
    runtimeModels = fresh;
    source = 'live';
  } else {
    const remembered = getRememberedLiveModels(definition.id);
    if (remembered.length > 0) {
      runtimeModels = mergeFallbackModelMetadata(definition, remembered);
      source = 'remembered';
      warning = REMEMBERED_WARNING;
    } else {
      runtimeModels = definition.fallbackModels;
      source = 'fallback';
      warning = FALLBACK_WARNING;
    }
  }
  return projectAgentInfo({
    definition,
    inspection,
    runtimeModels,
    source,
    ...(warning ? { warning } : {}),
    ...(version ? { version } : {}),
  });
}

async function probeVersion(
  definition: RuntimeAgentDef,
  inspection: RuntimeCatalogInspection,
  execFile: RuntimeCatalogExecFile,
): Promise<string | undefined> {
  if (definition.mapDesign?.nativeToolAdapter === 'ai-sdk') return 'AI SDK';
  try {
    const result = await execFile(inspection.executable ?? definition.bin, definition.versionArgs, {
      env: inspection.environment,
      timeout: definition.versionProbeTimeoutMs ?? DEFAULT_VERSION_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const stdout = String(result.stdout).trim();
    const output = stdout || String(result.stderr).trim();
    if (definition.parseVersion) {
      const parsed = definition.parseVersion(output);
      return parsed && parsed.length <= MAX_VERSION_LENGTH ? parsed : undefined;
    }
    const line = output.split(/\r?\n/u).map((candidate) => candidate.trim()).find(Boolean);
    return line && line.length <= MAX_VERSION_LENGTH ? line : undefined;
  } catch {
    return undefined;
  }
}

async function probeModels(
  definition: RuntimeAgentDef,
  inspection: RuntimeCatalogInspection,
  execFile: RuntimeCatalogExecFile,
): Promise<RuntimeModelOption[] | null> {
  try {
    let parsed: RuntimeModelOption[] | null;
    if (definition.fetchModels) {
      parsed = await withTimeout(
        definition.fetchModels(inspection.executable ?? definition.bin, inspection.environment),
        definition.listModels?.timeoutMs ?? DEFAULT_MODEL_PROBE_TIMEOUT_MS,
      );
    } else if (definition.listModels) {
      const result = await execFile(
        inspection.executable ?? definition.bin,
        definition.listModels.args,
        {
          env: inspection.environment,
          timeout: definition.listModels.timeoutMs ?? DEFAULT_MODEL_PROBE_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      parsed = definition.listModels.parse(String(result.stdout));
    } else {
      return null;
    }
    if (!parsed || parsed.length === 0) return null;
    const merged = mergeFallbackModelMetadata(definition, parsed);
    if (!normalizeModels(merged, definition, true)) return null;
    rememberLiveModels(definition.id, merged);
    return merged;
  } catch {
    return null;
  }
}

function fallbackEntry(
  definition: RuntimeAgentDef,
  inspection: RuntimeCatalogInspection,
): LocalAgentInfo {
  return projectAgentInfo({
    definition,
    inspection,
    runtimeModels: definition.fallbackModels,
    source: 'fallback',
    warning: FALLBACK_WARNING,
  });
}

function projectAgentInfo(options: {
  definition: RuntimeAgentDef;
  inspection: RuntimeCatalogInspection;
  runtimeModels: RuntimeModelOption[];
  source: LocalAgentInfo['modelCatalogSource'];
  warning?: string;
  version?: string;
}): LocalAgentInfo {
  const models = normalizeModels(options.runtimeModels, options.definition, false) ?? [];
  const available = options.inspection.available;
  const mapDesign = projectCapability(options.inspection.mapDesign, available, models.length > 0);
  return {
    id: options.definition.id,
    label: options.definition.name,
    available,
    mapDesign,
    ...(options.version ? { version: options.version } : {}),
    models,
    supportsReasoning: models.some((model) => model.reasoningOptions.length > 0),
    supportsServiceTier: models.some((model) => model.serviceTierOptions.length > 0),
    supportsCustomModel: options.definition.supportsCustomModel === true,
    modelCatalogSource: options.source,
    ...(options.warning ? { modelCatalogWarning: options.warning } : {}),
  };
}

function projectCapability(
  capability: MapAgentCapability,
  available: boolean,
  hasModels: boolean,
): MapAgentCapability {
  const publicReasoningSummary = capability.publicReasoningSummary === true;
  if (!available) return { nativeMapTools: false, publicReasoningSummary, reason: 'agent-unavailable' };
  if (!hasModels && capability.nativeMapTools) {
    return { nativeMapTools: false, publicReasoningSummary, reason: 'model-catalog-unavailable' };
  }
  return {
    nativeMapTools: capability.nativeMapTools === true,
    publicReasoningSummary,
    ...(!capability.nativeMapTools && capability.reason ? { reason: capability.reason } : {}),
  };
}

function normalizeModels(
  models: readonly RuntimeModelOption[],
  definition: RuntimeAgentDef,
  strict: boolean,
): LocalAgentModelOption[] | null {
  const normalized: LocalAgentModelOption[] = [];
  const seen = new Set<string>();
  for (const model of models.slice(0, MAX_PUBLIC_MODELS)) {
    const projected = normalizeModel(model, definition);
    if (!projected) {
      if (strict) return null;
      continue;
    }
    if (seen.has(projected.id)) continue;
    seen.add(projected.id);
    normalized.push(projected);
  }
  return normalized;
}

function normalizeModel(
  model: RuntimeModelOption,
  definition: RuntimeAgentDef,
): LocalAgentModelOption | null {
  if (!model || typeof model !== 'object') return null;
  const id = sanitizeCustomModel(model.id);
  if (!id || !isCatalogIdentifier(id, 256) || id !== model.id.trim()) return null;
  const rawLabel = typeof model.label === 'string' ? model.label.trim() : '';
  const label = rawLabel || id;
  if (label.length > 256) return null;
  const description = typeof model.metadata?.description === 'string'
    ? model.metadata.description.trim()
    : '';
  if (description.length > 2_048) return null;
  const reasoningOptions = normalizeOptionIds(model.reasoningOptions ?? definition.reasoningOptions);
  const serviceTierOptions = normalizeOptionIds(model.serviceTierOptions);
  return {
    id,
    label,
    ...(description ? { description } : {}),
    enabled: model.enabled !== false,
    default: model.default === true || id === 'default',
    reasoningOptions,
    serviceTierOptions,
    ...optionalDefault(
      'defaultReasoning',
      defaultOptionId(model.reasoningOptions ?? definition.reasoningOptions, reasoningOptions),
    ),
    ...optionalDefault(
      'defaultServiceTier',
      defaultOptionId(model.serviceTierOptions, serviceTierOptions),
    ),
  };
}

function defaultOptionId(
  options: readonly RuntimeModelOption[] | undefined,
  normalizedIds: readonly string[],
): string | undefined {
  const value = options?.find((option) => option.default === true)?.id;
  return value && normalizedIds.includes(value) ? value : undefined;
}

function optionalDefault<Key extends 'defaultReasoning' | 'defaultServiceTier'>(
  key: Key,
  value: string | undefined,
): Partial<Record<Key, string>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, string>;
}

function normalizeOptionIds(options: readonly RuntimeModelOption[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const option of options?.slice(0, MAX_PUBLIC_MODEL_OPTIONS) ?? []) {
    const id = sanitizeCustomModel(option?.id);
    if (!id || !isCatalogIdentifier(id, 128) || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

function isCatalogIdentifier(value: string, maxLength: number): boolean {
  return value.length <= maxLength && /^(?!-)[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value);
}

function safeInspect(
  inspect: (definition: RuntimeAgentDef) => RuntimeCatalogInspection,
  definition: RuntimeAgentDef,
): RuntimeCatalogInspection {
  try {
    return inspect(definition);
  } catch {
    return {
      definition,
      available: false,
      environment: {},
      mapDesign: {
        nativeMapTools: false,
        publicReasoningSummary: definition.mapDesign?.publicReasoningSummary === true,
        reason: 'agent-unavailable',
      },
    };
  }
}

function freezeSnapshot(entries: LocalAgentInfo[]): readonly LocalAgentInfo[] {
  for (const entry of entries) {
    Object.freeze(entry.mapDesign);
    for (const model of entry.models ?? []) {
      Object.freeze(model.reasoningOptions);
      Object.freeze(model.serviceTierOptions);
      Object.freeze(model);
    }
    if (entry.models) Object.freeze(entry.models);
    Object.freeze(entry);
  }
  return Object.freeze(entries);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Runtime catalog probe timed out.')), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
