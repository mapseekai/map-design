import { z } from 'zod';

import { MapStudioEventSchema } from './events.js';
import { MapIdentifierSchema, MapSafeRevisionSchema } from './project.js';

export const MapDesignRuntimeSelectionSchema = z.strictObject({
  agentId: MapIdentifierSchema,
  model: z.string().trim().min(1).max(256).optional(),
  reasoning: z.string().trim().min(1).max(64).optional(),
  serviceTier: z.string().trim().min(1).max(64).optional(),
});
export type MapDesignRuntimeSelection = z.infer<typeof MapDesignRuntimeSelectionSchema>;

export const MapStudioEventRecordSchema = z.strictObject({
  sequence: MapSafeRevisionSchema,
  event: MapStudioEventSchema,
});
export type MapStudioEventRecord = z.infer<typeof MapStudioEventRecordSchema>;

export const MapStudioEventReplaySchema = z.strictObject({
  events: z.array(MapStudioEventRecordSchema).max(1_000),
  oldestAvailableSequence: MapSafeRevisionSchema.nullable(),
  latestSequence: MapSafeRevisionSchema.nullable(),
  gap: z.boolean(),
});
export type MapStudioEventReplay = z.infer<typeof MapStudioEventReplaySchema>;
