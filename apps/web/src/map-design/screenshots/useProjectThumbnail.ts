import { useEffect } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { MAP_THUMBNAIL_MAX_BASE64, MAP_THUMBNAIL_MAX_DIMENSION, mapThumbnailUrl, type MapThumbnailInput } from '@mapseekai/contracts';

/** Cache a rendered frame while the WebGL buffer is valid, then flush it on departure. */
export function useProjectThumbnail(projectId: string, map: MapLibreMap | null, suspended: boolean): void {
  useEffect(() => {
    if (!map || suspended) return;
    let dirty = true;
    let active = true;
    let encoding = false;
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
        if (!dirty || encoding || map.isMoving() || !map.isStyleLoaded() || !map.areTilesLoaded()) return;
        const source = map.getCanvas();
        if (!source.width || !source.height) return;
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, MAP_THUMBNAIL_MAX_DIMENSION / Math.max(source.width, source.height));
        canvas.width = Math.max(1, Math.round(source.width * scale));
        canvas.height = Math.max(1, Math.round(source.height * scale));
        const context = canvas.getContext('2d');
        if (!context) return;
        // Copy pixels while WebGL is valid; encode the detached copy asynchronously.
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const capturedAt = Date.now();
        dirty = false;
        encoding = true;
        void encodeThumbnail(canvas).then(input => {
          if (input.pngBase64 === lastImage) return;
          lastImage = input.pngBase64;
          pending = { ...input, capturedAt };
          clearTimeout(timer);
          if (!active || document.visibilityState === 'hidden') flush();
          else timer = setTimeout(flush, 500);
        }).catch(() => {
          // Wait for the next map change after a failed canvas conversion.
        }).finally(() => {
          encoding = false;
          if (active && dirty) map.triggerRepaint();
        });
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
      active = false;
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

async function encodeThumbnail(canvas: HTMLCanvasElement): Promise<Omit<MapThumbnailInput, 'capturedAt'>> {
  try {
    for (;;) {
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => {
        if (value) resolve(value); else reject(new Error('Thumbnail encoding failed.'));
      }, 'image/png'));
      if (Math.ceil(blob.size / 3) * 4 <= MAP_THUMBNAIL_MAX_BASE64) {
        const pngBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).slice(22));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        return { pngBase64, width: canvas.width, height: canvas.height };
      }
      if (canvas.width === 1 && canvas.height === 1) throw new Error('Thumbnail exceeds size limit.');
      const smaller = document.createElement('canvas');
      smaller.width = Math.max(1, Math.floor(canvas.width * 0.75));
      smaller.height = Math.max(1, Math.floor(canvas.height * 0.75));
      const context = smaller.getContext('2d');
      if (!context) throw new Error('Thumbnail conversion is unavailable.');
      context.drawImage(canvas, 0, 0, smaller.width, smaller.height);
      canvas.width = canvas.height = 0;
      canvas = smaller;
    }
  } finally {
    canvas.width = canvas.height = 0;
  }
}
