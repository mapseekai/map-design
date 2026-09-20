import type { MapDesignResourceScope } from '@mapseekai/map-design-contracts';
import { PMTiles, TileType } from 'pmtiles';
import { validateStyleDocument, type StyleDocument } from 'maplibre-style-tools/core';

import type { DetectedMapSource } from './source-detector.js';
import type { PinnedTransport } from './pinned-transport.js';
import type { LoadedMapDesignSystem } from '../validation/design-system-loader.js';
import { PmtilesRangeSource } from './pmtiles-range-source.js';
import {
  buildSourceManifest,
  buildStyleSemantics,
  createResourceId,
  finalizeInitialMapBuild,
  resourceGatewayPath,
  type InitialMapBuild,
  type ResourceDescriptor,
} from './resource-manifest-builder.js';

const MAX_VECTOR_LAYERS = 256;

export async function buildPmtilesSource(input: {
  projectId: string;
  source: DetectedMapSource;
  approvedFinalUrl: URL;
  etag: string | null;
  capturedAt: string;
  transport: PinnedTransport;
  designSystem: LoadedMapDesignSystem;
  resourceScope?: MapDesignResourceScope;
}): Promise<InitialMapBuild> {
  if (input.source.kind !== 'pmtiles') throw new TypeError('Expected a detected PMTiles source');
  const archive = new PMTiles(new PmtilesRangeSource(input.approvedFinalUrl, input.transport, input.etag));
  const header = await archive.getHeader();
  const etag = requirePinnedEtag(input.etag ?? header.etag);
  const vector = header.tileType === TileType.Mvt;
  if (!vector && ![TileType.Png, TileType.Jpeg, TileType.Webp, TileType.Avif].includes(header.tileType)) {
    throw new TypeError('Unsupported PMTiles tile type');
  }
  const vectorLayerIds = vector ? metadataVectorLayerIds(await archive.getMetadata()) : [];
  if (vector && vectorLayerIds.length === 0) {
    throw new TypeError('Vector PMTiles metadata must declare at least one vector layer');
  }
  const sourceUrl = input.approvedFinalUrl.href;
  const id = createResourceId('pmtiles', sourceUrl);
  const resource: ResourceDescriptor = {
    id,
    kind: 'pmtiles',
    mode: 'remote',
    mediaType: input.source.mediaType,
    sourceUrl,
    etag,
    byteLength: null,
    contentDigest: null,
  };
  const requestedMinZoom = Math.max(0, Math.min(24, header.minZoom));
  const minzoom = requestedMinZoom === 24 ? 23 : requestedMinZoom;
  const maxzoom = Math.min(24, Math.max(minzoom + 1, Math.min(24, header.maxZoom)));
  const zoom = initialCameraZoom(header.centerZoom, minzoom, maxzoom);
  const url = `pmtiles://${resourceGatewayPath(input.projectId, id, 'archive.pmtiles', input.resourceScope)}`;
  const source = vector
    ? { type: 'vector', url, minzoom, maxzoom }
    : { type: 'raster', url, minzoom, maxzoom, tileSize: 256 };
  const layers = vector
    ? vectorLayerIds.map((sourceLayer, index) => ({
        id: uniqueLayerId(sourceLayer, index),
        type: 'line' as const,
        source: 'pmtiles',
        'source-layer': sourceLayer,
        minzoom,
        maxzoom,
        paint: { 'line-color': '#4f6578' },
      }))
    : [{ id: 'pmtiles', type: 'raster' as const, source: 'pmtiles', minzoom, maxzoom }];
  const validated = validateStyleDocument({
    version: 8,
    center: [header.centerLon, header.centerLat],
    zoom,
    sources: { pmtiles: source },
    layers,
  });
  if (!validated.ok) throw new TypeError('Generated PMTiles Style is structurally invalid');
  const style: StyleDocument = validated.style;
  const semantics = buildStyleSemantics(style);
  const sourceManifest = buildSourceManifest({
    kind: 'pmtiles',
    mediaType: input.source.mediaType,
    sourceBytes: input.source.headerBytes,
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

function metadataVectorLayerIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.vector_layers)) return [];
  return value.vector_layers.flatMap((layer) => (
    isRecord(layer) && typeof layer.id === 'string' && layer.id.trim().length > 0
      ? [layer.id]
      : []
  )).slice(0, MAX_VECTOR_LAYERS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueLayerId(sourceLayer: string, index: number): string {
  const normalized = sourceLayer.trim().slice(0, 220);
  return `${normalized}-${index + 1}`;
}

function initialCameraZoom(centerZoom: number, minzoom: number, maxzoom: number): number {
  return Math.max(minzoom, Math.min(centerZoom, maxzoom - 0.5));
}

function requirePinnedEtag(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim().length === 0
    || !/^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/u.test(value)) {
    throw new TypeError('PMTiles imports require a valid pinned ETag');
  }
  return value;
}
