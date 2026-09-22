import { describe, expect, it } from 'vitest';
import { MapInspectInputSchema, MapSearchLayersInputSchema } from '@mapseekai/map-design-contracts';
import type { StyleDocument } from 'maplibre-style-tools/core';
import { inspectMapStyle, searchMapLayers } from '../../../src/map-design/application/map-layer-read.js';

const style: StyleDocument = {
  version: 8, sources: {}, layers: Array.from({ length: 200 }, (_, index) => ({
    id: `background-${index}`, type: 'background',
    paint: { 'background-color': '#123456', 'background-opacity': 0.5 },
    layout: { visibility: 'visible' },
  })),
};
const snapshot = { style, semantics: { version: 1 as const, groups: [] } };

describe('projected layer reads', () => {
  it('returns only requested property keys when inspecting a layer', () => {
    const input = MapInspectInputSchema.parse({ target: { kind: 'layer', layerId: 'background-0' },
      properties: { paint: ['background-color'] } });
    const output = inspectMapStyle(snapshot, input);
    expect(output.view).toMatchObject({ layer: { paint: { 'background-color': '#123456' } } });
    if (output.view.kind !== 'layer') throw new Error('Expected layer');
    expect(output.view.layer.paint).toEqual({ 'background-color': '#123456' });
    expect(output.view.layer.layout).toBeUndefined();
  });

  it('returns projected properties directly from layer search', () => {
    const input = MapSearchLayersInputSchema.parse({ query: 'background-0', properties: { paint: ['background-color'] } });
    const output = searchMapLayers(style, input);
    expect(output.layers).toEqual([{ id: 'background-0', type: 'background', paint: { 'background-color': '#123456' } }]);
  });

  it('keeps default batch output small and exposes every omitted layer for continuation', () => {
    const input = MapInspectInputSchema.parse({ target: { kind: 'layers', layerIds: style.layers.map(layer => layer.id) } });
    const output = inspectMapStyle(snapshot, input);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(16 * 1024);
    expect(output.truncated).toBe(true);
    if (output.view.kind !== 'layers') throw new Error('Expected layers');
    expect(output.view.layers.length + output.view.omittedLayerIds.length).toBe(200);
    expect(output.view.layers.length).toBeGreaterThan(0);
  });

  it('paginates projected search at the byte boundary without skipping rows', () => {
    const input = MapSearchLayersInputSchema.parse({ limit: 200, fields: ['paint', 'layout'], maxBytes: 8192 });
    const output = searchMapLayers(style, input);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(8192);
    expect(output.nextOffset).toBe(output.returned);
    expect(output.truncated).toBe(true);
    const next = searchMapLayers(style, { ...input, offset: output.nextOffset });
    expect(next.layers[0]?.id).toBe(`background-${output.returned}`);
  });

  it('reports omitted fields on an oversized search row while making progress', () => {
    const largeStyle: StyleDocument = { ...style, layers: [{ id: 'large', type: 'background',
      paint: { 'background-color': 'x'.repeat(20000) } }, ...style.layers.slice(0, 1)] };
    const input = MapSearchLayersInputSchema.parse({ fields: ['paint'], maxBytes: 8192 });
    const output = searchMapLayers(largeStyle, input);
    expect(output).toMatchObject({ returned: 2, truncated: true,
      layers: [{ id: 'large', omittedFields: ['paint'] }, { id: 'background-0', paint: { 'background-color': '#123456' } }] });
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(8192);
  });

  it('continues root discovery from the returned layer offset', () => {
    const input = MapInspectInputSchema.parse({ target: { kind: 'root' }, maxBytes: 8192 });
    const output = inspectMapStyle(snapshot, input);
    expect(output.truncated).toBe(true);
    if (output.view.kind !== 'root') throw new Error('Expected root');
    expect(output.nextOffset).toBe(output.view.layers.length);
    const next = inspectMapStyle(snapshot, { ...input, offset: output.nextOffset });
    if (next.view.kind !== 'root') throw new Error('Expected root');
    expect(next.view.layers[0]?.id).toBe(`background-${output.view.layers.length}`);
  });

  it('keeps escaped multibyte batch payloads inside the exact requested budget', () => {
    const unicodeStyle: StyleDocument = { ...style, layers: Array.from({ length: 40 }, (_, index) => ({
      id: `地\"${index}`, type: 'background', paint: { 'background-color': `色${'\\\t地'.repeat(250)}` },
    })) };
    const input = MapInspectInputSchema.parse({ target: { kind: 'layers', layerIds: unicodeStyle.layers.map(layer => layer.id) },
      fields: ['paint'], maxBytes: 8192 });
    const output = inspectMapStyle({ ...snapshot, style: unicodeStyle }, input);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(8192);
    if (output.view.kind !== 'layers') throw new Error('Expected layers');
    expect(output.view.returned).toBeGreaterThan(0);
    expect(output.view.returned + output.view.omittedLayerIds.length).toBe(40);
  });

  it('continues source-layer IDs and source summaries at their returned offsets', () => {
    const sourceStyle: StyleDocument = { version: 8,
      sources: Object.fromEntries(Array.from({ length: 105 }, (_, i) => [`source-${i}`, { type: 'vector', tiles: [] }])),
      layers: Array.from({ length: 205 }, (_, i) => ({ id: `road-${i}`, type: 'line', source: 'source-0', 'source-layer': 'roads' })),
    };
    const sourceSnapshot = { ...snapshot, style: sourceStyle };
    const input = MapInspectInputSchema.parse({ target: { kind: 'source-layer', sourceId: 'source-0', sourceLayer: 'roads' }, offset: 200 });
    expect(inspectMapStyle(sourceSnapshot, input)).toMatchObject({ truncated: false,
      view: { layerIds: ['road-200', 'road-201', 'road-202', 'road-203', 'road-204'] } });
    const root = inspectMapStyle(sourceSnapshot, MapInspectInputSchema.parse({ target: { kind: 'root' }, offset: 205, sourceOffset: 100 }));
    expect(root).toMatchObject({ truncated: false, view: { layers: [], sources: [{ id: 'source-100' }, { id: 'source-101' },
      { id: 'source-102' }, { id: 'source-103' }, { id: 'source-104' }] } });
  });
});
