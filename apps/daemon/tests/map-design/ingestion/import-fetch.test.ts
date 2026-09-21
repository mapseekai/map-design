import { describe, expect, it, vi } from 'vitest';
import { fetchImportResource, ImportHttpError, importHttpFailure } from '../../../src/map-design/ingestion/import-fetch.js';
import type { PinnedFetchRequest, PinnedFetchResponse } from '../../../src/map-design/ingestion/pinned-transport.js';

const url = new URL('https://maps.example.test/style.json');
function response(status: number, headers: Record<string, string> = {}): PinnedFetchResponse {
  return { requestedUrl: url, finalUrl: url, redirects: [], status, headers, body: new Uint8Array() };
}
const request: PinnedFetchRequest = { url, purpose: 'document', accept: ['application/json'] };

describe('bounded map import HTTP retries', () => {
  it('retries a transient 429 without changing the URL, headers or byte range', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(429, { 'retry-after': '1' })).mockResolvedValueOnce(response(206));
    const range = { start: 0, endInclusive: 7 };
    const started = Date.now();
    expect((await fetchImportResource({ fetch }, { ...request, purpose: 'pmtiles-range', range })).status).toBe(206);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0]).toMatchObject({ url, range, accept: ['application/json'], purpose: 'pmtiles-range' });
    expect(fetch.mock.calls[0]![0].signal).toBe(fetch.mock.calls[1]![0].signal);
  });

  it('returns the final upstream status after at most two retries', async () => {
    const fetch = vi.fn().mockResolvedValue(response(503));
    expect((await fetchImportResource({ fetch }, request)).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(['60', new Date(Date.now() + 120_000).toUTCString()])('does not ignore Retry-After beyond the request budget: %s', async (value) => {
    const fetch = vi.fn().mockResolvedValue(response(429, { 'retry-after': value }));
    expect((await fetchImportResource({ fetch }, request)).status).toBe(429);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([200, 206, 400, 401, 403, 404, 416])('does not retry HTTP %s', async (status) => {
    const fetch = vi.fn().mockResolvedValue(response(status));
    expect((await fetchImportResource({ fetch }, request)).status).toBe(status);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('cancels backoff without another network request', async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(response(429));
    const pending = fetchImportResource({ fetch }, { ...request, signal: controller.signal });
    const result = expect(pending).rejects.toThrow();
    await Promise.resolve();
    controller.abort();
    await result;
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('never retries transport or network-policy exceptions', async () => {
    const error = new Error('DNS returned a forbidden private address');
    const fetch = vi.fn().mockRejectedValue(error);
    await expect(fetchImportResource({ fetch }, request)).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('classifies only safe, typed HTTP failures', () => {
    expect(importHttpFailure(new ImportHttpError(429, 'source'))).toMatchObject({ code: 'IMPORT_RATE_LIMITED' });
    expect(importHttpFailure(new ImportHttpError(403, 'source-metadata'))).toEqual({
      code: 'IMPORT_HTTP_FAILED', message: 'The remote map service returned HTTP 403 during source-metadata download.',
    });
    expect(importHttpFailure(new Error('upstream credentials or response body'))).toBeNull();
  });
});
