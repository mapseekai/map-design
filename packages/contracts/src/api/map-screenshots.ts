import { z } from 'zod';

export const MAP_SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
export const MAP_SCREENSHOT_MAX_COUNT = 4;
export const MapScreenshotIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const MapScreenshotIdsSchema = z.array(MapScreenshotIdSchema).min(1).max(MAP_SCREENSHOT_MAX_COUNT)
  .refine((ids) => new Set(ids).size === ids.length, 'Screenshot references must be unique.');
const metadata = {
  draftRevision: z.number().int().nonnegative().safe(),
  styleHash: z.string().regex(/^[a-f0-9]{64}$/u),
  width: z.number().int().min(1).max(4096),
  height: z.number().int().min(1).max(4096),
  viewport: z.object({
    center: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
    zoom: z.number().min(0).max(24), bearing: z.number().min(-180).max(180), pitch: z.number().min(0).max(85),
  }).strict(),
};
export const MapScreenshotInputSchema = z.object({
  ...metadata,
  pngBase64: z.string().min(4).max(Math.ceil(MAP_SCREENSHOT_MAX_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u).refine((value) => value.length % 4 === 0, 'Invalid base64 length.'),
}).strict();
export type MapScreenshotInput = z.infer<typeof MapScreenshotInputSchema>;
export const MapScreenshotSchema = z.object({
  ...metadata, id: MapScreenshotIdSchema,
  projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  capturedAt: z.string().datetime(),
}).strict();
export type MapScreenshot = z.infer<typeof MapScreenshotSchema>;

export function mapScreenshotUrl(screenshot: Pick<MapScreenshot, 'projectId' | 'id'>): string {
  return `/api/map-design/projects/${encodeURIComponent(screenshot.projectId)}/screenshots/${encodeURIComponent(screenshot.id)}/image`;
}
