import { MAP_TEXT_ATTACHMENT_MAX_COUNT, MapTextAttachmentSchema, type MapTextAttachment } from './map-text-attachments.js';
import { z } from 'zod';

import type { MapRunStage, MapRunStatus, SafeToolSummary } from './agents.js';
import { MAP_SCREENSHOT_MAX_COUNT, MapScreenshotSchema, type MapScreenshot } from './map-screenshots.js';

export type MapDesignMessageRole = 'user' | 'assistant' | 'system';

export interface MapDesignMessageError {
  code: string;
  message: string;
}

export type MapDesignModelOrigin = 'catalog' | 'custom';

export interface MapDesignRuntimeSelectionInput {
  agentId: string;
  model?: string;
  modelOrigin?: MapDesignModelOrigin;
  reasoning?: string;
  serviceTier?: string;
}

export interface MapDesignConversationRuntimeChoice extends MapDesignRuntimeSelectionInput {
  revision: number;
  updatedAt: string;
}

export interface UpdateMapDesignConversationRuntimeRequest {
  expectedRevision: number;
  runtime: MapDesignRuntimeSelectionInput;
  clientRequestId: string;
}

export interface MapDesignConversationRuntimeResponse {
  /** Persisted CAS state; normalization never mutates this record implicitly. */
  runtime: MapDesignConversationRuntimeChoice;
  /** Safe catalog-backed choice used for rendering and the next Run. */
  effectiveRuntime: MapDesignConversationRuntimeChoice;
  normalizationNotice?: string;
}

export interface MapDesignRuntimeProvenance {
  agentId: string;
  agentVersion?: string | undefined;
  model: string;
  modelOrigin?: MapDesignModelOrigin | undefined;
  reasoning?: string | undefined;
  serviceTier?: string | undefined;
  adapter: string;
}

const maximumEventCount = 80;
const maximumPayloadBytes = 65_536;
const uncAbsolutePathPattern = /\\\\/;
const windowsAbsolutePathPattern = /[A-Za-z]:[\\/]/;

function isSafeSummaryIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}_-]/u.test(value);
}

function containsUnixAbsolutePath(value: string): boolean {
  const tokens = Array.from(value);

  return tokens.some((token, index) => token === '/'
    && !(isSafeSummaryIdentifierCharacter(tokens[index - 1]) && isSafeSummaryIdentifierCharacter(tokens[index + 1])));
}

function containsRawAbsolutePath(value: string): boolean {
  return containsUnixAbsolutePath(value)
    || uncAbsolutePathPattern.test(value)
    || windowsAbsolutePathPattern.test(value);
}

function payloadByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const runtimeIdentifierSchema = z.string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^(?!-)[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'Runtime identifiers must not begin with a hyphen.');
const runtimeOptionSchema = runtimeIdentifierSchema.max(128);
const runtimeRevisionSchema = z.number().int().nonnegative().safe();
export const MapDesignModelOriginSchema = z.enum(['catalog', 'custom']);

function requireModelForOrigin(
  runtime: {
    model?: string | undefined;
    modelOrigin?: MapDesignModelOrigin | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (runtime.modelOrigin !== undefined && runtime.model === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['modelOrigin'],
      message: 'Model origin requires a model identifier.',
    });
  }
}

export const MapDesignRuntimeSelectionInputSchema = z.object({
  agentId: runtimeIdentifierSchema,
  model: runtimeIdentifierSchema.optional(),
  modelOrigin: MapDesignModelOriginSchema.optional(),
  reasoning: runtimeOptionSchema.optional(),
  serviceTier: runtimeOptionSchema.optional(),
}).strict().superRefine(requireModelForOrigin);
export const MapDesignConversationRuntimeChoiceSchema = z.object({
  agentId: runtimeIdentifierSchema,
  model: runtimeIdentifierSchema.optional(),
  modelOrigin: MapDesignModelOriginSchema.optional(),
  reasoning: runtimeOptionSchema.optional(),
  serviceTier: runtimeOptionSchema.optional(),
  revision: runtimeRevisionSchema,
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine(requireModelForOrigin);
export const UpdateMapDesignConversationRuntimeRequestSchema = z.object({
  expectedRevision: runtimeRevisionSchema,
  runtime: MapDesignRuntimeSelectionInputSchema,
  clientRequestId: z.string().trim().min(1).max(128),
}).strict().superRefine((request, context) => {
  if (request.runtime.model !== undefined && request.runtime.modelOrigin === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['runtime', 'modelOrigin'],
      message: 'Runtime updates with a model must declare its origin.',
    });
  }
});
export const MapDesignConversationRuntimeResponseSchema = z.object({
  runtime: MapDesignConversationRuntimeChoiceSchema,
  effectiveRuntime: MapDesignConversationRuntimeChoiceSchema,
  normalizationNotice: z.string().trim().min(1).max(2_048).optional(),
}).strict();
export const MapDesignRuntimeProvenanceSchema = z.object({
  agentId: runtimeIdentifierSchema,
  agentVersion: z.string().trim().min(1).max(256).optional(),
  model: runtimeIdentifierSchema,
  modelOrigin: MapDesignModelOriginSchema.optional(),
  reasoning: runtimeOptionSchema.optional(),
  serviceTier: runtimeOptionSchema.optional(),
  adapter: runtimeIdentifierSchema,
}).strict();

const safeToolSummaryStringSchema = z
  .string()
  .refine((value) => !containsRawAbsolutePath(value), 'Raw absolute paths are not allowed.');
const safeToolSummaryValueSchema = z.union([
  safeToolSummaryStringSchema,
  z.number(),
  z.boolean(),
  z.null(),
]);

export const SafeToolSummarySchema: z.ZodType<SafeToolSummary> = z
  .record(safeToolSummaryStringSchema, safeToolSummaryValueSchema)
  .superRefine((summary, context) => {
    if (payloadByteLength(summary) > maximumPayloadBytes) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Tool summaries must not exceed 65,536 bytes.' });
    }
  });

const mapRunStageSchema: z.ZodType<MapRunStage> = z.enum([
  'preparing',
  'analyzing',
  'validating',
  'previewing',
  'committing',
]);
const mapRunStatusSchema: z.ZodType<MapRunStatus> = z.enum([
  'queued',
  'running',
  'awaiting_input',
  'succeeded',
  'failed',
  'canceled',
]);

export type PersistedMapAgentEvent =
  | { kind: 'status'; label: MapRunStage }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; summary: SafeToolSummary }
  | { kind: 'tool_result'; toolUseId: string; status: 'succeeded' | 'failed' | 'canceled'; summary: SafeToolSummary }
  | { kind: 'text'; text: string }
  | { kind: 'run_finished'; status: Extract<MapRunStatus, 'succeeded' | 'failed' | 'canceled'> };

export const PersistedMapAgentEventSchema: z.ZodType<PersistedMapAgentEvent> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), label: mapRunStageSchema }).strict(),
  z.object({ kind: z.literal('thinking'), text: z.string() }).strict(),
  z.object({ kind: z.literal('tool_use'), id: z.string(), name: z.string(), summary: SafeToolSummarySchema }).strict(),
  z.object({ kind: z.literal('tool_result'), toolUseId: z.string(), status: z.enum(['succeeded', 'failed', 'canceled']), summary: SafeToolSummarySchema }).strict(),
  z.object({ kind: z.literal('text'), text: z.string() }).strict(),
  z.object({ kind: z.literal('run_finished'), status: z.enum(['succeeded', 'failed', 'canceled']) }).strict(),
]);

export const PersistedMapAgentEventsSchema: z.ZodType<PersistedMapAgentEvent[]> = z
  .array(PersistedMapAgentEventSchema)
  .max(maximumEventCount)
  .superRefine((events, context) => {
    if (payloadByteLength(events) > maximumPayloadBytes) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event snapshots must not exceed 65,536 bytes.' });
    }
  });

interface MapDesignMessageBase {
  id: string;
  conversationId: string;
  content: string;
  events: PersistedMapAgentEvent[];
  runStatus: MapRunStatus;
  startedAt: number;
  endedAt: number;
}

export type MapDesignMessage =
  | (MapDesignMessageBase & { role: 'assistant'; runtime?: MapDesignRuntimeProvenance | undefined })
  | (MapDesignMessageBase & { role: 'user'; runtime?: never; screenshots?: MapScreenshot[] | undefined; attachments?: MapTextAttachment[] | undefined })
  | (MapDesignMessageBase & { role: 'system'; runtime?: never });

const mapDesignMessageBaseSchema = {
  id: z.string(),
  conversationId: z.string(),
  content: z.string(),
  events: PersistedMapAgentEventsSchema,
  runStatus: mapRunStatusSchema,
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative(),
};

export const MapDesignMessageSchema = z
  .discriminatedUnion('role', [
    z.object({
      ...mapDesignMessageBaseSchema,
      role: z.literal('assistant'),
      runtime: MapDesignRuntimeProvenanceSchema.optional(),
    }).strict(),
    z.object({ ...mapDesignMessageBaseSchema, role: z.literal('user'), screenshots: z.array(MapScreenshotSchema).max(MAP_SCREENSHOT_MAX_COUNT).optional(), attachments: z.array(MapTextAttachmentSchema).max(MAP_TEXT_ATTACHMENT_MAX_COUNT).optional() }).strict(),
    z.object({ ...mapDesignMessageBaseSchema, role: z.literal('system') }).strict(),
  ])
  .superRefine((message, context) => {
    if (payloadByteLength(message) > maximumPayloadBytes) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Messages must not exceed 65,536 bytes.' });
    }
  });

export interface MapDesignConversation {
  id: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  messages: MapDesignMessage[];
}

export interface MapDesignConversationSummary {
  conversationId: string;
  projectId: string;
  title: string;
  titleIsDefault: boolean;
  messageCount: number;
  createdAt: string;
  lastActivityAt: string;
  runState: 'idle' | 'running';
}

export interface MapDesignConversationListResponse {
  conversations: MapDesignConversationSummary[];
}

export interface CreateMapDesignConversationInput {
  idempotencyKey: string;
}

export interface CreateMapDesignConversationResponse {
  conversation: MapDesignConversationSummary;
}
