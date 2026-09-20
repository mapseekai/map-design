import {
  MAP_TEXT_ATTACHMENT_MAX_BYTES, MAP_TEXT_ATTACHMENT_MAX_COUNT, MAP_TEXT_ATTACHMENT_MAX_TOTAL_BYTES,
  MapTextAttachmentInputSchema, MapTextAttachmentSchema, type MapTextAttachment,
} from '@mapseekai/contracts';
import { request } from '../../api/request';

export type TextAttachmentSelectionError = 'unsupported' | 'tooLarge' | 'tooMany' | 'tooMuch';

export function validateTextAttachmentSelection(files: readonly File[], current: readonly MapTextAttachment[]): TextAttachmentSelectionError | null {
  if (files.some((file) => !MapTextAttachmentInputSchema.shape.fileName.safeParse(file.name).success)) return 'unsupported';
  if (files.some((file) => file.size > MAP_TEXT_ATTACHMENT_MAX_BYTES)) return 'tooLarge';
  if (files.length + current.length > MAP_TEXT_ATTACHMENT_MAX_COUNT) return 'tooMany';
  if (files.reduce((total, file) => total + file.size, 0) + current.reduce((total, file) => total + file.byteLength, 0) > MAP_TEXT_ATTACHMENT_MAX_TOTAL_BYTES) return 'tooMuch';
  return null;
}

export async function uploadTextAttachment(projectId: string, file: File, signal: AbortSignal): Promise<MapTextAttachment> {
  if (validateTextAttachmentSelection([file], [])) throw new TypeError('Invalid text attachment.');
  signal.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  const contentBase64 = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
  return request<MapTextAttachment>(`/api/map-design/projects/${encodeURIComponent(projectId)}/attachments`, {
    method: 'POST', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify(MapTextAttachmentInputSchema.parse({ fileName: file.name, contentBase64 })),
  }, (value) => {
    const parsed = MapTextAttachmentSchema.safeParse(value);
    return parsed.success && parsed.data.projectId === projectId;
  });
}
