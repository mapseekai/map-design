import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MapDesignMap } from '../../src/map-design/map/map-design-map';

const runtime = vi.hoisted(() => ({
  calls: Array<string>(),
  getTerrain: vi.fn<MapLibreMap['getTerrain']>(),
  setTerrain: vi.fn(),
  setStyle: vi.fn(),
}));

vi.mock('maplibre-gl', () => ({
  Map: class {
    getTerrain() { return runtime.getTerrain(); }
    setTerrain(value: Parameters<MapLibreMap['setTerrain']>[0]) {
      runtime.calls.push('terrain');
      runtime.setTerrain(value);
      return this;
    }
    setStyle(...args: Parameters<MapLibreMap['setStyle']>) {
      runtime.calls.push('style');
      runtime.setStyle(...args);
      return this;
    }
  },
}));

const style: StyleSpecification = { version: 8, sources: {}, layers: [], terrain: { source: 'new-dem' } };

function createMap() { return new MapDesignMap({ container: 'map' }); }

describe('MapDesignMap full style replacement', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.calls.length = 0;
    runtime.getTerrain.mockReturnValue({ source: 'old-dem' });
  });

  it('clears existing terrain before replacing the style and preserves the incoming terrain', () => {
    // Given a loaded terrain map and an incoming style with different terrain.
    const map = createMap();
    const options = { diff: false };
    // When the complete style is replaced.
    const result = map.setStyle(style, options);
    // Then stale terrain is removed first and the original style is forwarded intact.
    expect(runtime.calls).toEqual(['terrain', 'style']);
    expect(runtime.setTerrain).toHaveBeenCalledWith(null);
    expect(runtime.setStyle).toHaveBeenCalledWith(style, options);
    expect(style.terrain).toEqual({ source: 'new-dem' });
    expect(result).toBe(map);
  });

  it.each([undefined, { diff: true }])('preserves terrain for normal diff updates with options %j', (options) => {
    // Given a terrain map.
    const map = createMap();
    // When normal MapLibre style diffing is requested.
    map.setStyle(style, options);
    // Then terrain ownership stays with MapLibre.
    expect(runtime.setTerrain).not.toHaveBeenCalled();
    expect(runtime.setStyle).toHaveBeenCalledWith(style, options);
  });

  it('does not clear terrain during initial style loading', () => {
    // Given a map with no loaded terrain.
    runtime.getTerrain.mockReturnValue(null);
    const map = createMap();
    // When a full style is loaded.
    map.setStyle(style, { diff: false });
    // Then no terrain setter runs before initialization.
    expect(runtime.calls).toEqual(['style']);
  });

  it('propagates style replacement errors', () => {
    // Given a MapLibre style setter failure.
    const failure = new Error('style rejected');
    runtime.setStyle.mockImplementation(() => { throw failure; });
    const map = createMap();
    // When a full replacement fails, then callers receive the same error.
    expect(() => map.setStyle(style, { diff: false })).toThrow(failure);
  });
});
