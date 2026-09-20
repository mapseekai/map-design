import { describe, expect, it } from 'vitest';
import { hashStyle } from 'maplibre-style-tools/maplibre';

import { hashMapDesignStyle } from '../../src/map-design/map/map-design-style-hash';

const PROJECT_ID = 'project-a';
const OTHER_PROJECT_ID = 'project-b';
const ORIGIN = 'http://127.0.0.1:58357';
const resource = (projectId: string, id: string, suffix: string) =>
  `/api/map-design/projects/${projectId}/resources/${id}/${suffix}`;

const relativeStyle = {
  version: 8 as const,
  id: 'daemon-style-id',
  glyphs: resource(PROJECT_ID, 'glyphs', 'fonts/{fontstack}/{range}.pbf'),
  sprite: [{ id: 'main', url: resource(PROJECT_ID, 'sprite', 'sprite') }],
  imports: [{ id: 'base', url: resource(PROJECT_ID, 'import', 'style.json') }],
  sources: {
    vector: {
      type: 'vector',
      url: resource(PROJECT_ID, 'source', 'source.json'),
      tiles: [resource(PROJECT_ID, 'tile', 'tiles/{z}/{x}/{y}.pbf')],
    },
    geojson: { type: 'geojson', data: resource(PROJECT_ID, 'geojson', 'data.geojson') },
    video: { type: 'video', urls: [resource(PROJECT_ID, 'video', 'video/0')] },
  },
  layers: [{ id: 'background', type: 'background', filter: ['all'], paint: { 'background-color': '#ffffff' } }],
  metadata: { documentation: 'https://docs.example.test/map-design' },
};

function absoluteResources(style: typeof relativeStyle): typeof relativeStyle {
  return {
    ...style,
    glyphs: `${ORIGIN}${style.glyphs}`,
    sprite: style.sprite.map((entry) => ({ ...entry, url: `${ORIGIN}${entry.url}` })),
    imports: style.imports.map((entry) => ({ ...entry, url: `${ORIGIN}${entry.url}` })),
    sources: {
      vector: {
        ...style.sources.vector,
        url: `${ORIGIN}${style.sources.vector.url}`,
        tiles: style.sources.vector.tiles.map((url) => `${ORIGIN}${url}`),
      },
      geojson: { ...style.sources.geojson, data: `${ORIGIN}${style.sources.geojson.data}` },
      video: { ...style.sources.video, urls: style.sources.video.urls.map((url) => `${ORIGIN}${url}`) },
    },
  };
}

function browserSerializedStyle(style: typeof relativeStyle) {
  const expanded = absoluteResources(style);
  const { id: _unsupportedId, ...withoutId } = expanded;
  return {
    ...withoutId,
    layers: expanded.layers.map((layer) => {
      const { filter: _inertBackgroundFilter, ...withoutFilter } = layer;
      return withoutFilter;
    }),
  };
}

describe('hashMapDesignStyle', () => {
  it('hashes relative and browser-expanded same-origin project resource URLs identically', async () => {
    await expect(hashMapDesignStyle(browserSerializedStyle(relativeStyle) as never, PROJECT_ID, { origin: ORIGIN }))
      .resolves.toBe(await hashMapDesignStyle(relativeStyle as never, PROJECT_ID, { origin: ORIGIN }));
  });

  it('omits only the unsupported top-level style id from MapLibre confirmation hashing', async () => {
    const { id: _id, ...browserStyle } = relativeStyle;
    await expect(hashMapDesignStyle(browserStyle as never, PROJECT_ID, { origin: ORIGIN }))
      .resolves.toBe(await hashMapDesignStyle(relativeStyle as never, PROJECT_ID, { origin: ORIGIN }));
  });

  it('omits only an inert all-filter from a background layer', async () => {
    const withoutFilter = {
      ...relativeStyle,
      layers: relativeStyle.layers.map((layer) => {
        const { filter: _filter, ...rest } = layer;
        return rest;
      }),
    };
    await expect(hashMapDesignStyle(withoutFilter as never, PROJECT_ID, { origin: ORIGIN }))
      .resolves.toBe(await hashMapDesignStyle(relativeStyle as never, PROJECT_ID, { origin: ORIGIN }));
  });

  it.each([
    ['cross-origin', `https://attacker.example.test${relativeStyle.glyphs}`],
    ['cross-project', `${ORIGIN}${resource(OTHER_PROJECT_ID, 'glyphs', 'fonts/{fontstack}/{range}.pbf')}`],
    ['malformed', `${ORIGIN}${resource(PROJECT_ID, 'glyphs', '%2e%2e/secret')}`],
  ])('rejects %s resource fields instead of normalizing them', async (_name, glyphs) => {
    await expect(hashMapDesignStyle({ ...relativeStyle, glyphs } as never, PROJECT_ID, { origin: ORIGIN })).rejects.toThrow();
  });

  it('does not rewrite legitimate absolute URLs in unrelated style strings', async () => {
    const style = {
      version: 8 as const,
      sources: { geojson: { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, attribution: 'https://data.example.test/license' } },
      layers: [{ id: 'background', type: 'background', paint: { 'background-pattern': 'https://assets.example.test/pattern-name' } }],
      metadata: { documentation: 'https://docs.example.test/map-design' },
    };

    await expect(hashMapDesignStyle(style as never, PROJECT_ID, { origin: ORIGIN }))
      .resolves.toBe(await hashStyle(style as never));
  });

  it('retains unrelated root strings and non-background filters in the semantic hash', async () => {
    const base = {
      version: 8 as const,
      name: 'First style',
      sources: { geojson: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [{ id: 'places', type: 'circle', source: 'geojson', filter: ['==', 'kind', 'city'] }],
    };
    await expect(hashMapDesignStyle({ ...base, name: 'Second style' } as never, PROJECT_ID, { origin: ORIGIN }))
      .resolves.not.toBe(await hashMapDesignStyle(base as never, PROJECT_ID, { origin: ORIGIN }));
    await expect(hashMapDesignStyle({ ...base, layers: [{ ...base.layers[0], filter: ['==', 'kind', 'town'] }] } as never, PROJECT_ID, { origin: ORIGIN }))
      .resolves.not.toBe(await hashMapDesignStyle(base as never, PROJECT_ID, { origin: ORIGIN }));
  });
});
