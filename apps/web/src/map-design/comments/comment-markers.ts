import type { MapComment } from '@mapseekai/map-design-contracts';
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent } from 'maplibre-gl';
import { useEffect, useId, useMemo, useRef } from 'react';
import { commentIconImage } from './comment-icon';
import { COMMENT_MARKER_PREFIX } from './feature-picking';
type MarkerData = Extract<Parameters<GeoJSONSource['setData']>[0], { type: 'FeatureCollection' }>;

export function useCommentMarkers(map: MapLibreMap | null, comments: readonly MapComment[], enabled: boolean, onSelect: (comment: MapComment) => void, draftAnchor: [number, number] | null = null, onHover?: (comment: MapComment | null) => void): void {
  const key = useId();
  const sourceId = `${COMMENT_MARKER_PREFIX}${key}`;
  const data = useMemo<MarkerData>(() => {
    const features: MarkerData['features'] = enabled ? comments.map((comment, index) => ({
      type: 'Feature', id: comment.id, geometry: { type: 'Point', coordinates: comment.target.anchor },
      properties: { commentId: comment.id, number: index + 1, label: String(index + 1), icon: `${sourceId}:${index + 1}` },
    })) : [];
    if (enabled && draftAnchor) features.push({ type: 'Feature', id: `${sourceId}:draft`, geometry: { type: 'Point', coordinates: draftAnchor },
      properties: { commentId: `${sourceId}:draft`, number: 0, label: '+', icon: `${sourceId}:draft` } });
    return { type: 'FeatureCollection', features };
  }, [comments, draftAnchor, enabled, sourceId]);
  const latest = useRef({ data, comments, enabled, onSelect, onHover });
  latest.current = { data, comments, enabled, onSelect, onHover };
  const sync = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!map) return;
    const labelsId = `${sourceId}:labels`;
    const images = new Set<string>();
    const theme = getComputedStyle(map.getCanvas());
    const color = theme.getPropertyValue('--primary').trim() || '#a9583e';
    const background = theme.getPropertyValue('--card').trim() || '#faf9f5';
    const font = theme.getPropertyValue('--sans').trim() || 'sans-serif';
    let applied: MarkerData | null = null;
    const update = () => {
      if (!map.getStyle() || !map.isStyleLoaded()) return;
      const current = latest.current.data;
      let source = map.getSource(sourceId) as GeoJSONSource | undefined;
      if (!source && !current.features.length) return;
      if (source && applied === current && map.getLayer(labelsId)) return;
      for (const feature of current.features) {
        const id = String(feature.properties!.icon);
        if (map.hasImage(id)) continue;
        const image = commentIconImage(String(feature.properties!.label), color, background, font);
        if (image) { map.addImage(id, image, { pixelRatio: 2 }); images.add(id); }
      }
      if (!source) { map.addSource(sourceId, { type: 'geojson', data: current }); source = map.getSource(sourceId) as GeoJSONSource; }
      else if (applied !== current) source.setData(current);
      if (!map.getLayer(labelsId)) map.addLayer({ id: labelsId, source: sourceId, type: 'symbol', layout: {
        'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport',
      } });
      applied = current;
    };
    const click = (event: MapLayerMouseEvent) => {
      if (!latest.current.enabled || (event.originalEvent?.target as Element | null)?.closest?.('[data-comment-editor]')) return;
      const id = event.features?.[0]?.properties?.commentId;
      const comment = latest.current.comments.find((item) => item.id === id);
      if (comment) latest.current.onSelect(comment);
    };
    const hover = (event: MapLayerMouseEvent) => {
      const id = event.features?.[0]?.properties?.commentId;
      latest.current.onHover?.(latest.current.enabled ? latest.current.comments.find((item) => item.id === id) ?? null : null);
    };
    const leave = () => latest.current.onHover?.(null);
    map.on('mouseenter', labelsId, hover); map.on('mousemove', labelsId, hover); map.on('mouseleave', labelsId, leave);
    map.on('style.load', leave);
    sync.current = update;
    map.on('style.load', update); map.on('idle', update); map.on('click', labelsId, click);
    update();
    return () => {
      sync.current = null;
      map.off('mouseenter', labelsId, hover); map.off('mousemove', labelsId, hover); map.off('mouseleave', labelsId, leave);
      map.off('style.load', leave); leave();
      map.off('style.load', update); map.off('idle', update); map.off('click', labelsId, click);
      if (!map.getStyle()) return;
      if (map.getLayer(labelsId)) map.removeLayer(labelsId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      for (const id of images) if (map.hasImage(id)) map.removeImage(id);
    };
  }, [map, sourceId]);
  useEffect(() => { sync.current?.(); latest.current.onHover?.(null); }, [data]);
}
