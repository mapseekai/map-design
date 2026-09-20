import type { Map as MapLibreMap, FeatureIdentifier } from 'maplibre-gl';
import type { MapStyleEditPatch } from '@mapseekai/map-design-contracts';

type Section = 'paint' | 'layout';
type SavedValue = { section: Section; property: string; value: unknown };

export interface StylePreviewSession {
  apply(patch: MapStyleEditPatch): void;
  restore(): void;
  discard(): void;
}

export function createStylePreviewSession(
  map: MapLibreMap,
  layerId: string,
  properties: readonly { property: string; section?: Section; transition?: boolean }[],
  feature?: FeatureIdentifier,
): StylePreviewSession {
  // MapLibre getLayer returns the stored StyleLayer instance, not a serialized copy.
  const layer = map.getLayer(layerId);
  let live = Boolean(layer);
  const applied = new Map<string, unknown>();
  const featureValues = new Map<string, { key: string; expression: unknown; canonical: unknown }>();
  const transitions = new Map<string, unknown>();
  const transitionProperties = new Set(properties.filter(property => property.transition !== false).map(property => property.property));
  const instantTransition = { duration: 0, delay: 0 };
  const saved: SavedValue[] = (layer ? properties : []).map(({ property, section = 'paint' }) => ({
    property,
    section,
    value: section === 'paint' ? map.getPaintProperty(layerId, property as never) : map.getLayoutProperty(layerId, property as never),
  }));

  const set = ({ section, property, value }: SavedValue) => {
    const restored = value === undefined ? null : value;
    if (section === 'paint') map.setPaintProperty(layerId, property as never, restored as never);
    else map.setLayoutProperty(layerId, property as never, restored as never);
  };
  const key = (value: Pick<SavedValue, 'section' | 'property'>) => `${value.section}:${value.property}`;
  const get = ({ section, property }: SavedValue) => section === 'paint'
    ? map.getPaintProperty(layerId, property as never)
    : map.getLayoutProperty(layerId, property as never);
  const equal = (left: unknown, right: unknown) => Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
  const clearFeatureValues = () => {
    if (feature && map.getSource(feature.source)) for (const value of featureValues.values()) map.removeFeatureState(feature, value.key);
    featureValues.clear();
  };
  const ownsLayer = () => {
    if (!live) return false;
    if (map.getLayer(layerId) === layer) return true;
    live = false; applied.clear(); transitions.clear(); clearFeatureValues();
    return false;
  };
  const restoreTransition = (property: string) => {
    if (!transitions.has(property)) return;
    const name = `${property}-transition`;
    if (equal(map.getPaintProperty(layerId, name as never), instantTransition)) {
      map.setPaintProperty(layerId, name as never, (transitions.get(property) ?? null) as never);
    }
    transitions.delete(property);
  };
  const restoreValue = (value: SavedValue) => {
    const id = key(value);
    if (applied.has(id) && equal(get(value), applied.get(id))) set(value);
    applied.delete(id);
    const state = featureValues.get(value.property);
    if (state && feature) { map.removeFeatureState(feature, state.key); featureValues.delete(value.property); }
  };

  return {
    apply(patch) {
      if (!ownsLayer()) return;
      const next: SavedValue[] = [
        ...Object.entries(patch.paint ?? {}).map(([property, value]) => ({ section: 'paint' as const, property, value })),
        ...Object.entries(patch.layout ?? {}).map(([property, value]) => ({ section: 'layout' as const, property, value })),
      ];
      const keys = new Set(next.map(key));
      for (const value of saved) {
        if (!keys.has(key(value))) { restoreValue(value); restoreTransition(value.property); }
      }
      for (const value of next) {
        const current = get(value);
        const priorState = featureValues.get(value.property);
        if (equal(current, value.value) || (priorState && equal(current, priorState.expression) && equal(value.value, priorState.canonical))) continue;
        if (value.section === 'paint' && transitionProperties.has(value.property) && !transitions.has(value.property)) {
          const name = `${value.property}-transition`;
          transitions.set(value.property, map.getPaintProperty(layerId, name as never));
          map.setPaintProperty(layerId, name as never, instantTransition as never);
        }
        const expression = value.value;
        if (feature && typeof map.setFeatureState === 'function' && value.section === 'paint'
          && Array.isArray(expression) && expression.length === 4 && expression[0] === 'case'
          && equal(expression[1], ['==', ['id'], feature.id]) && !Array.isArray(expression[2])) {
          const previous = featureValues.get(value.property);
          const stateKey = previous?.key ?? `mapdesign-preview-${globalThis.crypto.randomUUID()}`;
          const installed = previous?.expression ?? ['case', expression[1], ['coalesce', ['feature-state', stateKey], expression[2]], expression[3]];
          map.setFeatureState(feature, { [stateKey]: expression[2] });
          if (!equal(get(value), installed)) set({ ...value, value: installed });
          featureValues.set(value.property, { key: stateKey, expression: installed, canonical: expression });
          applied.set(key(value), installed);
        } else {
          set(value); applied.set(key(value), value.value);
          const state = featureValues.get(value.property);
          if (state && feature) { map.removeFeatureState(feature, state.key); featureValues.delete(value.property); }
        }
      }
    },
    restore() {
      if (!ownsLayer()) return;
      for (const value of saved) restoreValue(value);
      for (const property of transitions.keys()) restoreTransition(property);
      live = false;
    },
    discard() {
      if (!ownsLayer()) return;
      for (const [property, state] of featureValues) {
        if (equal(map.getPaintProperty(layerId, property as never), state.expression)) set({ section: 'paint', property, value: state.canonical });
      }
      clearFeatureValues();
      for (const property of transitions.keys()) restoreTransition(property);
      applied.clear(); live = false;
    },
  };
}
