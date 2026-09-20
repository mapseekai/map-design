import { z } from 'zod';

import {
  MapDesignMessageSchema,
  PersistedMapAgentEventsSchema,
  type MapDesignMessage,
  type MapDesignMessageError,
  type PersistedMapAgentEvent,
} from '../api/conversations.js';
import type { MapDesignRunResponse } from '../api/runs.js';

export type MapDesignRunEvent =
  | { type: 'event_snapshot'; runId: string; messageId: string; events: PersistedMapAgentEvent[] }
  | { type: 'message_completed'; runId: string; message: MapDesignMessage }
  | { type: 'run_finished'; run: MapDesignRunResponse }
  | { type: 'error'; runId: string; error: MapDesignMessageError };

const mapDesignMessageErrorSchema: z.ZodType<MapDesignMessageError> = z
  .object({ code: z.string(), message: z.string() })
  .strict();
const mapDesignRunResponseSchema = z
  .object({
    runId: z.string(),
    projectId: z.string(),
    conversationId: z.string(),
    status: z.enum(['queued', 'running', 'awaiting_input', 'succeeded', 'failed', 'canceled']),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    error: mapDesignMessageErrorSchema.optional(),
  })
  .strict()
  .transform((response): MapDesignRunResponse => {
    const normalized: MapDesignRunResponse = {
      runId: response.runId,
      projectId: response.projectId,
      conversationId: response.conversationId,
      status: response.status,
    };

    if (response.startedAt !== undefined) normalized.startedAt = response.startedAt;
    if (response.finishedAt !== undefined) normalized.finishedAt = response.finishedAt;
    if (response.error !== undefined) normalized.error = response.error;

    return normalized;
  });

export const MapDesignRunEventSchema: z.ZodType<MapDesignRunEvent, z.ZodTypeDef, unknown> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('event_snapshot'),
    runId: z.string(),
    messageId: z.string(),
    events: PersistedMapAgentEventsSchema,
  }).strict(),
  z.object({ type: z.literal('message_completed'), runId: z.string(), message: MapDesignMessageSchema }).strict(),
  z.object({ type: z.literal('run_finished'), run: mapDesignRunResponseSchema }).strict(),
  z.object({ type: z.literal('error'), runId: z.string(), error: mapDesignMessageErrorSchema }).strict(),
]);
