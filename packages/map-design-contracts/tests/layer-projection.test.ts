import { expect, it } from 'vitest';
import { MapInspectInputSchema, MapInspectOutputSchema, MapSearchLayersInputSchema, MapSearchLayersOutputSchema } from '../src/layer-read.js';
import { mapJsonByteLength } from '../src/project.js';

it('accepts bounded property projections and byte budgets for both read tools', () => {
  const projection = { properties: { paint: ['line-color'], layout: ['visibility'] }, maxBytes: 8192 };
  expect(MapInspectInputSchema.safeParse({ target: { kind: 'layers', layerIds: ['road'] }, ...projection }).success).toBe(true);
  expect(MapSearchLayersInputSchema.safeParse(projection).success).toBe(true);
});

it('rejects malformed property projections and unsupported budgets', () => {
  for (const input of [
    { properties: { paint: ['line-color', 'line-color'] } },
    { properties: { paint: ['__proto__'] } },
    { properties: { paint: [''] } },
    { properties: { paint: Array.from({ length: 65 }, (_, i) => `key-${i}`) } },
    { maxBytes: 8191 }, { maxBytes: 262145 },
  ]) expect(MapSearchLayersInputSchema.safeParse(input).success).toBe(false);
});

it('reserves the entire response envelope when a batch contains only missing IDs', () => {
  const layerIds = Array.from({ length: 20 }, (_, i) => `${i}-${'x'.repeat(250)}`);
  const target = { kind: 'layers', layerIds };
  const completeResponse = { target,
    view: { kind: 'layers', layers: [], returned: 0, missingLayerIds: layerIds, omittedLayerIds: [] }, truncated: false };
  const maxBytes = mapJsonByteLength(completeResponse) - 1;
  expect(MapInspectInputSchema.safeParse({ target, maxBytes }).success).toBe(false);
});

it('rejects continuation metadata that claims an untruncated response', () => {
  expect(MapSearchLayersOutputSchema.safeParse({ layers: [{ id: 'road', type: 'line', omittedFields: ['paint'] }],
    returned: 1, truncated: false }).success).toBe(false);
  expect(MapInspectOutputSchema.safeParse({ target: { kind: 'source-layer', sourceId: 'base', sourceLayer: 'road' },
    view: { kind: 'source-layer', sourceId: 'base', sourceLayer: 'road', layerIds: [] }, truncated: false, nextOffset: 2 }).success).toBe(false);
});
