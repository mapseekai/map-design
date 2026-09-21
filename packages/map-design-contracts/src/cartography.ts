import { z } from 'zod';
import { MapDesignRuntimeSelectionSchema } from './studio.js';
import { CartographySampleBindingsSchema } from './cartography-sample.js';
import { MapDigestSchema, mapStringByteLength } from './project.js';

export const CARTOGRAPHY_MAX_BYTES = 64 * 1024;
export const CartographySourceSchema = z.string().min(1).max(CARTOGRAPHY_MAX_BYTES)
  .refine((source) => mapStringByteLength(source) <= CARTOGRAPHY_MAX_BYTES, 'CARTOGRAPHY.md exceeds 64 KiB');
export const CartographyDescriptionSchema = z.string().trim().max(2048);
export const CartographyMetadataInputSchema = z.strictObject({ description: CartographyDescriptionSchema.optional(), name: z.string().trim().min(1).max(256).optional() }).refine(value => value.description !== undefined || value.name !== undefined);
export const CartographyImportInputSchema = z.strictObject({ source: CartographySourceSchema, description: CartographyDescriptionSchema.optional(), sampleBindings: CartographySampleBindingsSchema.optional() });
// Preview paint is data, never an SVG resource URL or executable markup.
export const CartographyPreviewColorSchema = z.string().max(96).regex(/^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(?:rgb|hsl)a?\([\d\s.,%/+\-]+\))$/i);
export const CartographyMapElementSchema = z.object({
  name: z.string().max(128), geometry: z.enum(['background', 'point', 'line', 'polygon', 'label']),
  family: z.string().max(128).optional(), role: z.string().max(128).optional(),
  color: CartographyPreviewColorSchema.optional(), fillColor: CartographyPreviewColorSchema.optional(),
  strokeColor: CartographyPreviewColorSchema.optional(), outlineColor: CartographyPreviewColorSchema.optional(),
  casingColor: CartographyPreviewColorSchema.optional(), haloColor: CartographyPreviewColorSchema.optional(),
  strokeWidth: z.number().min(0).max(64).optional(), outlineWidth: z.number().min(0).max(64).optional(),
  casingWidth: z.number().min(0).max(64).optional(), haloWidth: z.number().min(0).max(16).optional(),
  size: z.number().min(0).max(128).optional(), fontSize: z.number().min(1).max(96).optional(),
  opacity: z.number().min(0).max(1).optional(), fillOpacity: z.number().min(0).max(1).optional(), strokeOpacity: z.number().min(0).max(1).optional(),
  fontFamily: z.array(z.string().max(80)).min(1).max(8).optional(),
  dash: z.array(z.number().positive().max(128)).min(2).max(16).optional(),
  unsupported: z.array(z.string().max(64)).max(32),
});
export type CartographyMapElement = z.infer<typeof CartographyMapElementSchema>;
export const CartographyPreviewSchema = z.object({
  sampleBindings: CartographySampleBindingsSchema.optional(),
  elements: z.array(CartographyMapElementSchema).max(256).optional(),
  palette: z.array(z.object({ name: z.string().max(128), color: CartographyPreviewColorSchema })).max(1024),
  typography: z.array(z.object({
    name: z.string().max(128),
    fontFamily: z.string().max(512),
    fontSize: z.string().max(32).optional(),
    fontWeight: z.union([z.number().min(1).max(1000), z.enum(['normal', 'bold'])]).optional(),
  })).max(128).optional(),
});
export type CartographyPreview = z.infer<typeof CartographyPreviewSchema>;
export const CartographySummarySchema = z.object({
  // Legacy library documents were user imports; only explicitly tagged entries are presets.
  origin: z.enum(['user', 'preset']).optional(),
  id: MapDigestSchema,
  name: z.string().min(1).max(256),
  description: z.string().max(2048),
  updatedAt: z.string().datetime().nullable().optional(),
  version: z.string().min(1).max(64),
  preview: CartographyPreviewSchema.optional(),
});
export const CartographyDocumentSchema = CartographySummarySchema.extend({ source: CartographySourceSchema });
export const CartographyListOutputSchema = z.strictObject({ documents: z.array(CartographySummarySchema) });
export type CartographySummary = z.infer<typeof CartographySummarySchema>;
export type CartographyDocument = z.infer<typeof CartographyDocumentSchema>;

export const CARTOGRAPHY_STYLE_MAX_BYTES = 4 * 1024 * 1024;
export const CartographyUrlInputSchema = z.strictObject({ url: z.string().url().max(8192), description: CartographyDescriptionSchema.optional() });
export const CartographyInitializeInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(256),
  fileName: z.string().min(1).max(256).regex(/^[^/\\]+\.(json|qgs|qgz|lyrx|stylx|sld|xml)$/i),
  content: z.string().min(1).max(Math.ceil(CARTOGRAPHY_STYLE_MAX_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export const CartographyInitializeUrlInputSchema = z.strictObject({
  name: CartographyInitializeInputSchema.shape.name,
  url: CartographyUrlInputSchema.shape.url,
  fileName: CartographyInitializeInputSchema.shape.fileName.optional(),
});
export type CartographyInitializeUrlInput = z.infer<typeof CartographyInitializeUrlInputSchema>;
export const CartographyGenerateInputSchema = z.strictObject({
  jobId: z.string().uuid(),
  runtime: z.union([z.enum(['api', 'codex']), MapDesignRuntimeSelectionSchema]).default('codex'),
  name: z.string().trim().min(1).max(256), requirements: z.string().trim().min(1).max(8000),
});
export const CartographyDraftOutputSchema = z.strictObject({
  source: CartographySourceSchema,
  reportMarkdown: z.string().max(2 * 1024 * 1024),
  reportJson: z.string().max(2 * 1024 * 1024),
});
export type CartographyDraft = z.infer<typeof CartographyDraftOutputSchema>;
export type CartographyInitializeInput = z.infer<typeof CartographyInitializeInputSchema>;
export type CartographyGenerateInput = z.infer<typeof CartographyGenerateInputSchema>;

export const CartographyGenerationSchema = z.discriminatedUnion('status', [
  z.strictObject({ jobId: z.string().uuid(), status: z.literal('running') }),
  z.strictObject({ jobId: z.string().uuid(), status: z.literal('succeeded'), draft: CartographyDraftOutputSchema }),
  z.strictObject({ jobId: z.string().uuid(), status: z.literal('failed'), message: z.string() }),
]);
export type CartographyGeneration = z.infer<typeof CartographyGenerationSchema>;
