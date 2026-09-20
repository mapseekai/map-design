import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { validateStyleDocument } from 'maplibre-style-tools/core';

const load = (name: string) => JSON.parse(readFileSync(new URL(`../../public/cartography-sample/${name}`, import.meta.url), 'utf8'));
it('ships valid sample layers and stable, closed geometry for every declared role', () => {
  const data = load('riverside.geojson');
  const manifest = load('manifest.json');
  const style = load('style.json');
  expect(validateStyleDocument(style).ok).toBe(true);
  expect(data.features).toHaveLength(manifest.featureCount);
  expect(new Set(data.features.map((f: { id: string }) => f.id)).size).toBe(data.features.length);
  for (const feature of data.features) {
    expect(feature.properties.synthetic).toBe(true);
    expect(feature.properties.match_key).toBe(`${feature.properties.family}.${feature.properties.role}`);
    expect(feature.properties.name).toBeTruthy();
    if (feature.geometry.type === 'Polygon') {
      for (const ring of feature.geometry.coordinates) {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring[0]).toEqual(ring.at(-1));
      }
    }
  }
  for (const role of manifest.roles) {
    expect(data.features.filter((f: { properties: { match_key: string } }) => f.properties.match_key === role.match_key)).toHaveLength(role.count);
  }
  expect(style.glyphs).toBeUndefined();
  expect(style.layers.some((layer: { type: string }) => layer.type === 'symbol')).toBe(true);
});
