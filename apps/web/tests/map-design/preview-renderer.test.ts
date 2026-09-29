import { describe, expect, it, vi } from 'vitest';

import { renderMapDesignPreview } from '../../src/map-design/preview/preview-renderer';

const HASH = 'b'.repeat(64);
const DIGEST = 'd'.repeat(64);

describe('renderMapDesignPreview', () => {
  it.each([
    { width: 1280, height: 720, captureFails: false },
    { width: 320, height: 240, captureFails: false },
    { width: 1280, height: 720, captureFails: true },
  ])('renders the requested size outside layout constraints and restores them: %j', async ({ width, height, captureFails }) => {
    const original = { width: '100%', height: '100%', maxWidth: '100%', maxHeight: '600px', minWidth: '400px', minHeight: '320px' };
    const container = { style: { ...original } };
    let rendered = { width: 752, height: 600 };
    const map = {
      getCenter: () => ({ lng: 0, lat: 0 }), getZoom: () => 1, getBearing: () => 0, getPitch: () => 0,
      getContainer: () => container as unknown as HTMLElement,
      getPixelRatio: () => 1, setPixelRatio: vi.fn(), jumpTo: vi.fn(),
      resize: () => {
        // Model the real pane's max-w-full and min-h-80 constraints.
        rendered = {
          width: Math.max(Number.parseFloat(container.style.minWidth), Math.min(Number.parseFloat(container.style.width), container.style.maxWidth === 'none' ? Infinity : 752)),
          height: Math.max(Number.parseFloat(container.style.minHeight), Math.min(Number.parseFloat(container.style.height), container.style.maxHeight === 'none' ? Infinity : 600)),
        };
      },
      isStyleLoaded: () => true, areTilesLoaded: () => true, isMoving: () => false,
      once: vi.fn(), off: vi.fn(), getCanvas: () => ({ toDataURL: () => {
        if (captureFails) throw new Error('Capture failed.');
        return 'data:image/png;base64,iVBORw0KGgo=';
      } }),
    };
    const fulfill = vi.fn(async (body) => {
      expect(rendered).toEqual({ width, height });
      return body;
    });
    await expect(renderMapDesignPreview({ map: withRenderFrame(map),
      request: { previewId: 'preview-size', draftRevision: 1, styleHash: HASH, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        viewport: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0, width, height, pixelRatio: 1 } },
      snapshot: () => ({ draftRevision: 1, styleHash: HASH }), loadCanonical: vi.fn(), validationDigest: DIGEST, fulfill,
    })).resolves.toMatchObject({ status: captureFails ? 'failed' : 'succeeded' });
    expect(container.style).toEqual(original);
    expect(fulfill).toHaveBeenCalledOnce();
  });

  it('reloads stale canonical state, renders the bounded viewport at its device ratio, and restores the map', async () => {
    const order: string[] = [];
    let idle: (() => void) | undefined;
    const map = {
      getCenter: () => ({ lng: 12, lat: 34 }), getZoom: () => 7, getBearing: () => 8, getPitch: () => 9,
      getPixelRatio: () => 1, setPixelRatio: vi.fn((value: number) => order.push(`ratio:${value}`)),
      jumpTo: vi.fn((value: unknown) => order.push(`jump:${JSON.stringify(value)}`)),
      resize: vi.fn(() => order.push('resize')), isStyleLoaded: () => true, areTilesLoaded: () => true,
      isMoving: () => true,
      once: vi.fn((name: string, callback: () => void) => { expect(name).toBe('idle'); idle = callback; }),
      off: vi.fn(),
      getCanvas: () => ({ toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' }),
    };
    const loadCanonical = vi.fn(async () => { order.push('canonical'); });
    const fulfill = vi.fn(async (body) => { order.push('fulfill'); return body; });
    const pending = renderMapDesignPreview({
      map: withRenderFrame(map),
      request: {
        previewId: 'preview-1', draftRevision: 5, styleHash: HASH, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        viewport: { center: [1, 2], zoom: 3, bearing: 4, pitch: 5, width: 640, height: 480, pixelRatio: 2 },
      },
      snapshot: vi.fn().mockReturnValueOnce({ draftRevision: 4, styleHash: 'a'.repeat(64) }).mockReturnValue({ draftRevision: 5, styleHash: HASH }),
      loadCanonical,
      validationDigest: DIGEST,
      fulfill,
    });
    await vi.waitFor(() => expect(idle).toBeTypeOf('function'));
    idle?.();
    await pending;

    expect(loadCanonical).toHaveBeenCalledWith('preview-request', expect.any(AbortSignal));
    expect(fulfill).toHaveBeenCalledWith({
      status: 'succeeded', previewId: 'preview-1', draftRevision: 5, styleHash: HASH,
      report: { previewId: 'preview-1', validationDigest: DIGEST }, pngBase64: 'iVBORw0KGgo=',
    }, expect.any(AbortSignal));
    expect(order.at(-1)).toBe('resize');
    expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [12, 34], zoom: 7, bearing: 8, pitch: 9 });
    expect(map.setPixelRatio).toHaveBeenLastCalledWith(1);
  });

  it('submits a strict failed fulfillment and restores state when browser capture fails', async () => {
    const fulfill = vi.fn(async (body) => body);
    const map = {
      getCenter: () => ({ lng: 0, lat: 0 }), getZoom: () => 1, getBearing: () => 0, getPitch: () => 0,
      getPixelRatio: () => 1, setPixelRatio: vi.fn(), jumpTo: vi.fn(), resize: vi.fn(),
      isStyleLoaded: () => true, areTilesLoaded: () => true,
      once: (_name: string, callback: () => void) => callback(), off: vi.fn(),
      getCanvas: () => ({ toDataURL: () => { throw new Error('context lost'); } }),
    };
    await renderMapDesignPreview({
      map: withRenderFrame(map), request: { previewId: 'preview-2', draftRevision: 1, styleHash: HASH, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        viewport: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0, width: 320, height: 240, pixelRatio: 1 } },
      snapshot: () => ({ draftRevision: 1, styleHash: HASH }), loadCanonical: vi.fn(),
      validationDigest: DIGEST, fulfill,
    });
    expect(fulfill).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', pngBase64: null }), expect.any(AbortSignal));
    expect(map.jumpTo).toHaveBeenCalledTimes(2);
  });

  it('re-arms after an incomplete idle and captures once after a later loaded idle', async () => {
    const idleListeners: Array<() => void> = [];
    let tilesLoaded = false;
    const capture = vi.fn(() => 'data:image/png;base64,iVBORw0KGgo=');
    const map = {
      getCenter: () => ({ lng: 0, lat: 0 }), getZoom: () => 1, getBearing: () => 0, getPitch: () => 0,
      getPixelRatio: () => 1, setPixelRatio: vi.fn(), jumpTo: vi.fn(), resize: vi.fn(),
      isStyleLoaded: () => true, areTilesLoaded: () => tilesLoaded, isMoving: () => true,
      once: vi.fn((_name: string, callback: () => void) => { idleListeners.push(callback); }),
      off: vi.fn(), getCanvas: () => ({ toDataURL: capture }),
    };
    const fulfill = vi.fn(async (body) => body);
    const pending = renderMapDesignPreview({
      map: withRenderFrame(map), request: { previewId: 'preview-rearm', draftRevision: 1, styleHash: HASH,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        viewport: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0, width: 320, height: 240, pixelRatio: 1 } },
      snapshot: () => ({ draftRevision: 1, styleHash: HASH }), loadCanonical: vi.fn(),
      validationDigest: DIGEST, fulfill,
    });
    await vi.waitFor(() => expect(idleListeners).toHaveLength(1));

    idleListeners.shift()?.();
    expect(capture).not.toHaveBeenCalled();
    expect(fulfill).not.toHaveBeenCalled();
    expect(idleListeners).toHaveLength(1);

    tilesLoaded = true;
    idleListeners.shift()?.();
    await pending;

    expect(capture).toHaveBeenCalledTimes(1);
    expect(fulfill).toHaveBeenCalledTimes(1);
    expect(fulfill).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }), expect.any(AbortSignal));
  });

  it.each([false, true])('observes readiness without another idle (initial idle: %s)', async (initialIdle) => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-09-02T00:00:00.000Z');
    let idle: (() => void) | undefined;
    let tilesLoaded = false;
    const styleReady = vi.fn(() => true);
    const tilesReady = vi.fn(() => tilesLoaded);
    const capture = vi.fn(() => 'data:image/png;base64,iVBORw0KGgo=');
    const map = {
      getCenter: () => ({ lng: 0, lat: 0 }), getZoom: () => 1, getBearing: () => 0, getPitch: () => 0,
      getPixelRatio: () => 1, setPixelRatio: vi.fn(), jumpTo: vi.fn(), resize: vi.fn(),
      isStyleLoaded: styleReady, areTilesLoaded: tilesReady, isMoving: () => true,
      once: vi.fn((_name: string, callback: () => void) => { idle = callback; }), off: vi.fn(),
      getCanvas: () => ({ toDataURL: capture }),
    };
    const fulfill = vi.fn(async (body) => body);
    const pending = renderMapDesignPreview({
      map: withRenderFrame(map), request: { previewId: 'preview-readiness-observation', draftRevision: 1, styleHash: HASH,
        expiresAt: '2026-09-02T00:00:00.500Z',
        viewport: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0, width: 320, height: 240, pixelRatio: 1 } },
      snapshot: () => ({ draftRevision: 1, styleHash: HASH }), loadCanonical: vi.fn(),
      validationDigest: DIGEST, fulfill,
    });
    expect(idle).toBeTypeOf('function');
    if (initialIdle) idle?.();
    const checksAfterIdle = tilesReady.mock.calls.length;
    tilesLoaded = true;

    await vi.advanceTimersByTimeAsync(49);
    expect(tilesReady).toHaveBeenCalledTimes(checksAfterIdle);
    expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(tilesReady.mock.calls.length).toBe(checksAfterIdle + 2);
    expect(styleReady.mock.calls.length).toBeLessThanOrEqual(4);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(fulfill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('keeps re-arming incomplete idles until the original deadline expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-09-02T00:00:00.000Z');
    const idleListeners: Array<() => void> = [];
    const map = {
      getCenter: () => ({ lng: 0, lat: 0 }), getZoom: () => 1, getBearing: () => 0, getPitch: () => 0,
      getPixelRatio: () => 1, setPixelRatio: vi.fn(), jumpTo: vi.fn(), resize: vi.fn(),
      isStyleLoaded: () => true, areTilesLoaded: () => false, isMoving: () => true,
      once: vi.fn((_name: string, callback: () => void) => { idleListeners.push(callback); }),
      off: vi.fn(), getCanvas: () => ({ toDataURL: vi.fn() }),
    };
    const fulfill = vi.fn();
    const pending = renderMapDesignPreview({
      map: withRenderFrame(map), request: { previewId: 'preview-incomplete-timeout', draftRevision: 1, styleHash: HASH,
        expiresAt: '2026-09-02T00:00:00.050Z',
        viewport: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0, width: 320, height: 240, pixelRatio: 1 } },
      snapshot: () => ({ draftRevision: 1, styleHash: HASH }), loadCanonical: vi.fn(),
      validationDigest: DIGEST, fulfill,
    });

    for (let count = 0; count < 3; count += 1) {
      expect(idleListeners).toHaveLength(1);
      idleListeners.shift()?.();
    }
    expect(map.once).toHaveBeenCalledTimes(4);
    const rejected = expect(pending).rejects.toThrow(/expired|deadline/i);
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    expect(fulfill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('removes idle and deadline work when aborted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-09-02T00:00:00.000Z');
    let idle: (() => void) | undefined;
    const controller = new AbortController();
    const map = {
      getCenter: () => ({ lng: 0, lat: 0 }), getZoom: () => 1, getBearing: () => 0, getPitch: () => 0,
      getPixelRatio: () => 1, setPixelRatio: vi.fn(), jumpTo: vi.fn(), resize: vi.fn(),
      isStyleLoaded: () => true, areTilesLoaded: () => false, isMoving: () => true,
      once: vi.fn((_name: string, callback: () => void) => { idle = callback; }), off: vi.fn(),
      getCanvas: () => ({ toDataURL: vi.fn() }),
    };
    const fulfill = vi.fn();
    const pending = renderMapDesignPreview({
      map: withRenderFrame(map), request: { previewId: 'preview-abort', draftRevision: 1, styleHash: HASH,
        expiresAt: '2026-09-02T00:00:30.000Z',
        viewport: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0, width: 320, height: 240, pixelRatio: 1 } },
      snapshot: () => ({ draftRevision: 1, styleHash: HASH }), loadCanonical: vi.fn(),
      validationDigest: DIGEST, fulfill, signal: controller.signal,
    });
    await vi.waitFor(() => expect(idle).toBeTypeOf('function'));
    idle?.();
    expect(vi.getTimerCount()).toBe(2);

    controller.abort(new DOMException('Preview stopped.', 'AbortError'));
    await expect(pending).rejects.toThrow('Preview stopped.');

    expect(map.off).toHaveBeenCalledWith('idle', idle);
    expect(fulfill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('does not capture or fulfill twice when idle fires again after success', async () => {
    let idle: (() => void) | undefined;
    let tilesLoaded = false;
    const capture = vi.fn(() => 'data:image/png;base64,iVBORw0KGgo=');
    const map = {
      getCenter: () => ({ lng: 0, lat: 0 }), getZoom: () => 1, getBearing: () => 0, getPitch: () => 0,
      getPixelRatio: () => 1, setPixelRatio: vi.fn(), jumpTo: vi.fn(), resize: vi.fn(),
      isStyleLoaded: () => true, areTilesLoaded: () => tilesLoaded, isMoving: () => true,
      once: vi.fn((_name: string, callback: () => void) => { idle = callback; }), off: vi.fn(),
      getCanvas: () => ({ toDataURL: capture }),
    };
    const fulfill = vi.fn(async (body) => body);
    const pending = renderMapDesignPreview({
      map: withRenderFrame(map), request: { previewId: 'preview-once', draftRevision: 1, styleHash: HASH,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        viewport: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0, width: 320, height: 240, pixelRatio: 1 } },
      snapshot: () => ({ draftRevision: 1, styleHash: HASH }), loadCanonical: vi.fn(),
      validationDigest: DIGEST, fulfill,
    });
    await vi.waitFor(() => expect(idle).toBeTypeOf('function'));
    const lateIdle = idle;
    tilesLoaded = true;

    lateIdle?.();
    lateIdle?.();
    await pending;

    expect(capture).toHaveBeenCalledTimes(1);
    expect(fulfill).toHaveBeenCalledTimes(1);
  });

  it('bounds idle waiting by expiresAt, removes the listener, and restores the viewport', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-16T00:00:00.000Z');
    let idle: (() => void) | undefined;
    const container = { style: { width: '900px', height: '700px' } } as HTMLElement;
    const map = {
      getCenter: () => ({ lng: 12, lat: 34 }), getZoom: () => 7, getBearing: () => 8, getPitch: () => 9,
      getPixelRatio: () => 1, setPixelRatio: vi.fn(), getContainer: () => container,
      jumpTo: vi.fn(), resize: vi.fn(), isStyleLoaded: () => false, areTilesLoaded: () => false,
      isMoving: () => true,
      once: vi.fn((_name: string, callback: () => void) => { idle = callback; }),
      off: vi.fn(),
      getCanvas: () => ({ toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' }),
    };
    const fulfill = vi.fn();
    const pending = renderMapDesignPreview({
      map: withRenderFrame(map),
      request: { previewId: 'preview-timeout', draftRevision: 1, styleHash: HASH,
        expiresAt: '2026-08-16T00:00:00.050Z',
        viewport: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0, width: 320, height: 240, pixelRatio: 2 } },
      snapshot: () => ({ draftRevision: 1, styleHash: HASH }), loadCanonical: vi.fn(),
      validationDigest: DIGEST, fulfill,
    });
    const rejected = expect(pending).rejects.toThrow(/expired|deadline/i);
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    expect(map.off).toHaveBeenCalledWith('idle', idle);
    expect(container.style.width).toBe('900px');
    expect(container.style.height).toBe('700px');
    expect(map.jumpTo).toHaveBeenLastCalledWith({ center: [12, 34], zoom: 7, bearing: 8, pitch: 9 });
    expect(fulfill).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not submit a conflicting failed terminal result when fulfillment itself is transiently unavailable', async () => {
    const fulfill = vi.fn(async () => { throw new Error('network unavailable'); });
    const map = {
      getCenter: () => ({ lng: 0, lat: 0 }), getZoom: () => 1, getBearing: () => 0, getPitch: () => 0,
      getPixelRatio: () => 1, setPixelRatio: vi.fn(), jumpTo: vi.fn(), resize: vi.fn(),
      isStyleLoaded: () => true, areTilesLoaded: () => true, isMoving: () => false,
      once: vi.fn(), off: vi.fn(),
      getCanvas: () => ({ toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' }),
    };
    await expect(renderMapDesignPreview({
      map: withRenderFrame(map), request: { previewId: 'preview-3', draftRevision: 1, styleHash: HASH,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        viewport: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0, width: 320, height: 240, pixelRatio: 1 } },
      snapshot: () => ({ draftRevision: 1, styleHash: HASH }), loadCanonical: vi.fn(),
      validationDigest: DIGEST, fulfill,
    })).rejects.toThrow('network unavailable');
    expect(fulfill).toHaveBeenCalledTimes(1);
    expect(fulfill).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }), expect.any(AbortSignal));
  });
});

function withRenderFrame<T extends { once: (...args: any[]) => unknown }>(map: T): T {
  return { ...map, once: ((name: string, listener: () => void) => {
    if (name === 'render') { queueMicrotask(listener); return; }
    return map.once(name, listener);
  }) as T['once'] };
}

it('mismatched canonical state must not be fulfilled as requested pixels', async () => {
  const map = {
    getCenter: () => ({ lng: 0, lat: 0 }), getZoom: () => 1, getBearing: () => 0, getPitch: () => 0,
    jumpTo: vi.fn(), resize: vi.fn(), isStyleLoaded: () => true, areTilesLoaded: () => true, isMoving: () => false,
    once: vi.fn(), off: vi.fn(), getCanvas: () => ({ toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' }),
  };
  const fulfill = vi.fn(async body => body);
  await renderMapDesignPreview({ map: withRenderFrame(map),
    request: { previewId: 'audit-mismatch', draftRevision: 1, styleHash: HASH, expiresAt: new Date(Date.now() + 60000).toISOString(),
      viewport: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0, width: 320, height: 240, pixelRatio: 1 } },
    snapshot: () => ({ draftRevision: 2, styleHash: 'c'.repeat(64) }), loadCanonical: vi.fn(async () => {}), validationDigest: DIGEST, fulfill,
  });
  expect(fulfill).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }), expect.anything());
});

it('rejects pixels when the live snapshot changes during capture', async () => {
  let revision = 1;
  const map = {
    getCenter: () => ({ lng: 0, lat: 0 }), getZoom: () => 1, getBearing: () => 0, getPitch: () => 0,
    jumpTo: vi.fn(), resize: vi.fn(), isStyleLoaded: () => true, areTilesLoaded: () => true, isMoving: () => false,
    once: vi.fn(), off: vi.fn(), getCanvas: () => ({ toDataURL: () => { revision = 2; return 'data:image/png;base64,iVBORw0KGgo='; } }),
  };
  const fulfill = vi.fn(async body => body);
  await renderMapDesignPreview({ map: withRenderFrame(map),
    request: { previewId: 'capture-drift', draftRevision: 1, styleHash: HASH, expiresAt: new Date(Date.now() + 60000).toISOString(),
      viewport: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0, width: 320, height: 240, pixelRatio: 1 } },
    snapshot: () => ({ draftRevision: revision, styleHash: HASH }), loadCanonical: vi.fn(), validationDigest: DIGEST, fulfill,
  });
  expect(fulfill).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', pngBase64: null }), expect.anything());
});
