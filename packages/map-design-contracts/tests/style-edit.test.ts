import { createFunction, createPropertyExpression, validateStyleMin, v8, type StylePropertySpecification, type StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';

import {
  MapStyleEditInputSchema,
  buildMapStyleEditPatch,
  getMapStyleControls,
  canScopeMapStyleControl,
  mapStyleControlFallback,
} from '../src/style-edit.js';

const target = {
  layerId: 'places', sourceId: 'places-source', sourceLayer: 'place', featureId: 42,
  properties: { class: 'city' }, anchor: [10, 20] as [number, number], geometryType: 'Point' as const,
};

const input = (overrides: Record<string, unknown> = {}) => MapStyleEditInputSchema.parse({
  expectedRevision: 4,
  styleHash: 'a'.repeat(64),
  idempotencyKey: 'style-edit-1',
  target,
  scope: 'feature',
  changes: { 'circle-color': '#3366ff' },
  ...overrides,
});

describe('style edit contracts', () => {
  it.each([
    { stops: [[2, 12], [6, 16]] },
    { type: 'exponential', base: 1.5, stops: [[2, 12], [6, 16]] },
    { type: 'categorical', property: 'class', stops: [['city', 18], ['town', 12]], default: 10 },
    { type: 'exponential', property: 'rank', stops: [[{ zoom: 2, value: 1 }, 12], [{ zoom: 2, value: 5 }, 16], [{ zoom: 6, value: 1 }, 20], [{ zoom: 6, value: 5 }, 24]] },
    { type: 'identity', property: 'size', default: 16 },
  ])('preserves legacy text-size functions for unselected features: %j', (legacy) => {
    const spec = v8.layout_symbol['text-size'] as unknown as StylePropertySpecification;
    const layer = { id: 'places', type: 'symbol' as const, source: 'places-source', 'source-layer': 'place', layout: { 'text-size': legacy } };
    const patch = buildMapStyleEditPatch(layer, input({ changes: { 'text-size': 22 } }));
    expect(validateStyleMin({ version: 8, sources: { 'places-source': { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{ ...layer, layout: { ...layer.layout, ...patch.layout } }] } as unknown as StyleSpecification)).toEqual([]);
    const parsed = createPropertyExpression(patch.layout['text-size'], 'text-size', spec);
    expect(parsed.result).toBe('success');
    if (parsed.result !== 'success') throw new Error('Generated expression did not compile.');
    const original = createFunction(legacy, spec);
    for (const zoom of [0, 2, 4, 6, 10]) {
      for (const properties of [{ class: 'city', rank: 3, size: 19 }, { class: 'unknown', rank: 1 }]) {
        expect(parsed.value.evaluate({ zoom }, { id: 42, type: 'Point', properties })).toBe(22);
        expect(parsed.value.evaluate({ zoom }, { id: 43, type: 'Point', properties }))
          .toBeCloseTo(original.evaluate({ zoom }, { id: 43, type: 'Point', properties }), 6);
      }
    }
  });

  it.each(['rgb', 'lab', 'hcl'])('preserves legacy fill-color interpolation in %s space', (colorSpace) => {
    const legacy = { colorSpace, stops: [[2, '#123456'], [6, '#abcdef']] };
    const layer = { id: 'places', type: 'fill' as const, source: 'places-source', 'source-layer': 'place', paint: { 'fill-color': legacy } };
    const patch = buildMapStyleEditPatch(layer, input({ changes: { 'fill-color': '#3366ff' } }));
    expect(validateStyleMin({ version: 8, sources: { 'places-source': { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{ ...layer, paint: patch.paint }] })).toEqual([]);
    const spec = v8.paint_fill['fill-color'] as StylePropertySpecification;
    const parsed = createPropertyExpression(patch.paint['fill-color'], 'fill-color', spec);
    if (parsed.result !== 'success') throw new Error('Generated expression did not compile.');
    const original = createFunction(legacy, spec);
    for (const zoom of [0, 2, 4, 6, 10]) {
      const feature = { id: 43, type: 'Polygon' as const, properties: {} };
      const actual = parsed.value.evaluate({ zoom }, feature);
      const expected = original.evaluate({ zoom }, feature);
      for (const channel of ['r', 'g', 'b', 'a']) expect(actual[channel]).toBeCloseTo(expected[channel], 5);
    }
  });

  it('keeps zoom interpolation at the top level and scopes each output', () => {
    const existing = ['interpolate', ['linear'], ['zoom'], 4, '#111111', 10, '#222222'];
    expect(buildMapStyleEditPatch({ id: 'places', type: 'circle', paint: { 'circle-color': existing } }, input())).toEqual({
      paint: { 'circle-color': ['interpolate', ['linear'], ['zoom'], 4, ['case', ['==', ['id'], 42], '#3366ff', '#111111'], 10, ['case', ['==', ['id'], 42], '#3366ff', '#222222']] },
      layout: {},
    });
  });

  it('keeps zoom steps at the top level and rejects nested zoom forms it cannot preserve', () => {
    const existing = ['step', ['zoom'], 1, 8, 2, 12, 4];
    expect(buildMapStyleEditPatch({ id: 'places', type: 'circle', paint: { 'circle-radius': existing } }, input({ changes: { 'circle-radius': 9 } })).paint).toEqual({
      'circle-radius': ['step', ['zoom'], ['case', ['==', ['id'], 42], 9, 1], 8, ['case', ['==', ['id'], 42], 9, 2], 12, ['case', ['==', ['id'], 42], 9, 4]],
    });
    expect(() => buildMapStyleEditPatch(
      { id: 'places', type: 'circle', paint: { 'circle-radius': ['let', 'size', ['zoom'], ['step', ['var', 'size'], 1, 8, 2]] } },
      input({ changes: { 'circle-radius': 9 } }),
    )).toThrow(/zoom expression/u);
  });

  it('requires a matching property and applies similar edits only when it exists with the exact value', () => {
    const edit = input({ scope: 'similar', match: { property: 'class', value: 'city' } });
    expect(buildMapStyleEditPatch({ id: 'places', type: 'circle', paint: {} }, edit).paint).toEqual({
      'circle-color': ['case', ['all', ['has', 'class'], ['==', ['get', 'class'], 'city']], '#3366ff', '#000000'],
    });
  });

  it('uses concrete values for layer scope and places text size in layout', () => {
    const edit = input({ scope: 'layer', target: { ...target, layerId: 'labels' }, changes: { 'text-color': '#112233', 'text-size': 18 } });
    expect(buildMapStyleEditPatch({ id: 'labels', type: 'symbol', paint: {}, layout: {} }, edit)).toEqual({
      paint: { 'text-color': '#112233' }, layout: { 'text-size': 18 },
    });
  });

  it('rejects unsupported properties, invalid bounds, and feature edits without a stable id', () => {
    expect(() => input({ changes: { 'fill-pattern': 'dots' } })).toThrow();
    expect(MapStyleEditInputSchema.safeParse({ ...input(), changes: { constructor: '#fff' } }).success).toBe(false);
    expect(() => input({ changes: { 'circle-opacity': 1.1 } })).toThrow();
    expect(() => input({ changes: { 'circle-color': '#12345' } })).toThrow();
    expect(() => input({ target: { ...target, featureId: undefined } })).toThrow();
  });

  it('exposes controls only for properties supported by the selected layer type', () => {
    expect(getMapStyleControls('line').map((control) => control.property)).toEqual(expect.arrayContaining([
      'line-color', 'line-opacity', 'line-width', 'line-dasharray', 'line-cap', 'line-join',
    ]));
    expect(getMapStyleControls('line')[1]).toMatchObject({ kind: 'number', min: 0, max: 1, step: 0.05 });
    expect(getMapStyleControls('constructor')).toEqual([]);
  });
});

describe('MapLibre typed controls', () => {
  it.each([
    ['line', 'line-cap', 'round', 'layout'],
    ['line', 'line-join', 'bevel', 'layout'],
    ['line', 'line-dasharray', [2, 4], 'paint'],
    ['fill', 'fill-antialias', false, 'paint'],
    ['circle', 'circle-stroke-width', 3, 'paint'],
    ['symbol', 'text-offset', [1, -2], 'layout'],
    ['symbol', 'text-allow-overlap', true, 'layout'],
    ['fill-extrusion', 'fill-extrusion-height', 120, 'paint'],
  ] as const)('generates a valid %s layer edit for %s', (type, property, value, section) => {
    const layer = { id: 'places', type, source: 'places-source', 'source-layer': 'place' };
    const patch = buildMapStyleEditPatch(layer, input({ scope: 'layer', changes: { [property]: value } }));
    expect(patch[section][property]).toEqual(value);
    expect(validateStyleMin({ version: 8, sources: { 'places-source': { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } }, layers: [{ ...layer, ...patch }] } as StyleSpecification)).toEqual([]);
  });
  it('uses specification ranges instead of arbitrary UI limits', () => {
    expect(() => input({ changes: { 'line-width': 200 } })).not.toThrow();
    expect(() => input({ changes: { 'text-size': 0 } })).not.toThrow();
    expect(() => input({ changes: { 'line-width': -1 } })).toThrow();
    expect(() => input({ changes: { 'line-cap': 'triangle' } })).toThrow();
    expect(() => input({ changes: { 'circle-translate': [1] } })).toThrow();
    expect(() => input({ changes: { 'line-dasharray': [2, -1] } })).toThrow();
    expect(() => input({ changes: { 'fill-color': 'rgba(10, 20, 30, 0.5)' } })).not.toThrow();
  });
  it('rejects feature expressions for layer-only properties', () => {
    expect(() => buildMapStyleEditPatch({ id: 'places', type: 'fill' }, input({ changes: { 'fill-antialias': false } }))).toThrow(/layer scope/);
    expect(() => buildMapStyleEditPatch({ id: 'places', type: 'symbol' }, input({ changes: { 'text-allow-overlap': true } }))).toThrow(/layer scope/);
    expect(() => buildMapStyleEditPatch({ id: 'places', type: 'fill-extrusion' }, input({ changes: { 'fill-extrusion-opacity': 0.5 } }))).toThrow(/layer scope/);
  });
  it('wraps array literals in scoped expressions and preserves other features', () => {
    const patch = buildMapStyleEditPatch({ id: 'places', type: 'symbol', layout: { 'text-offset': [0, 2] } }, input({ changes: { 'text-offset': [3, 4] } }));
    // Raw layout specifications omit transition; layout properties do not transition.
    const specification = { ...v8.layout_symbol['text-offset'], transition: false } as StylePropertySpecification;
    const compiled = createPropertyExpression(patch.layout['text-offset'], 'text-offset', specification);
    expect(compiled.result).toBe('success');
    if (compiled.result !== 'success') throw Error('Invalid expression');
    expect(compiled.value.evaluate({ zoom: 5 }, { id: 42, type: 'Point', properties: {} })).toEqual([3, 4]);
    expect(compiled.value.evaluate({ zoom: 5 }, { id: 43, type: 'Point', properties: {} })).toEqual([0, 2]);
  });
  it('preserves the inherited fill color when setting an outline for one feature', () => {
    const patch = buildMapStyleEditPatch({ id: 'places', type: 'fill', paint: { 'fill-color': '#abcdef' } }, input({ changes: { 'fill-outline-color': '#ff0000' } }));
    expect(patch.paint['fill-outline-color']).toEqual(['case', ['==', ['id'], 42], '#ff0000', '#abcdef']);
  });
});

it('compiles every supported scoped property using the installed MapLibre specification', () => {
  for (const type of ['fill', 'line', 'circle', 'symbol', 'fill-extrusion']) {
    const layer = { id: 'places', type, paint: { 'line-dasharray': [2, 4] } };
    for (const control of getMapStyleControls(type)) {
      if (!canScopeMapStyleControl(layer, control)) continue;
      const value = control.property === 'line-dasharray' ? [1, 2, 3, 4] : mapStyleControlFallback(layer, control);
      const patch = buildMapStyleEditPatch(layer, input({ changes: { [control.property]: value } }));
      const group = v8[`${control.section}_${type}` as keyof typeof v8] as Record<string, StylePropertySpecification>;
      expect(createPropertyExpression(patch[control.section][control.property], control.property, group[control.property]!).result, control.property).toBe('success');
    }
  }
});
