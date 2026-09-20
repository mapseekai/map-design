import {required} from './required.js';

import {describe, expect, it} from 'vitest';

import {collectReferencedFields, discoverStyle} from '../src/style.js';

describe('discoverStyle', () => {
  it('discovers vector source, layer zooms, and referenced fields without inferring values', () => {
    const fragment = discoverStyle(
      {
        version: 8,
        sources: {
          roads: {
            type: 'vector',
            url: 'https://tiles.example/roads.json',
            tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'],
          },
        },
        layers: [
          {
            id: 'transportation-lines',
            type: 'line',
            source: 'roads',
            'source-layer': 'transportation',
            minzoom: 5,
            maxzoom: 16,
            filter: ['all', ['has', 'name'], ['==', 'class', 'primary']],
            paint: {'line-color': ['match', ['get', 'status'], 'open', '#0f0', '#f00']},
            layout: {'text-field': 'Road {ref}'},
          },
        ],
      },
      'style.json',
    );

    expect(fragment.sources.roads).toMatchObject({
      type: 'vector',
      tileTemplates: [
        'https://tiles.example/roads.json',
        'https://tiles.example/{z}/{x}/{y}.pbf',
      ],
    });
    expect(required(fragment.sources.roads).layers.transportation).toMatchObject({
      minzoom: 5,
      maxzoom: 16,
      geometries: ['unknown'],
      stableIdObserved: false,
    });
    expect(required(required(required(fragment.sources.roads).layers.transportation).fields.status).types).toEqual(['unknown']);
    expect(required(required(required(fragment.sources.roads).layers.transportation).fields.name).types).toEqual(['unknown']);
    expect(required(required(required(fragment.sources.roads).layers.transportation).fields.class).types).toEqual(['unknown']);
    expect(required(required(required(fragment.sources.roads).layers.transportation).fields.ref).types).toEqual(['unknown']);
    expect(required(required(required(fragment.sources.roads).layers.transportation).fields.status).categories).toEqual([]);
    expect(required(required(fragment.sources.roads).layers.transportation).evidence[0]?.kind).toBe('style-inferred');
    expect(required(required(required(fragment.sources.roads).layers.transportation).fields.status).evidence[0]?.kind).toBe(
      'style-inferred',
    );
  });

  it('retains evidence from every style layer contributing extrema or field support', () => {
    const fragment = discoverStyle(
      {
        version: 8,
        sources: {roads: {type: 'vector'}},
        layers: [
          {
            id: 'first',
            source: 'roads',
            'source-layer': 'transportation',
            minzoom: 8,
            maxzoom: 12,
            paint: {
              'line-width': ['get', 'shared'],
              'line-opacity': ['get', 'firstOnly'],
            },
          },
          {
            id: 'second',
            source: 'roads',
            'source-layer': 'transportation',
            minzoom: 4,
            maxzoom: 16,
            filter: ['has', 'shared'],
            paint: {'line-width': ['get', 'secondOnly']},
          },
        ],
      },
      'style.json',
    );
    const layer = required(required(fragment.sources.roads).layers.transportation);

    expect(layer).toMatchObject({minzoom: 4, maxzoom: 16});
    expect(layer.evidence.map((item) => item.location)).toEqual(['#/layers/0', '#/layers/1']);
    expect(required(layer.fields.shared).evidence.map((item) => item.location)).toEqual([
      '#/layers/0',
      '#/layers/1',
    ]);
    expect(required(layer.fields.firstOnly).evidence.map((item) => item.location)).toEqual(['#/layers/0']);
    expect(required(layer.fields.secondOnly).evidence.map((item) => item.location)).toEqual(['#/layers/1']);
  });

  it('reports unresolved style facts instead of guessing a layer or dynamic field', () => {
    const fragment = discoverStyle(
      {
        sources: {custom: {type: 'vector', url: 'mapbox://example.roads'}},
        layers: [
          {id: 'missing-source-layer', type: 'line', source: 'custom'},
          {
            id: 'dynamic-field',
            type: 'line',
            source: 'custom',
            'source-layer': 'roads',
            filter: ['==', ['get', ['var', 'fieldName']], 'primary'],
          },
        ],
      },
      'style.json',
    );

    expect(required(fragment.sources.custom).layers).toHaveProperty('default');
    expect(required(required(fragment.sources.custom).layers.roads).fields).toEqual({});
    expect(fragment.unresolved.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'vector-layer-missing-source-layer',
        'source-url-not-inspectable',
        'dynamic-field-reference',
      ]),
    );
    expect(fragment.unresolved.every((item) => item.evidence[0]?.kind === 'style-inferred')).toBe(true);
  });

  it('retains prototype-like source, source-layer, and field IDs as own enumerable facts', () => {
    const identifiers = ['__proto__', 'constructor', 'toString'];
    const style = JSON.parse(`{
      "version": 8,
      "sources": {
        "__proto__": {"type": "vector"},
        "constructor": {"type": "vector"},
        "toString": {"type": "vector"}
      },
      "layers": [
        {
          "id": "prototype",
          "type": "circle",
          "source": "__proto__",
          "source-layer": "__proto__",
          "paint": {"circle-radius": ["case", ["has", "__proto__"], ["get", "constructor"], ["get", "toString"]]}
        },
        {
          "id": "constructor",
          "type": "circle",
          "source": "constructor",
          "source-layer": "constructor",
          "paint": {"circle-radius": ["case", ["has", "__proto__"], ["get", "constructor"], ["get", "toString"]]}
        },
        {
          "id": "to-string",
          "type": "circle",
          "source": "toString",
          "source-layer": "toString",
          "paint": {"circle-radius": ["case", ["has", "__proto__"], ["get", "constructor"], ["get", "toString"]]}
        }
      ]
    }`) as unknown;
    const objectPrototypeKeys = Object.keys(Object.prototype);

    const fragment = discoverStyle(style, 'style.json');

    expect(Object.getPrototypeOf(fragment.sources)).toBeNull();
    expect(Object.keys(Object.prototype)).toEqual(objectPrototypeKeys);
    for (const identifier of identifiers) {
      expect(Object.prototype.propertyIsEnumerable.call(fragment.sources, identifier)).toBe(true);
      const source = fragment.sources[identifier]!;
      expect(Object.getPrototypeOf(source.layers)).toBeNull();
      expect(Object.prototype.propertyIsEnumerable.call(source.layers, identifier)).toBe(true);
      const layer = source.layers[identifier]!;
      expect(Object.getPrototypeOf(layer.fields)).toBeNull();
      for (const field of identifiers) {
        expect(Object.prototype.propertyIsEnumerable.call(layer.fields, field)).toBe(true);
      }
    }
  });

  it('treats legacy comparison field positions as fields only inside filters', () => {
    const fragment = discoverStyle(
      {
        sources: {roads: {type: 'vector'}},
        layers: [
          {
            id: 'road-lines',
            type: 'line',
            source: 'roads',
            'source-layer': 'roads',
            filter: ['==', 'class', 'primary'],
            paint: {'line-opacity': ['==', 'enabled', 'enabled']},
          },
        ],
      },
      'style.json',
    );

    expect(required(required(fragment.sources.roads).layers.roads).fields).toHaveProperty('class');
    expect(required(required(fragment.sources.roads).layers.roads).fields).not.toHaveProperty('enabled');
  });
});

describe('collectReferencedFields', () => {
  it('defaults to legacy filter semantics for direct callers', () => {
    expect(
      collectReferencedFields([
        'all',
        ['get', 'modern'],
        ['has', 'present'],
        ['in', 'legacy', 'a', 'b'],
        ['literal', 'not-a-field'],
      ]),
    ).toEqual(['modern', 'present', 'legacy']);
  });

  it('does not recurse into literal expression values', () => {
    expect(collectReferencedFields(['literal', ['get', 'not_a_field']])).toEqual([]);
  });
});

describe('style source templates', () => {
  it('drops every HTTP(S) query value before retaining source templates', () => {
    const fragment = discoverStyle(
      {
        sources: {
          roads: {
            type: 'vector',
            url: 'https://user:password@tiles.example/roads.json?password=top-secret&client_secret=hidden&unknown=also-hidden#private',
            tiles: ['https://tiles.example/{z}/{x}/{y}.pbf?arbitrary=not-safe'],
          },
        },
      },
      'style.json',
    );

    expect(required(fragment.sources.roads).tileTemplates).toEqual([
      'https://tiles.example/roads.json',
      'https://tiles.example/{z}/{x}/{y}.pbf',
    ]);
    expect(fragment.unresolved.map((item) => item.code)).toContain('credential-redacted');
    expect(JSON.stringify(fragment)).not.toContain('user');
    expect(JSON.stringify(fragment)).not.toContain('password');
    expect(JSON.stringify(fragment)).not.toContain('top-secret');
    expect(JSON.stringify(fragment)).not.toContain('client_secret');
    expect(JSON.stringify(fragment)).not.toContain('hidden');
    expect(JSON.stringify(fragment)).not.toContain('unknown');
    expect(JSON.stringify(fragment)).not.toContain('also-hidden');
    expect(JSON.stringify(fragment)).not.toContain('arbitrary');
    expect(JSON.stringify(fragment)).not.toContain('not-safe');
  });

  it('reports non-HTTP non-local tile templates as unresolved while retaining safe templates', () => {
    const fragment = discoverStyle(
      {
        sources: {
          roads: {
            type: 'vector',
            tiles: [
              'mapbox://tileset/{z}/{x}/{y}',
              'https://tiles.example/{z}/{x}/{y}.pbf',
              './tiles/{z}/{x}/{y}.pbf',
              '/tiles/{z}/{x}/{y}.pbf',
            ],
          },
        },
      },
      'style.json',
    );

    expect(required(fragment.sources.roads).tileTemplates).toEqual([
      'mapbox://tileset/{z}/{x}/{y}',
      'https://tiles.example/{z}/{x}/{y}.pbf',
      './tiles/{z}/{x}/{y}.pbf',
      '/tiles/{z}/{x}/{y}.pbf',
    ]);
    expect(fragment.unresolved.map((item) => item.code)).toContain('tile-template-not-inspectable');
  });

  it('reports invalid HTTP source URLs and tile templates as unresolved', () => {
    const fragment = discoverStyle(
      {
        sources: {
          roads: {
            type: 'vector',
            url: 'https://',
            tiles: ['http://', 'https://?unknown=not-retained', './tiles/{z}/{x}/{y}.pbf'],
          },
        },
      },
      'style.json',
    );

    expect(required(fragment.sources.roads).tileTemplates).toEqual([
      'https://',
      'http://',
      'https://',
      './tiles/{z}/{x}/{y}.pbf',
    ]);
    expect(fragment.unresolved.map((item) => item.code)).toEqual(
      expect.arrayContaining(['source-url-not-inspectable', 'tile-template-not-inspectable']),
    );
    expect(JSON.stringify(fragment)).not.toContain('unknown');
    expect(JSON.stringify(fragment)).not.toContain('not-retained');
  });

  it('does not interpret a queried URL as an explicit local tile template', () => {
    const fragment = discoverStyle(
      {
        sources: {
          roads: {
            type: 'vector',
            tiles: ['/tiles/{z}/{x}/{y}.pbf?cache=untrusted', './tiles/{z}/{x}/{y}.pbf'],
          },
        },
      },
      'style.json',
    );

    expect(required(fragment.sources.roads).tileTemplates).toEqual([
      '/tiles/{z}/{x}/{y}.pbf',
      './tiles/{z}/{x}/{y}.pbf',
    ]);
    expect(fragment.unresolved.map((item) => item.code)).toContain('tile-template-not-inspectable');
    expect(JSON.stringify(fragment)).not.toContain('cache');
    expect(JSON.stringify(fragment)).not.toContain('untrusted');
  });
});
