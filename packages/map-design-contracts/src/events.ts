import { z } from 'zod';

import {
  MapDigestSchema,
  MapIdentifierSchema,
  MapJsonValueSchema,
  MapProjectLifecycleSchema,
  MapSafeRevisionSchema,
  MapShortIdentifierSchema,
  MapTimestampSchema,
  MapValidationSummarySchema,
  StyleHashSchema,
} from './project.js';
import { MapPreviewTerminalStatusSchema, MapPreviewViewportSchema } from './preview.js';

const eventBase = {
  draftRevision: MapSafeRevisionSchema,
  styleHash: StyleHashSchema,
};

export const DraftUpdatedPayloadSchema = z.strictObject({
  ...eventBase,
  transaction: MapJsonValueSchema as z.ZodType<unknown>,
  changedLayers: z.array(MapIdentifierSchema).refine((values) => new Set(values).size === values.length),
  changedSources: z.array(MapIdentifierSchema).refine((values) => new Set(values).size === values.length),
});

export const ValidationUpdatedPayloadSchema = z.strictObject({
  ...eventBase,
  validationDigest: MapDigestSchema,
  summary: MapValidationSummarySchema,
});

export const PreviewUpdatedPayloadSchema = z.strictObject({
  ...eventBase,
  previewId: MapIdentifierSchema,
  status: MapPreviewTerminalStatusSchema,
});

export const RevisionCommittedPayloadSchema = z.strictObject({
  ...eventBase,
  revision: MapSafeRevisionSchema,
  committedAt: MapTimestampSchema,
});

export const DraftDiscardedPayloadSchema = z.strictObject({
  ...eventBase,
  restoredCommittedRevision: MapSafeRevisionSchema,
});

export const DraftRestoredPayloadSchema = z.strictObject({
  ...eventBase,
  restoredRevision: MapSafeRevisionSchema,
});

export const MapStudioEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('project.lifecycle.updated'),
    occurredAt: MapTimestampSchema,
    payload: z.strictObject({
      lifecycle: MapProjectLifecycleSchema,
      failure: z.strictObject({ code: MapShortIdentifierSchema, message: z.string().trim().min(1).max(2_048) }).nullable(),
    }),
  }),
  z.strictObject({ type: z.literal('draft.updated'), occurredAt: MapTimestampSchema, payload: DraftUpdatedPayloadSchema }),
  z.strictObject({
    type: z.literal('draft.reloaded'),
    occurredAt: MapTimestampSchema,
    payload: z.strictObject({
      ...eventBase,
      semanticDigest: MapDigestSchema,
      sourceDigest: MapDigestSchema,
      reason: z.enum(['event-gap', 'hash-mismatch', 'adapter-conflict', 'manual']),
    }),
  }),
  z.strictObject({ type: z.literal('validation.updated'), occurredAt: MapTimestampSchema, payload: ValidationUpdatedPayloadSchema }),
  z.strictObject({
    type: z.literal('preview.requested'),
    occurredAt: MapTimestampSchema,
    payload: z.strictObject({
      ...eventBase,
      previewId: MapIdentifierSchema,
      viewport: MapPreviewViewportSchema,
      expiresAt: MapTimestampSchema,
    }),
  }),
  z.strictObject({ type: z.literal('preview.updated'), occurredAt: MapTimestampSchema, payload: PreviewUpdatedPayloadSchema }),
  z.strictObject({ type: z.literal('revision.committed'), occurredAt: MapTimestampSchema, payload: RevisionCommittedPayloadSchema }),
  z.strictObject({ type: z.literal('draft.discarded'), occurredAt: MapTimestampSchema, payload: DraftDiscardedPayloadSchema }),
  z.strictObject({ type: z.literal('draft.restored'), occurredAt: MapTimestampSchema, payload: DraftRestoredPayloadSchema }),
  z.strictObject({
    type: z.literal('project.failed'),
    occurredAt: MapTimestampSchema,
    payload: z.strictObject({
      code: MapShortIdentifierSchema,
      message: z.string().trim().min(1).max(2_048),
    }),
  }),
]);
export type MapStudioEvent = z.infer<typeof MapStudioEventSchema>;
