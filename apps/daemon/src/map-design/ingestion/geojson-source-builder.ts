import { check } from '@placemarkio/check-geojson';
import type { MapDesignResourceScope } from '@mapseekai/map-design-contracts';
import {
  analyzeGeoJson,
  validateStyleDocument,
  type StyleDocument,
} from 'maplibre-style-tools/core';

import { canonicalJson, canonicalJsonBytes } from '../storage/canonical-json.js';
import type { MapDesignBlobStore } from '../storage/types.js';
import type { LoadedMapDesignSystem } from '../validation/design-system-loader.js';
import type { DetectedMapSource } from './source-detector.js';
import {
  buildSourceManifest,
  buildStyleSemantics,
  createResourceId,
  finalizeInitialMapBuild,
  resourceGatewayPath,
  type InitialMapBuild,
  type ResourceDescriptor,
} from './resource-manifest-builder.js';

export async function buildGeoJsonSource(input: {
  projectId: string;
  source: DetectedMapSource;
  approvedFinalUrl: URL;
  etag: string | null;
  capturedAt: string;
  blobStore: Pick<MapDesignBlobStore, 'putBytes'>;
  designSystem: LoadedMapDesignSystem;
  resourceScope?: MapDesignResourceScope;
}): Promise<InitialMapBuild> {
  if (input.source.kind !== 'geojson') throw new TypeError('Expected a detected GeoJSON source');
  const text = canonicalJson(input.source.document);
  const document = check(text);
  const analysis = analyzeGeoJson(document);
  if (!analysis.ok || !analysis.analysis.available) throw new TypeError('GeoJSON analysis failed');
  const bytes = canonicalJsonBytes(document);
  const blob = await input.blobStore.putBytes(
    input.projectId,
    'resources',
    bytes,
    'application/geo+json',
  );
  const sourceUrl = input.approvedFinalUrl.href;
  const id = createResourceId('geojson', sourceUrl);
  const resource: ResourceDescriptor = {
    id,
    kind: 'geojson',
    mode: 'captured',
    mediaType: 'application/geo+json',
    sourceUrl,
    etag: input.etag,
    byteLength: blob.byteLength,
    contentDigest: blob.digest,
  };
  const counts = analysis.analysis.geometryTypes;
  const layers: Array<Record<string, unknown>> = [];
  if ((counts.Polygon ?? 0) + (counts.MultiPolygon ?? 0) > 0) {
    layers.push({ id: 'polygons', type: 'fill', source: 'data', paint: { 'fill-color': '#7ba38c', 'fill-opacity': 0.55 } });
  }
  if ((counts.LineString ?? 0) + (counts.MultiLineString ?? 0) > 0) {
    layers.push({ id: 'lines', type: 'line', source: 'data', paint: { 'line-color': '#40596b', 'line-width': 2 } });
  }
  if ((counts.Point ?? 0) + (counts.MultiPoint ?? 0) > 0) {
    layers.push({ id: 'points', type: 'circle', source: 'data', paint: { 'circle-color': '#d26a4a', 'circle-radius': 5 } });
  }
  if (layers.length === 0) layers.push({ id: 'background', type: 'background', paint: { 'background-color': '#f4f3ee' } });
  const candidate = {
    version: 8,
    sources: {
      data: {
        type: 'geojson',
        data: resourceGatewayPath(input.projectId, id, 'data.geojson', input.resourceScope),
      },
    },
    layers,
  };
  const validated = validateStyleDocument(candidate);
  if (!validated.ok) throw new TypeError('Generated GeoJSON Style is structurally invalid');
  const style: StyleDocument = validated.style;
  const semantics = buildStyleSemantics(style);
  const sourceManifest = buildSourceManifest({
    kind: 'geojson',
    mediaType: input.source.mediaType,
    sourceBytes: bytes,
    resourceCount: 1,
    capturedAt: input.capturedAt,
  });
  return finalizeInitialMapBuild({
    style,
    semantics,
    sourceManifest,
    resources: [resource],
    designSystem: input.designSystem,
  });
}
