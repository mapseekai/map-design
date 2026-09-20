import { MapApplyTransactionOutputSchema, MapStyleDocumentInputSchema, type MapApplyTransactionOutput, type MapStyleDocumentInput } from '@mapseekai/map-design-contracts';
import { request } from '../../api/request';

export function saveMapStyleDocument(projectId: string, input: MapStyleDocumentInput): Promise<MapApplyTransactionOutput> {
  return request(`/api/map-design/projects/${encodeURIComponent(projectId)}/style-document`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(MapStyleDocumentInputSchema.parse(input)),
  }, value => MapApplyTransactionOutputSchema.safeParse(value).success);
}
