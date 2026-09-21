import { gatewayTileSuffix } from '../resources/tile-template.js';
import type { MapDesignResourceScope } from '@mapseekai/map-design-contracts';
import { validateStyleDocument, type StyleDocument } from 'maplibre-style-tools/core';

import { canonicalJsonBytes } from '../storage/canonical-json.js';
import type { MapDesignBlobStore } from '../storage/types.js';
import type { PinnedTransport } from './pinned-transport.js';
import { detectMapSource } from './source-detector.js';
import { fetchImportResource, ImportHttpError } from './import-fetch.js';
import {
  createResourceId,
  resourceGatewayPath,
  type ResourceDescriptor,
  type ResourceDescriptorBase,
} from './resource-manifest-builder.js';

export interface RewrittenStyleResources {
  style: StyleDocument;
  resources: readonly ResourceDescriptor[];
}

export async function rewriteStyleResources(input: {
  style: unknown;
  projectId: string;
  approvedFinalUrl: URL;
  blobStore?: Pick<MapDesignBlobStore, 'putBytes'>;
  transport?: PinnedTransport;
  resourceScope?: MapDesignResourceScope;
  signal?: AbortSignal;
}): Promise<RewrittenStyleResources> {
  const validated = validateStyleDocument(input.style);
  if (!validated.ok) throw new TypeError('Source Style is structurally invalid');
  const style = structuredClone(validated.style) as StyleDocument;
  const resources: ResourceDescriptor[] = [];
  const byKey = new Map<string, ResourceDescriptor>();

  const addRemote = (
    kind: ResourceDescriptorBase['kind'],
    rawUrl: string,
    mediaType: string,
    suffix: string,
    base = input.approvedFinalUrl,
  ): string => {
    const sourceUrl = resolveHttpTemplate(rawUrl, base);
    const key = `${kind}\0${sourceUrl}`;
    let resource = byKey.get(key);
    if (!resource) {
      resource = {
        id: createResourceId(kind, sourceUrl),
        kind,
        mode: 'remote',
        mediaType,
        sourceUrl,
        etag: null,
        byteLength: null,
        contentDigest: null,
      };
      byKey.set(key, resource);
      resources.push(resource);
    }
    return resourceGatewayPath(input.projectId, resource.id, suffix, input.resourceScope);
  };

  const captureSourceDocument = async (rawUrl: string): Promise<string> => {
    if (!input.transport || !input.blobStore) {
      throw new TypeError('Style source documents require pinned transport and blob storage');
    }
    const requestedUrl = new URL(resolveHttpTemplate(rawUrl, input.approvedFinalUrl));
    const requestedKey = `source-document\0${preserveTemplateBraces(requestedUrl.href)}`;
    const cached = byKey.get(requestedKey);
    if (cached) return resourceGatewayPath(input.projectId, cached.id, 'source.json', input.resourceScope);
    const response = await fetchImportResource(input.transport, {
      url: requestedUrl,
      purpose: 'document',
      accept: ['application/vnd.mapbox.tilejson+json', 'application/json'],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (response.status !== 200) {
      throw new ImportHttpError(response.status, 'source-metadata');
    }
    const detected = detectMapSource(response);
    if (detected.kind !== 'tilejson' || !isRecord(detected.document)) {
      throw new TypeError('Style source URL did not resolve to TileJSON');
    }
    const document = structuredClone(detected.document);
    if (!Array.isArray(document.tiles) || document.tiles.length === 0) {
      throw new TypeError('Style source TileJSON has no tiles');
    }
    document.tiles = document.tiles.flatMap((tile) => {
      if (typeof tile !== 'string') throw new TypeError('Style source TileJSON tile is invalid');
      const gatewayUrl = addRemote(
        'tile',
        tile,
        tileMediaType(tile),
        `tiles/${gatewayTileSuffix(tile)}`,
        response.finalUrl,
      );
      return [gatewayUrl];
    }).filter((value, index, values) => values.indexOf(value) === index);
    const sourceUrl = preserveTemplateBraces(response.finalUrl.href);
    const key = `source-document\0${sourceUrl}`;
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(requestedKey, existing);
      return resourceGatewayPath(input.projectId, existing.id, 'source.json', input.resourceScope);
    }
    const bytes = canonicalJsonBytes(document);
    const blob = await input.blobStore.putBytes(
      input.projectId,
      'resources',
      bytes,
      'application/vnd.mapbox.tilejson+json',
    );
    const resource: ResourceDescriptor = {
      id: createResourceId('source-document', sourceUrl),
      kind: 'source-document',
      mode: 'captured',
      mediaType: 'application/vnd.mapbox.tilejson+json',
      sourceUrl,
      etag: response.headers.etag ?? null,
      byteLength: blob.byteLength,
      contentDigest: blob.digest,
    };
    byKey.set(key, resource);
    byKey.set(requestedKey, resource);
    resources.push(resource);
    return resourceGatewayPath(input.projectId, resource.id, 'source.json', input.resourceScope);
  };

  const mutable = style as unknown as Record<string, unknown>;
  if (Array.isArray(mutable.imports) && mutable.imports.length > 0) {
    throw new TypeError('Style imports are not supported by the bounded resource capture');
  }
  if (typeof mutable.glyphs === 'string') {
    mutable.glyphs = addRemote(
      'glyph',
      mutable.glyphs,
      'application/x-protobuf',
      'fonts/{fontstack}/{range}.pbf',
    );
  }
  if (typeof mutable.sprite === 'string') {
    mutable.sprite = addRemote('sprite', mutable.sprite, 'application/json', 'sprite');
  } else if (Array.isArray(mutable.sprite)) {
    mutable.sprite = mutable.sprite.map((entry, index) => {
      if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.url !== 'string') {
        throw new TypeError('Style sprite entry is invalid');
      }
      return {
        ...entry,
        url: addRemote('sprite', entry.url, 'application/json', `sprite-${index}`),
      };
    });
  }

  for (const [sourceId, source] of Object.entries(style.sources)) {
    const mutableSource = source as unknown as Record<string, unknown>;
    if (mutableSource.type !== 'image' && typeof mutableSource.url === 'string') {
      mutableSource.url = await captureSourceDocument(mutableSource.url);
    }
    if (Array.isArray(mutableSource.tiles)) {
      mutableSource.tiles = mutableSource.tiles.map((tile) => {
        if (typeof tile !== 'string') throw new TypeError(`Invalid tile URL in source ${sourceId}`);
        return addRemote('tile', tile, tileMediaType(tile), `tiles/${gatewayTileSuffix(tile)}`);
      });
    }
    if (mutableSource.type === 'geojson' && typeof mutableSource.data === 'string') {
      mutableSource.data = addRemote('geojson', mutableSource.data, 'application/geo+json', 'data.geojson');
    }
    if (mutableSource.type === 'image' && typeof mutableSource.url === 'string') {
      mutableSource.url = addRemote('image', mutableSource.url, imageMediaType(mutableSource.url), 'image');
    }
    if (mutableSource.type === 'video' && Array.isArray(mutableSource.urls)) {
      mutableSource.urls = mutableSource.urls.map((url, index) => {
        if (typeof url !== 'string') throw new TypeError(`Invalid video URL in source ${sourceId}`);
        return addRemote('video', url, videoMediaType(url), `video/${index}`);
      });
    }
  }

  const rewritten = validateStyleDocument(style);
  if (!rewritten.ok) throw new TypeError('Rewritten Style is structurally invalid');
  return { style: rewritten.style, resources };
}

function resolveHttpTemplate(value: string, base: URL): string {
  let resolved: URL;
  try {
    resolved = new URL(value, base);
  } catch {
    throw new TypeError('Map resource URL is invalid');
  }
  if (!['http:', 'https:'].includes(resolved.protocol) || resolved.username || resolved.password) {
    throw new TypeError('Map resource URL is not an approved HTTP resource');
  }
  return preserveTemplateBraces(resolved.href);
}

function preserveTemplateBraces(value: string): string {
  return value.replaceAll('%7B', '{').replaceAll('%7D', '}').replaceAll('%7b', '{').replaceAll('%7d', '}');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tileMediaType(value: string): string {
  if (/\.(?:pbf|mvt)(?:[?#]|$)/iu.test(value)) return 'application/vnd.mapbox-vector-tile';
  if (/\.png(?:[?#]|$)/iu.test(value)) return 'image/png';
  if (/\.jpe?g(?:[?#]|$)/iu.test(value)) return 'image/jpeg';
  if (/\.webp(?:[?#]|$)/iu.test(value)) return 'image/webp';
  if (/\.avif(?:[?#]|$)/iu.test(value)) return 'image/avif';
  return 'application/octet-stream';
}

function imageMediaType(value: string): string {
  if (/\.png(?:[?#]|$)/iu.test(value)) return 'image/png';
  if (/\.jpe?g(?:[?#]|$)/iu.test(value)) return 'image/jpeg';
  if (/\.webp(?:[?#]|$)/iu.test(value)) return 'image/webp';
  if (/\.avif(?:[?#]|$)/iu.test(value)) return 'image/avif';
  return 'application/octet-stream';
}

function videoMediaType(value: string): string {
  if (/\.webm(?:[?#]|$)/iu.test(value)) return 'video/webm';
  return 'video/mp4';
}
