import { z } from 'zod';
import { CartographySampleBindingsSchema } from './cartography-sample.js';
import { CartographyStyleFileSchema, CartographyDescriptionSchema, CartographyPreviewSchema, CartographySourceSchema, CartographySummarySchema } from './cartography.js';
import { MapDigestSchema, MapSafeRevisionSchema } from './project.js';
import { MapDesignRuntimeSelectionSchema } from './studio.js';

export const CartographyEditRuntimeSchema = z.enum(['api', 'codex']);
export const CartographyEditCreateSchema = z.union([z.strictObject({
  sourceDocumentId: MapDigestSchema.optional(),
  source: CartographySourceSchema,
  sourceFile: CartographyStyleFileSchema.optional(),
  description: CartographyDescriptionSchema.default(''),
  reportMarkdown: z.string().max(2 * 1024 * 1024).default(''),
  runtime: CartographyEditRuntimeSchema.default('api'),
  initialPrompt: z.string().trim().min(1).max(8000),
}), z.strictObject({
  name: z.string().trim().min(1).max(256),
  requirements: z.string().trim().min(1).max(8000),
  description: CartographyDescriptionSchema.default(''),
  runtime: MapDesignRuntimeSelectionSchema.extend({ modelOrigin: z.enum(['catalog', 'custom']).optional() }),
})]);
export const CartographyEditTurnSchema = z.strictObject({
  requestId: z.string().uuid(),
  expectedRevision: MapSafeRevisionSchema,
  prompt: z.string().trim().min(1).max(8000),
  runtime: CartographyEditRuntimeSchema.optional(),
  conversationId: z.string().uuid().optional(),
  runtimeRevision: MapSafeRevisionSchema.optional(),
});
export const CartographyEditReplySchema = z.strictObject({
  message: z.string().trim().min(1).max(16_384), source: CartographySourceSchema,
  sampleBindings: CartographySampleBindingsSchema.optional(),
});
export const CartographyEditSessionSchema = z.strictObject({
  sourceDocumentId: MapDigestSchema.optional(),
  sampleBindings: CartographySampleBindingsSchema.optional(),
  initialAnalysisStarted: z.boolean().optional(),
  canOverwrite: z.boolean().optional(),
  activeConversationId: z.string().uuid().optional(),
  id: z.string().uuid(), name: z.string().min(1).max(256),
  source: CartographySourceSchema, description: CartographyDescriptionSchema,
  runtime: CartographyEditRuntimeSchema, initialPrompt: z.string().max(8000),
  revision: MapSafeRevisionSchema,
  status: z.enum(['idle', 'running', 'failed', 'canceled']),
  error: z.enum(['generation-failed', 'interrupted']).nullable(),
  savedId: MapDigestSchema.nullable(), savedRevision: MapSafeRevisionSchema.nullable(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  messages: z.array(z.strictObject({ id: z.string().uuid(), role: z.enum(['user', 'assistant']), content: z.string().max(16_384), createdAt: z.string().datetime() })).max(200),
  preview: CartographyPreviewSchema.optional(),
});
export const CartographyEditSaveSchema = z.union([
  z.strictObject({ expectedRevision: MapSafeRevisionSchema, mode: z.literal('overwrite') }),
  z.strictObject({ expectedRevision: MapSafeRevisionSchema, mode: z.literal('new'), name: z.string().trim().min(1).max(256) }),
  z.strictObject({ expectedRevision: MapSafeRevisionSchema }),
]);
export type CartographyEditSave = z.input<typeof CartographyEditSaveSchema>;
export const CartographyActiveEditsSchema = z.object({ sessions: z.array(z.object({
  id: z.string().uuid(), sourceDocumentId: MapDigestSchema.optional(),
})) });
export const CartographyEditHistorySchema = z.object({ sessions: z.array(CartographyEditSessionSchema.pick({
  id: true, name: true, createdAt: true, updatedAt: true, status: true, revision: true,
})) });
export const CartographyEditSaveOutputSchema = z.strictObject({ session: CartographyEditSessionSchema, document: CartographySummarySchema });
export type CartographyEditCreate = z.input<typeof CartographyEditCreateSchema>;
export type CartographyEditTurn = z.infer<typeof CartographyEditTurnSchema>;
export type CartographyEditReply = z.infer<typeof CartographyEditReplySchema>;
export type CartographyEditSession = z.infer<typeof CartographyEditSessionSchema>;
