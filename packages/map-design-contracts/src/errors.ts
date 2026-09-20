import { z } from 'zod';

import {
  MapIdentifierSchema,
  MapJsonValueSchema,
  MapSafeRevisionSchema,
  mapJsonByteLength,
} from './project.js';

export const MAP_ERROR_DETAILS_MAX_BYTES = 64 * 1024;

export const MAP_TOOL_ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'STYLE_INVALID',
  'SEMANTIC_INVALID',
  'DESIGN_SYSTEM_VIOLATION',
  'SOURCE_UNAVAILABLE',
  'PREVIEW_FAILED',
  'PREVIEW_STALE',
  'RUN_NOT_AUTHORIZED',
  'PROJECT_NOT_READY',
  'RUNTIME_CONFLICT',
  'INTERNAL',
] as const;

export const MapToolErrorCodeSchema = z.enum(MAP_TOOL_ERROR_CODES);
export type MapToolErrorCode = z.infer<typeof MapToolErrorCodeSchema>;

export const MapToolEnvelopeMetaSchema = z.strictObject({
  requestId: MapIdentifierSchema,
  projectId: MapIdentifierSchema,
  runId: MapIdentifierSchema,
  draftRevision: MapSafeRevisionSchema.optional(),
});
export type MapToolEnvelopeMeta = z.infer<typeof MapToolEnvelopeMetaSchema>;

export const MapPublicErrorDetailsSchema = MapJsonValueSchema.refine(
  (value) => mapJsonByteLength(value) <= MAP_ERROR_DETAILS_MAX_BYTES,
  { message: `Public error details must not exceed ${MAP_ERROR_DETAILS_MAX_BYTES} bytes` },
);
export type MapPublicErrorDetails = z.infer<typeof MapPublicErrorDetailsSchema>;

export const MapToolErrorSchema = z.strictObject({
  code: MapToolErrorCodeSchema,
  message: z.string().trim().min(1).max(2_048),
  retryable: z.boolean(),
  details: MapPublicErrorDetailsSchema.optional(),
});
export type MapToolError = z.infer<typeof MapToolErrorSchema>;

export type MapToolEnvelope<T> = {
  ok: true;
  data: T;
  meta: MapToolEnvelopeMeta;
} | {
  ok: false;
  error: MapToolError;
  meta: MapToolEnvelopeMeta;
};

export const MapToolEnvelopeSchema = <T extends z.ZodType>(dataSchema: T) => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    data: dataSchema,
    meta: MapToolEnvelopeMetaSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    error: MapToolErrorSchema,
    meta: MapToolEnvelopeMetaSchema,
  }),
]);
