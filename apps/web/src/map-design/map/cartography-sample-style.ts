import { CARTOGRAPHY_SAMPLE_GEOMETRY, type CartographySampleKey, type CartographySampleBindings, type CartographyMapElement } from '@mapseekai/map-design-contracts';
import type { FilterSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';

export interface SampleBinding { key: string; element?: string; status: 'matched' | 'partial' | 'unmatched' | 'ambiguous'; unsupported: string[]; viaAgent?: boolean; }
const normalize = (name: string) => name.toLowerCase().replace(/[._]/g, '-').replace(/^roads-/, 'road-');
const families: Record<string, string[]> = { water: ['water'], building: ['building', 'buildings'], landuse: ['landuse', 'park', 'greenspace'], road: ['road', 'roads'], poi: ['poi', 'point', 'atlas-point'], label: ['label', 'place-label'], background: ['background', 'canvas', 'atlas-ground'] };

export function buildCartographySampleStyle(elements: CartographyMapElement[], language: string, sampleBindings: CartographySampleBindings = {}) {
  const bindings: SampleBinding[] = [];
  const layers: LayerSpecification[] = [];
  const groups = Object.entries(CARTOGRAPHY_SAMPLE_GEOMETRY).map(([match_key, geometry]) => { const [family, role] = match_key.split('.'); return { match_key, geometry, family: family!, role: role! }; });
  for (const group of groups) {
    const geometry = group.geometry;
    const ranked = elements.filter((e) => e.geometry === geometry).map((element) => {
      let score = 0;
      const name = normalize(element.name);
      const family = normalize(element.family ?? '');
      const role = normalize(element.role ?? '');
      if (name === normalize(group.match_key)) score = 4;
      const sameFamily = families[group.family]?.includes(family);
      if (sameFamily && role === group.role) score = Math.max(score, 3);
      if (sameFamily && (!role || ['default', 'context', 'reference'].includes(role))) score = Math.max(score, 1);
      if (group.family === 'label' && sameFamily && role === 'primary' && group.role === 'district') score = 3;
      if (group.family === 'background') score = 3;
      if (!element.family && (name === group.family || name === normalize(group.match_key))) score = Math.max(score, name === group.family ? 1 : 4);
      return { element, score };
    }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
    const explicit = sampleBindings[group.match_key as CartographySampleKey];
    const ambiguous = !explicit && ranked.length > 1 && ranked[0]!.score === ranked[1]!.score;
    const e = explicit ? elements.find((element) => element.name === explicit && element.geometry === geometry) : !ambiguous ? ranked[0]?.element : undefined;
    bindings.push({ viaAgent: Boolean(explicit && e), key: group.match_key, element: e?.name, status: ambiguous ? 'ambiguous' : e ? e.unsupported.length ? 'partial' : 'matched' : 'unmatched', unsupported: e?.unsupported ?? [] });
    const common = () => ({ source: 'sample', filter: ['==', ['get', 'match_key'], group.match_key] as FilterSpecification });
    if (geometry === 'background') {
      layers.push({ id: group.match_key, type: 'background', paint: { 'background-color': e?.color ?? e?.fillColor ?? '#f4f3ef', 'background-opacity': e?.opacity ?? 1 } });
    } else if (geometry === 'polygon') {
      layers.push({ ...common(), id: group.match_key, type: 'fill', paint: { 'fill-color': e?.fillColor ?? e?.color ?? '#deded8', 'fill-opacity': e?.fillOpacity ?? e?.opacity ?? 1 } });
      layers.push({ ...common(), id: `${group.match_key}.outline`, type: 'line', paint: { 'line-color': e?.outlineColor ?? e?.strokeColor ?? '#b9bbb5', 'line-width': e?.outlineWidth ?? e?.strokeWidth ?? 0.5, 'line-opacity': e?.strokeOpacity ?? e?.opacity ?? 1 } });
    } else if (geometry === 'line') {
      const width = e?.strokeWidth ?? 2;
      if (e?.casingColor || e?.casingWidth !== undefined) layers.push({ ...common(), id: `${group.match_key}.casing`, type: 'line', paint: { 'line-color': e.casingColor ?? '#b9bbb5', 'line-width': width + 2 * (e.casingWidth ?? 1), 'line-opacity': e.opacity ?? 1 } });
      layers.push({ ...common(), id: group.match_key, type: 'line', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': e?.strokeColor ?? e?.color ?? '#a8aaa4', 'line-width': width, 'line-opacity': e?.strokeOpacity ?? e?.opacity ?? 1,
        ...(e?.dash && width > 0 ? { 'line-dasharray': e.dash.map((length) => length / width) } : {}),
      } });
    } else if (geometry === 'point') {
      layers.push({ ...common(), id: group.match_key, type: 'circle', paint: { 'circle-color': e?.fillColor ?? e?.color ?? '#858a82', 'circle-radius': e?.size !== undefined ? e.size / 2 : 4,
        'circle-stroke-color': e?.outlineColor ?? '#f4f3ef', 'circle-stroke-width': e?.outlineWidth ?? 1, 'circle-opacity': e?.fillOpacity ?? e?.opacity ?? 1 } });
    } else if (geometry === 'label') {
      layers.push({ ...common(), id: group.match_key, type: 'symbol', layout: { 'text-field': ['get', language.startsWith('zh') ? 'name' : 'name_en'], 'text-font': (e?.fontFamily ?? ['sans-serif']).map((font) => ['serif', 'sans-serif', 'monospace', 'system-ui'].includes(font) ? font : JSON.stringify(font)), 'text-size': e?.fontSize ?? 13 }, paint: { 'text-color': e?.color ?? '#686d65', 'text-halo-color': e?.haloColor ?? '#f4f3ef', 'text-halo-width': e?.haloWidth ?? 1, 'text-opacity': e?.opacity ?? 1 } });
    }
  }
  // Draw surface fills first, then roads/points, and finally labels, regardless of manifest order.
  const order = (layer: LayerSpecification) => layer.type === 'background' ? 0 : layer.id.startsWith('landuse.') ? 1 : layer.id.startsWith('water.') ? 2 : layer.id.startsWith('building.') ? 3 : layer.type === 'line' ? 4 : layer.type === 'circle' ? 5 : 6;
  layers.sort((a, b) => order(a) - order(b));
  const style: StyleSpecification = { version: 8, sources: { sample: { type: 'geojson', data: '/cartography-sample/riverside.geojson' } }, layers };
  return { style, bindings };
}
