import {
  MapCommentInputSchema, MapCommentListSchema, MapCommentSchema,
  type MapComment, type MapCommentInput,
} from '@mapseekai/map-design-contracts';
import { request } from '../../api/request';

const path = (projectId: string) => `/api/map-design/projects/${encodeURIComponent(projectId)}/comments`;

export async function listMapComments(projectId: string, signal?: AbortSignal): Promise<MapComment[]> {
  return request<MapComment[]>(path(projectId), { signal }, (value) => MapCommentListSchema.safeParse(value).success);
}

export async function saveMapComment(projectId: string, input: MapCommentInput, signal?: AbortSignal): Promise<MapComment> {
  return request<MapComment>(path(projectId), {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify(MapCommentInputSchema.parse(input)),
  }, (value) => MapCommentSchema.safeParse(value).success);
}

export async function deleteMapComment(projectId: string, id: string, version: number, signal?: AbortSignal): Promise<void> {
  await request(`${path(projectId)}/${encodeURIComponent(id)}?version=${version}`, { method: 'DELETE', signal }, (value) => value === null);
}
