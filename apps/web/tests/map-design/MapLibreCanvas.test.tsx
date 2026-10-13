// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MapLibreCanvas } from '../../src/map-design/map/MapLibreCanvas';
import { resetMapDesignProtocolsForTests } from '../../src/map-design/map/map-lifecycle';

describe('MapLibreCanvas', () => {
  it('releases the map, subscriptions and protocols when initial resize fails', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unsubscribe = vi.fn();
    const map = { remove: vi.fn(), resize: () => { throw new Error('resize failed'); }, on: () => ({ unsubscribe }) };
    const maplibre = { addProtocol: vi.fn(), removeProtocol: vi.fn() };
    try {
      expect(() => render(<MapLibreCanvas style="/style.json" createMap={() => map} maplibre={maplibre} />)).toThrow('resize failed');
      expect(map.remove).toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledTimes(map.remove.mock.calls.length);
      expect(maplibre.removeProtocol).toHaveBeenCalledWith('pmtiles');
      expect(maplibre.removeProtocol).toHaveBeenCalledWith('map-design-resource');
    } finally { consoleError.mockRestore(); }
  });

  afterEach(() => {
    cleanup();
    resetMapDesignProtocolsForTests();
  });

  it('owns worker, protocols, map events, first idle, resize, and cleanup', () => {
    const calls: string[] = [];
    const listeners = new Map<string, Set<() => void>>();
    const subscriptions: Array<ReturnType<typeof vi.fn>> = [];
    const map = {
      remove: vi.fn(() => calls.push('remove-map')),
      resize: vi.fn(() => calls.push('resize-map')),
      on: vi.fn((type: string, listener: () => void) => {
        const bucket = listeners.get(type) ?? new Set<() => void>();
        bucket.add(listener);
        listeners.set(type, bucket);
        const unsubscribe = vi.fn(() => bucket.delete(listener));
        subscriptions.push(unsubscribe);
        return { unsubscribe };
      }),
    };
    const maplibre = {
      setWorkerUrl: vi.fn((url: string) => calls.push(`worker:${url}`)),
      addProtocol: vi.fn((scheme: string) => calls.push(`add:${scheme}`)),
      removeProtocol: vi.fn((scheme: string) => calls.push(`remove:${scheme}`)),
    };
    const createMap = vi.fn(() => {
      calls.push('construct-map');
      return map;
    });
    const onMapIdle = vi.fn();
    const onMapError = vi.fn();
    const onMapReady = vi.fn();

    const view = render(
      <MapLibreCanvas
        style="/api/map-design/source-previews/preview-1/style"
        maplibre={maplibre}
        createMap={createMap}
        onMapIdle={onMapIdle}
        onMapError={onMapError}
        onMapReady={onMapReady}
      />,
    );

    expect(calls.slice(0, 4)).toEqual([
      expect.stringMatching(/^worker:.*maplibre-gl-worker\.mjs$/u),
      'add:map-design-resource',
      'add:pmtiles',
      'construct-map',
    ]);
    expect(createMap).toHaveBeenCalledWith(expect.objectContaining({
      style: '/api/map-design/source-previews/preview-1/style',
      container: expect.any(HTMLDivElement),
      attributionControl: { customAttribution: [] },
      maplibreLogo: false,
    }));
    expect(map.resize).toHaveBeenCalledOnce();
    expect(onMapReady).toHaveBeenCalledWith(map);

    act(() => {
      for (const listener of listeners.get('idle') ?? []) listener();
      for (const listener of listeners.get('idle') ?? []) listener();
      for (const listener of listeners.get('error') ?? []) listener();
    });
    expect(onMapIdle).toHaveBeenCalledOnce();
    expect(onMapError).toHaveBeenCalledOnce();
    act(() => { for (const listener of listeners.get('idle') ?? []) listener(); });
    expect(onMapIdle).toHaveBeenCalledTimes(2);
    act(() => { for (const listener of listeners.get('idle') ?? []) listener(); });
    expect(onMapIdle).toHaveBeenCalledTimes(2);
    expect(map.remove).not.toHaveBeenCalled();

    view.unmount();
    expect(subscriptions.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);
    expect(map.remove).toHaveBeenCalledOnce();
    expect(maplibre.removeProtocol.mock.calls.map(([scheme]) => scheme)).toEqual([
      'map-design-resource',
      'pmtiles',
    ]);
  });
});
