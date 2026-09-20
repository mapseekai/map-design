import { expect, it } from 'vitest';
import { validateStyleDocument } from 'maplibre-style-tools/core';
import { buildCartographySampleStyle } from '../../src/map-design/map/cartography-sample-style';

it('applies Agent bindings to exact compatible elements and rejects incompatible geometry', () => {
  const elements = [
    { name: 'custom-artery', geometry: 'line' as const, strokeColor: '#123456', strokeWidth: 6, unsupported: [] },
    { name: 'custom-lake', geometry: 'polygon' as const, fillColor: '#abcdef', unsupported: [] },
  ];
  const result = buildCartographySampleStyle(elements, 'en', { 'road.primary': 'custom-artery', 'water.river': 'custom-lake' });
  expect(result.style.layers.find((layer) => layer.id === 'road.primary')?.paint).toMatchObject({ 'line-color': '#123456', 'line-width': 6 });
  expect(result.bindings.find((binding) => binding.key === 'road.primary')).toMatchObject({ viaAgent: true });
  const invalid = buildCartographySampleStyle(elements, 'en', { 'road.primary': 'custom-lake' });
  expect(invalid.bindings.find((binding) => binding.key === 'road.primary')?.status).toBe('unmatched');
});

it('matches explicit semantics and applies actual paint and font values', () => {
  const { style, bindings } = buildCartographySampleStyle([
    { name: 'primary-road', geometry: 'line', family: 'road', role: 'primary', strokeColor: '#123456', strokeWidth: 4, dash: [8, 4], unsupported: [] },
    { name: 'water-area', geometry: 'polygon', family: 'water', role: 'context', fillColor: '#abcdef', fillOpacity: 0.58, unsupported: [] },
    { name: 'place-label', geometry: 'label', family: 'place-label', role: 'primary', color: '#222222', fontFamily: ['Source Serif 4', 'Georgia'], fontSize: 15, unsupported: [] },
  ], 'zh-CN');
  expect(validateStyleDocument(style).ok).toBe(true);
  expect(style.layers.find((layer) => layer.id === 'road.primary')?.paint).toMatchObject({ 'line-color': '#123456', 'line-width': 4, 'line-dasharray': [2, 1] });
  expect(style.layers.find((layer) => layer.id === 'water.river')?.paint).toMatchObject({ 'fill-color': '#abcdef', 'fill-opacity': 0.58 });
  expect(style.layers.find((layer) => layer.id === 'label.district')?.layout).toMatchObject({ 'text-font': ['"Source Serif 4"', '"Georgia"'], 'text-size': 15 });
  expect(bindings.find((binding) => binding.key === 'road.primary')?.status).toBe('matched');
  expect(bindings.find((binding) => binding.key === 'building.public')?.status).toBe('unmatched');
});
it('does not interpret pipeline lines as roads and refuses ambiguous matches', () => {
  const { style, bindings } = buildCartographySampleStyle([
    { name: 'pipeline-primary', geometry: 'line', family: 'pipeline', role: 'primary', color: '#ff0000', unsupported: [] },
    { name: 'water-one', geometry: 'polygon', family: 'water', fillColor: '#ff0000', unsupported: [] },
    { name: 'water-two', geometry: 'polygon', family: 'water', fillColor: '#0000ff', unsupported: [] },
  ], 'en');
  expect(bindings.find((binding) => binding.key === 'road.primary')?.status).toBe('unmatched');
  expect(bindings.find((binding) => binding.key === 'water.river')?.status).toBe('ambiguous');
  expect(validateStyleDocument(style).ok).toBe(true);
});
it('reports unsupported properties and supports documents with no element definitions', () => {
  const partial = buildCartographySampleStyle([{ name: 'building', geometry: 'polygon', color: '#aaaaaa', unsupported: ['pattern'] }], 'en');
  expect(partial.bindings.find((binding) => binding.key === 'building.public')).toMatchObject({ status: 'partial', unsupported: ['pattern'] });
  const empty = buildCartographySampleStyle([], 'en');
  expect(empty.bindings.every((binding) => binding.status === 'unmatched')).toBe(true);
  expect(validateStyleDocument(empty.style).ok).toBe(true);
  expect(empty.style.glyphs).toBeUndefined();
});
