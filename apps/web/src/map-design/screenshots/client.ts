import { MapScreenshotInputSchema, MapScreenshotSchema, type MapScreenshot, type MapScreenshotInput } from '@mapseekai/contracts';
import { request } from '../../api/request';

export async function saveMapScreenshot(projectId: string, input: MapScreenshotInput, signal?: AbortSignal): Promise<MapScreenshot> {
  return request<MapScreenshot>(`/api/map-design/projects/${encodeURIComponent(projectId)}/screenshots`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal, body: JSON.stringify(MapScreenshotInputSchema.parse(input)),
  }, (value) => MapScreenshotSchema.safeParse(value).success);
}
