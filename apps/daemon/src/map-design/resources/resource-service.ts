import { expandTileTemplate, parseTileCoordinates } from './tile-template.js';
import type Database from 'better-sqlite3';
import { fetchImportResource } from '../ingestion/import-fetch.js';
import { blake3Digest } from '../storage/canonical-json.js';
import { PMTiles, TileType } from 'pmtiles';

import type { PinnedTransport } from '../ingestion/pinned-transport.js';
import { PmtilesRangeSource } from '../ingestion/pmtiles-range-source.js';
import type { ResourceDescriptorBase } from '../ingestion/resource-manifest-builder.js';
import type { MapDesignBlobStore } from '../storage/types.js';

type SqliteDb = Database.Database;

export interface MapDesignResourceRepresentation {
  bytes: Uint8Array;
  mediaType: string;
  etag: string;
}

export interface MapDesignPmtilesRangeRepresentation extends MapDesignResourceRepresentation {
  start: number;
  end: number;
  total: number;
}

export interface MapDesignResourceService {
  getResource(
    projectId: string,
    resourceId: string,
    suffix: readonly string[],
    signal?: AbortSignal,
  ): Promise<MapDesignResourceRepresentation>;
  getPmtilesArchiveRange(
    projectId: string,
    resourceId: string,
    range: { start: number; endInclusive: number },
    ifMatch?: string,
    signal?: AbortSignal,
  ): Promise<MapDesignPmtilesRangeRepresentation>;
}

export class MapDesignResourceError extends Error {
  constructor(
    readonly status: 400 | 404 | 408 | 409 | 412 | 415 | 429 | 500 | 502 | 503 | 504,
    message: string,
    options?: ErrorOptions,
    readonly retryAfter?: string,
  ) {
    super(message, options);
    this.name = 'MapDesignResourceError';
  }
}

export interface MapDesignResolvedResource {
  ownerId: string;
  resourceId: string;
  kind: ResourceDescriptorBase['kind'];
  mode: 'captured' | 'remote';
  mediaType: string;
  byteLength: number | null;
  contentDigest: string | null;
  sourceUrl: string;
  etag: string | null;
}

export interface MapDesignResourceLookup {
  find(ownerId: string, resourceId: string): MapDesignResolvedResource | null;
  readCaptured(ownerId: string, digest: string): Promise<Uint8Array>;
}

const RESOURCE_KINDS = new Set<ResourceDescriptorBase['kind']>([
  'source-document', 'tile', 'glyph', 'sprite', 'pmtiles', 'geojson', 'image', 'video',
]);
const SAFE_MEDIA_TYPES = new Set([
  'application/json',
  'application/geo+json',
  'application/vnd.mapbox.style+json',
  'application/vnd.mapbox.tilejson+json',
  'application/vnd.mapbox-vector-tile',
  'application/vnd.mapbox.glyphs',
  'application/x-protobuf',
  'application/octet-stream',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
]);

export function createMapDesignResourceService(input: {
  db: SqliteDb;
  blobStore: MapDesignBlobStore;
  transport: PinnedTransport;
}): MapDesignResourceService {
  const getStatement = input.db.prepare(`SELECT
    project_id AS projectId, resource_id AS resourceId, kind,
    storage_kind AS storageKind, media_type AS mediaType,
    byte_length AS byteLength, content_digest AS contentDigest,
    metadata_json AS metadataJson
    FROM map_design_resources WHERE project_id = ? AND resource_id = ?`);

  return createMapDesignResourceServiceFromLookup({
    lookup: {
      find(ownerId, resourceId) {
        const raw = getStatement.get(ownerId, resourceId) as Record<string, unknown> | undefined;
        return raw ? decodeStoredResource(raw) : null;
      },
      readCaptured(ownerId, digest) {
        return input.blobStore.getBytes(ownerId, 'resources', digest);
      },
    },
    transport: input.transport,
  });
}

export function createMapDesignResourceServiceFromLookup(input: {
  lookup: MapDesignResourceLookup;
  transport: PinnedTransport;
}): MapDesignResourceService {
  return {
    async getResource(ownerId, resourceId, suffix, signal) {
      const resource = input.lookup.find(ownerId, resourceId);
      if (!resource) throw new MapDesignResourceError(404, 'Map resource not found');
      assertSafeSuffix(suffix);
      if (resource.mode === 'captured') {
        if (!SAFE_MEDIA_TYPES.has(resource.mediaType)) {
          throw new MapDesignResourceError(415, 'Map resource media type is not allowed');
        }
        const bytes = await input.lookup.readCaptured(ownerId, resource.contentDigest as string);
        if (bytes.byteLength !== resource.byteLength) {
          throw new MapDesignResourceError(409, 'Captured map resource length does not match metadata');
        }
        return { bytes, mediaType: resource.mediaType, etag: `"${resource.contentDigest}"` };
      }
      if (resource.kind === 'pmtiles') {
        return loadPmtilesTile(resource, suffix, input.transport, signal);
      }
      if (resource.kind === 'source-document') {
        throw new MapDesignResourceError(409, 'Map source documents must be captured during ingestion');
      }
      if (!SAFE_MEDIA_TYPES.has(resource.mediaType)) {
        throw new MapDesignResourceError(415, 'Map resource media type is not allowed');
      }
      const target = resolveRemoteTarget(resource, suffix);
      const mediaType = effectiveMediaType(resource, suffix);
      let response;
      try {
        response = await fetchImportResource(input.transport, {
          url: target,
          purpose: purposeFor(resource.kind),
          accept: [mediaType],
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throw new MapDesignResourceError(502, 'Map resource upstream request failed', { cause: error });
      }
      if (response.status === 404) throw new MapDesignResourceError(404, 'Map resource not found');
      if (response.status !== 200) {
        const status = response.status === 429 ? 429 : 502;
        throw new MapDesignResourceError(status, 'Map resource upstream returned an invalid status', undefined, safeRetryAfter(response.headers['retry-after']));
      }
      const responseEtag = response.headers.etag ?? resource.etag;
      if (resource.etag && response.headers.etag && response.headers.etag !== resource.etag) {
        throw new MapDesignResourceError(409, 'Map resource upstream ETag changed');
      }
      return {
        bytes: response.body,
        mediaType,
        etag: responseEtag ?? `"${blake3Digest(response.body)}"`,
      };
    },
    async getPmtilesArchiveRange(ownerId, resourceId, range, ifMatch, signal) {
      const resource = input.lookup.find(ownerId, resourceId);
      if (!resource) throw new MapDesignResourceError(404, 'Map resource not found');
      if (resource.kind !== 'pmtiles' || resource.mode !== 'remote') {
        throw new MapDesignResourceError(404, 'PMTiles archive not found');
      }
      if (!resource.etag) throw new MapDesignResourceError(409, 'PMTiles archive does not have a pinned ETag');
      if (ifMatch !== undefined && ifMatch !== resource.etag) {
        throw new MapDesignResourceError(412, 'PMTiles archive ETag changed');
      }
      const { start, endInclusive } = range;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0
        || endInclusive < start || endInclusive - start + 1 > 1024 * 1024) {
        throw new MapDesignResourceError(400, 'PMTiles archive range is invalid');
      }
      let response;
      try {
        response = await fetchImportResource(input.transport, {
          url: new URL(resource.sourceUrl),
          purpose: 'pmtiles-range',
          range,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        throw new MapDesignResourceError(502, 'PMTiles archive range request failed', { cause: error });
      }
      if (response.finalUrl.href !== resource.sourceUrl || response.redirects.length > 0) {
        throw new MapDesignResourceError(409, 'PMTiles archive redirected after approval');
      }
      if (response.status !== 206 || response.headers.etag !== resource.etag) {
        throw new MapDesignResourceError(409, 'PMTiles archive ETag changed or partial response is invalid');
      }
      const contentRange = parseContentRange(response.headers['content-range']);
      if (!contentRange || contentRange.start !== start || contentRange.end > endInclusive
        || contentRange.end < contentRange.start || contentRange.total <= contentRange.end
        || response.body.byteLength !== contentRange.end - contentRange.start + 1
        || (contentRange.end !== endInclusive && contentRange.end !== contentRange.total - 1)) {
        throw new MapDesignResourceError(502, 'PMTiles archive returned an invalid byte range');
      }
      return {
        bytes: response.body,
        mediaType: 'application/vnd.pmtiles',
        etag: resource.etag,
        ...contentRange,
      };
    },
  };
}

function parseContentRange(value: string | undefined): { start: number; end: number; total: number } | null {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/u);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return [start, end, total].every(Number.isSafeInteger) ? { start, end, total } : null;
}

function decodeStoredResource(raw: Record<string, unknown>): MapDesignResolvedResource {
  const ownerId = requiredString(raw.projectId);
  const resourceId = requiredString(raw.resourceId);
  const kind = requiredString(raw.kind);
  if (!RESOURCE_KINDS.has(kind as ResourceDescriptorBase['kind'])) invalidMetadata();
  const mode = requiredString(raw.storageKind);
  if (mode !== 'captured' && mode !== 'remote') invalidMetadata();
  const mediaType = requiredString(raw.mediaType).toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)) invalidMetadata();
  let metadata: unknown;
  try {
    metadata = JSON.parse(requiredString(raw.metadataJson)) as unknown;
  } catch {
    invalidMetadata();
  }
  if (!isRecord(metadata) || !onlyKeys(metadata, ['sourceUrl', 'etag'])
    || typeof metadata.sourceUrl !== 'string'
    || !(metadata.etag === null || typeof metadata.etag === 'string')) {
    invalidMetadata();
  }
  const sourceUrl = validateSourceUrl(metadata.sourceUrl);
  const byteLength = raw.byteLength === null ? null : safeNonnegativeInteger(raw.byteLength);
  const contentDigest = raw.contentDigest === null ? null : requiredString(raw.contentDigest);
  if (mode === 'captured') {
    if (byteLength === null || contentDigest === null || !/^[a-f0-9]{64}$/u.test(contentDigest)) invalidMetadata();
  } else if (byteLength !== null || contentDigest !== null) {
    invalidMetadata();
  }
  return {
    ownerId,
    resourceId,
    kind: kind as ResourceDescriptorBase['kind'],
    mode,
    mediaType,
    byteLength,
    contentDigest,
    sourceUrl,
    etag: metadata.etag,
  };
}

async function loadPmtilesTile(
  resource: MapDesignResolvedResource,
  suffix: readonly string[],
  transport: PinnedTransport,
  signal?: AbortSignal,
): Promise<MapDesignResourceRepresentation> {
  const coordinates = parseTileSuffix(suffix);
  const archive = new PMTiles(
    new PmtilesRangeSource(new URL(resource.sourceUrl), transport, resource.etag),
  );
  let header;
  let tile;
  try {
    header = await archive.getHeader();
    if (resource.etag && header.etag && resource.etag !== header.etag) {
      throw new MapDesignResourceError(409, 'PMTiles archive ETag changed');
    }
    tile = await archive.getZxy(coordinates.z, coordinates.x, coordinates.y, signal);
  } catch (error) {
    if (error instanceof MapDesignResourceError) throw error;
    throw new MapDesignResourceError(502, 'PMTiles tile request failed', { cause: error });
  }
  if (!tile) throw new MapDesignResourceError(404, 'Map tile not found');
  const mediaType = mediaTypeForTileType(header.tileType);
  return {
    bytes: new Uint8Array(tile.data),
    mediaType,
    etag: `"${blake3Digest(new Uint8Array(tile.data))}"`,
  };
}

function resolveRemoteTarget(resource: MapDesignResolvedResource, suffix: readonly string[]): URL {
  if (resource.kind === 'tile') {
    try { return expandTileTemplate(resource.sourceUrl, suffix); }
    catch { throw new MapDesignResourceError(400, 'Map tile suffix or template is invalid'); }
  }
  if (resource.kind === 'glyph') {
    if (suffix.length !== 3 || suffix[0] !== 'fonts'
      || !/^[^/\\\0]{1,256}$/u.test(suffix[1] ?? '')
      || !/^\d+-\d+\.pbf$/u.test(suffix[2] ?? '')) {
      throw new MapDesignResourceError(400, 'Map glyph suffix is invalid');
    }
    const range = (suffix[2] as string).slice(0, -4);
    return finalTemplateUrl(resource.sourceUrl, { fontstack: suffix[1] as string, range });
  }
  if (resource.kind === 'sprite') {
    if (suffix.length !== 1 || !/^sprite(?:-\d+)?(?:@2x)?\.(?:json|png)$/u.test(suffix[0] ?? '')) {
      throw new MapDesignResourceError(400, 'Map sprite suffix is invalid');
    }
    const spriteSuffix = (suffix[0] as string).replace(/^sprite(?:-\d+)?/u, '');
    const target = new URL(resource.sourceUrl);
    target.pathname = `${target.pathname}${spriteSuffix}`;
    return target;
  }
  const expected = resource.kind === 'source-document' ? 'source.json'
    : resource.kind === 'geojson' ? 'data.geojson'
    : resource.kind === 'image' ? 'image'
    : resource.kind === 'video' ? /^video\/\d+$/u
    : null;
  const actual = suffix.join('/');
  if ((typeof expected === 'string' && actual !== expected)
    || (expected instanceof RegExp && !expected.test(actual))
    || expected === null) {
    throw new MapDesignResourceError(400, 'Map resource suffix is invalid');
  }
  return new URL(resource.sourceUrl);
}

function effectiveMediaType(resource: MapDesignResolvedResource, suffix: readonly string[]): string {
  return resource.kind === 'sprite' && suffix[0]?.endsWith('.png')
    ? 'image/png'
    : resource.mediaType;
}

function parseTileSuffix(suffix: readonly string[]): { z: number; x: number; y: number } {
  try { return parseTileCoordinates(suffix); }
  catch { throw new MapDesignResourceError(400, 'Map tile suffix is invalid'); }
}

function finalTemplateUrl(template: string, values: Readonly<Record<string, string>>): URL {
  let resolved = template;
  for (const [name, value] of Object.entries(values)) {
    resolved = resolved.replaceAll(`{${name}}`, encodeURIComponent(value));
  }
  if (/\{[^}]+\}/u.test(resolved)) throw new MapDesignResourceError(400, 'Map resource template is invalid');
  return new URL(resolved);
}

function assertSafeSuffix(suffix: readonly string[]): void {
  if (suffix.length === 0 || suffix.length > 8 || suffix.some((part) =>
    part.length === 0 || part.length > 512 || part === '.' || part === '..'
    || /[/\\\0]/u.test(part))) {
    throw new MapDesignResourceError(400, 'Map resource suffix is invalid');
  }
}

function validateSourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidMetadata();
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalidMetadata();
  return url.href.replaceAll('%7B', '{').replaceAll('%7D', '}').replaceAll('%7b', '{').replaceAll('%7d', '}');
}

function purposeFor(kind: ResourceDescriptorBase['kind']): 'document' | 'tile' | 'glyph' | 'sprite' | 'resource' {
  if (kind === 'source-document') return 'document';
  if (kind === 'tile') return 'tile';
  if (kind === 'glyph') return 'glyph';
  if (kind === 'sprite') return 'sprite';
  return 'resource';
}

function mediaTypeForTileType(tileType: TileType): string {
  if (tileType === TileType.Mvt) return 'application/vnd.mapbox-vector-tile';
  if (tileType === TileType.Png) return 'image/png';
  if (tileType === TileType.Jpeg) return 'image/jpeg';
  if (tileType === TileType.Webp) return 'image/webp';
  if (tileType === TileType.Avif) return 'image/avif';
  throw new MapDesignResourceError(415, 'PMTiles tile media type is not allowed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function requiredString(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : invalidMetadata();
}

function safeNonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalidMetadata();
}

function invalidMetadata(): never {
  throw new MapDesignResourceError(409, 'Map resource metadata is invalid');
}

function safeRetryAfter(value: string | undefined): string | undefined {
  if (!value || value.length > 128 || /[\r\n]/u.test(value)) return undefined;
  return /^\d+$/u.test(value) || Number.isFinite(Date.parse(value)) ? value : undefined;
}
