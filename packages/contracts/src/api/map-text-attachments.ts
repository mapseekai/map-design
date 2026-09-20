import { z } from 'zod';

export const MAP_TEXT_ATTACHMENT_MAX_BYTES = 65_536;
export const MAP_TEXT_ATTACHMENT_MAX_COUNT = 4;
export const MAP_TEXT_ATTACHMENT_MAX_TOTAL_BYTES = 131_072;
export const MapTextAttachmentIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const MapTextAttachmentIdsSchema = z.array(MapTextAttachmentIdSchema).min(1).max(MAP_TEXT_ATTACHMENT_MAX_COUNT)
  .refine((ids) => new Set(ids).size === ids.length, 'Attachment references must be unique.');
const fileNameSchema = z.string().min(1).max(255)
  .regex(/^[^\\/\x00-\x1f\x7f:]+\.(txt|md|csv|tsv|json|geojson)$/iu)
  .refine((name) => name.trim() === name && !name.startsWith('.'), 'A plain file name is required.');
export const MapTextAttachmentInputSchema = z.object({
  fileName: fileNameSchema,
  contentBase64: z.string().max(Math.ceil(MAP_TEXT_ATTACHMENT_MAX_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
}).strict();
export type MapTextAttachmentInput = z.infer<typeof MapTextAttachmentInputSchema>;
export const MapTextAttachmentSchema = z.object({
  id: MapTextAttachmentIdSchema,
  projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  fileName: fileNameSchema,
  mediaType: z.literal('text/plain'),
  byteLength: z.number().int().min(0).max(MAP_TEXT_ATTACHMENT_MAX_BYTES),
  createdAt: z.string().datetime(),
}).strict();
export type MapTextAttachment = z.infer<typeof MapTextAttachmentSchema>;
export function mapTextAttachmentUrl(attachment: Pick<MapTextAttachment, 'projectId' | 'id'>): string {
  return `/api/map-design/projects/${encodeURIComponent(attachment.projectId)}/attachments/${encodeURIComponent(attachment.id)}/content`;
}
