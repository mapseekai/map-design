import {testDesignSystem} from '../../fixtures/map-design/test-design-system.js';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';
import { validateStyleDocument } from 'maplibre-style-tools/core';

import type { PinnedTransport } from '../../../src/map-design/ingestion/pinned-transport.js';
import { buildPmtilesSource } from '../../../src/map-design/ingestion/pmtiles-source-builder.js';
import type { LoadedMapDesignSystem } from '../../../src/map-design/validation/design-system-loader.js';

const DESIGN_SYSTEM: LoadedMapDesignSystem = testDesignSystem({ id: 'pmtiles-builder', digest: 'd'.repeat(64) });

interface PmtilesFixture {
  bytes: Uint8Array;
  metadataRange: { start: number; endInclusive: number };
}

function pmtilesArchive(
  tileType: 1 | 2,
  metadata: unknown = { vector_layers: [{ id: 'zcta' }] },
  minZoom = 2,
  maxZoom = 12,
  centerZoom = 4,
): PmtilesFixture {
  const rootDirectory = new Uint8Array(gzipSync(Uint8Array.of(0)));
  const metadataBytes = new Uint8Array(gzipSync(new TextEncoder().encode(JSON.stringify(metadata))));
  const rootOffset = 127;
  const metadataOffset = rootOffset + rootDirectory.byteLength;
  const tileDataOffset = metadataOffset + metadataBytes.byteLength;
  const bytes = new Uint8Array(tileDataOffset);
  bytes.set(new TextEncoder().encode('PMTiles'));
  bytes[7] = 3;
  const view = new DataView(bytes.buffer);
  const u64 = (offset: number, value: number) => view.setBigUint64(offset, BigInt(value), true);
  u64(8, rootOffset); u64(16, rootDirectory.byteLength);
  u64(24, metadataOffset); u64(32, metadataBytes.byteLength);
  u64(40, tileDataOffset); u64(48, 0); u64(56, tileDataOffset); u64(64, 0);
  u64(72, 0); u64(80, 0); u64(88, 0);
  bytes[96] = 1; bytes[97] = 2; bytes[98] = 1; bytes[99] = tileType;
  bytes[100] = minZoom; bytes[101] = maxZoom;
  view.setInt32(102, -120_0000000, true); view.setInt32(106, -45_0000000, true);
  view.setInt32(110, 120_0000000, true); view.setInt32(114, 45_0000000, true);
  bytes[118] = centerZoom;
  bytes.set(rootDirectory, rootOffset);
  bytes.set(metadataBytes, metadataOffset);
  return {
    bytes,
    metadataRange: {
      start: metadataOffset,
      endInclusive: metadataOffset + metadataBytes.byteLength - 1,
    },
  };
}

function rangedTransport(
  fixture: PmtilesFixture,
  ranges: Array<{ start: number; endInclusive: number }>,
  etag = '"pm-v1"',
): PinnedTransport {
  return {
    fetch: async (request) => {
      if (!request.range) throw new Error('range required');
      ranges.push(request.range);
      const start = request.range.start;
      const end = Math.min(request.range.endInclusive, fixture.bytes.byteLength - 1);
      if (start > end) throw new Error('range starts beyond archive');
      return {
        requestedUrl: request.url,
        finalUrl: request.url,
        redirects: [],
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${fixture.bytes.byteLength}`, etag },
        body: fixture.bytes.slice(start, end + 1),
      };
    },
  };
}

describe('PMTiles source builder', () => {
  it.each([
    [1, 'vector', 'line'],
    [2, 'raster', 'raster'],
  ] as const)('builds a bounded %s archive through PMTiles Source range reads', async (tileType, sourceType, layerType) => {
    const fixture = pmtilesArchive(tileType);
    const ranges: Array<{ start: number; endInclusive: number }> = [];
    const transport = rangedTransport(fixture, ranges);

    const build = await buildPmtilesSource({
      projectId: 'pmtiles-project',
      source: { kind: 'pmtiles', mediaType: 'application/vnd.pmtiles', headerBytes: fixture.bytes },
      approvedFinalUrl: new URL('https://maps.example.test/world.pmtiles'),
      etag: '"pm-v1"',
      capturedAt: '2026-08-14T00:00:00.000Z',
      transport,
      designSystem: DESIGN_SYSTEM,
    });

    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges[0]).toEqual({ start: 0, endInclusive: 16_383 });
    expect(ranges.every((range) => range.endInclusive - range.start < 1024 * 1024)).toBe(true);
    if (tileType === 1) expect(ranges).toContainEqual(fixture.metadataRange);
    else expect(ranges).toHaveLength(1);
    expect(validateStyleDocument(build.style).ok).toBe(true);
    expect(build.style.sources.pmtiles).toMatchObject({
      type: sourceType,
      minzoom: 2,
      maxzoom: 12,
      url: expect.stringMatching(/^pmtiles:\/\/\/api\/map-design\/projects\/pmtiles-project\/resources\/[a-f0-9]{64}\/archive\.pmtiles$/),
    });
    expect(build.style.layers).toEqual([
      expect.objectContaining({
        id: tileType === 1 ? 'zcta-1' : 'pmtiles',
        type: layerType,
        minzoom: 2,
        maxzoom: 12,
        ...(tileType === 1 ? { 'source-layer': 'zcta' } : {}),
      }),
    ]);
    expect(build.resources).toEqual([
      expect.objectContaining({
        kind: 'pmtiles',
        mode: 'remote',
        sourceUrl: 'https://maps.example.test/world.pmtiles',
        etag: '"pm-v1"',
      }),
    ]);
  });

  it('uses a source-preview gateway for the PMTiles archive', async () => {
    const fixture = pmtilesArchive(2, {});
    const build = await buildPmtilesSource({
      projectId: 'preview-1',
      resourceScope: 'source-previews',
      source: { kind: 'pmtiles', mediaType: 'application/vnd.pmtiles', headerBytes: fixture.bytes },
      approvedFinalUrl: new URL('https://maps.example.test/world.pmtiles'),
      etag: '"pm-v1"',
      capturedAt: '2026-08-14T00:00:00.000Z',
      transport: rangedTransport(fixture, []),
      designSystem: DESIGN_SYSTEM,
    });

    expect(build.style.sources.pmtiles).toMatchObject({
      url: expect.stringMatching(/^pmtiles:\/\/\/api\/map-design\/source-previews\/preview-1\/resources\/[a-f0-9]{64}\/archive\.pmtiles$/),
    });
  });

  it('generates one bounded preview layer for every valid metadata vector layer', async () => {
    const fixture = pmtilesArchive(1, {
      vector_layers: [
        { id: '' },
        { id: 42 },
        { id: 'zcta' },
        { id: 'roads' },
        ...Array.from({ length: 298 }, (_, index) => ({ id: `extra-${index}` })),
      ],
    });
    const ranges: Array<{ start: number; endInclusive: number }> = [];

    const build = await buildPmtilesSource({
      projectId: 'pmtiles-project',
      source: { kind: 'pmtiles', mediaType: 'application/vnd.pmtiles', headerBytes: fixture.bytes },
      approvedFinalUrl: new URL('https://maps.example.test/world.pmtiles'),
      etag: '"pm-v1"',
      capturedAt: '2026-08-14T00:00:00.000Z',
      transport: rangedTransport(fixture, ranges),
      designSystem: DESIGN_SYSTEM,
    });

    const sourceLayers = build.style.layers.map((layer) => layer['source-layer']);
    expect(sourceLayers).toHaveLength(256);
    expect(sourceLayers.slice(0, 2)).toEqual(['zcta', 'roads']);
    expect(sourceLayers.at(-1)).toBe('extra-253');
    expect(sourceLayers).not.toContain('default');
    expect(ranges).toContainEqual(fixture.metadataRange);
    expect(ranges.every((range) => range.endInclusive - range.start < 1024 * 1024)).toBe(true);
  });

  it.each([
    ['vector', 1, 0, 7, 7],
    ['raster', 2, 0, 7, 7],
    ['vector', 1, 2, 7, 1],
    ['raster', 2, 2, 7, 1],
  ] as const)(
    'clamps the initial %s PMTiles camera into its visible zoom interval',
    async (_kind, tileType, minzoom, maxzoom, centerZoom) => {
      const fixture = pmtilesArchive(
        tileType,
        tileType === 1 ? { vector_layers: [{ id: 'zcta' }] } : {},
        minzoom,
        maxzoom,
        centerZoom,
      );

      const build = await buildPmtilesSource({
        projectId: 'pmtiles-project',
        source: { kind: 'pmtiles', mediaType: 'application/vnd.pmtiles', headerBytes: fixture.bytes },
        approvedFinalUrl: new URL('https://maps.example.test/world.pmtiles'),
        etag: '"pm-v1"',
        capturedAt: '2026-08-14T00:00:00.000Z',
        transport: rangedTransport(fixture, []),
        designSystem: DESIGN_SYSTEM,
      });

      expect(build.style.sources.pmtiles).toMatchObject({ minzoom, maxzoom });
      expect(build.style.layers[0]).toMatchObject({ minzoom, maxzoom });
      expect(build.style.zoom).toBeGreaterThanOrEqual(minzoom);
      expect(build.style.zoom).toBeLessThan(maxzoom);
    },
  );

  it.each([
    ['missing vector_layers', {}],
    ['non-array vector_layers', { vector_layers: 'zcta' }],
    ['no valid layer ids', { vector_layers: [{}, { id: '' }, { id: 42 }] }],
  ])('rejects vector PMTiles metadata with %s', async (_case, metadata) => {
    const fixture = pmtilesArchive(1, metadata);

    await expect(buildPmtilesSource({
      projectId: 'pmtiles-project',
      source: { kind: 'pmtiles', mediaType: 'application/vnd.pmtiles', headerBytes: fixture.bytes },
      approvedFinalUrl: new URL('https://maps.example.test/world.pmtiles'),
      etag: '"pm-v1"',
      capturedAt: '2026-08-14T00:00:00.000Z',
      transport: rangedTransport(fixture, []),
      designSystem: DESIGN_SYSTEM,
    })).rejects.toThrow(/metadata.*vector layer/i);
  });

  it('keeps PMTiles zoom bounds valid when the archive is pinned at zoom 24', async () => {
    const fixture = pmtilesArchive(2, {}, 24, 24);
    const transport: PinnedTransport = {
      fetch: async (request) => ({
        requestedUrl: request.url,
        finalUrl: request.url,
        redirects: [],
        status: 206,
        headers: { 'content-range': `bytes 0-${fixture.bytes.byteLength - 1}/${fixture.bytes.byteLength}`, etag: '"pm-v1"' },
        body: fixture.bytes,
      }),
    };

    const build = await buildPmtilesSource({
      projectId: 'pmtiles-project',
      source: { kind: 'pmtiles', mediaType: 'application/vnd.pmtiles', headerBytes: fixture.bytes },
      approvedFinalUrl: new URL('https://maps.example.test/world.pmtiles'),
      etag: '"pm-v1"',
      capturedAt: '2026-08-14T00:00:00.000Z',
      transport,
      designSystem: DESIGN_SYSTEM,
    });

    expect(build.style.layers[0]).toMatchObject({ minzoom: 23, maxzoom: 24 });
  });

  it('rejects a missing approved ETag on the initial PMTiles header range', async () => {
    const fixture = pmtilesArchive(2, {});
    await expect(buildPmtilesSource({
      projectId: 'pmtiles-project',
      source: { kind: 'pmtiles', mediaType: 'application/vnd.pmtiles', headerBytes: fixture.bytes },
      approvedFinalUrl: new URL('https://maps.example.test/world.pmtiles'),
      etag: '"approved-v1"',
      capturedAt: '2026-08-14T00:00:00.000Z',
      transport: {
        fetch: async (request) => ({
          requestedUrl: request.url,
          finalUrl: request.url,
          redirects: [],
          status: 206,
          headers: { 'content-range': `bytes 0-${fixture.bytes.byteLength - 1}/${fixture.bytes.byteLength}` },
          body: fixture.bytes,
        }),
      },
      designSystem: DESIGN_SYSTEM,
    })).rejects.toThrow(/ETag/u);
  });

  it('rejects a PMTiles archive when neither discovery nor the header pins an ETag', async () => {
    const fixture = pmtilesArchive(2, {});

    await expect(buildPmtilesSource({
      projectId: 'pmtiles-project',
      source: { kind: 'pmtiles', mediaType: 'application/vnd.pmtiles', headerBytes: fixture.bytes },
      approvedFinalUrl: new URL('https://maps.example.test/world.pmtiles'),
      etag: null,
      capturedAt: '2026-08-14T00:00:00.000Z',
      transport: {
        fetch: async (request) => ({
          requestedUrl: request.url,
          finalUrl: request.url,
          redirects: [],
          status: 206,
          headers: { 'content-range': `bytes 0-${fixture.bytes.byteLength - 1}/${fixture.bytes.byteLength}` },
          body: fixture.bytes,
        }),
      },
      designSystem: DESIGN_SYSTEM,
    })).rejects.toThrow(/ETag/u);
  });

  it.each(['', '   ', '\t'])('rejects a PMTiles archive with a syntactically empty ETag (%j)', async (etag) => {
    const fixture = pmtilesArchive(2, {});

    await expect(buildPmtilesSource({
      projectId: 'pmtiles-project',
      source: { kind: 'pmtiles', mediaType: 'application/vnd.pmtiles', headerBytes: fixture.bytes },
      approvedFinalUrl: new URL('https://maps.example.test/world.pmtiles'),
      etag,
      capturedAt: '2026-08-14T00:00:00.000Z',
      transport: {
        fetch: async (request) => ({
          requestedUrl: request.url,
          finalUrl: request.url,
          redirects: [],
          status: 206,
          headers: { 'content-range': `bytes 0-${fixture.bytes.byteLength - 1}/${fixture.bytes.byteLength}`, etag },
          body: fixture.bytes,
        }),
      },
      designSystem: DESIGN_SYSTEM,
    })).rejects.toThrow(/ETag/u);
  });

  it.each(['W/"weak-v1"', '""'])('preserves the valid HTTP entity-tag %s exactly', async (etag) => {
    const fixture = pmtilesArchive(2, {});
    const build = await buildPmtilesSource({
      projectId: 'pmtiles-project',
      source: { kind: 'pmtiles', mediaType: 'application/vnd.pmtiles', headerBytes: fixture.bytes },
      approvedFinalUrl: new URL('https://maps.example.test/world.pmtiles'),
      etag,
      capturedAt: '2026-08-14T00:00:00.000Z',
      transport: {
        fetch: async (request) => ({
          requestedUrl: request.url,
          finalUrl: request.url,
          redirects: [],
          status: 206,
          headers: { 'content-range': `bytes 0-${fixture.bytes.byteLength - 1}/${fixture.bytes.byteLength}`, etag },
          body: fixture.bytes,
        }),
      },
      designSystem: DESIGN_SYSTEM,
    });

    expect(build.resources).toEqual([expect.objectContaining({ etag })]);
  });
});
