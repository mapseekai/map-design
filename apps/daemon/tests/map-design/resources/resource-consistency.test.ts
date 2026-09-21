import { describe, it, expect, vi } from 'vitest';
import { createMapDesignResourceServiceFromLookup, type MapDesignResolvedResource } from '../../../src/map-design/resources/resource-service.js';
import type { PinnedFetchRequest, PinnedFetchResponse } from '../../../src/map-design/ingestion/pinned-transport.js';
const resource: MapDesignResolvedResource = { ownerId: 'p', resourceId: 'r', kind: 'geojson', mode: 'remote',
  mediaType: 'application/geo+json', byteLength: null, contentDigest: null, sourceUrl: 'https://maps.example.test/data', etag: null };
function service(fetch: (request: PinnedFetchRequest) => Promise<PinnedFetchResponse>) {
  return createMapDesignResourceServiceFromLookup({ lookup: { find: () => resource, readCaptured: async () => { throw new Error('not captured'); } }, transport: { fetch } });
}
function response(request: PinnedFetchRequest, version: number, status = 200, headers: Record<string, string> = {}): PinnedFetchResponse {
  return { requestedUrl: request.url, finalUrl: request.url, redirects: [], status, headers, body: new TextEncoder().encode(JSON.stringify({ version })) };
}
describe('runtime resource consistency', () => {
  it('changes the fallback ETag when upstream bytes change at the same URL', async () => {
    let version = 1; const resources = service(async (request) => response(request, version));
    const first = await resources.getResource('p', 'r', ['data.geojson']); version = 2;
    const second = await resources.getResource('p', 'r', ['data.geojson']);
    expect(first.etag).not.toBe(second.etag);
    expect((await resources.getResource('p', 'r', ['data.geojson'])).etag).toBe(second.etag);
  });
  it('recovers from one transient runtime resource 429', async () => {
    let calls = 0; const fetch = vi.fn(async (request: PinnedFetchRequest) => response(request, 1, ++calls === 1 ? 429 : 200));
    const result = await service(fetch).getResource('p', 'r', ['data.geojson']);
    expect(result.bytes.byteLength).toBeGreaterThan(0); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('preserves a prolonged 429 and Retry-After without violating the delay', async () => {
    const fetch = vi.fn(async (request: PinnedFetchRequest) => response(request, 1, 429, { 'retry-after': '120' }));
    await expect(service(fetch).getResource('p', 'r', ['data.geojson'])).rejects.toMatchObject({ status: 429, retryAfter: '120' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not retry missing resources', async () => {
    const fetch = vi.fn(async (request: PinnedFetchRequest) => response(request, 1, 404));
    await expect(service(fetch).getResource('p', 'r', ['data.geojson'])).rejects.toMatchObject({ status: 404 });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
