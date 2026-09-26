import {
  MapPreviewFulfillRequestSchema,
  MapPreviewViewportSchema,
  type MapPreviewFulfillRequest,
  type MapPreviewViewport,
  type MapRenderPreviewOutput,
} from '@mapseekai/map-design-contracts';

interface PreviewMap {
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getBearing(): number;
  getPitch(): number;
  getPixelRatio?(): number;
  setPixelRatio?(ratio: number): void;
  getContainer?(): HTMLElement;
  jumpTo(options: { center: [number, number]; zoom: number; bearing: number; pitch: number }): void;
  resize(): void;
  isStyleLoaded(): boolean;
  areTilesLoaded(): boolean;
  isMoving?(): boolean;
  once(name: 'idle' | 'render', callback: () => void): void;
  off(name: 'idle' | 'render', callback: () => void): void;
  triggerRepaint?(): void;
  getCanvas(): { toDataURL(type?: string): string; width?: number; height?: number; ownerDocument?: Document };
}

export interface RenderMapDesignPreviewOptions {
  map: PreviewMap;
  request: {
    previewId: string;
    draftRevision: number;
    styleHash: string;
    expiresAt: string;
    viewport: MapPreviewViewport;
  };
  snapshot(): { draftRevision: number; styleHash: string };
  loadCanonical(reason: string, signal: AbortSignal): Promise<void>;
  validationDigest: string;
  fulfill(request: MapPreviewFulfillRequest, signal: AbortSignal): Promise<MapRenderPreviewOutput | unknown>;
  signal?: AbortSignal;
}

const READINESS_OBSERVATION_INTERVAL_MS = 50;

export async function renderMapDesignPreview(options: RenderMapDesignPreviewOptions): Promise<MapRenderPreviewOutput | unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const signal = controller.signal;
  const deadline = Date.parse(options.request.expiresAt);
  if (!Number.isFinite(deadline)) throw new TypeError('Map preview expiry is invalid.');
  const viewport = MapPreviewViewportSchema.parse(options.request.viewport);
  const map = options.map;
  const previous = {
    center: [map.getCenter().lng, map.getCenter().lat] as [number, number],
    zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(),
    pixelRatio: map.getPixelRatio?.() ?? 1,
    width: map.getContainer?.().style.width,
    height: map.getContainer?.().style.height,
    minWidth: map.getContainer?.().style.minWidth,
    minHeight: map.getContainer?.().style.minHeight,
    maxWidth: map.getContainer?.().style.maxWidth,
    maxHeight: map.getContainer?.().style.maxHeight,
  };
  try {
    let fulfillment: MapPreviewFulfillRequest;
    let failureStage: 'sync' | 'viewport' | 'render' | 'capture' = 'sync';
    try {
      assertActive(signal);
      assertBeforeDeadline(deadline);
      const snapshot = options.snapshot();
      if (snapshot.draftRevision !== options.request.draftRevision || snapshot.styleHash !== options.request.styleHash) {
        await options.loadCanonical('preview-request', signal);
      }
      assertActive(signal);
      assertBeforeDeadline(deadline);
      failureStage = 'viewport';
      applyViewport(map, viewport);
      failureStage = 'render';
      await waitForIdle(map, signal, deadline);
      failureStage = 'capture';
      const pngBase64 = await capturePng(map, viewport, signal, deadline);
      fulfillment = MapPreviewFulfillRequestSchema.parse({
        status: 'succeeded', previewId: options.request.previewId,
        draftRevision: options.request.draftRevision, styleHash: options.request.styleHash,
        report: { previewId: options.request.previewId, validationDigest: options.validationDigest },
        pngBase64,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (isDeadlineError(error) || Date.now() >= deadline) throw error;
      fulfillment = MapPreviewFulfillRequestSchema.parse({
        status: 'failed', previewId: options.request.previewId,
        draftRevision: options.request.draftRevision, styleHash: options.request.styleHash,
        report: { previewId: options.request.previewId, validationDigest: options.validationDigest, failureStage },
        pngBase64: null,
      });
    }
    assertBeforeDeadline(deadline);
    return await options.fulfill(fulfillment, signal);
  } finally {
    const container = map.getContainer?.();
    if (container) {
      container.style.width = previous.width ?? '';
      container.style.height = previous.height ?? '';
      container.style.minWidth = previous.minWidth ?? '';
      container.style.minHeight = previous.minHeight ?? '';
      container.style.maxWidth = previous.maxWidth ?? '';
      container.style.maxHeight = previous.maxHeight ?? '';
    }
    map.setPixelRatio?.(previous.pixelRatio);
    map.jumpTo({ center: previous.center, zoom: previous.zoom, bearing: previous.bearing, pitch: previous.pitch });
    map.resize();
    options.signal?.removeEventListener('abort', abort);
  }
}

function applyViewport(map: PreviewMap, viewport: MapPreviewViewport): void {
  const container = map.getContainer?.();
  if (container) {
    // Preview dimensions are independent of the interactive pane's CSS bounds.
    container.style.minWidth = '0px';
    container.style.minHeight = '0px';
    container.style.maxWidth = 'none';
    container.style.maxHeight = 'none';
    container.style.width = `${viewport.width}px`;
    container.style.height = `${viewport.height}px`;
  }
  map.setPixelRatio?.(viewport.pixelRatio);
  map.jumpTo({ center: viewport.center, zoom: viewport.zoom, bearing: viewport.bearing, pitch: viewport.pitch });
  map.resize();
}

function waitForIdle(map: PreviewMap, signal: AbortSignal, deadline: number): Promise<void> {
  assertActive(signal);
  assertBeforeDeadline(deadline);
  if (map.isStyleLoaded() && map.areTilesLoaded() && map.isMoving?.() === false) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let observationTimer: ReturnType<typeof setTimeout> | null = null;
    let idleArmed = false;
    const cleanup = () => {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (observationTimer !== null) clearTimeout(observationTimer);
      signal.removeEventListener('abort', onAbort);
      map.off('idle', done);
    };
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onAbort = () => finish(() => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')));
    const loaded = () => map.isStyleLoaded() && map.areTilesLoaded();
    const observe = () => {
      if (settled) return;
      if (Date.now() >= deadline) {
        finish(() => reject(deadlineError()));
        return;
      }
      if (loaded()) {
        finish(resolve);
        return;
      }
      scheduleObservation();
    };
    const scheduleObservation = () => {
      if (settled || observationTimer !== null) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        finish(() => reject(deadlineError()));
        return;
      }
      observationTimer = setTimeout(() => {
        observationTimer = null;
        observe();
      }, Math.min(READINESS_OBSERVATION_INTERVAL_MS, remaining));
    };
    const armIdle = () => {
      if (settled || idleArmed) return;
      idleArmed = true;
      map.once('idle', done);
    };
    const done = () => {
      idleArmed = false;
      if (settled) return;
      if (Date.now() >= deadline) {
        finish(() => reject(deadlineError()));
        return;
      }
      if (!loaded()) {
        armIdle();
        scheduleObservation();
        return;
      }
      finish(resolve);
    };
    deadlineTimer = setTimeout(() => finish(() => reject(deadlineError())), Math.max(0, deadline - Date.now()));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    armIdle();
    // Readiness can change without another idle event after a style update.
    scheduleObservation();
  });
}

function capturePng(map: PreviewMap, viewport: MapPreviewViewport, signal: AbortSignal, deadline: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown, value?: string) => {
      clearTimeout(timer);
      map.off('render', capture);
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const capture = () => {
      try {
        assertActive(signal);
        assertBeforeDeadline(deadline);
        if (!map.isStyleLoaded() || !map.areTilesLoaded()) {
          map.once('render', capture);
          return;
        }
        const source = map.getCanvas();
        let canvas = source;
        // The API's PNG dimensions are logical viewport pixels, independent of rendering DPR.
        if (source.ownerDocument && (source.width !== viewport.width || source.height !== viewport.height)) {
          const scaled = source.ownerDocument.createElement('canvas');
          scaled.width = viewport.width; scaled.height = viewport.height;
          const context = scaled.getContext('2d');
          if (!context) throw new Error('Preview image conversion is unavailable.');
          context.drawImage(source as HTMLCanvasElement, 0, 0, scaled.width, scaled.height);
          canvas = scaled;
        }
        const match = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/u.exec(canvas.toDataURL('image/png'));
        if (!match) throw new TypeError('Map preview capture did not return PNG data.');
        finish(undefined, match[1]!);
      } catch (error) { finish(error); }
    };
    const timer = setTimeout(() => finish(deadlineError()), Math.max(0, deadline - Date.now()));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    map.once('render', capture);
    map.triggerRepaint?.();
  });
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function assertBeforeDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw deadlineError();
}

function deadlineError(): DOMException {
  return new DOMException('Map preview deadline expired.', 'TimeoutError');
}

function isDeadlineError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}
