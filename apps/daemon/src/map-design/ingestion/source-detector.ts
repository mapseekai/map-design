import { check } from '@placemarkio/check-geojson';

import type { PinnedFetchResponse } from './pinned-transport.js';
import { decodeSourceDocument } from './source-document.js';

export type DetectedMapSource =
  | { kind: 'style'; document: unknown; mediaType: string }
  | { kind: 'tilejson'; document: unknown; mediaType: string }
  | { kind: 'geojson'; document: unknown; mediaType: string }
  | { kind: 'pmtiles'; headerBytes: Uint8Array; mediaType: string };

export class SourceDetectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SourceDetectionError';
  }
}

const PMTILES_MAGIC = new TextEncoder().encode('PMTiles');
const TILEJSON_MAX_TEMPLATES = 256;
const TILEJSON_MAX_TEMPLATE_LENGTH = 8_192;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPmtiles(body: Uint8Array): boolean {
  return (
    body.byteLength > PMTILES_MAGIC.byteLength &&
    PMTILES_MAGIC.every((byte, index) => body[index] === byte) &&
    body[PMTILES_MAGIC.byteLength] === 3
  );
}

function isStyle(document: unknown): boolean {
  return (
    isRecord(document) &&
    document.version === 8 &&
    isRecord(document.sources) &&
    Array.isArray(document.layers)
  );
}

function isTileJson(document: unknown): boolean {
  if (!isRecord(document) || typeof document.tilejson !== 'string') return false;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(document.tilejson)) return false;
  if (!Array.isArray(document.tiles) || document.tiles.length === 0) return false;
  if (document.tiles.length > TILEJSON_MAX_TEMPLATES) return false;
  return document.tiles.every(
    (tile) =>
      typeof tile === 'string' && tile.length > 0 && tile.length <= TILEJSON_MAX_TEMPLATE_LENGTH,
  );
}

export function detectMapSource(response: PinnedFetchResponse): DetectedMapSource {
  if (isPmtiles(response.body)) {
    return {
      kind: 'pmtiles',
      headerBytes: response.body,
      mediaType: 'application/vnd.pmtiles',
    };
  }

  let decoded: ReturnType<typeof decodeSourceDocument>;
  try {
    decoded = decodeSourceDocument(response.body);
  } catch (error) {
    if (error instanceof Error && /UTF-8/u.test(error.message)) throw error;
    throw new SourceDetectionError('Unable to detect a supported map source', { cause: error });
  }
  if (isStyle(decoded.document)) {
    return {
      kind: 'style',
      document: decoded.document,
      mediaType: 'application/vnd.mapbox.style+json',
    };
  }
  if (isTileJson(decoded.document)) {
    return {
      kind: 'tilejson',
      document: decoded.document,
      mediaType: 'application/vnd.mapbox.tilejson+json',
    };
  }
  try {
    const geojson = check(decoded.text);
    return { kind: 'geojson', document: geojson, mediaType: 'application/geo+json' };
  } catch (error) {
    throw new SourceDetectionError('Unable to detect a supported map source', { cause: error });
  }
}
