import { z } from 'zod';

import {
  MapDigestSchema,
  MapIdentifierSchema,
  MapSafeRevisionSchema,
  MapTimestampSchema,
  MapValidationSummarySchema,
  StyleHashSchema,
} from './project.js';

export const MapPreviewStatusSchema = z.enum(['missing', 'rendering', 'current', 'stale', 'failed']);
export type MapPreviewStatus = z.infer<typeof MapPreviewStatusSchema>;

export const MapPreviewTerminalStatusSchema = z.enum(['succeeded', 'failed']);
export type MapPreviewTerminalStatus = z.infer<typeof MapPreviewTerminalStatusSchema>;

export const MapPreviewViewportSchema = z.strictObject({
  center: z.tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ]),
  zoom: z.number().min(0).max(24),
  bearing: z.number().min(-180).max(180),
  pitch: z.number().min(0).max(85),
  width: z.int().min(320).max(2_048),
  height: z.int().min(240).max(2_048),
  pixelRatio: z.number().min(0.5).max(2),
});
export type MapPreviewViewport = z.infer<typeof MapPreviewViewportSchema>;

export const DEFAULT_MAP_PREVIEW_VIEWPORT = {
  center: [0, 0],
  zoom: 1,
  bearing: 0,
  pitch: 0,
  width: 1280,
  height: 720,
  pixelRatio: 1,
} as const;

export const MapPreviewPngDescriptorSchema = z.strictObject({
  digest: MapDigestSchema,
  mediaType: z.literal('image/png'),
  byteLength: MapSafeRevisionSchema,
  width: z.int().min(320).max(2_048),
  height: z.int().min(240).max(2_048),
});
export type MapPreviewPngDescriptor = z.infer<typeof MapPreviewPngDescriptorSchema>;

export const MapPreviewReportDescriptorSchema = z.strictObject({
  digest: MapDigestSchema,
  mediaType: z.literal('application/json'),
  byteLength: MapSafeRevisionSchema,
});
export type MapPreviewReportDescriptor = z.infer<typeof MapPreviewReportDescriptorSchema>;

const mapPreviewEvidenceBase = {
  previewId: MapIdentifierSchema,
  draftRevision: MapSafeRevisionSchema,
  styleHash: StyleHashSchema,
  viewport: MapPreviewViewportSchema.optional(),
  report: MapPreviewReportDescriptorSchema,
  validationSummary: MapValidationSummarySchema,
  createdAt: MapTimestampSchema,
  expiresAt: MapTimestampSchema.optional(),
};

export const MapPreviewEvidenceSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...mapPreviewEvidenceBase,
    status: z.literal('succeeded'),
    png: MapPreviewPngDescriptorSchema,
  }),
  z.strictObject({
    ...mapPreviewEvidenceBase,
    status: z.literal('failed'),
    png: z.null(),
  }),
]);
export type MapPreviewEvidence = z.infer<typeof MapPreviewEvidenceSchema>;

export const MapPreviewRuntimeReportSchema = z.strictObject({
  failureStage: z.enum(['sync', 'viewport', 'render', 'capture']).optional(),
  previewId: MapIdentifierSchema,
  validationDigest: MapDigestSchema,
});
export type MapPreviewRuntimeReport = z.infer<typeof MapPreviewRuntimeReportSchema>;

const MAP_PREVIEW_PNG_BASE64_MAX_LENGTH = 11_184_812;
const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const encodedPngSchema = z.string()
  .regex(/^[A-Za-z0-9+/]*={0,2}$/u)
  .max(MAP_PREVIEW_PNG_BASE64_MAX_LENGTH)
  .refine((value) => canonicalBase64.test(value), { message: 'PNG must use valid base64 padding' })
  .refine((value) => (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0) <= 8 * 1024 * 1024, {
    message: 'PNG must not exceed 8 MiB after base64 decoding',
  });

const mapPreviewFulfillBase = {
  previewId: MapIdentifierSchema,
  draftRevision: MapSafeRevisionSchema,
  styleHash: StyleHashSchema,
  report: MapPreviewRuntimeReportSchema,
};

export const MapPreviewFulfillRequestSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...mapPreviewFulfillBase,
    status: z.literal('succeeded'),
    pngBase64: encodedPngSchema,
  }),
  z.strictObject({
    ...mapPreviewFulfillBase,
    status: z.literal('failed'),
    pngBase64: z.null(),
  }),
]).refine((value) => value.report.previewId === value.previewId, {
  path: ['report', 'previewId'],
  message: 'Preview report identity must match the fulfillment',
});
export type MapPreviewFulfillRequest = z.infer<typeof MapPreviewFulfillRequestSchema>;
