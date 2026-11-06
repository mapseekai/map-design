import { z } from 'zod';

import {
  MapDigestSchema,
  MapDesignProjectReadSchema,
  MapIdentifierSchema,
  MapProjectLifecycleSchema,
  MapSafeRevisionSchema,
  MapSourceKindSchema,
  MapTimestampSchema,
  MapValidationStatusSchema,
} from './project.js';

import { MapDesignRuntimeSelectionSchema } from './studio.js';
import { CartographySummarySchema } from './cartography.js';

export const MapSourceReferenceSchema = z.strictObject({
  url: z.string().url().max(4_096),
});
export type MapSourceReference = z.infer<typeof MapSourceReferenceSchema>;

export const MapSourcePreflightInputSchema = z.strictObject({
  source: MapSourceReferenceSchema,
});
export type MapSourcePreflightInput = z.infer<typeof MapSourcePreflightInputSchema>;

export const MapSourcePreviewDescriptorSchema = z.strictObject({
  previewId: MapIdentifierSchema,
  styleUrl: z.string().min(1).max(4_096),
  expiresAt: MapTimestampSchema,
});
export type MapSourcePreviewDescriptor = z.infer<typeof MapSourcePreviewDescriptorSchema>;

export const MapSourcePreflightOutputSchema = z.strictObject({
  kind: MapSourceKindSchema,
  requestedHost: z.string().min(1).max(512),
  finalHost: z.string().min(1).max(512),
  redirectCount: z.number().int().min(0).max(5),
  reachability: z.literal('reachable'),
  security: z.strictObject({
    scheme: z.enum(['http', 'https']),
    allResolvedAddressesPublic: z.literal(true),
    credentialsPresent: z.literal(false),
  }),
  mediaType: z.string().min(1).max(128),
  byteLength: z.number().int().nonnegative().nullable(),
  preview: MapSourcePreviewDescriptorSchema,
}).superRefine((value, context) => {
  const expected = `/api/map-design/source-previews/${encodeURIComponent(value.preview.previewId)}/style`;
  if (value.preview.styleUrl !== expected) {
    context.addIssue({
      code: 'custom',
      path: ['preview', 'styleUrl'],
      message: 'Preview Style URL must match its preview identifier.',
    });
  }
});
export type MapSourcePreflightOutput = z.infer<typeof MapSourcePreflightOutputSchema>;

export const MapProjectImportInputSchema = z.strictObject({
  source: MapSourceReferenceSchema,
  designRequirement: z.string().trim().min(1).max(16_384),
  idempotencyKey: MapIdentifierSchema,
});
export type MapProjectImportInput = z.infer<typeof MapProjectImportInputSchema>;

export const MapDesignProjectCreateInputSchema = z.strictObject({
  cartographyId: MapDigestSchema.optional(),
  projectId: MapIdentifierSchema,
  title: z.string().trim().min(1).max(256),
  source: MapSourceReferenceSchema,
  designRequirement: z.string().trim().min(1).max(16_384),
  runtime: MapDesignRuntimeSelectionSchema,
  workingDirectory: z.strictObject({
    path: z.string().trim().min(1).max(4_096),
    token: z.string().trim().min(16).max(4_096),
  }).optional(),
  idempotencyKey: MapIdentifierSchema,
});
export type MapDesignProjectCreateInput = z.infer<typeof MapDesignProjectCreateInputSchema>;

export const MapDesignProjectCreateOutputSchema = z.strictObject({
  cartography: CartographySummarySchema.optional(),
  project: MapDesignProjectReadSchema,
  conversationId: MapIdentifierSchema.nullable(),
  title: z.string().trim().min(1).max(256),
  runtime: MapDesignRuntimeSelectionSchema,
});
export type MapDesignProjectCreateOutput = z.infer<typeof MapDesignProjectCreateOutputSchema>;

export const MapProjectRetryInputSchema = z.strictObject({
  idempotencyKey: MapIdentifierSchema,
});
export type MapProjectRetryInput = z.infer<typeof MapProjectRetryInputSchema>;

export const DEFAULT_MAP_DESIGN_SYSTEM_ID = 'monet' as const;

export const MapDesignProjectSummarySchema = z.strictObject({
  projectId: MapIdentifierSchema,
  title: z.string().min(1).max(256),
  lifecycle: MapProjectLifecycleSchema,
  sourceKind: MapSourceKindSchema.nullable(),
  draftRevision: MapSafeRevisionSchema,
  committedRevision: MapSafeRevisionSchema.nullable(),
  validationStatus: MapValidationStatusSchema,
  updatedAt: MapTimestampSchema,
});
export type MapDesignProjectSummary = z.infer<typeof MapDesignProjectSummarySchema>;

export const MapDesignProjectRenameInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(256),
});
export const MapDesignProjectRenameOutputSchema = MapDesignProjectSummarySchema.pick({
  projectId: true, title: true, updatedAt: true,
});

export const MapDesignProjectListOutputSchema = z.strictObject({
  projects: z.array(MapDesignProjectSummarySchema).max(100),
});
export type MapDesignProjectListOutput = z.infer<typeof MapDesignProjectListOutputSchema>;
