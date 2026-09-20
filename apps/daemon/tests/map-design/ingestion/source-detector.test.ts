import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { detectMapSource } from '../../../src/map-design/ingestion/source-detector.js';
import type { PinnedFetchResponse } from '../../../src/map-design/ingestion/pinned-transport.js';

const fixture = (name: string) =>
  readFile(fileURLToPath(new URL(`../../fixtures/map-design/sources/${name}`, import.meta.url)));

function fetched(body: Uint8Array, pathname: string, contentType?: string): PinnedFetchResponse {
  const url = new URL(`https://example.com/${pathname}`);
  return {
    requestedUrl: url,
    finalUrl: url,
    redirects: [],
    status: 200,
    headers: contentType ? { 'content-type': contentType } : {},
    body,
  };
}

describe('MapDesign source detector', () => {
  it('recognizes a MapLibre Style only with version 8, sources, and layers', async () => {
    const result = detectMapSource(fetched(await fixture('style.json'), 'no-extension', 'text/plain'));
    expect(result).toMatchObject({ kind: 'style', mediaType: 'application/vnd.mapbox.style+json' });
    if (result.kind !== 'style') throw new Error('expected style');
    expect(result.document).toMatchObject({ version: 8, sources: {}, layers: [] });
  });

  it.each([
    { version: 7, sources: {}, layers: [] },
    { version: 8, layers: [] },
    { version: 8, sources: {} },
    { version: 8, sources: [], layers: [] },
    { version: 8, sources: {}, layers: {} },
  ])('does not accept a weak style-shaped object %#', (document) => {
    expect(() =>
      detectMapSource(
        fetched(new TextEncoder().encode(JSON.stringify(document)), 'style.json', 'application/json'),
      ),
    ).toThrow(/unsupported|detect/i);
  });

  it('recognizes TileJSON by tilejson plus a bounded tiles list despite a misleading suffix', async () => {
    expect(
      detectMapSource(fetched(await fixture('tilejson.json'), 'photo.jpg', 'image/jpeg')),
    ).toMatchObject({ kind: 'tilejson', mediaType: 'application/vnd.mapbox.tilejson+json' });
  });

  it.each([
    { tilejson: '3.0.0' },
    { tilejson: '3.0.0', tiles: [] },
    { tilejson: '3.0.0', tiles: Array.from({ length: 257 }, () => 'https://x.test/{z}/{x}/{y}.mvt') },
    { tilejson: '3.0.0', tiles: [7] },
  ])('rejects unbounded or malformed TileJSON %#', (document) => {
    expect(() =>
      detectMapSource(fetched(new TextEncoder().encode(JSON.stringify(document)), 'tiles.json')),
    ).toThrow(/unsupported|detect/i);
  });

  it('recognizes validator-approved GeoJSON without relying on Content-Type or extension', async () => {
    const result = detectMapSource(
      fetched(await fixture('places.geojson'), 'download.bin', 'application/octet-stream'),
    );
    expect(result).toMatchObject({ kind: 'geojson', mediaType: 'application/geo+json' });
  });

  it.each([
    { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point' } }] },
    { type: 'Point', coordinates: [Number.NaN, 1] },
    { type: 'LineString', coordinates: [[1, 2]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
  ])('rejects invalid GeoJSON that only has a familiar type %#', (document) => {
    expect(() =>
      detectMapSource(fetched(new TextEncoder().encode(JSON.stringify(document)), 'places.geojson')),
    ).toThrow(/unsupported|detect/i);
  });

  it.each([undefined, 'text/plain', 'application/json'])(
    'lets PMTiles magic outrank missing or incorrect Content-Type %s',
    async (contentType) => {
      const result = detectMapSource(fetched(await fixture('sample.pmtiles'), 'style.json', contentType));
      expect(result).toMatchObject({ kind: 'pmtiles', mediaType: 'application/vnd.pmtiles' });
      if (result.kind !== 'pmtiles') throw new Error('expected PMTiles');
      expect(new TextDecoder().decode(result.headerBytes.subarray(0, 7))).toBe('PMTiles');
    },
  );

  it('rejects a PMTiles-like prefix with the wrong format version', () => {
    const wrongVersion = Uint8Array.from([...new TextEncoder().encode('PMTiles'), 4]);
    expect(() => detectMapSource(fetched(wrongVersion, 'sample.pmtiles'))).toThrow(
      /unsupported|detect/i,
    );
  });

  it('rejects invalid UTF-8 before JSON parsing', async () => {
    const encodedHex = (await fixture('invalid-utf8.bin')).toString('ascii').trim();
    const invalidUtf8 = Uint8Array.from(Buffer.from(encodedHex, 'hex'));
    expect(() => detectMapSource(fetched(invalidUtf8, 'style.json', 'application/json'))).toThrow(/UTF-8/i);
  });

  it('does not accept extension or Content-Type without a strong signature', () => {
    expect(() =>
      detectMapSource(
        fetched(new TextEncoder().encode('{"hello":"world"}'), 'style.json', 'application/geo+json'),
      ),
    ).toThrow(/unsupported|detect/i);
  });
});
