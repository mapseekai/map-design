// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapOptions } from 'maplibre-gl';
import { I18nProvider } from '../../src/i18n';
import { MapSourcePreview, SOURCE_PREVIEW_DEBOUNCE_MS, SOURCE_PREVIEW_TIMEOUT_MS } from '../../src/map-design/components/MapSourcePreview';
import type { MapCanvasError } from '../../src/map-design/map/MapLibreCanvas';

const URL_A = 'https://demotiles.maplibre.org/styles/osm-bright-gl-terrain/style.json';
const URL_B = 'https://maps.example.com/other.json';
type Listener = (event?: MapCanvasError) => void;
function harness() {
  const maps: Array<{ remove: ReturnType<typeof vi.fn>; listeners: Map<string, Listener> }> = [];
  const maplibre = { addProtocol: vi.fn(), removeProtocol: vi.fn(), setWorkerUrl: vi.fn() };
  const createMap = vi.fn((_options: MapOptions) => {
    const listeners = new Map<string, Listener>();
    const map = { remove: vi.fn(), resize: vi.fn(), listeners,
      on: (type: string, listener: Listener) => {
        listeners.set(type, listener);
        return { unsubscribe: () => { listeners.delete(type); } };
      },
    };
    maps.push(map);
    return map;
  });
  const ui = (sourceUrl: string) => <I18nProvider><MapSourcePreview sourceUrl={sourceUrl} maplibre={maplibre} createMap={createMap} /></I18nProvider>;
  return { maps, maplibre, createMap, ui };
}
async function advance(ms = SOURCE_PREVIEW_DEBOUNCE_MS) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('MapSourcePreview direct browser loading', () => {
  it('debounces the URL and gives MapLibre the original Style without any daemon preflight or protocols', async () => {
    const h = harness();
    const view = render(h.ui(''));
    expect(screen.getByText(/load the map automatically/i)).toBeInTheDocument();
    view.rerender(h.ui(URL_B));
    await advance(200);
    view.rerender(h.ui(URL_A));
    await advance(399);
    expect(h.createMap).not.toHaveBeenCalled();
    await advance(1);
    expect(h.createMap).toHaveBeenCalledOnce();
    const options = h.createMap.mock.calls[0]![0];
    expect(options.style).toBe(URL_A);
    expect(options.validateStyle).not.toBe(false);
    expect(h.maplibre.addProtocol).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(options.transformRequest?.('https://tiles.example.com/0/0/0.pbf', 'Tile' as never))
      .toEqual({ url: 'https://tiles.example.com/0/0/0.pbf', credentials: 'same-origin' });
    for (const url of ['file:///etc/passwd', 'map-design-resource:///api/map-design/projects/p/resources/a',
      'pmtiles:///api/map-design/projects/p/resources/archive', window.location.origin + '/api/config',
      'https://user:secret@maps.example.com/style.json']) {
      expect(() => options.transformRequest?.(url, 'Source' as never)).toThrow();
    }
  });

  it('cleans up the previous map immediately and ignores its late events after a URL change', async () => {
    const h = harness();
    const view = render(h.ui(URL_A));
    await advance();
    const oldLoad = h.maps[0]!.listeners.get('load')!;
    const oldError = h.maps[0]!.listeners.get('error')!;
    act(() => oldLoad());
    expect(view.container.querySelector('[data-preview-ready="true"]')).toBeTruthy();
    view.rerender(h.ui(URL_B));
    expect(h.maps[0]!.remove).toHaveBeenCalledOnce();
    await advance();
    act(() => { oldLoad(); oldError(); });
    expect(view.container.querySelector('[data-preview-ready="false"]')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    view.unmount();
    expect(h.maps[1]!.remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows a non-gating error and retries the same URL with a new map', async () => {
    const h = harness();
    render(h.ui(URL_A));
    await advance();
    act(() => h.maps[0]!.listeners.get('error')?.({ error: new Error('sensitive request detail') }));
    expect(screen.getByRole('alert')).toHaveTextContent('You can still create the project.');
    expect(screen.queryByText(/sensitive request detail/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload preview' }));
    expect(h.createMap).toHaveBeenCalledTimes(2);
    expect(h.maps[0]!.remove).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => h.maps[1]!.listeners.get('load')?.());
    expect(document.querySelector('[data-preview-ready="true"]')).toBeTruthy();
  });

  it('keeps partial resource errors visible even when MapLibre completes its first render', async () => {
    const h = harness();
    render(h.ui(URL_A));
    await advance();
    act(() => {
      h.maps[0]!.listeners.get('error')?.({ sourceId: 'terrain' });
      h.maps[0]!.listeners.get('load')?.();
    });
    expect(document.querySelector('[data-preview-ready="true"]')).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent('Some map resources could not load.');
  });

  it('offers retry instead of spinning indefinitely, and can recover from a late successful load', async () => {
    const h = harness();
    render(h.ui(URL_A));
    await advance();
    await advance(SOURCE_PREVIEW_TIMEOUT_MS);
    expect(screen.getByRole('button', { name: 'Reload preview' })).toBeInTheDocument();
    act(() => h.maps[0]!.listeners.get('load')?.());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears the map for invalid or empty input and cancels pending input timers', async () => {
    const h = harness();
    const view = render(h.ui(URL_A));
    await advance();
    view.rerender(h.ui('not-a-url'));
    expect(h.maps[0]!.remove).toHaveBeenCalledOnce();
    expect(screen.getByText(/Enter a valid HTTP/)).toBeInTheDocument();
    view.rerender(h.ui(''));
    await advance();
    expect(h.createMap).toHaveBeenCalledOnce();
    view.rerender(h.ui(URL_B));
    view.unmount();
    await advance();
    expect(h.createMap).toHaveBeenCalledOnce();
  });

  it('contains synchronous map construction failures within the preview', async () => {
    const h = harness();
    h.createMap.mockImplementation(() => { throw new Error('WebGL unavailable'); });
    render(h.ui(URL_A));
    await advance();
    expect(screen.getByRole('alert')).toHaveTextContent('You can still create the project.');
    expect(screen.getByRole('button', { name: 'Reload preview' })).toBeInTheDocument();
  });
});
