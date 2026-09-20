import { z } from 'zod';
import { CartographySampleBindingsSchema } from './cartography-sample.js';
import { CartographyDescriptionSchema, CartographyPreviewSchema, CartographySourceSchema, CartographySummarySchema } from './cartography.js';
import { MapDigestSchema, MapSafeRevisionSchema } from './project.js';

export const CartographyEditRuntimeSchema = z.enum(['api', 'codex']);
export const CartographyEditCreateSchema = z.strictObject({
  source: CartographySourceSchema,
  description: CartographyDescriptionSchema.default(''),
  reportMarkdown: z.string().max(2 * 1024 * 1024).default(''),
  runtime: CartographyEditRuntimeSchema.default('api'),
  initialPrompt: z.string().trim().min(1).max(8000),
});
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
  sampleBindings: CartographySampleBindingsSchema.optional(),
  initialAnalysisStarted: z.boolean().optional(),
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
export const CartographyEditSaveSchema = z.strictObject({ expectedRevision: MapSafeRevisionSchema });
export const CartographyEditSaveOutputSchema = z.strictObject({ session: CartographyEditSessionSchema, document: CartographySummarySchema });
export type CartographyEditCreate = z.input<typeof CartographyEditCreateSchema>;
export type CartographyEditTurn = z.infer<typeof CartographyEditTurnSchema>;
export type CartographyEditReply = z.infer<typeof CartographyEditReplySchema>;
export type CartographyEditSession = z.infer<typeof CartographyEditSessionSchema>;
