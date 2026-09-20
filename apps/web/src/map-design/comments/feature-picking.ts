import type { MapCommentTarget } from '@mapseekai/map-design-contracts';
import type { MapGeoJSONFeature, PointLike } from 'maplibre-gl';

type PersistedProperty = string | number | boolean | null;

export type PickedFeature = Pick<MapGeoJSONFeature, 'geometry' | 'id' | 'properties' | 'source' | 'sourceLayer'> & {
  layer: { id: string };
};

export interface FeatureCandidate {
  key: string;
  feature: PickedFeature;
  label: string;
  keyAttributes: Array<[string, PersistedProperty]>;
}

const MAX_PROPERTIES = 64;
const MAX_PROPERTY_BYTES = 16 * 1024;
const MAX_STRING_BYTES = 8 * 1024;
const encoder = new TextEncoder();
export const COMMENT_MARKER_PREFIX = '__map-design-comments:';

export function isCommentMarkerFeature(feature: PickedFeature): boolean {
  return feature.layer?.id.startsWith(COMMENT_MARKER_PREFIX) ?? false;
}

export function queryBox(point: { x: number; y: number }, tolerance = 4): [PointLike, PointLike] {
  return [[point.x - tolerance, point.y - tolerance], [point.x + tolerance, point.y + tolerance]];
}

export function deduplicateFeatureCandidates(features: readonly PickedFeature[]): FeatureCandidate[] {
  const candidates: FeatureCandidate[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    if (!feature.source || !feature.layer?.id || feature.layer.id.startsWith('__map-design-highlight:') || isCommentMarkerFeature(feature) || !commentableGeometry(feature.geometry)) continue;
    const key = identityKey(feature);
    if (seen.has(key)) continue;
    seen.add(key);
    const properties = persistedProperties(feature.properties);
    candidates.push({ key,
      feature,
      label: candidateLabel(feature.layer.id, properties),
      keyAttributes: Object.entries(properties).slice(0, 3),
    });
  }
  return candidates;
}

export function buildCommentTarget(feature: PickedFeature, anchor: [number, number]): MapCommentTarget {
  const target: MapCommentTarget = {
    layerId: feature.layer.id,
    sourceId: feature.source,
    properties: persistedProperties(feature.properties),
    anchor,
    geometryType: feature.geometry.type,
  };
  if (feature.sourceLayer) target.sourceLayer = feature.sourceLayer;
  if (usableFeatureId(feature.id)) target.featureId = feature.id;
  return target;
}

export function featureScopeAvailable(
  feature: Pick<PickedFeature, 'id' | 'source'>,
  generatedSources: ReadonlySet<string>,
  style?: { sources?: Record<string, unknown> } | null,
): boolean {
  if (!usableFeatureId(feature.id) || generatedSources.has(feature.source)) return false;
  const source = style?.sources?.[feature.source] as { type?: unknown; promoteId?: unknown; data?: unknown } | undefined;
  if (source?.type !== 'geojson' || source.promoteId != null || typeof source.data !== 'object' || source.data === null) return true;
  const data = source.data as { type?: unknown; features?: unknown; id?: unknown };
  const features = data.type === 'FeatureCollection' && Array.isArray(data.features) ? data.features
    : data.type === 'Feature' ? [data] : null;
  if (!features) return true;
  // Unpromoted string IDs can be coerced by tile encoding (e.g. to 0) while
  // paint expressions still see the original ID. Do not persist that mismatch.
  let matches = 0;
  for (const item of features) {
    const id = typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) return false;
    if (id === feature.id) matches++;
  }
  return matches === 1;
}

export function generatedSourceIds(style: { sources?: Record<string, unknown> } | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const [id, source] of Object.entries(style?.sources ?? {})) {
    if (typeof source === 'object' && source !== null && (source as { generateId?: unknown }).generateId === true) ids.add(id);
  }
  return ids;
}

export function persistedProperties(input: Record<string, unknown> | null | undefined): Record<string, PersistedProperty> {
  const output: Record<string, PersistedProperty> = Object.create(null) as Record<string, PersistedProperty>;
  let bytes = 2;
  for (const [key, value] of Object.entries(input ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!key || Object.keys(output).length >= MAX_PROPERTIES || !isPersistedProperty(value)) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    if (encoder.encode(key).length > 256 || (typeof value === 'string' && encoder.encode(value).length > MAX_STRING_BYTES)) continue;
    const nextBytes = encoder.encode(JSON.stringify({ [key]: value })).length;
    if (bytes + nextBytes > MAX_PROPERTY_BYTES) continue;
    output[key] = value;
    bytes += nextBytes;
  }
  return output;
}

function identityKey(feature: PickedFeature): string {
  const prefix = JSON.stringify([feature.layer.id, feature.source, feature.sourceLayer ?? '']);
  if (usableFeatureId(feature.id)) return `${prefix}:id:${typeof feature.id}:${String(feature.id)}`;
  return `${prefix}:fallback:${stableStringify(persistedProperties(feature.properties))}:${normalizedGeometry(feature.geometry)}`;
}

export function normalizeAnchor(anchor: [number, number]): [number, number] {
  return [((anchor[0] + 180) % 360 + 360) % 360 - 180, anchor[1]];
}

function usableFeatureId(id: PickedFeature['id']): id is string | number {
  return typeof id === 'string' ? id.length > 0 && id.length <= 256
    : typeof id === 'number' && Number.isSafeInteger(id);
}

function commentableGeometry(geometry: PickedFeature['geometry'] | null | undefined): geometry is PickedFeature['geometry'] {
  return Boolean(geometry);
}

function normalizedGeometry(geometry: PickedFeature['geometry']): string {
  return stableStringify(normalizeLongitude(geometry));
}

function normalizeLongitude(value: unknown): unknown {
  if (!Array.isArray(value)) {
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalizeLongitude(nested)]));
  }
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    const longitude = ((value[0] + 180) % 360 + 360) % 360 - 180;
    return [longitude, value[1], ...value.slice(2)];
  }
  return value.map(normalizeLongitude);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function candidateLabel(layerId: string, properties: Record<string, PersistedProperty>): string {
  const name = ['name', 'title', 'label', 'ref'].map((key) => properties[key]).find((value) => typeof value === 'string' && value.trim());
  return name ? `${String(name)} · ${layerId}` : layerId;
}

function isPersistedProperty(value: unknown): value is PersistedProperty {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number';
}
