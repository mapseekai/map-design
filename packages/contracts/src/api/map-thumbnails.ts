import { z } from 'zod';

// Retain enough detail for project cards on high-density displays.
export const MAP_THUMBNAIL_MAX_BASE64 = 1_400_000;
export const MAP_THUMBNAIL_MAX_DIMENSION = 1280;
export const MapThumbnailInputSchema = z.object({
  pngBase64: z.string().min(4).max(MAP_THUMBNAIL_MAX_BASE64)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u).refine(value => value.length % 4 === 0),
  width: z.number().int().min(1).max(MAP_THUMBNAIL_MAX_DIMENSION),
  height: z.number().int().min(1).max(MAP_THUMBNAIL_MAX_DIMENSION),
  capturedAt: z.number().int().nonnegative().safe(),
}).strict();
export type MapThumbnailInput = z.infer<typeof MapThumbnailInputSchema>;

export function mapThumbnailUrl(projectId: string): string {
  return `/api/map-design/projects/${encodeURIComponent(projectId)}/thumbnail`;
}
