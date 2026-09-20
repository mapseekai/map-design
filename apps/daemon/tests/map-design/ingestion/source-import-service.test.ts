import {testDesignSystem} from '../../fixtures/map-design/test-design-system.js';
import { describe, expect, it } from 'vitest';

import { MapSourceImportServiceImpl } from '../../../src/map-design/ingestion/source-import-service.js';
import type {
  PinnedFetchRequest,
  PinnedFetchResponse,
  PinnedTransport,
} from '../../../src/map-design/ingestion/pinned-transport.js';
import type { LoadedMapDesignSystem } from '../../../src/map-design/validation/design-system-loader.js';

const STYLE_URL = new URL('https://maps.example.test/style.json');
const NOW = '2026-09-04T03:00:00.000Z';
const DESIGN_SYSTEM: LoadedMapDesignSystem = testDesignSystem({ id: 'quiet-atlas', digest: 'd'.repeat(64) });

function fetched(input: {
  status: number;
  headers?: Record<string, string>;
  body: Uint8Array;
  url?: URL;
}): PinnedFetchResponse {
  const url = input.url ?? STYLE_URL;
  return {
    requestedUrl: url,
    finalUrl: url,
    redirects: [],
    status: input.status,
    headers: input.headers ?? {},
    body: input.body,
  };
}

function service(input: {
  transport: PinnedTransport;
  now?: () => string;
}): MapSourceImportServiceImpl {
  return new MapSourceImportServiceImpl({
    db: {} as never,
    blobStore: {} as never,
    transport: input.transport,
    designSystem: { id: 'quiet-atlas', digest: DESIGN_SYSTEM.digest },
    loadDesignSystem: async () => DESIGN_SYSTEM,
    ...(input.now ? { now: input.now } : {}),
  });
}

function directDocumentTransport(document: unknown, url = STYLE_URL): PinnedTransport {
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  return {
    fetch: async () => fetched({
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(bytes.byteLength) },
      body: bytes,
      url,
    }),
  };
}

describe('MapSourceImportServiceImpl preflight', () => {
  it('falls back to the complete map document after a zero-byte 206 range probe', async () => {
    const style = new TextEncoder().encode(JSON.stringify({ version: 8, sources: {}, layers: [] }));
    const responses = [
      fetched({
        status: 206,
        headers: { 'content-range': 'bytes 0-7/77', 'content-type': 'application/json' },
        body: new Uint8Array(),
      }),
      fetched({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: style,
      }),
    ];
    const requests: PinnedFetchRequest[] = [];
    const transport: PinnedTransport = {
      async fetch(request) {
        requests.push(request);
        const response = responses.shift();
        if (!response) throw new Error('unexpected extra fetch');
        return response;
      },
    };
    const sourceImportService = service({ transport });

    const result = await sourceImportService.preflight(
      { source: { url: STYLE_URL.href } },
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      kind: 'style',
      reachability: 'reachable',
      mediaType: 'application/vnd.mapbox.style+json',
      byteLength: style.byteLength,
      preview: {
        styleUrl: expect.stringMatching(/^\/api\/map-design\/source-previews\/[^/]+\/style$/),
        expiresAt: expect.any(String),
      },
    });
    expect(sourceImportService.getPreviewStyle(result.preview.previewId)).toEqual({
      version: 8,
      sources: {},
      layers: [],
    });
    expect(requests).toEqual([
      expect.objectContaining({ purpose: 'pmtiles-range', range: { start: 0, endInclusive: 7 } }),
      expect.objectContaining({
        purpose: 'document',
        accept: ['application/json', 'application/geo+json', 'application/octet-stream'],
      }),
    ]);
  });

  it('binds nested Style resource discovery to the preflight abort signal', async () => {
    const controller = new AbortController();
    const requests: PinnedFetchRequest[] = [];
    const style = {
      version: 8,
      sources: { tiles: { type: 'vector', url: './tiles.json' } },
      layers: [],
    };
    const tilejson = {
      tilejson: '3.0.0',
      tiles: ['https://tiles.example.test/{z}/{x}/{y}.pbf'],
      vector_layers: [{ id: 'roads' }],
    };
    const transport: PinnedTransport = {
      async fetch(request) {
        requests.push(request);
        const document = requests.length === 1 ? style : tilejson;
        const body = new TextEncoder().encode(JSON.stringify(document));
        return fetched({
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(body.byteLength) },
          body,
          url: request.url,
        });
      },
    };
    const sourceImportService = service({ transport });

    await sourceImportService.preflight(
      { source: { url: STYLE_URL.href } },
      controller.signal,
    );

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ purpose: 'document' });
    expect(requests[1]!.signal).toBe(controller.signal);
  });

  it('serves captured GeoJSON bytes from the in-memory preview', async () => {
    const url = new URL('https://maps.example.test/places.geojson');
    const document = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'A' },
        geometry: { type: 'Point', coordinates: [1, 2] },
      }],
    };
    const sourceImportService = service({ transport: directDocumentTransport(document, url) });

    const result = await sourceImportService.preflight(
      { source: { url: url.href } },
      new AbortController().signal,
    );
    const style = sourceImportService.getPreviewStyle(result.preview.previewId);
    const dataUrl = (style.sources.data as { data: string }).data;
    const match = dataUrl.match(/\/resources\/([^/]+)\/data\.geojson$/u);
    expect(match?.[1]).toBeTruthy();

    const representation = await sourceImportService.getResource(
      result.preview.previewId,
      match![1]!,
      ['data.geojson'],
    );
    expect(JSON.parse(new TextDecoder().decode(representation.bytes))).toEqual(document);
    expect(representation.mediaType).toBe('application/geo+json');
  });

  it('removes deleted and expired preview sessions', async () => {
    let now = NOW;
    const sourceImportService = service({
      transport: directDocumentTransport({ version: 8, sources: {}, layers: [] }),
      now: () => now,
    });
    const deleted = await sourceImportService.preflight(
      { source: { url: STYLE_URL.href } },
      new AbortController().signal,
    );
    sourceImportService.deletePreview(deleted.preview.previewId);
    expect(() => sourceImportService.getPreviewStyle(deleted.preview.previewId))
      .toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));

    const expired = await sourceImportService.preflight(
      { source: { url: STYLE_URL.href } },
      new AbortController().signal,
    );
    now = '2026-09-04T03:11:00.000Z';
    expect(() => sourceImportService.getPreviewStyle(expired.preview.previewId))
      .toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('evicts the oldest preview when the in-memory session bound is reached', async () => {
    const sourceImportService = service({
      transport: directDocumentTransport({ version: 8, sources: {}, layers: [] }),
      now: () => NOW,
    });
    const previews: Awaited<ReturnType<MapSourceImportServiceImpl['preflight']>>[] = [];
    for (let index = 0; index < 17; index += 1) {
      previews.push(await sourceImportService.preflight(
        { source: { url: STYLE_URL.href } },
        new AbortController().signal,
      ));
    }

    expect(() => sourceImportService.getPreviewStyle(previews[0]!.preview.previewId))
      .toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(sourceImportService.getPreviewStyle(previews.at(-1)!.preview.previewId))
      .toMatchObject({ version: 8 });
  });
});
