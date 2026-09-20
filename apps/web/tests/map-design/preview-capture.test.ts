// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { renderMapDesignPreview } from '../../src/map-design/preview/preview-renderer';
afterEach(() => vi.restoreAllMocks());
it('reads pixels inside a render callback and normalizes high-DPI output to requested dimensions', async () => {
  let inRender = false;
  let frame: (() => void) | undefined;
  const source = document.createElement('canvas'); source.width = 640; source.height = 480;
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function(this: HTMLCanvasElement) {
    expect(inRender).toBe(true);
    expect([this.width, this.height]).toEqual([320, 240]);
    return 'data:image/png;base64,iVBORw0KGgo=';
  });
  const map = {
    getCenter: () => ({ lng: 0, lat: 0 }), getZoom: () => 1, getBearing: () => 0, getPitch: () => 0,
    getPixelRatio: () => 1, setPixelRatio: vi.fn(), jumpTo: vi.fn(), resize: vi.fn(),
    isStyleLoaded: () => true, areTilesLoaded: () => true, isMoving: () => false,
    getCanvas: () => source,
    once: (name: string, callback: () => void) => { if (name === 'render') frame = callback; },
    off: vi.fn(), triggerRepaint: () => { inRender = true; frame?.(); inRender = false; },
  };
  const result = await renderMapDesignPreview({ map,
    request: { previewId: 'frame-test', draftRevision: 1, styleHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 5000).toISOString(),
      viewport: { center: [0, 0], zoom: 1, bearing: 0, pitch: 0, width: 320, height: 240, pixelRatio: 2 } },
    snapshot: () => ({ draftRevision: 1, styleHash: 'a'.repeat(64) }), loadCanonical: vi.fn(), validationDigest: 'b'.repeat(64),
    fulfill: async body => body,
  });
  expect(result).toMatchObject({ status: 'succeeded' });
  expect(drawImage).toHaveBeenCalledWith(source, 0, 0, 320, 240);
});
