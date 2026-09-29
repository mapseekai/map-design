// @vitest-environment jsdom
import { renderHook, cleanup, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MAP_THUMBNAIL_MAX_BASE64 } from '@mapseekai/contracts';
import { useProjectThumbnail } from '../../../src/map-design/screenshots/useProjectThumbnail';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function fixture() {
  vi.useFakeTimers();
  const listeners = new Map<string, Set<() => void>>();
  const source = document.createElement('canvas');
  source.width = 800; source.height = 400;
  const map = {
    on: (event: string, fn: () => void) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn); },
    off: (event: string, fn: () => void) => listeners.get(event)?.delete(fn),
    triggerRepaint: vi.fn(), getCanvas: () => source,
    isMoving: () => false, isStyleLoaded: () => true, areTilesLoaded: () => true,
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never);
  const image = vi.fn(() => 'data:image/png;base64,AAAA');
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => { throw new Error('Synchronous encoding is forbidden.'); });
  const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
    const dataUrl = image();
    queueMicrotask(() => callback({ size: (dataUrl.length - 22) * 3 / 4, dataUrl } as unknown as Blob));
  });
  vi.stubGlobal('FileReader', class {
    result = ''; onload?: () => void;
    readAsDataURL(blob: Blob & { dataUrl: string }) { this.result = blob.dataUrl; queueMicrotask(() => this.onload?.()); }
  });
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetch);
  return { map: map as never, fetch, image, encode, emit: (event: string) => act(() => { listeners.get(event)?.forEach(fn => fn()); }), listeners };
}

it('captures rendered pixels, saves a bounded thumbnail, and flushes the last view on departure', async () => {
  const f = fixture();
  const hook = renderHook(() => useProjectThumbnail('project-a', f.map, false));
  f.emit('render');
  await act(async () => {});
  expect(f.fetch).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(500));
  expect(f.fetch).toHaveBeenCalledWith('/api/map-design/projects/project-a/thumbnail', expect.objectContaining({ method: 'PUT', keepalive: true }));
  expect(JSON.parse(f.fetch.mock.calls[0]![1].body)).toMatchObject({ pngBase64: 'AAAA', width: 800, height: 400 });
  f.image.mockReturnValue('data:image/png;base64,BBBB');
  f.emit('moveend'); f.emit('render');
  hook.unmount();
  await act(async () => {});
  expect(JSON.parse(f.fetch.mock.calls[1]![1].body).pngBase64).toBe('BBBB');
  expect(f.listeners.get('render')?.size).toBe(0);
});

it('flushes pending pixels on pagehide without waiting for another WebGL frame', async () => {
  const f = fixture();
  renderHook(() => useProjectThumbnail('project-a', f.map, false));
  f.emit('render');
  await act(async () => {});
  act(() => window.dispatchEvent(new Event('pagehide')));
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

it('does not replace the saved view while temporary style edits are active or capture fails', async () => {
  const f = fixture();
  const hook = renderHook(({ suspended }) => useProjectThumbnail('project-a', f.map, suspended), { initialProps: { suspended: true } });
  f.emit('render'); act(() => vi.advanceTimersByTime(600));
  expect(f.fetch).not.toHaveBeenCalled();
  hook.rerender({ suspended: false });
  f.image.mockImplementation(() => { throw new Error('tainted'); });
  f.emit('render'); hook.unmount();
  await act(async () => {});
  expect(f.fetch).not.toHaveBeenCalled();
});

it('keeps high-resolution PNGs instead of shrinking them to the keepalive budget', async () => {
  const f = fixture();
  f.image.mockReturnValue('data:image/png;base64,' + 'A'.repeat(100_000));
  renderHook(() => useProjectThumbnail('project-a', f.map, false));
  f.emit('render');
  await act(async () => {});
  act(() => vi.advanceTimersByTime(500));
  const options = f.fetch.mock.calls[0]![1];
  expect(options.keepalive).toBe(false);
  expect(JSON.parse(options.body)).toMatchObject({ width: 800, height: 400 });
  expect(JSON.parse(options.body).pngBase64).toHaveLength(100_000);
});

it('bounds in-flight encoding and finishes departure without accessing the removed map', async () => {
  const f = fixture();
  let finish!: BlobCallback;
  f.encode.mockImplementationOnce(callback => { finish = callback; });
  const hook = renderHook(() => useProjectThumbnail('project-a', f.map, false));
  f.emit('render'); f.emit('moveend'); f.emit('render');
  expect(f.encode).toHaveBeenCalledTimes(1);
  hook.unmount();
  const repaints = (f.map as any).triggerRepaint.mock.calls.length;
  await act(async () => finish({ size: 3, dataUrl: 'data:image/png;base64,AAAA' } as unknown as Blob));
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect((f.map as any).triggerRepaint).toHaveBeenCalledTimes(repaints);
  expect(f.listeners.get('render')?.size).toBe(0);
});

it('shrinks oversized encoded copies and releases their canvas buffers', async () => {
  const f = fixture();
  f.image.mockReturnValueOnce('data:image/png;base64,' + 'A'.repeat(MAP_THUMBNAIL_MAX_BASE64 + 4));
  renderHook(() => useProjectThumbnail('project-a', f.map, false));
  f.emit('render');
  await act(async () => {});
  act(() => vi.advanceTimersByTime(500));
  expect(JSON.parse(f.fetch.mock.calls[0]![1].body)).toMatchObject({ width: 600, height: 300 });
  expect(f.encode).toHaveBeenCalledTimes(2);
  for (const canvas of f.encode.mock.contexts) expect((canvas as HTMLCanvasElement).width).toBe(0);
});
