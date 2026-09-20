import type { FilterSpecification, LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useId } from 'react';
import { COMMENT_MARKER_PREFIX, featureScopeAvailable, generatedSourceIds, type PickedFeature } from './feature-picking';

export function featureHighlightLayer(feature: PickedFeature, key: string, color = '#a9583e', original?: LayerSpecification): LayerSpecification | null {
  if (!featureScopeAvailable(feature, new Set())) return null;
  const common = {
    id: `__map-design-highlight:${key}`, source: feature.source,
    ...(feature.sourceLayer ? { 'source-layer': feature.sourceLayer } : {}),
    filter: ['==', ['id'], feature.id!] as FilterSpecification,
  };
  if (original?.type === 'symbol' && original.layout?.['text-field']) return {
    ...original, ...common, type: 'symbol', layout: { ...original.layout,
      'text-size': enlargeTextSize(original.layout['text-size'] ?? 16) as never,
      'text-allow-overlap': true, 'text-ignore-placement': true,
    }, paint: { ...original.paint, 'text-color': color, 'text-halo-width': 2, 'icon-opacity': 0 },
  } as LayerSpecification;
  // Let MapLibre render all tiles for this identity. A polygon outline would
  // expose artificial tile clipping edges rather than the feature's boundary.
  if (['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) return {
    ...common, type: 'fill', paint: { 'fill-color': color, 'fill-opacity': 0.3, 'fill-antialias': false },
  };
  if (['LineString', 'MultiLineString'].includes(feature.geometry.type)) return {
    ...common, type: 'line', paint: { 'line-color': color, 'line-width': 3 },
  };
  if (['Point', 'MultiPoint'].includes(feature.geometry.type)) return {
    ...common, type: 'circle', paint: { 'circle-color': color, 'circle-radius': 7, 'circle-opacity': 0.6 },
  };
  return null;
}

export function useFeatureHighlight(map: MapLibreMap | null, feature: PickedFeature | null): void {
  const key = useId();
  useEffect(() => {
    if (!map || !feature) return;
    const color = getComputedStyle(map.getCanvas()).getPropertyValue('--primary').trim() || undefined;
    const layer = featureHighlightLayer(feature, key, color, map.getStyle()?.layers?.find((item) => item.id === feature.layer.id));
    if (!layer) return;
    const show = () => {
      if (!map.getStyle() || !map.isStyleLoaded() || !map.getSource(feature.source) || map.getLayer(layer.id)
        || !featureScopeAvailable(feature, generatedSourceIds(map.getStyle()), map.getStyle())) return;
      const markerLayer = map.getStyle()?.layers?.find((candidate) => candidate.id.startsWith(COMMENT_MARKER_PREFIX));
      map.addLayer(layer, markerLayer?.id);
    };
    map.on('style.load', show); map.on('idle', show);
    show();
    return () => {
      map.off('style.load', show); map.off('idle', show);
      if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    };
  }, [feature, key, map]);
}

// Keep camera expressions at the top level, as required by MapLibre text-size.
export function enlargeTextSize(value: unknown): unknown {
  if (typeof value === 'number') return value * 1.3;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const legacy = value as Record<string, unknown>;
    if (Array.isArray(legacy.stops)) return {
      ...legacy,
      ...(typeof legacy.default === 'number' ? { default: legacy.default * 1.3 } : {}),
      stops: legacy.stops.map((stop) => Array.isArray(stop) ? [stop[0], enlargeTextSize(stop[1])] : stop),
    };
    if (legacy.type === 'identity' && typeof legacy.property === 'string') {
      return ['*', ['number', ['get', legacy.property], typeof legacy.default === 'number' ? legacy.default : 16], 1.3];
    }
  }
  if (Array.isArray(value) && ['interpolate', 'interpolate-hcl', 'interpolate-lab', 'step', 'let'].includes(value[0])) {
    const result = [...value];
    if (value[0] === 'let') result[result.length - 1] = enlargeTextSize(result.at(-1));
    else {
      const firstOutput = value[0] === 'step' ? 2 : 4;
      for (let index = firstOutput; index < result.length; index += 2) result[index] = enlargeTextSize(result[index]);
    }
    return result;
  }
  return ['*', value, 1.3];
}
