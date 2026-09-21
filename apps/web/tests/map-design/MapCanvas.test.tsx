// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddProtocolAction, MapOptions } from 'maplibre-gl';

import { MapCanvas } from '../../src/map-design/map/MapCanvas';
import {
  acquireMapDesignProtocols,
  resetMapDesignProtocolsForTests,
} from '../../src/map-design/map/map-lifecycle';
import { GatewayPmtilesSource } from '../../src/map-design/map/gateway-pmtiles-source';
import { PMTILES_PROTOCOL } from '../../src/map-design/map/pmtiles-protocol';
import { createMapDesignResourceProtocol } from '../../src/map-design/map/resource-protocol';

describe('MapCanvas lifecycle and resource protocols', () => {
  afterEach(() => {
    cleanup();
    resetMapDesignProtocolsForTests();
    vi.unstubAllGlobals();
  });

  it('registers protocols before constructing one map and releases them after the final owner', () => {
    const calls: string[] = [];
    const maps: Array<{ remove: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn> }> = [];
    const maplibre = {
      setWorkerUrl: vi.fn((url: string) => calls.push(`worker:${url}`)),
      addProtocol: vi.fn((scheme: string) => calls.push(`add:${scheme}`)),
      removeProtocol: vi.fn((scheme: string) => calls.push(`remove:${scheme}`)),
    };
    const createMap = vi.fn(() => {
      calls.push('construct');
      const map = { remove: vi.fn(() => calls.push('map.remove')), resize: vi.fn() };
      maps.push(map);
      return map;
    });

    const first = render(<MapCanvas projectId="project-a" initialStyle={{ version: 8, sources: {}, layers: [] }} maplibre={maplibre} createMap={createMap} />);
    const second = render(<MapCanvas projectId="project-b" initialStyle={{ version: 8, sources: {}, layers: [] }} maplibre={maplibre} createMap={createMap} />);

    expect(createMap).toHaveBeenCalledTimes(2);
    expect(calls[0]).toMatch(/^worker:.*maplibre-gl-worker\.mjs$/u);
    expect(calls.slice(1, 4)).toEqual(['add:map-design-resource', 'add:pmtiles', 'construct']);
    expect(maplibre.addProtocol).toHaveBeenCalledTimes(2);
    first.unmount();
    expect(maplibre.removeProtocol).not.toHaveBeenCalled();
    second.unmount();
    expect(maps.every((map) => map.remove.mock.calls.length === 1)).toBe(true);
    expect(maplibre.removeProtocol.mock.calls.map(([scheme]) => scheme)).toEqual(['map-design-resource', 'pmtiles']);
  });

  it('tears down and creates a fresh map when the project changes', () => {
    const maplibre = { addProtocol: vi.fn(), removeProtocol: vi.fn() };
    const remove = vi.fn();
    const createMap = vi.fn(() => ({ remove, resize: vi.fn() }));
    const view = render(<MapCanvas projectId="project-a" initialStyle={{ version: 8, sources: {}, layers: [] }} maplibre={maplibre} createMap={createMap} />);
    view.rerender(<MapCanvas projectId="project-b" initialStyle={{ version: 8, sources: {}, layers: [] }} maplibre={maplibre} createMap={createMap} />);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(createMap).toHaveBeenCalledTimes(2);
  });

  it('handles a MapLibre resource error and unsubscribes the listener without exposing details', () => {
    let errorListener: (() => void) | undefined;
    let idleListener: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const map = {
      remove: vi.fn(),
      resize: vi.fn(),
      on: vi.fn((type: string, listener: () => void) => {
        if (type === 'error') errorListener = listener;
        if (type === 'idle') idleListener = listener;
        return { unsubscribe };
      }),
    };
    const onMapError = vi.fn();
    const onMapIdle = vi.fn();
    const view = render(<MapCanvas
      projectId="project-a"
      initialStyle={{ version: 8, sources: {}, layers: [] }}
      maplibre={{ addProtocol: vi.fn(), removeProtocol: vi.fn() }}
      createMap={() => map}
      onMapError={onMapError}
      onMapIdle={onMapIdle}
    />);

    expect(map.on).toHaveBeenCalledWith('error', expect.any(Function));
    act(() => { errorListener?.(); });
    expect(onMapError).toHaveBeenCalledExactlyOnceWith();
    expect(JSON.stringify(onMapError.mock.calls)).not.toContain('private.example');
    act(() => { idleListener?.(); });
    expect(onMapIdle).toHaveBeenCalledOnce();
    expect(map.remove).not.toHaveBeenCalled();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('waits for the next frame before resizing MapLibre for a layout revision', () => {
    const animationFrame = installAnimationFrameHarness();
    const maplibre = { addProtocol: vi.fn(), removeProtocol: vi.fn() };
    const map = { remove: vi.fn(), resize: vi.fn() };
    const createMap = vi.fn(() => map);
    const props = {
      projectId: 'project-a', initialStyle: { version: 8 as const, sources: {}, layers: [] }, maplibre, createMap,
    };

    const view = render(<MapCanvas {...props} layoutRevision={0} />);
    expect(map.resize).toHaveBeenCalledTimes(1);
    view.rerender(<MapCanvas {...props} layoutRevision={1} />);
    expect(map.resize).toHaveBeenCalledTimes(1);
    expect(animationFrame.requestAnimationFrame).toHaveBeenCalledTimes(1);
    animationFrame.run(1);
    expect(map.resize).toHaveBeenCalledTimes(2);
  });

  it('coalesces superseded layout revisions into the latest frame resize', () => {
    const animationFrame = installAnimationFrameHarness();
    const maplibre = { addProtocol: vi.fn(), removeProtocol: vi.fn() };
    const map = { remove: vi.fn(), resize: vi.fn() };
    const createMap = vi.fn(() => map);
    const props = {
      projectId: 'project-a', initialStyle: { version: 8 as const, sources: {}, layers: [] }, maplibre, createMap,
    };

    const view = render(<MapCanvas {...props} layoutRevision={0} />);
    view.rerender(<MapCanvas {...props} layoutRevision={1} />);
    view.rerender(<MapCanvas {...props} layoutRevision={2} />);

    expect(map.resize).toHaveBeenCalledTimes(1);
    expect(animationFrame.cancelAnimationFrame).toHaveBeenCalledWith(1);
    animationFrame.run(2);
    expect(map.resize).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending layout resize frame on unmount', () => {
    const animationFrame = installAnimationFrameHarness();
    const maplibre = { addProtocol: vi.fn(), removeProtocol: vi.fn() };
    const map = { remove: vi.fn(), resize: vi.fn() };
    const createMap = vi.fn(() => map);
    const props = {
      projectId: 'project-a', initialStyle: { version: 8 as const, sources: {}, layers: [] }, maplibre, createMap,
    };

    const view = render(<MapCanvas {...props} layoutRevision={0} />);
    view.rerender(<MapCanvas {...props} layoutRevision={1} />);
    view.unmount();

    expect(animationFrame.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(map.resize).toHaveBeenCalledTimes(1);
  });

  it('recreates the map when workspace resource headers become available', () => {
    const maplibre = { addProtocol: vi.fn(), removeProtocol: vi.fn() };
    const remove = vi.fn();
    const createMap = vi.fn(() => ({ remove, resize: vi.fn() }));
    const view = render(
      <MapCanvas projectId="project-a" initialStyle={{ version: 8, sources: {}, layers: [] }}
        maplibre={maplibre} createMap={createMap} />,
    );

    view.rerender(
      <MapCanvas projectId="project-a" initialStyle={{ version: 8, sources: {}, layers: [] }}
        maplibre={maplibre} createMap={createMap}
        protocolOptions={{ headers: { 'x-map-design-workspace-id': 'workspace-a' } }} />,
    );

    expect(remove).toHaveBeenCalledTimes(1);
    expect(createMap).toHaveBeenCalledTimes(2);
  });

  it('rejects local/privileged URLs before map construction and defends every transformed request', () => {
    const maplibre = { addProtocol: vi.fn(), removeProtocol: vi.fn() };
    const createMap = vi.fn((_options: MapOptions) => ({ remove: vi.fn(), resize: vi.fn() }));
    const attackerStyle = {
      version: 8 as const,
      sources: { attacker: { type: 'vector' as const, tiles: ['http://127.0.0.1/{z}/{x}/{y}.pbf'] } },
      layers: [],
    };

    expect(() => render(<MapCanvas projectId="project-a" initialStyle={attackerStyle} maplibre={maplibre} createMap={createMap} />))
      .toThrow(/resource gateway|unsafe MapDesign Style resource/i);
    expect(createMap).not.toHaveBeenCalled();

    const safeStyle = {
      version: 8 as const,
      sources: { safe: { type: 'vector' as const, tiles: ['/api/map-design/projects/project-a/resources/tiles/tiles/{z}/{x}/{y}.pbf'] } },
      layers: [],
    };
    render(<MapCanvas projectId="project-a" initialStyle={safeStyle} maplibre={maplibre} createMap={createMap} />);
    const options = createMap.mock.calls[0]?.[0];
    expect(() => options?.transformRequest?.('http://127.0.0.1/native.pbf', 'Tile' as never))
      .toThrow(/resource gateway/i);
    expect(options?.transformRequest?.('/api/map-design/projects/project-a/resources/tiles/tiles/0/0/0.pbf', 'Tile' as never))
      .toMatchObject({ url: expect.stringContaining('/projects/project-a/resources/') });
  });

  it('leaves validated PMTiles requests on the registered PMTiles protocol', () => {
    const origin = 'https://studio.example';
    const archivePath = '/api/map-design/projects/project-a/resources/archive/archive.pmtiles';
    const archiveUrl = `${PMTILES_PROTOCOL}://${origin}${archivePath}`;
    const tileUrl = `${archiveUrl}/0/0/0`;
    const maplibre = { addProtocol: vi.fn(), removeProtocol: vi.fn() };
    const createMap = vi.fn((_options: MapOptions) => ({ remove: vi.fn(), resize: vi.fn() }));

    render(
      <MapCanvas
        projectId="project-a"
        initialStyle={{
          version: 8,
          sources: { archive: { type: 'vector', url: archiveUrl } },
          layers: [],
        }}
        maplibre={maplibre}
        createMap={createMap}
        protocolOptions={{ origin }}
      />,
    );

    const options = createMap.mock.calls[0]?.[0];
    expect(options?.transformRequest?.(tileUrl, 'Tile' as never)).toEqual({ url: tileUrl });
  });

  it('ref-counts direct protocol owners independently of canvas instances', () => {
    const maplibre = { addProtocol: vi.fn(), removeProtocol: vi.fn() };
    const first = acquireMapDesignProtocols(maplibre);
    const second = acquireMapDesignProtocols(maplibre);
    first();
    expect(maplibre.removeProtocol).not.toHaveBeenCalled();
    second();
    expect(maplibre.removeProtocol).toHaveBeenCalledTimes(2);
  });

  it('accepts same-origin source-preview resources through the shared protocol', async () => {
    const fetcher = vi.fn(async () => new Response('{"ok":true}', {
      headers: { 'content-type': 'application/json' },
    }));
    const protocol = createMapDesignResourceProtocol({
      origin: 'https://studio.example',
      fetch: fetcher,
    });

    await expect(protocol({
      url: 'map-design-resource:///api/map-design/source-previews/preview-1/resources/data/data.geojson',
      type: 'json',
    }, new AbortController())).resolves.toMatchObject({ data: { ok: true } });
    expect(fetcher).toHaveBeenCalledWith(
      new URL('https://studio.example/api/map-design/source-previews/preview-1/resources/data/data.geojson'),
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('returns parsed JSON when MapLibre requests a gateway JSON resource', async () => {
    const protocol = createMapDesignResourceProtocol({
      origin: 'https://studio.example',
      fetch: vi.fn(async () => new Response('{"road":{"width":16}}', {
        headers: { 'content-type': 'application/json' },
      })),
    });

    await expect(protocol({
      url: 'map-design-resource:///api/map-design/projects/project-a/resources/sprite/sprite-0.json',
      type: 'json',
    }, new AbortController())).resolves.toMatchObject({
      data: { road: { width: 16 } },
    });
  });

  it('serves exact byte ranges with ETag and abort propagation and rejects arbitrary upstream URLs', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('range')).toBe('bytes=10-14');
      expect(new Headers(init?.headers).get('if-match')).toBe('"archive-v1"');
      expect(init?.signal).toBe(controller.signal);
      return new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        status: 206,
        headers: { etag: '"archive-v1"', 'content-range': 'bytes 10-14/100' },
      });
    });
    const controller = new AbortController();
    const source = new GatewayPmtilesSource('https://studio.example/api/map-design/projects/project-a/resources/archive/data.pmtiles', {
      origin: 'https://studio.example',
      fetch: fetcher,
    });
    const result = await source.getBytes(10, 5, controller.signal, '"archive-v1"');
    expect([...new Uint8Array(result.data)]).toEqual([1, 2, 3, 4, 5]);
    expect(result.etag).toBe('"archive-v1"');
    expect(() => new GatewayPmtilesSource('https://tiles.attacker.test/archive.pmtiles', {
      origin: 'https://studio.example',
      fetch: fetcher,
    })).toThrow(/same-origin/i);
  });

  it('uses the default browser fetch with its required global receiver', async () => {
    vi.stubGlobal('fetch', function nativeLikeFetch(this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 206,
        headers: { 'content-range': 'bytes 0-3/100' },
      }));
    });
    const source = new GatewayPmtilesSource(
      'https://studio.example/api/map-design/projects/project-a/resources/archive/archive.pmtiles',
      { origin: 'https://studio.example' },
    );

    const result = await source.getBytes(0, 4);

    expect([...new Uint8Array(result.data)]).toEqual([1, 2, 3, 4]);
  });

  it('accepts a legal EOF-clamped PMTiles range and rejects an inconsistent response body', async () => {
    const clamped = new GatewayPmtilesSource(
      'https://studio.example/api/map-design/projects/project-a/resources/archive/archive.pmtiles',
      {
        origin: 'https://studio.example',
        fetch: vi.fn(async () => new Response(new Uint8Array([7, 8, 9]), {
          status: 206,
          headers: { etag: '"archive-v1"', 'content-range': 'bytes 10-12/13' },
        })),
      },
    );
    await expect(clamped.getBytes(10, 5, undefined, '"archive-v1"'))
      .resolves.toMatchObject({ data: expect.any(ArrayBuffer), etag: '"archive-v1"' });

    const inconsistent = new GatewayPmtilesSource(
      'https://studio.example/api/map-design/projects/project-a/resources/archive/archive.pmtiles',
      {
        origin: 'https://studio.example',
        fetch: vi.fn(async () => new Response(new Uint8Array([7, 8]), {
          status: 206,
          headers: { etag: '"archive-v1"', 'content-range': 'bytes 10-12/13' },
        })),
      },
    );
    await expect(inconsistent.getBytes(10, 5, undefined, '"archive-v1"'))
      .rejects.toThrow(/Content-Range|length/i);
  });

  it('routes multiple PMTiles tile URLs through one stable gateway archive and drops it after final release', async () => {
    const archive = minimalPmtilesArchive();
    const ranges: string[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('range');
      if (!range) throw new TypeError('expected PMTiles range');
      ranges.push(range);
      const match = range.match(/^bytes=(\d+)-(\d+)$/u);
      if (!match) throw new TypeError('invalid range');
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), archive.byteLength - 1);
      return new Response(archive.slice(start, end + 1), {
        status: 206,
        headers: { etag: '"archive-v1"', 'content-range': `bytes ${start}-${end}/${archive.byteLength}` },
      });
    });
    const handlers = new Map<string, AddProtocolAction>();
    const maplibre = {
      addProtocol: vi.fn((scheme, handler) => handlers.set(scheme, handler)),
      removeProtocol: vi.fn((scheme) => { handlers.delete(scheme); }),
    };
    const release = acquireMapDesignProtocols(maplibre, { origin: 'https://studio.example', fetch: fetcher });
    const firstHandler = handlers.get('pmtiles');
    const base = 'https://studio.example/api/map-design/projects/project-a/resources/archive/archive.pmtiles';
    if (!firstHandler) throw new TypeError('missing PMTiles handler');

    await expect(firstHandler({ url: `pmtiles://${base}/0/0/0`, type: 'Tile' } as never, new AbortController()))
      .resolves.toMatchObject({ data: new Uint8Array([17]) });
    await expect(firstHandler({ url: `pmtiles://${base}/1/0/0`, type: 'Tile' } as never, new AbortController()))
      .resolves.toMatchObject({ data: new Uint8Array([34]) });
    expect(ranges.filter((range) => range === 'bytes=0-16383')).toHaveLength(1);

    release();
    const releaseAgain = acquireMapDesignProtocols(maplibre, { origin: 'https://studio.example', fetch: fetcher });
    const replacementHandler = handlers.get('pmtiles');
    expect(replacementHandler).not.toBe(firstHandler);
    if (!replacementHandler) throw new TypeError('missing replacement PMTiles handler');
    await replacementHandler({ url: `pmtiles://${base}/0/0/0`, type: 'Tile' } as never, new AbortController());
    expect(ranges.filter((range) => range === 'bytes=0-16383')).toHaveLength(2);
    releaseAgain();
  });
});

function minimalPmtilesArchive(): Uint8Array {
  const root = new Uint8Array([2, 0, 1, 1, 1, 1, 1, 1, 0]);
  const bytes = new Uint8Array(127 + root.byteLength + 2);
  bytes.set(new TextEncoder().encode('PMTiles'));
  bytes[7] = 3;
  const view = new DataView(bytes.buffer);
  const u64 = (offset: number, value: number) => view.setBigUint64(offset, BigInt(value), true);
  u64(8, 127); u64(16, root.byteLength); u64(24, 136); u64(32, 0); u64(40, 136); u64(48, 0);
  u64(56, 136); u64(64, 2); u64(72, 2); u64(80, 2); u64(88, 2);
  bytes[96] = 1; bytes[97] = 1; bytes[98] = 1; bytes[99] = 1;
  bytes[100] = 0; bytes[101] = 1;
  view.setInt32(102, -180_0000000, true); view.setInt32(106, -85_0000000, true);
  view.setInt32(110, 180_0000000, true); view.setInt32(114, 85_0000000, true);
  bytes.set(root, 127);
  bytes[136] = 17;
  bytes[137] = 34;
  return bytes;
}

function installAnimationFrameHarness() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    const frame = ++nextFrame;
    callbacks.set(frame, callback);
    return frame;
  });
  const cancelAnimationFrame = vi.fn((frame: number) => {
    callbacks.delete(frame);
  });
  vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
  vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);

  return {
    requestAnimationFrame,
    cancelAnimationFrame,
    run(frame: number) {
      const callback = callbacks.get(frame);
      if (!callback) throw new Error(`Missing animation frame ${frame}`);
      callbacks.delete(frame);
      callback(0);
    },
  };
}
