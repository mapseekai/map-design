import { describe, expect, it } from 'vitest';
import { applyStyleTransaction, validateStyleDocument } from 'maplibre-style-tools/core';

import { createMapDesignBlobStore } from '../../../src/map-design/storage/blob-store.js';
import { buildStyleSource } from '../../../src/map-design/ingestion/style-source-builder.js';
import { buildTileJsonSource } from '../../../src/map-design/ingestion/tilejson-source-builder.js';
import { buildGeoJsonSource } from '../../../src/map-design/ingestion/geojson-source-builder.js';
import type { LoadedMapDesignSystem } from '../../../src/map-design/validation/design-system-loader.js';
import { validateMapDesign } from '../../../src/map-design/validation/map-validator.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const NOW = '2026-08-14T00:00:00.000Z';
const PROJECT_ID = 'source-builders-project';
const DESIGN_SYSTEM: LoadedMapDesignSystem = {
  id: 'source-builders',
  digest: 'd'.repeat(64),
  humanGuidance: '',
  rules: {
    version: 1,
    requiredSemanticRoles: [],
    maxLabelLayerCount: 256,
    minimumContrastRatio: 1,
  },
};

describe('MapDesign source builders', () => {
  it('uses source-preview gateway paths for Style, TileJSON, and GeoJSON builds', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'map-design-source-preview-builders-'));
    try {
      const blobStore = createMapDesignBlobStore(root);
      const style = await buildStyleSource({
        projectId: 'preview-1',
        resourceScope: 'source-previews',
        source: {
          kind: 'style',
          mediaType: 'application/vnd.mapbox.style+json',
          document: {
            version: 8,
            glyphs: './fonts/{fontstack}/{range}.pbf',
            sources: {},
            layers: [{ id: 'background', type: 'background' }],
          },
        },
        approvedFinalUrl: new URL('https://maps.example.test/style.json'),
        etag: null,
        capturedAt: NOW,
        designSystem: DESIGN_SYSTEM,
      });
      const tilejson = await buildTileJsonSource({
        projectId: 'preview-1',
        resourceScope: 'source-previews',
        source: {
          kind: 'tilejson',
          mediaType: 'application/vnd.mapbox.tilejson+json',
          document: { tilejson: '3.0.0', tiles: ['./tiles/{z}/{x}/{y}.png'] },
        },
        approvedFinalUrl: new URL('https://maps.example.test/source.json'),
        etag: null,
        capturedAt: NOW,
        designSystem: DESIGN_SYSTEM,
      });
      const geojson = await buildGeoJsonSource({
        projectId: 'preview-1',
        resourceScope: 'source-previews',
        source: {
          kind: 'geojson',
          mediaType: 'application/geo+json',
          document: {
            type: 'FeatureCollection',
            features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } }],
          },
        },
        approvedFinalUrl: new URL('https://maps.example.test/data.geojson'),
        etag: null,
        capturedAt: NOW,
        blobStore,
        designSystem: DESIGN_SYSTEM,
      });

      const prefix = '/api/map-design/source-previews/preview-1/resources/';
      expect(style.style.glyphs).toMatch(new RegExp(`^${prefix}`));
      expect((tilejson.style.sources.tiles as { tiles: string[] }).tiles[0]).toMatch(new RegExp(`^${prefix}`));
      expect((geojson.style.sources.data as { data: string }).data).toMatch(new RegExp(`^${prefix}`));
      expect(JSON.stringify([style.style, tilejson.style, geojson.style])).not.toContain('/api/map-design/projects/');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rewrites an imported Style to same-origin gateway resources resolved from the approved final URL', async () => {
    const build = await buildStyleSource({
      projectId: PROJECT_ID,
      source: {
        kind: 'style',
        mediaType: 'application/vnd.mapbox.style+json',
        document: {
          version: 8,
          glyphs: './fonts/{fontstack}/{range}.pbf',
          sprite: './sprites/basic',
          sources: {
            streets: { type: 'vector', tiles: ['./tiles/{z}/{x}/{y}.pbf'] },
          },
          layers: [
            { id: 'roads', type: 'line', source: 'streets', 'source-layer': 'roads' },
          ],
        },
      },
      approvedFinalUrl: new URL('https://maps.example.test/maps/style.json'),
      etag: '"style-v1"',
      capturedAt: NOW,
      designSystem: DESIGN_SYSTEM,
    });

    expect(validateStyleDocument(build.style).ok).toBe(true);
    expect(build.style.glyphs).toMatch(
      /^\/api\/map-design\/projects\/source-builders-project\/resources\/[a-f0-9]{64}\/fonts\/\{fontstack\}\/\{range\}\.pbf$/,
    );
    expect(build.style.sprite).toMatch(
      /^\/api\/map-design\/projects\/source-builders-project\/resources\/[a-f0-9]{64}\/sprite$/,
    );
    expect(build.style.sources.streets).toMatchObject({
      type: 'vector',
      tiles: [expect.stringMatching(/^\/api\/map-design\/projects\/source-builders-project\/resources\/[a-f0-9]{64}\/tiles\/\{z\}\/\{x\}\/\{y\}\.pbf$/)],
    });
    expect(build.resources.map((resource) => resource.sourceUrl)).toEqual([
      'https://maps.example.test/maps/fonts/{fontstack}/{range}.pbf',
      'https://maps.example.test/maps/sprites/basic',
      'https://maps.example.test/maps/tiles/{z}/{x}/{y}.pbf',
    ]);
    expect(build.resources.every((resource) => resource.mode === 'remote')).toBe(true);
    expect(build.sourceManifest).toMatchObject({
      kind: 'style',
      resourceCount: 3,
      capturedAt: NOW,
    });
    expect(build.semantics.groups).toEqual([
      expect.objectContaining({ layerIds: ['roads'], sourceIds: ['streets'] }),
    ]);
  });

  it('builds valid unique semantic roles for styles with multiple sources', async () => {
    const build = await buildStyleSource({
      projectId: PROJECT_ID,
      source: {
        kind: 'style',
        mediaType: 'application/vnd.mapbox.style+json',
        document: {
          version: 8,
          sources: {
            streets: { type: 'vector', tiles: ['https://tiles.example.test/streets/{z}/{x}/{y}.pbf'] },
            places: { type: 'vector', tiles: ['https://tiles.example.test/places/{z}/{x}/{y}.pbf'] },
          },
          layers: [
            { id: 'roads', type: 'line', source: 'streets', 'source-layer': 'roads' },
            { id: 'cities', type: 'circle', source: 'places', 'source-layer': 'cities' },
          ],
        },
      },
      approvedFinalUrl: new URL('https://maps.example.test/maps/style.json'),
      etag: null,
      capturedAt: NOW,
      designSystem: DESIGN_SYSTEM,
    });

    expect(build.semantics.groups.map((group) => group.role)).toEqual(['source-1-1', 'source-2-1']);
    expect(build.validation).toMatchObject({ ok: true, summary: { status: 'valid', errors: 0 } });
    const edited = applyStyleTransaction(build.style, { operations: [
      { op: 'setLayerProperties', layerId: 'roads', paint: { 'line-color': '#123456' } },
    ] });
    if (!edited.ok) throw new Error(edited.error.message);
    expect(validateMapDesign({ style: edited.style, semantics: build.semantics, sourceManifest: build.sourceManifest, designSystem: DESIGN_SYSTEM }))
      .toMatchObject({ ok: true, summary: { status: 'valid', errors: 0 } });
  });

  it('rewrites image source URLs exactly once as image resources', async () => {
    const build = await buildStyleSource({
      projectId: PROJECT_ID,
      source: {
        kind: 'style',
        mediaType: 'application/vnd.mapbox.style+json',
        document: {
          version: 8,
          sources: {
            overlay: {
              type: 'image',
              url: './overlay.png',
              coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]],
            },
          },
          layers: [{ id: 'overlay', type: 'raster', source: 'overlay' }],
        },
      },
      approvedFinalUrl: new URL('https://maps.example.test/maps/style.json'),
      etag: null,
      capturedAt: NOW,
      designSystem: DESIGN_SYSTEM,
    });

    expect(build.resources).toEqual([
      expect.objectContaining({
        kind: 'image',
        sourceUrl: 'https://maps.example.test/maps/overlay.png',
      }),
    ]);
    expect(build.style.sources.overlay).toMatchObject({
      url: expect.stringMatching(/\/resources\/[a-f0-9]{64}\/image$/),
    });
  });

  it('rewrites every public multi-sprite URL without changing sprite IDs', async () => {
    const build = await buildStyleSource({
      projectId: PROJECT_ID,
      source: {
        kind: 'style',
        mediaType: 'application/vnd.mapbox.style+json',
        document: {
          version: 8,
          sprite: [
            { id: 'default', url: './sprites/default' },
            { id: 'poi', url: './sprites/poi' },
          ],
          sources: {},
          layers: [{ id: 'background', type: 'background' }],
        },
      },
      approvedFinalUrl: new URL('https://maps.example.test/maps/style.json'),
      etag: null,
      capturedAt: NOW,
      designSystem: DESIGN_SYSTEM,
    });

    expect(build.resources.map((resource) => [resource.kind, resource.sourceUrl])).toEqual([
      ['sprite', 'https://maps.example.test/maps/sprites/default'],
      ['sprite', 'https://maps.example.test/maps/sprites/poi'],
    ]);
    expect(build.style.sprite).toEqual([
      { id: 'default', url: expect.stringMatching(/\/sprite-0$/) },
      { id: 'poi', url: expect.stringMatching(/\/sprite-1$/) },
    ]);
  });

  it('builds bounded vector and raster TileJSON styles with resolved gateway templates', async () => {
    const vectorLayers = Array.from({ length: 300 }, (_, index) => ({ id: `layer-${index}` }));
    const vector = await buildTileJsonSource({
      projectId: PROJECT_ID,
      source: {
        kind: 'tilejson',
        mediaType: 'application/vnd.mapbox.tilejson+json',
        document: {
          tilejson: '3.0.0',
          tiles: ['./vector/{z}/{x}/{y}.pbf'],
          minzoom: -10,
          maxzoom: 99,
          vector_layers: vectorLayers,
        },
      },
      approvedFinalUrl: new URL('https://tiles.example.test/catalog/source.json'),
      etag: null,
      capturedAt: NOW,
      designSystem: DESIGN_SYSTEM,
    });
    const raster = await buildTileJsonSource({
      projectId: PROJECT_ID,
      source: {
        kind: 'tilejson',
        mediaType: 'application/vnd.mapbox.tilejson+json',
        document: {
          tilejson: '3.0.0',
          tiles: ['https://tiles.example.test/raster/{z}/{x}/{y}.png'],
          minzoom: 2,
          maxzoom: 12,
        },
      },
      approvedFinalUrl: new URL('https://tiles.example.test/raster.json'),
      etag: null,
      capturedAt: NOW,
      designSystem: DESIGN_SYSTEM,
    });

    expect(validateStyleDocument(vector.style).ok).toBe(true);
    expect(vector.style.layers).toHaveLength(256);
    expect(vector.style.layers[0]).toMatchObject({ minzoom: 0, maxzoom: 24, 'source-layer': 'layer-0' });
    expect(vector.resources[0]?.sourceUrl).toBe('https://tiles.example.test/catalog/vector/{z}/{x}/{y}.pbf');
    expect(validateStyleDocument(raster.style).ok).toBe(true);
    expect(raster.style.layers).toEqual([
      expect.objectContaining({ id: 'raster', type: 'raster', minzoom: 2, maxzoom: 12 }),
    ]);
  });

  it('deduplicates canonical TileJSON templates and reports one resource', async () => {
    const build = await buildTileJsonSource({
      projectId: PROJECT_ID,
      source: {
        kind: 'tilejson',
        mediaType: 'application/vnd.mapbox.tilejson+json',
        document: {
          tilejson: '3.0.0',
          tiles: ['./tiles/{z}/{x}/{y}.png', 'https://tiles.example.test/tiles/{z}/{x}/{y}.png'],
        },
      },
      approvedFinalUrl: new URL('https://tiles.example.test/source.json'),
      etag: null,
      capturedAt: NOW,
      designSystem: DESIGN_SYSTEM,
    });

    expect(build.resources).toHaveLength(1);
    expect(build.sourceManifest.resourceCount).toBe(1);
    expect(build.style.sources.tiles).toMatchObject({
      tiles: [expect.stringMatching(/\/tiles\/\{z\}\/\{x\}\/\{y\}\.png$/)],
    });
  });

  it('keeps TileJSON zoom bounds valid when the source is pinned at zoom 24', async () => {
    const build = await buildTileJsonSource({
      projectId: PROJECT_ID,
      source: {
        kind: 'tilejson',
        mediaType: 'application/vnd.mapbox.tilejson+json',
        document: {
          tilejson: '3.0.0',
          tiles: ['./tiles/{z}/{x}/{y}.png'],
          minzoom: 24,
          maxzoom: 24,
        },
      },
      approvedFinalUrl: new URL('https://tiles.example.test/source.json'),
      etag: null,
      capturedAt: NOW,
      designSystem: DESIGN_SYSTEM,
    });

    expect(validateStyleDocument(build.style).ok).toBe(true);
    expect(build.style.layers[0]).toMatchObject({ minzoom: 23, maxzoom: 24 });
  });

  it('validates and analyzes GeoJSON, captures it in CAS, and generates geometry-aware layers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'map-design-map-geojson-'));
    try {
      const blobStore = createMapDesignBlobStore(root);
      const document = {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { name: 'A' }, geometry: { type: 'Point', coordinates: [1, 2] } },
          { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
          { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
        ],
      };
      const build = await buildGeoJsonSource({
        projectId: PROJECT_ID,
        source: { kind: 'geojson', mediaType: 'application/geo+json', document },
        approvedFinalUrl: new URL('https://data.example.test/places.geojson'),
        etag: '"geo-v1"',
        capturedAt: NOW,
        blobStore,
        designSystem: DESIGN_SYSTEM,
      });

      expect(validateStyleDocument(build.style).ok).toBe(true);
      expect(build.style.layers.map((layer) => layer.type)).toEqual(['fill', 'line', 'circle']);
      expect(build.style.sources.data).toMatchObject({
        type: 'geojson',
        data: expect.stringMatching(/^\/api\/map-design\/projects\/source-builders-project\/resources\/[a-f0-9]{64}\/data\.geojson$/),
      });
      const resource = build.resources[0];
      expect(resource).toMatchObject({
        kind: 'geojson',
        mode: 'captured',
        mediaType: 'application/geo+json',
        sourceUrl: 'https://data.example.test/places.geojson',
        etag: '"geo-v1"',
      });
      if (!resource || resource.mode !== 'captured') throw new Error('expected captured GeoJSON');
      const captured = await blobStore.getBytes(PROJECT_ID, 'resources', resource.contentDigest);
      expect(JSON.parse(new TextDecoder().decode(captured))).toEqual(document);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns valid warning-only evidence for a structurally valid design-system violation', async () => {
    const build = await buildStyleSource({
      projectId: PROJECT_ID,
      source: {
        kind: 'style',
        mediaType: 'application/vnd.mapbox.style+json',
        document: {
          version: 8,
          sprite: './sprites/basic',
          sources: {},
          layers: [{ id: 'background', type: 'background' }],
        },
      },
      approvedFinalUrl: new URL('https://maps.example.test/maps/style.json'),
      etag: null,
      capturedAt: NOW,
      designSystem: {
        ...DESIGN_SYSTEM,
        rules: { ...DESIGN_SYSTEM.rules, requiredSemanticRoles: ['park'] },
      },
    });

    expect(validateStyleDocument(build.style).ok).toBe(true);
    expect(build.sourceManifest.resourceCount).toBe(1);
    expect(build.validation).toMatchObject({
      ok: true,
      summary: { status: 'valid', errors: 0, warnings: 1 },
    });
    expect(build.validation.findings).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'DESIGN_SYSTEM_VIOLATION',
      scope: { kind: 'design-system', id: 'source-builders' },
    }));
  });
});
