import { describe, expect, it } from 'vitest';
import { enlargeTextSize, featureHighlightLayer } from '../../../src/map-design/comments/feature-highlight';
import type { PickedFeature } from '../../../src/map-design/comments/feature-picking';

const water: PickedFeature = {
  id: 0, source: 'basemap', sourceLayer: 'water', layer: { id: 'water-fill' },
  properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
};

describe('native feature highlight', () => {
  it('addresses the selected feature in its existing vector source without stroking tile edges', () => {
    expect(featureHighlightLayer(water, 'selection')).toEqual({
      id: '__map-design-highlight:selection', source: 'basemap', 'source-layer': 'water',
      filter: ['==', ['id'], 0], type: 'fill',
      paint: { 'fill-color': '#a9583e', 'fill-opacity': 0.3, 'fill-antialias': false },
    });
  });

  it('keeps string ids typed and does not highlight an entire source when no id exists', () => {
    expect(featureHighlightLayer({ ...water, id: '0' }, 'selection')).toMatchObject({ filter: ['==', ['id'], '0'] });
    expect(featureHighlightLayer({ ...water, id: undefined }, 'selection')).toBeNull();
  });

  it('uses native line and circle renderers for non-polygon features', () => {
    expect(featureHighlightLayer({ ...water, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }, 'selection')?.type).toBe('line');
    expect(featureHighlightLayer({ ...water, geometry: { type: 'Point', coordinates: [0, 0] } }, 'selection')?.type).toBe('circle');
  });
});

it('enlarges only the identified text in a temporary symbol layer', () => {
  const original = { id: 'labels', type: 'symbol' as const, source: 'basemap', 'source-layer': 'places',
    layout: { 'text-field': ['get', 'name'], 'text-size': ['interpolate', ['linear'], ['zoom'], 0, 10, 12, 20] },
    paint: { 'text-color': '#111111' } };
  const before = JSON.stringify(original);
  const layer = featureHighlightLayer({ ...water, sourceLayer: 'places', layer: { id: 'labels' }, geometry: { type: 'Point', coordinates: [0, 0] } }, 'hover', '#a9583e', original as never);
  expect(layer).toMatchObject({ type: 'symbol', source: 'basemap', 'source-layer': 'places', filter: ['==', ['id'], 0],
    layout: { 'text-field': ['get', 'name'], 'text-size': ['interpolate', ['linear'], ['zoom'], 0, 13, 12, 26], 'text-allow-overlap': true } });
  expect(JSON.stringify(original)).toBe(before);
  expect(enlargeTextSize(['step', ['zoom'], 10, 5, 20])).toEqual(['step', ['zoom'], 13, 5, 26]);
  expect(enlargeTextSize(['get', 'size'])).toEqual(['*', ['get', 'size'], 1.3]);
});

it('preserves legacy zoom and property functions while scaling text sizes', () => {
  expect(enlargeTextSize({ base: 1.2, stops: [[2, 12], [6, 16]] })).toEqual({ base: 1.2, stops: [[2, expect.closeTo(15.6)], [6, expect.closeTo(20.8)]] });
  expect(enlargeTextSize({ property: 'rank', type: 'categorical', default: 10, stops: [['capital', 20]] })).toEqual({ property: 'rank', type: 'categorical', default: 13, stops: [['capital', 26]] });
});
