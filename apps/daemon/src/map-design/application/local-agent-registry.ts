import { resolveApiProfile } from './api-profile-service.js';
import { API_AGENT_ID } from '../../runtimes/defs/api.js';
import { createApiMapAgentAdapter } from '../agents/ai-sdk.js';
import { spawnAgentProcess } from '../../runtimes/spawn.js';
import { join } from 'node:path';

import type {
  ByokProviderSelection,
  MapAgentCapability,
  MapDesignAppConfig,
} from '@mapseekai/contracts';
import type { RuntimeAgentDef } from '../../runtimes/types.js';
import { AGENT_DEFS } from '../../runtimes/registry.js';
import { applyAgentLaunchEnv, resolveAgentLaunch } from '../../runtimes/launch.js';
import { buildOpenCodeByokProviderConfig } from '../../runtimes/byok-opencode.js';
import { skillCwdAliasSegment, stageActiveSkill } from '../../cwd-aliases.js';
import {
  createMapAgentAdapterRegistry,
  type MapAgentAdapterRegistry,
} from '../agents/registry.js';
import { createCodexMapAgentAdapter } from '../agents/codex-app-server.js';
import { resolveDeepSeekProfileHome } from '../agents/deepseek-profile-bundle.js';
import { createDeepSeekHarnessMapAgentAdapter } from '../agents/deepseek-profile.js';
import { createOhMyPiMapAgentAdapter } from '../agents/omp-rpc.js';
import { createOpenCodeMapAgentAdapter } from '../agents/opencode-plugin.js';
import { createPiMapAgentAdapter } from '../agents/pi-sdk.js';
import { sanitizeMapAgentLaunchEnvironment } from '../agents/launch-environment.js';
import {
  createMemoryMapAgentSessionBroker,
  type MapAgentSessionBroker,
} from '../agents/session-broker.js';
import type { MapAgentAdapter } from '../agents/types.js';
import type { MapDesignNativeToolRegistry } from '../tools/tool-context.js';
import type { LocalAgentRegistry, SpawnedLocalAgent } from './run-service.js';
import {
  createMapDesignRuntimeCatalog,
  type MapDesignRuntimeCatalog,
} from './runtime-catalog.js';

type RetainedRuntimeAgent = Pick<RuntimeAgentDef,
  'id' | 'name' | 'bin' | 'buildArgs' | 'streamFormat' | 'eventParser'
  | 'promptViaStdin' | 'promptInputFormat' | 'resumesSessionViaCli'
  | 'capturesSessionIdFromStream' | 'fallbackModels' | 'acpMcpEnvFormat'
  | 'acpTurnEndCompletesPrompt'> & {
    available: boolean;
    mapDesign: MapAgentCapability;
  };

export interface LocalAgentRegistryOptions {
  definitions?: readonly RuntimeAgentDef[];
  stageSkill?: (skillId: 'map-design', cwd: string) => Promise<void>;
  projectRoot?: string;
  config?: { read(): MapDesignAppConfig };
  mapAgentAdapters?: MapAgentAdapterRegistry;
  nativeToolRegistry?: MapDesignNativeToolRegistry;
  spawn?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean }) => SpawnedLocalAgent;
  nativeToolProbeTimeoutMs?: number;
  deepSeekProfileRoot?: string;
  sessionBroker?: MapAgentSessionBroker;
}

export interface MapDesignLocalAgentRegistry extends LocalAgentRegistry {
  list(): readonly RetainedRuntimeAgent[];
  runtimeCatalog: MapDesignRuntimeCatalog;
  getMapAgent?(agentId: string): MapAgentAdapter | null;
  probeNativeMapTools(): Promise<void>;
  launchEnv(agentId: string, options?: { byokProvider?: ByokProviderSelection; model: string | null }): NodeJS.ProcessEnv | null;
}

export function createLocalAgentRegistry(options: LocalAgentRegistryOptions = {}): MapDesignLocalAgentRegistry {
  const agents = options.definitions ?? AGENT_DEFS;
  const apiAdapter = createApiMapAgentAdapter({ projectRoot: options.projectRoot ?? process.cwd(), provider: (model) => resolveApiProfile(options.config?.read() ?? {}, model), execution: () => options.config?.read().apiExecution });
  const configuredEnv = (agentId: string): Record<string, string> => {
    const configId = agentId === 'byok-opencode' ? 'opencode' : agentId;
    return { ...(options.config?.read().agentCliEnv?.[configId] ?? {}) };
  };
  const explicitEnvKeys = (agent: RuntimeAgentDef): string[] => [
    ...Object.keys(agent.env ?? {}),
    ...Object.keys(configuredEnv(agent.id)),
  ];
  const allowedEnvKeys = (agent: RuntimeAgentDef): string[] => [
    ...(agent.inheritedEnvKeys ?? []),
    ...explicitEnvKeys(agent),
  ];
  const resolved = (agent: RuntimeAgentDef) => resolveAgentLaunch(agent, configuredEnv(agent.id));
  const nativeToolRegistry = options.nativeToolRegistry;
  const spawnAgent = options.spawn ?? spawnAgentProcess;
  const nativeMapToolSupport = new Map<string, boolean>();
  const nativeMapToolProbes = new Map<string, Promise<boolean>>();
  const sessionBroker = options.sessionBroker ?? createMemoryMapAgentSessionBroker();
  const deepSeekProfileHome = resolveDeepSeekProfileHome(options.deepSeekProfileRoot);
  const launchEnvironment = (
    agentId: string,
    launchOptions?: { byokProvider?: ByokProviderSelection; model: string | null },
  ): NodeJS.ProcessEnv | null => {
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) return null;
    const launch = resolved(agent);
    if (!launch.launchPath) return null;
    const config = options.config?.read();
    const persistedByokProvider = Object.values(config?.byokProviders ?? {}).find((provider) =>
      typeof provider.model === 'string' && provider.model.length > 0);
    const byokProvider = agent.id === 'byok-opencode'
      ? launchOptions?.byokProvider ?? persistedByokProvider
      : undefined;
    const byok = agent.id === 'byok-opencode'
      ? buildOpenCodeByokProviderConfig(byokProvider, launchOptions?.model ?? byokProvider?.model ?? null)
      : null;
    if (agent.id === 'byok-opencode' && !byok) return null;
    const environment = {
      ...sanitizeMapAgentLaunchEnvironment(applyAgentLaunchEnv({
      ...process.env,
      ...(agent.env ?? {}),
      ...configuredEnv(agent.id),
      }, launch), allowedEnvKeys(agent)),
      ...(byok?.env ?? {}),
      ...(byok ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(byok.config) } : {}),
    };
    return agent.id === 'deepseek-harness'
      ? deepSeekEnvironment(environment, deepSeekProfileHome)
      : environment;
  };
  const mapAgentAdapters = options.mapAgentAdapters ?? createMapAgentAdapterRegistry(
    nativeToolRegistry
      ? {
          'ai-sdk': () => apiAdapter,
          'codex-app-server': (definition) => definition.id === 'codex'
            ? createCodexMapAgentAdapter({
                definition,
                nativeToolRegistry,
                spawn: spawnAgent,
                environment: () => launchEnvironment(definition.id, { model: null }),
                environmentKeys: () => explicitEnvKeys(definition),
                sessionBroker,
                probeCwd: options.projectRoot ?? process.cwd(),
                ...(options.nativeToolProbeTimeoutMs === undefined
                  ? {}
                  : { probeTimeoutMs: options.nativeToolProbeTimeoutMs }),
              })
            : null,
          'omp-rpc': (definition) => definition.id === 'oh-my-pi'
            ? createOhMyPiMapAgentAdapter({
                definition,
                toolDefinitions: () => nativeToolRegistry.definitions(),
                spawn: spawnAgent,
                environment: () => launchEnvironment(definition.id, { model: null }),
                environmentKeys: () => explicitEnvKeys(definition),
                sessionBroker,
                probeCwd: options.projectRoot ?? process.cwd(),
                ...(options.nativeToolProbeTimeoutMs === undefined
                  ? {}
                  : { probeTimeoutMs: options.nativeToolProbeTimeoutMs }),
              })
            : null,
          'pi-sdk': (definition) => definition.id === 'pi'
            ? createPiMapAgentAdapter({
                definition,
                toolDefinitions: () => nativeToolRegistry.definitions(),
                spawn: spawnAgent,
                environment: () => launchEnvironment(definition.id, { model: null }),
                environmentKeys: () => explicitEnvKeys(definition),
                probeCwd: options.projectRoot ?? process.cwd(),
                sessionBroker,
                ...(options.nativeToolProbeTimeoutMs === undefined
                  ? {}
                  : { probeTimeoutMs: options.nativeToolProbeTimeoutMs }),
              })
            : null,
          'opencode-plugin': (definition) => definition.id === 'opencode'
            ? createOpenCodeMapAgentAdapter({
                definition,
                toolDefinitions: () => nativeToolRegistry.definitions(),
                spawn: spawnAgent,
                environment: () => launchEnvironment(definition.id, { model: null }),
                environmentKeys: () => explicitEnvKeys(definition),
                probeCwd: options.projectRoot ?? process.cwd(),
                sessionBroker,
                ...(options.nativeToolProbeTimeoutMs === undefined
                  ? {}
                  : { probeTimeoutMs: options.nativeToolProbeTimeoutMs }),
              })
            : null,
          'deepseek-profile': (definition) => definition.id === 'deepseek-harness'
            ? createDeepSeekHarnessMapAgentAdapter({
                definition,
                toolDefinitions: () => nativeToolRegistry.definitions(),
                spawn: spawnAgent,
                environment: () => launchEnvironment(definition.id, { model: null }),
                environmentKeys: () => explicitEnvKeys(definition),
                probeCwd: options.projectRoot ?? process.cwd(),
                sessionBroker,
                ...(options.deepSeekProfileRoot === undefined
                  ? {}
                  : { profileRoot: options.deepSeekProfileRoot }),
                ...(options.nativeToolProbeTimeoutMs === undefined
                  ? {}
                  : { probeTimeoutMs: options.nativeToolProbeTimeoutMs }),
              })
            : null,
        }
      : {},
  );
  const stageSkill = options.stageSkill ?? (async (skillId, cwd) => {
    if (!options.projectRoot) throw new Error('MapDesign skill root is unavailable.');
    await stageActiveSkill(cwd, skillCwdAliasSegment(skillId), join(options.projectRoot, 'skills', skillId));
  });
  const probeNativeMapTools = async (): Promise<void> => {
    await Promise.all(agents.map(async (agent) => {
      if (agent.id === API_AGENT_ID || !agent.mapDesign?.nativeToolAdapter) return;
      const launch = resolved(agent);
      if (!launch.launchPath) {
        nativeMapToolSupport.set(agent.id, false);
        return;
      }
      const definition = { ...agent, bin: launch.launchPath };
      const adapter = mapAgentAdapters.get(definition);
      if (!adapter?.capabilities.nativeMapTools || !adapter.probeNativeMapTools) {
        nativeMapToolSupport.set(agent.id, false);
        return;
      }
      const probeKey = nativeMapToolProbeKey(agent.id, launch.launchPath);
      let probe = nativeMapToolProbes.get(probeKey);
      if (!probe) {
        probe = Promise.resolve(adapter.probeNativeMapTools()).then(
          (supported) => supported === true,
          () => false,
        );
        nativeMapToolProbes.set(probeKey, probe);
      }
      const supported = await probe;
      nativeMapToolSupport.set(probeKey, supported);
      if (!supported && nativeMapToolProbes.get(probeKey) === probe) nativeMapToolProbes.delete(probeKey);
    }));
  };
  const mapCapability = (definition: RuntimeAgentDef, available: boolean): MapAgentCapability => {
    const capability = mapAgentAdapters.capability(definition, available);
    if (!available || definition.id === API_AGENT_ID) return capability;
    if (definition.mapDesign?.unsupportedReason) {
      return {
        nativeMapTools: false,
        publicReasoningSummary: capability.publicReasoningSummary,
        reason: definition.mapDesign.unsupportedReason,
      };
    }
    if (!capability.nativeMapTools || !definition.mapDesign?.nativeToolAdapter) return capability;
    const probeKey = nativeMapToolProbeKey(definition.id, definition.bin);
    if (nativeMapToolSupport.get(probeKey) === true) return capability;
    return {
      nativeMapTools: false,
      publicReasoningSummary: capability.publicReasoningSummary,
      reason: 'native-tools-unavailable',
    };
  };
  const runtimeCatalog = createMapDesignRuntimeCatalog({
    ...(options.config ? { apiConfig: () => options.config!.read() } : {}),
    definitions: agents,
    inspect: (agent) => {
      if (agent.id === API_AGENT_ID) return { definition: agent, available: true, environment: {}, mapDesign: mapCapability(agent, true) };
      const launch = resolved(agent);
      const available = launch.launchPath !== null;
      const definition = available ? { ...agent, bin: launch.launchPath! } : agent;
      return {
        definition,
        available,
        ...(launch.launchPath ? { executable: launch.launchPath } : {}),
        environment: agent.id === 'deepseek-harness'
          ? deepSeekEnvironment(sanitizeMapAgentLaunchEnvironment(applyAgentLaunchEnv({
              ...process.env,
              ...(agent.env ?? {}),
              ...configuredEnv(agent.id),
            }, launch), allowedEnvKeys(agent)), deepSeekProfileHome)
          : sanitizeMapAgentLaunchEnvironment(applyAgentLaunchEnv({
              ...process.env,
              ...(agent.env ?? {}),
              ...configuredEnv(agent.id),
          }, launch), allowedEnvKeys(agent)),
        mapDesign: mapCapability(definition, available),
      };
    },
  });

  return {
    runtimeCatalog,
    get: (agentId) => {
      const agent = agents.find((candidate) => candidate.id === agentId);
      if (!agent) return null;
      if (agent.id === API_AGENT_ID) return agent;
      const launch = resolved(agent);
      return launch.launchPath ? { ...agent, bin: launch.launchPath } : null;
    },
    getMapAgent: (agentId) => {
      const agent = agents.find((candidate) => candidate.id === agentId);
      if (!agent) return null;
      if (agent.id === API_AGENT_ID) return mapAgentAdapters.get(agent);
      const launch = resolved(agent);
      if (!launch.launchPath) return null;
      const definition = { ...agent, bin: launch.launchPath };
      if (
        definition.mapDesign?.nativeToolAdapter
        && nativeMapToolSupport.get(nativeMapToolProbeKey(definition.id, definition.bin)) !== true
      ) return null;
      return mapAgentAdapters.get(definition);
    },
    list: () => agents.map((agent) => {
      if (agent.id === API_AGENT_ID) return { ...agent, available: true, mapDesign: mapCapability(agent, true) };
      const launch = resolved(agent);
      const available = launch.launchPath !== null;
      const definition = available
        ? { ...agent, bin: launch.launchPath! }
        : agent;
      return {
        ...agent,
        available,
        mapDesign: mapCapability(definition, available),
      };
    }),
    probeNativeMapTools,
    launchEnv: launchEnvironment,
    spawn: spawnAgent,
    stageSkill,
  };
}

function nativeMapToolProbeKey(agentId: string, launchPath: string): string {
  return `${agentId}\u0000${launchPath}`;
}

function deepSeekEnvironment(environment: NodeJS.ProcessEnv, profileHome: string): NodeJS.ProcessEnv {
  return { ...environment, DSH_HOME: profileHome };
}
