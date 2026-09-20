import { MAP_SCREENSHOT_MAX_BYTES, MapScreenshotInputSchema, type MapScreenshotInput } from '@mapseekai/contracts';
import type { Map as MapLibreMap } from 'maplibre-gl';

/** Read the WebGL canvas inside its render callback, before its buffer can be cleared. */
export function captureMapScreenshot(map: MapLibreMap, snapshot: { draftRevision: number; styleHash: string }, signal?: AbortSignal): Promise<MapScreenshotInput> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown, value?: MapScreenshotInput) => {
      clearTimeout(timer); map.off('render', capture); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(signal?.reason ?? new DOMException('Canceled', 'AbortError'));
    const capture = () => {
      try {
        if (!map.isStyleLoaded() || !map.areTilesLoaded()) return;
        const source = map.getCanvas();
        if (!source.width || !source.height) throw new Error('Map canvas is empty.');
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 2048 / Math.max(source.width, source.height));
        canvas.width = Math.max(1, Math.round(source.width * scale));
        canvas.height = Math.max(1, Math.round(source.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas capture is unavailable.');
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        let data = canvas.toDataURL('image/png');
        while (data.length > Math.ceil(MAP_SCREENSHOT_MAX_BYTES / 3) * 4 + 22 && (canvas.width > 1 || canvas.height > 1)) {
          canvas.width = Math.max(1, Math.round(canvas.width / 2)); canvas.height = Math.max(1, Math.round(canvas.height / 2));
          context.drawImage(source, 0, 0, canvas.width, canvas.height);
          data = canvas.toDataURL('image/png');
        }
        if (!data.startsWith('data:image/png;base64,')) throw new Error('PNG capture failed.');
        const center = map.getCenter();
        const normalizeLongitude = (value: number) => ((value + 180) % 360 + 360) % 360 - 180;
        finish(undefined, MapScreenshotInputSchema.parse({ ...snapshot, pngBase64: data.slice(22), width: canvas.width, height: canvas.height,
          viewport: { center: [normalizeLongitude(center.lng), center.lat], zoom: map.getZoom(), bearing: normalizeLongitude(map.getBearing()), pitch: map.getPitch() } }));
      } catch (error) { finish(error); }
    };
    const timer = setTimeout(() => finish(new Error('Map capture timed out.')), 8000);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    map.on('render', capture); map.triggerRepaint();
  });
}
