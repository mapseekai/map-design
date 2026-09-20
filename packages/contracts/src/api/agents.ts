import { z } from 'zod';

export interface LocalAgentModelOption {
  id: string;
  label: string;
  description?: string;
  enabled: boolean;
  default: boolean;
  reasoningOptions: string[];
  serviceTierOptions: string[];
  defaultReasoning?: string;
  defaultServiceTier?: string;
}

export type AgentModelCatalogSource = 'live' | 'remembered' | 'fallback';

export type MapAgentUnsupportedReason =
  | 'native-tools-unavailable'
  | 'agent-unavailable'
  | 'map-tools-policy-unsupported'
  | 'model-catalog-unavailable';

export type MapAgentCapability = {
  nativeMapTools: boolean;
  publicReasoningSummary: boolean;
  reason?: MapAgentUnsupportedReason;
};

export type SafeToolSummary = Record<string, string | number | boolean | null>;

export type MapRunStage = 'preparing' | 'analyzing' | 'validating' | 'previewing' | 'committing';

export type MapRunStatus = 'queued' | 'running' | 'awaiting_input' | 'succeeded' | 'failed' | 'canceled';

export interface LocalAgentInfo {
  id: string;
  label: string;
  available: boolean;
  mapDesign: MapAgentCapability;
  executable?: string;
  version?: string;
  models?: LocalAgentModelOption[];
  supportsReasoning?: boolean;
  supportsServiceTier?: boolean;
  supportsCustomModel?: boolean;
  modelCatalogSource: AgentModelCatalogSource;
  modelCatalogWarning?: string;
}

export interface LocalAgentListResponse {
  agents: LocalAgentInfo[];
}

const agentIdentifierSchema = z.string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^(?!-)[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'Identifiers must not begin with a hyphen.');
const catalogOptionSchema = agentIdentifierSchema.max(128);

export const AgentModelCatalogSourceSchema = z.enum([
  'live',
  'remembered',
  'fallback',
]);
export const MapAgentUnsupportedReasonSchema = z.enum([
  'native-tools-unavailable',
  'agent-unavailable',
  'map-tools-policy-unsupported',
  'model-catalog-unavailable',
]);
export const MapAgentCapabilitySchema = z.object({
  nativeMapTools: z.boolean(),
  publicReasoningSummary: z.boolean(),
  reason: MapAgentUnsupportedReasonSchema.optional(),
}).strict();
export const LocalAgentModelOptionSchema = z.object({
  id: agentIdentifierSchema,
  label: z.string().trim().min(1).max(256),
  description: z.string().trim().min(1).max(2_048).optional(),
  enabled: z.boolean(),
  default: z.boolean(),
  reasoningOptions: z.array(catalogOptionSchema).max(64),
  serviceTierOptions: z.array(catalogOptionSchema).max(64),
  defaultReasoning: catalogOptionSchema.optional(),
  defaultServiceTier: catalogOptionSchema.optional(),
}).strict().superRefine((model, context) => {
  if (model.defaultReasoning && !model.reasoningOptions.includes(model.defaultReasoning)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultReasoning'], message: 'Default reasoning must be selectable.' });
  }
  if (model.defaultServiceTier && !model.serviceTierOptions.includes(model.defaultServiceTier)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultServiceTier'], message: 'Default service tier must be selectable.' });
  }
});
export const LocalAgentInfoSchema = z.object({
  id: agentIdentifierSchema,
  label: z.string().trim().min(1).max(256),
  available: z.boolean(),
  mapDesign: MapAgentCapabilitySchema,
  executable: z.string().trim().min(1).max(1_024).optional(),
  version: z.string().trim().min(1).max(256).optional(),
  models: z.array(LocalAgentModelOptionSchema).max(1_024).optional(),
  supportsReasoning: z.boolean().optional(),
  supportsServiceTier: z.boolean().optional(),
  supportsCustomModel: z.boolean().optional(),
  modelCatalogSource: AgentModelCatalogSourceSchema,
  modelCatalogWarning: z.string().trim().min(1).max(2_048).optional(),
}).strict();
export const LocalAgentListResponseSchema = z.object({
  agents: z.array(LocalAgentInfoSchema).max(256),
}).strict();
