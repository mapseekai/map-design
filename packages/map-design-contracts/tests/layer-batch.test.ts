import { describe, expect, it } from 'vitest';
import { MapInspectInputSchema, MapInspectOutputSchema, MapSearchLayersInputSchema } from '../src/tools.js';

const ids = Array.from({ length: 200 }, (_, index) => `layer-${index}`);

describe('bounded batch layer reads', () => {
  it('accepts 200 unique inspection targets and rejects overflow or duplicates', () => {
    expect(MapInspectInputSchema.parse({ target: { kind: 'layers', layerIds: ids }, fields: ['paint'] })).toEqual({
      target: { kind: 'layers', layerIds: ids }, fields: ['paint'],
    });
    for (const layerIds of [[], [...ids, 'overflow'], ['same', 'same']]) {
      expect(MapInspectInputSchema.safeParse({ target: { kind: 'layers', layerIds } }).success).toBe(false);
    }
    expect(MapInspectInputSchema.safeParse({ target: { kind: 'layers', layerIds: ids }, fields: ['paint', 'paint'] }).success).toBe(false);
  });

  it('accepts grouped searches, pagination and a 200 layer limit', () => {
    expect(MapSearchLayersInputSchema.parse({ query: ['road', 'water'], limit: 200, offset: 200 })).toMatchObject({
      query: ['road', 'water'], limit: 200, offset: 200,
    });
    expect(MapSearchLayersInputSchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(MapSearchLayersInputSchema.safeParse({ query: [] }).success).toBe(false);
    expect(MapSearchLayersInputSchema.safeParse({ query: Array.from({ length: 21 }, () => 'road') }).success).toBe(false);
    expect(MapSearchLayersInputSchema.safeParse({ offset: -1 }).success).toBe(false);
    expect(MapSearchLayersInputSchema.parse({ query: 'road' }).limit).toBe(25);
  });

  it('correlates every batch result and omission with the requested IDs', () => {
    const response = {
      target: { kind: 'layers', layerIds: ['roads', 'missing', 'large'] },
      view: { kind: 'layers', layers: [{ id: 'roads', type: 'line', paint: {} }], returned: 1,
        missingLayerIds: ['missing'], omittedLayerIds: ['large'] }, truncated: true,
    };
    expect(MapInspectOutputSchema.safeParse(response).success).toBe(true);
    expect(MapInspectOutputSchema.safeParse({ ...response, view: { ...response.view, returned: 2 } }).success).toBe(false);
    expect(MapInspectOutputSchema.safeParse({ ...response, view: { ...response.view, missingLayerIds: ['foreign'] } }).success).toBe(false);
    expect(MapInspectOutputSchema.safeParse({ ...response, view: { ...response.view, missingLayerIds: ['roads'] } }).success).toBe(false);
  });
});

it('rejects batch targets whose identifiers alone exceed the inspection byte budget', () => {
  const layerIds = Array.from({ length: 200 }, (_, index) => `${index}-${'地'.repeat(250)}`);
  expect(MapInspectInputSchema.safeParse({ target: { kind: 'layers', layerIds } }).success).toBe(false);
});
