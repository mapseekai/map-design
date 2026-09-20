import { MapTextAttachmentIdsSchema } from './map-text-attachments.js';
import type { ByokProviderSelection } from './app-config.js';
import { z } from 'zod';
import { MapScreenshotIdsSchema } from './map-screenshots.js';

export interface StartMapDesignRunRequest {
  projectId: string;
  conversationId: string;
  prompt: string;
  runtimeRevision: number;
  byokProvider?: MapDesignRunByokProviderSelection | undefined;
  locale?: string | undefined;
  viewedRevision?: number | undefined;
  clientRequestId: string;
  userMessageId: string;
  assistantMessageId: string;
  commentRefs?: Array<{ id: string; version: number }> | undefined;
  screenshotIds?: string[] | undefined;
  attachmentIds?: string[] | undefined;
}

/** Request-scoped BYOK credentials; model selection remains daemon-owned runtime state. */
export interface MapDesignRunByokProviderSelection {
  protocol: ByokProviderSelection['protocol'];
  apiKey: string;
  baseUrl?: string | undefined;
  apiVersion?: string | undefined;
  apiFormat?: 'chat-completions' | 'responses' | undefined;
  requiresApiKey?: boolean | undefined;
}

const mapRunIdentifierSchema = z.string().trim().min(1).max(256);
const byokProviderSelectionSchema = z.object({
  protocol: z.enum(['anthropic', 'openai', 'azure', 'google', 'ollama', 'aihubmix']),
  apiKey: z.string().min(1).max(16_384),
  baseUrl: z.string().url().max(2_048).optional(),
  apiVersion: z.string().trim().min(1).max(256).optional(),
  apiFormat: z.enum(['chat-completions', 'responses']).optional(),
  requiresApiKey: z.boolean().optional(),
}).strict();

export const StartMapDesignRunRequestSchema = z.object({
  projectId: mapRunIdentifierSchema,
  conversationId: mapRunIdentifierSchema,
  prompt: z.string().trim().min(1).max(65_536),
  runtimeRevision: z.number().int().nonnegative().safe(),
  byokProvider: byokProviderSelectionSchema.optional(),
  locale: z.string().trim().min(1).max(64).optional(),
  viewedRevision: z.number().int().nonnegative().safe().optional(),
  clientRequestId: mapRunIdentifierSchema,
  userMessageId: mapRunIdentifierSchema,
  assistantMessageId: mapRunIdentifierSchema,
  screenshotIds: MapScreenshotIdsSchema.optional(),
  attachmentIds: MapTextAttachmentIdsSchema.optional(),
  commentRefs: z.array(z.object({ id: mapRunIdentifierSchema, version: z.number().int().nonnegative().safe() }).strict())
    .min(1).max(20).refine((refs) => new Set(refs.map((ref) => ref.id)).size === refs.length, 'Comment references must be unique.').optional(),
}).strict();

export type MapDesignRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_input'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface MapDesignRunResponse {
  runId: string;
  projectId: string;
  conversationId: string;
  status: MapDesignRunStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: { code: string; message: string };
}

export interface CancelMapDesignRunResponse {
  runId: string;
  status: 'canceled';
}
