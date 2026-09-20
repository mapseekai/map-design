import type { MapDesignResourceScope } from '@mapseekai/map-design-contracts';
import { validateStyleDocument, type StyleDocument } from 'maplibre-style-tools/core';

import { canonicalJsonBytes } from '../storage/canonical-json.js';
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

const MAX_VECTOR_LAYERS = 256;

export async function buildTileJsonSource(input: {
  projectId: string;
  source: DetectedMapSource;
  approvedFinalUrl: URL;
  etag: string | null;
  capturedAt: string;
  designSystem: LoadedMapDesignSystem;
  resourceScope?: MapDesignResourceScope;
}): Promise<InitialMapBuild> {
  if (input.source.kind !== 'tilejson' || !isRecord(input.source.document)) {
    throw new TypeError('Expected a detected TileJSON source');
  }
  const document = input.source.document;
  const rawTiles = document.tiles;
  if (!Array.isArray(rawTiles) || rawTiles.length === 0) throw new TypeError('TileJSON has no tiles');
  const requestedMinZoom = clampZoom(document.minzoom, 0);
  const minzoom = requestedMinZoom === 24 ? 23 : requestedMinZoom;
  const maxzoom = Math.min(24, Math.max(minzoom + 1, clampZoom(document.maxzoom, 24)));
  const vectorLayerIds = Array.isArray(document.vector_layers)
    ? document.vector_layers.flatMap((layer) => isRecord(layer) && typeof layer.id === 'string' ? [layer.id] : [])
      .slice(0, MAX_VECTOR_LAYERS)
    : [];
  const vector = vectorLayerIds.length > 0 || rawTiles.some((tile) =>
    typeof tile === 'string' && /\.(?:pbf|mvt)(?:[?#]|$)/iu.test(tile));
  const resources: ResourceDescriptor[] = [];
  const byUrl = new Map<string, string>();
  const tiles = rawTiles.flatMap((raw) => {
    if (typeof raw !== 'string') throw new TypeError('TileJSON tile template is invalid');
    const sourceUrl = resolveHttp(raw, input.approvedFinalUrl);
    const existing = byUrl.get(sourceUrl);
    if (existing) return [];
    const id = createResourceId('tile', sourceUrl);
    const extension = raw.match(/\{y\}([^/?#]*)/u)?.[1] ?? '';
    resources.push({
      id,
      kind: 'tile',
      mode: 'remote',
      mediaType: vector ? 'application/vnd.mapbox-vector-tile' : rasterMediaType(sourceUrl),
      sourceUrl,
      etag: null,
      byteLength: null,
      contentDigest: null,
    });
    const gatewayUrl = resourceGatewayPath(input.projectId, id, `tiles/{z}/{x}/{y}${extension}`, input.resourceScope);
    byUrl.set(sourceUrl, gatewayUrl);
    return [gatewayUrl];
  });
  const source = vector
    ? { type: 'vector', tiles, minzoom, maxzoom }
    : { type: 'raster', tiles, minzoom, maxzoom, tileSize: 256 };
  const layers = vector
    ? (vectorLayerIds.length > 0 ? vectorLayerIds : ['default']).map((sourceLayer, index) => ({
        id: uniqueLayerId(sourceLayer, index),
        type: 'line' as const,
        source: 'tiles',
        'source-layer': sourceLayer,
        minzoom,
        maxzoom,
        paint: { 'line-color': '#4f6578', 'line-width': 1 },
      }))
    : [{
        id: 'raster',
        type: 'raster' as const,
        source: 'tiles',
        minzoom,
        maxzoom,
      }];
  const candidate = { version: 8 as const, sources: { tiles: source }, layers };
  const validated = validateStyleDocument(candidate);
  if (!validated.ok) throw new TypeError('Generated TileJSON Style is structurally invalid');
  const style: StyleDocument = validated.style;
  const semantics = buildStyleSemantics(style);
  const sourceManifest = buildSourceManifest({
    kind: 'tilejson',
    mediaType: input.source.mediaType,
    sourceBytes: canonicalJsonBytes(document),
    resourceCount: resources.length,
    capturedAt: input.capturedAt,
  });
  return finalizeInitialMapBuild({
    style,
    semantics,
    sourceManifest,
    resources,
    designSystem: input.designSystem,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampZoom(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(24, value))
    : fallback;
}

function resolveHttp(value: string, base: URL): string {
  const resolved = new URL(value, base);
  if (!['http:', 'https:'].includes(resolved.protocol) || resolved.username || resolved.password) {
    throw new TypeError('TileJSON tile URL is not an approved HTTP resource');
  }
  return resolved.href.replaceAll('%7B', '{').replaceAll('%7D', '}').replaceAll('%7b', '{').replaceAll('%7d', '}');
}

function rasterMediaType(value: string): string {
  if (/\.png(?:[?#]|$)/iu.test(value)) return 'image/png';
  if (/\.jpe?g(?:[?#]|$)/iu.test(value)) return 'image/jpeg';
  if (/\.webp(?:[?#]|$)/iu.test(value)) return 'image/webp';
  if (/\.avif(?:[?#]|$)/iu.test(value)) return 'image/avif';
  return 'application/octet-stream';
}

function uniqueLayerId(sourceLayer: string, index: number): string {
  const normalized = sourceLayer.trim().slice(0, 220);
  return normalized.length > 0 ? `${normalized}-${index + 1}` : `layer-${index + 1}`;
}
