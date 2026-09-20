import {
  MapApplyTransactionOutputSchema,
  MapStyleEditInputSchema,
  type MapApplyTransactionOutput,
  type MapStyleEditInput,
} from '@mapseekai/map-design-contracts';

import { request } from '../../api/request';

export async function saveMapStyleEdit(
  projectId: string,
  input: MapStyleEditInput,
  signal?: AbortSignal,
): Promise<MapApplyTransactionOutput> {
  return request<MapApplyTransactionOutput>(
    `/api/map-design/projects/${encodeURIComponent(projectId)}/style-edits`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(MapStyleEditInputSchema.parse(input)),
      signal,
    },
    (value) => MapApplyTransactionOutputSchema.safeParse(value).success,
  );
}
