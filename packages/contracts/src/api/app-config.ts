import type { MapApiConnectionTest } from './api-profiles.js';
export interface AgentModelPrefs {
  model?: string;
  reasoning?: string;
  serviceTier?: string;
}

export type AgentCliEnvPrefs = Record<string, Record<string, string>>;
export type AgentCliEnvIntentPrefs = Record<string, { apiKeyOverride?: boolean }>;

export type ByokProtocol =
  | 'anthropic'
  | 'openai'
  | 'azure'
  | 'google'
  | 'ollama'
  | 'aihubmix';

export interface ByokProviderSelection {
  name?: string;
  connectionTest?: MapApiConnectionTest;
  protocol: ByokProtocol;
  apiKey: string;
  baseUrl?: string;
  apiVersion?: string;
  apiFormat?: 'chat-completions' | 'responses';
  model?: string;
  requiresApiKey?: boolean;
}

export interface MapDesignApiExecutionSettings {
  maxSteps?: number;
  maxToolCalls?: number;
  maxOutputTokens?: number;
  cartographyMaxOutputTokens?: number;
}

export const MAP_API_EXECUTION_DEFAULTS = Object.freeze({
  maxSteps: 48, maxToolCalls: 192, maxOutputTokens: 16_384, cartographyMaxOutputTokens: 32_768,
});
export const MAP_API_EXECUTION_BOUNDS = Object.freeze({
  maxSteps: [1, 128], maxToolCalls: [1, 512], maxOutputTokens: [256, 131_072], cartographyMaxOutputTokens: [256, 131_072],
} as const);

export function resolveMapApiExecutionSettings(input: MapDesignApiExecutionSettings = {}): Required<MapDesignApiExecutionSettings> {
  const limits: Required<MapDesignApiExecutionSettings> = { ...MAP_API_EXECUTION_DEFAULTS };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(MAP_API_EXECUTION_BOUNDS, key)) throw new RangeError('Unknown API execution setting');
    const name = key as keyof typeof limits;
    const [min, max] = MAP_API_EXECUTION_BOUNDS[name];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new RangeError('Invalid API execution budget');
    limits[name] = value;
  }
  return limits;
}

export interface MapDesignAppConfig {
  activeApiProfileId?: string | null;
  apiExecution?: MapDesignApiExecutionSettings;
  agentId?: string | null;
  agentModels?: Record<string, AgentModelPrefs>;
  agentCliEnv?: AgentCliEnvPrefs;
  agentCliEnvIntent?: AgentCliEnvIntentPrefs;
  byokProviders?: Record<string, ByokProviderSelection>;
  customInstructions?: string | null;
  recentLinkedDirs?: string[];
}

export interface MapDesignAppConfigResponse {
  config: MapDesignAppConfig;
}

export type UpdateMapDesignAppConfigRequest = Partial<MapDesignAppConfig>;

export interface OrbitConfigPrefs {
  enabled: boolean;
  /** Local 24-hour clock time in HH:mm format. Defaults to 08:00. */
  time: string;
  /** Optional skill id from the examples gallery where scenario === "orbit". */
  templateSkillId?: string | null;
  /**
   * Workspace selected in the tab that configured Orbit. The daemon verifies
   * this pair when saving and again before every unattended run.
   */
  workspaceScope?: AutomationWorkspaceScope | null;
}

export interface AutomationWorkspaceScope {
  workspaceId: string;
  workspaceMemberId: string;
}

export interface ProjectLocationPrefs {
  id: string;
  name: string;
  path: string;
}

export interface TelemetryPrefs {
  metrics?: boolean;
  content?: boolean;
  artifactManifest?: boolean;
}

export interface AppConfigPrefs {
  onboardingCompleted?: boolean;
  agentId?: string | null;
  agentModels?: Record<string, AgentModelPrefs>;
  agentCliEnv?: AgentCliEnvPrefs;
  agentCliEnvIntent?: AgentCliEnvIntentPrefs;
  skillId?: string | null;
  designSystemId?: string | null;
  disabledSkills?: string[];
  disabledDesignSystems?: string[];
  installationId?: string | null;
  privacyDecisionAt?: number | null;
  telemetry?: TelemetryPrefs;
  orbit?: OrbitConfigPrefs;
  customInstructions?: string | null;
  /** External project library roots. The daemon adds its built-in .md/projects location at read time. */
  projectLocations?: ProjectLocationPrefs[];
  /** Project location id used for new projects when the create request does not choose one explicitly. */
  defaultProjectLocationId?: string | null;
  /**
   * Most-recently-used local working directories the user granted the agent
   * read access to (via the Home composer's working-directory picker). These
   * become a new project's `metadata.linkedDirs` — the agent perceives them
   * through `--add-dir`; they are NOT imported into Design Files. Stored
   * most-recent-first and capped by the daemon.
   */
  recentLinkedDirs?: string[];
}

export interface AppConfigResponse {
  config: AppConfigPrefs;
}

export type UpdateAppConfigRequest = Partial<AppConfigPrefs>;

/** Response body for `GET /api/recent-dirs` — recent working directories
 *  pruned to those that still exist on disk, most-recent-first. */
export interface RecentLinkedDirsResponse {
  dirs: string[];
}
