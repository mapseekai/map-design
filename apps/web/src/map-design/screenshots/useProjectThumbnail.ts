import { useEffect } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { MAP_THUMBNAIL_MAX_BASE64, MAP_THUMBNAIL_MAX_DIMENSION, mapThumbnailUrl, type MapThumbnailInput } from '@mapseekai/contracts';

/** Cache a rendered frame while the WebGL buffer is valid, then flush it on departure. */
export function useProjectThumbnail(projectId: string, map: MapLibreMap | null, suspended: boolean): void {
  useEffect(() => {
    if (!map || suspended) return;
    let dirty = true;
    let pending: MapThumbnailInput | null = null;
    let lastImage = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (!pending) return;
      const input = pending;
      pending = null;
      const body = JSON.stringify(input);
      void fetch(mapThumbnailUrl(projectId), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        // Large PNGs are saved while browsing; only small requests fit keepalive.
        body, keepalive: body.length <= 60_000,
      }).then(response => {
        if (!response.ok && !pending) pending = input;
      }).catch(() => { if (!pending) pending = input; });
    };
    const markDirty = () => { dirty = true; map.triggerRepaint(); };
    const capture = () => {
      try {
        if (!dirty || map.isMoving() || !map.isStyleLoaded() || !map.areTilesLoaded()) return;
        const source = map.getCanvas();
        if (!source.width || !source.height) return;
        const canvas = document.createElement('canvas');
        let scale = Math.min(1, MAP_THUMBNAIL_MAX_DIMENSION / Math.max(source.width, source.height));
        let pngBase64 = '';
        do {
          canvas.width = Math.max(1, Math.round(source.width * scale));
          canvas.height = Math.max(1, Math.round(source.height * scale));
          const context = canvas.getContext('2d');
          if (!context) return;
          context.drawImage(source, 0, 0, canvas.width, canvas.height);
          const data = canvas.toDataURL('image/png');
          if (!data.startsWith('data:image/png;base64,')) return;
          pngBase64 = data.slice(22);
          scale *= 0.75;
        } while (pngBase64.length > MAP_THUMBNAIL_MAX_BASE64 && (canvas.width > 1 || canvas.height > 1));
        if (pngBase64.length > MAP_THUMBNAIL_MAX_BASE64) return;
        dirty = false;
        if (pngBase64 === lastImage) return;
        lastImage = pngBase64;
        pending = { pngBase64, width: canvas.width, height: canvas.height, capturedAt: Date.now() };
        clearTimeout(timer);
        timer = setTimeout(flush, 500);
      } catch {
        // A loading or cross-origin canvas must not replace the last good thumbnail.
      }
    };
    const hide = () => { if (document.visibilityState === 'hidden') flush(); };
    map.on('moveend', markDirty);
    map.on('styledata', markDirty);
    map.on('resize', markDirty);
    map.on('render', capture);
    map.triggerRepaint();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hide);
    return () => {
      clearTimeout(timer);
      map.off('moveend', markDirty);
      map.off('styledata', markDirty);
      map.off('resize', markDirty);
      map.off('render', capture);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hide);
      flush();
    };
  }, [projectId, map, suspended]);
}
