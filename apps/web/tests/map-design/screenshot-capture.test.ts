// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { captureMapScreenshot } from '../../src/map-design/screenshots/capture';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const listeners = new Set<() => void>();
  let ready = false;
  const canvas = { width: 1200, height: 800 };
  const draw = vi.fn(); const encode = vi.fn(() => 'data:image/png;base64,AAAA');
  vi.spyOn(document, 'createElement').mockReturnValue({ width: 0, height: 0, getContext: () => ({ drawImage: draw }), toDataURL: encode } as unknown as HTMLCanvasElement);
  const map = { on: (_name: string, listener: () => void) => listeners.add(listener), off: (_name: string, listener: () => void) => listeners.delete(listener),
    loaded: () => ready, isStyleLoaded: () => ready, areTilesLoaded: () => ready,
    getCanvas: () => canvas, triggerRepaint: vi.fn(), getCenter: () => ({ lng: 480, lat: 30 }),
    getZoom: () => 10, getBearing: () => 0, getPitch: () => 0 };
  return { map, listeners, draw, encode, render: (loaded = true) => { ready = loaded; for (const listener of [...listeners]) listener(); } };
}

it('copies the rendered WebGL frame only when ready and preserves its view context', async () => {
  const f = fixture();
  const promise = captureMapScreenshot(f.map as never, { draftRevision: 2, styleHash: 'a'.repeat(64) });
  expect(f.draw).not.toHaveBeenCalled();
  f.render(false);
  expect(f.draw).not.toHaveBeenCalled();
  f.render();
  expect(f.draw).toHaveBeenCalledOnce();
  expect(await promise).toMatchObject({ pngBase64: 'AAAA', width: 1200, height: 800, draftRevision: 2, viewport: { center: [120, 30], zoom: 10 } });
  expect(f.listeners.size).toBe(0);
});

it('aborts pending capture and removes listeners before a later render', async () => {
  const f = fixture(); const controller = new AbortController();
  const promise = captureMapScreenshot(f.map as never, { draftRevision: 2, styleHash: 'a'.repeat(64) }, controller.signal);
  controller.abort();
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  f.render();
  expect(f.draw).not.toHaveBeenCalled();
  expect(f.listeners.size).toBe(0);
});

it('captures the requested painted frame even if other source updates are still pending', async () => {
  const f = fixture();
  f.map.loaded = () => false;
  const promise = captureMapScreenshot(f.map as never, { draftRevision: 2, styleHash: 'a'.repeat(64) });
  f.render();
  await expect(promise).resolves.toMatchObject({ width: 1200, height: 800 });
});

it('keeps shrinking oversized encodings until they fit the image limit', async () => {
  const f = fixture();
  const oversized = 'data:image/png;base64,' + 'A'.repeat(5_592_412);
  f.encode.mockReturnValueOnce(oversized).mockReturnValueOnce(oversized);
  const promise = captureMapScreenshot(f.map as never, { draftRevision: 2, styleHash: 'a'.repeat(64) });
  f.render();
  await expect(promise).resolves.toMatchObject({ width: 300, height: 200 });
  expect(f.draw).toHaveBeenCalledTimes(3);
});
