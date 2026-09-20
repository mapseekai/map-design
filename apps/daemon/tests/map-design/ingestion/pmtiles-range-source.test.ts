import { describe, expect, it } from 'vitest';

import type { PinnedFetchRequest, PinnedTransport } from '../../../src/map-design/ingestion/pinned-transport.js';
import { PmtilesRangeSource } from '../../../src/map-design/ingestion/pmtiles-range-source.js';

describe('PmtilesRangeSource', () => {
  it('uses exact pinned ranges and returns public PMTiles RangeResponse metadata', async () => {
    const requests: PinnedFetchRequest[] = [];
    const transport: PinnedTransport = {
      fetch: async (request) => {
        requests.push(request);
        return {
          requestedUrl: request.url,
          finalUrl: request.url,
          redirects: [],
          status: 206,
          headers: {
            'content-range': 'bytes 10-13/100',
            etag: '"archive-v1"',
            'cache-control': 'public, max-age=60',
            expires: 'Fri, 14 Aug 2026 00:00:00 GMT',
          },
          body: new Uint8Array([1, 2, 3, 4]),
        };
      },
    };
    const source = new PmtilesRangeSource(new URL('https://maps.example.test/archive.pmtiles'), transport);

    const response = await source.getBytes(10, 4, undefined, '"archive-v1"');

    expect(source.getKey()).toBe('https://maps.example.test/archive.pmtiles');
    expect(requests).toEqual([
      expect.objectContaining({
        purpose: 'pmtiles-range',
        range: { start: 10, endInclusive: 13 },
      }),
    ]);
    expect(Array.from(new Uint8Array(response.data))).toEqual([1, 2, 3, 4]);
    expect(response).toMatchObject({
      etag: '"archive-v1"',
      cacheControl: 'public, max-age=60',
      expires: 'Fri, 14 Aug 2026 00:00:00 GMT',
    });
  });

  it('rejects inexact ranges, full-archive responses, redirects, and ETag changes', async () => {
    const cases = [
      { status: 206, headers: { 'content-range': 'bytes 9-12/100', etag: '"v1"' }, body: new Uint8Array(4), final: 'same' },
      { status: 200, headers: { 'content-length': '100', etag: '"v1"' }, body: new Uint8Array(100), final: 'same' },
      { status: 206, headers: { 'content-range': 'bytes 10-13/100', etag: '"v1"' }, body: new Uint8Array(4), final: 'redirect' },
      { status: 206, headers: { 'content-range': 'bytes 10-13/100', etag: '"v2"' }, body: new Uint8Array(4), final: 'same' },
    ] as const;
    for (const testCase of cases) {
      const url = new URL('https://maps.example.test/archive.pmtiles');
      const source = new PmtilesRangeSource(url, {
        fetch: async () => ({
          requestedUrl: url,
          finalUrl: testCase.final === 'same' ? url : new URL('https://other.example.test/archive.pmtiles'),
          redirects: testCase.final === 'same' ? [] : [new URL('https://other.example.test/archive.pmtiles')],
          status: testCase.status,
          headers: testCase.headers,
          body: testCase.body,
        }),
      });
      await expect(source.getBytes(10, 4, undefined, '"v1"')).rejects.toThrow();
    }
  });

  it.each([
    ['missing', undefined, undefined],
    ['drifted', '"archive-v2"', undefined],
    ['library-overridden', '"archive-v2"', '"archive-v2"'],
  ] as const)('enforces an approved ETag on the %s range response', async (_case, responseEtag, requestEtag) => {
    const url = new URL('https://maps.example.test/archive.pmtiles');
    const source = new PmtilesRangeSource(url, {
      fetch: async () => ({
        requestedUrl: url,
        finalUrl: url,
        redirects: [],
        status: 206,
        headers: {
          'content-range': 'bytes 0-3/100',
          ...(responseEtag ? { etag: responseEtag } : {}),
        },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
    }, '"archive-v1"');

    await expect(source.getBytes(0, 4, undefined, requestEtag)).rejects.toThrow(/ETag/u);
  });
});
