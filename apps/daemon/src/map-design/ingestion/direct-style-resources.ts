import { assertExternalMapResourceUrl } from '@mapseekai/map-design-contracts';
import { validateStyleDocument, type StyleDocument } from 'maplibre-style-tools/core';
import { createResourceId, type ResourceDescriptor, type ResourceDescriptorBase } from './resource-manifest-builder.js';

/** Save the editable style locally, but let MapLibre load public dependencies on demand. */
export function resolveDirectStyleResources(input: { style: unknown; approvedFinalUrl: URL }): {
  style: StyleDocument; resources: ResourceDescriptor[];
} {
  const parsed = validateStyleDocument(input.style);
  if (!parsed.ok) throw new TypeError('Source Style is structurally invalid');
  const style = structuredClone(parsed.style);
  const resources = new Map<string, ResourceDescriptor>();
  const resolve = (value: string, kind: ResourceDescriptorBase['kind'], mediaType: string): string => {
    const sourceUrl = assertExternalMapResourceUrl(new URL(value, input.approvedFinalUrl).href);
    const id = createResourceId(kind, sourceUrl);
    resources.set(id, { id, kind, mode: 'remote', mediaType, sourceUrl, etag: null, byteLength: null, contentDigest: null });
    return sourceUrl;
  };
  const root = style as unknown as Record<string, unknown>;
  if (typeof root.glyphs === 'string') root.glyphs = resolve(root.glyphs, 'glyph', 'application/x-protobuf');
  if (typeof root.sprite === 'string') root.sprite = resolve(root.sprite, 'sprite', 'application/json');
  else if (Array.isArray(root.sprite)) for (const item of root.sprite) {
    if (item && typeof item.url === 'string') item.url = resolve(item.url, 'sprite', 'application/json');
  }
  if (Array.isArray(root.imports) && root.imports.length) throw new TypeError('Style imports are not supported');
  for (const source of Object.values(style.sources)) {
    const record = source as unknown as Record<string, unknown>;
    if (typeof record.url === 'string') record.url = resolve(record.url,
      record.type === 'image' ? 'image' : 'source-document', record.type === 'image' ? 'application/octet-stream' : 'application/json');
    if (Array.isArray(record.tiles)) record.tiles = record.tiles.map((url) => resolve(String(url), 'tile', 'application/octet-stream'));
    if (typeof record.data === 'string') record.data = resolve(record.data, 'geojson', 'application/geo+json');
    if (Array.isArray(record.urls)) record.urls = record.urls.map((url) => resolve(String(url), 'video', 'video/mp4'));
  }
  return { style, resources: [...resources.values()] };
}
