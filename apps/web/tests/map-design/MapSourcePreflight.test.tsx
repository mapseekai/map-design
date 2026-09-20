// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapOptions } from 'maplibre-gl';

import { I18nProvider } from '../../src/i18n';
import { MapSourcePreflight } from '../../src/map-design/components/MapSourcePreflight';
import { resetMapDesignProtocolsForTests } from '../../src/map-design/map/map-lifecycle';

const result = {
  kind: 'style' as const,
  requestedHost: 'maps.example.test',
  finalHost: 'maps.example.test',
  redirectCount: 0,
  reachability: 'reachable' as const,
  security: {
    scheme: 'https' as const,
    allResolvedAddressesPublic: true as const,
    credentialsPresent: false as const,
  },
  mediaType: 'application/vnd.mapbox.style+json',
  byteLength: 100,
  preview: {
    previewId: 'preview-1',
    styleUrl: '/api/map-design/source-previews/preview-1/style',
    expiresAt: '2026-09-04T03:10:00.000Z',
  },
};

describe('MapSourcePreflight map preview', () => {
  afterEach(() => {
    cleanup();
    resetMapDesignProtocolsForTests();
  });

  it('loads the same-origin preview Style and reports idle and error for the exact preview', () => {
    const listeners = new Map<string, () => void>();
    const map = {
      remove: vi.fn(),
      resize: vi.fn(),
      on: vi.fn((type: string, listener: () => void) => {
        listeners.set(type, listener);
        return { unsubscribe: vi.fn() };
      }),
    };
    const createMap = vi.fn((_options: MapOptions) => map);
    const onPreviewReady = vi.fn();
    const onPreviewError = vi.fn();
    const maplibre = { addProtocol: vi.fn(), removeProtocol: vi.fn(), setWorkerUrl: vi.fn() };

    const view = render(
      <I18nProvider>
        <MapSourcePreflight
          result={result}
          loading={false}
          ready={false}
          error={null}
          maplibre={maplibre}
          protocolOptions={{ origin: 'https://studio.example' }}
          createMap={createMap}
          onPreviewReady={onPreviewReady}
          onPreviewError={onPreviewError}
        />
      </I18nProvider>,
    );

    const options = createMap.mock.calls[0]?.[0];
    expect(options?.style).toBe(result.preview.styleUrl);
    expect(options?.transformRequest?.(
      'https://studio.example/api/map-design/source-previews/preview-1/style',
      'Style' as never,
    )).toEqual({ url: 'https://studio.example/api/map-design/source-previews/preview-1/style' });
    expect(options?.transformRequest?.(
      '/api/map-design/source-previews/preview-1/resources/data/data.geojson',
      'Source' as never,
    )).toEqual({
      url: 'map-design-resource:///api/map-design/source-previews/preview-1/resources/data/data.geojson',
    });
    const archive = 'pmtiles:///api/map-design/source-previews/preview-1/resources/archive/archive.pmtiles';
    expect(options?.transformRequest?.(archive, 'Source' as never)).toEqual({ url: archive });
    expect(() => options?.transformRequest?.('https://attacker.test/tile.pbf', 'Tile' as never))
      .toThrow(/resource gateway/i);

    act(() => listeners.get('idle')?.());
    act(() => listeners.get('error')?.());
    expect(onPreviewReady).toHaveBeenCalledExactlyOnceWith('preview-1');
    expect(onPreviewError).toHaveBeenCalledExactlyOnceWith('preview-1');

    view.rerender(
      <I18nProvider>
        <MapSourcePreflight
          result={result}
          loading={false}
          ready
          error={null}
          maplibre={maplibre}
          protocolOptions={{ origin: 'https://studio.example' }}
          createMap={createMap}
          onPreviewReady={onPreviewReady}
          onPreviewError={onPreviewError}
        />
      </I18nProvider>,
    );
    expect(view.container.querySelector('[data-preview-ready="true"]')).toBeTruthy();
  });
});
