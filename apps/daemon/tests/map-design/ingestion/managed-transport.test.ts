import { describe, it, expect, vi } from 'vitest';
import { createManagedTransport } from '../../../src/map-design/ingestion/managed-transport.js';
import type { PinnedFetchRequest, PinnedFetchResponse } from '../../../src/map-design/ingestion/pinned-transport.js';
const request: PinnedFetchRequest = { url: new URL('https://tiles.example.test/a'), purpose: 'tile' };
function response(input: PinnedFetchRequest, headers: Record<string, string> = {}): PinnedFetchResponse {
  return { requestedUrl: input.url, finalUrl: input.url, redirects: [], status: 200, headers, body: Uint8Array.of(1, 2, 3) };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('managed map transport', () => {
  it('coalesces equal requests and isolates cancellation and mutable result bytes', async () => {
    let release!: () => void; let signal!: AbortSignal;
    const fetch = vi.fn(async (input: PinnedFetchRequest) => { signal = input.signal!; await new Promise<void>((resolve) => { release = resolve; }); return response(input); });
    const managed = createManagedTransport({ fetch });
    const controller = new AbortController();
    const first = managed.fetch({ ...request, signal: controller.signal }); const rejected = expect(first).rejects.toThrow();
    const second = managed.fetch(request); const third = managed.fetch(request);
    await tick(); controller.abort(); await rejected;
    expect(signal.aborted).toBe(false); expect(fetch).toHaveBeenCalledOnce(); release();
    const [left, right] = await Promise.all([second, third]); left.body[0] = 99;
    expect(right.body[0]).toBe(1); await managed.close?.();
  });
  it('cancels the actual request after every subscriber leaves', async () => {
    const fetch = vi.fn((input: PinnedFetchRequest) => new Promise<PinnedFetchResponse>((_resolve, reject) => {
      input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true });
    }));
    const managed = createManagedTransport({ fetch }); const controller = new AbortController();
    const task = managed.fetch({ ...request, signal: controller.signal }); const rejected = expect(task).rejects.toThrow();
    await tick(); controller.abort(); await rejected;
    expect(fetch.mock.calls[0]![0].signal!.aborted).toBe(true); await managed.close?.();
  });
  it('respects explicit freshness, cache size, conditional requests and no-store', async () => {
    let now = 10000;
    const fetch = vi.fn(async (input: PinnedFetchRequest) => response(input, { 'cache-control': input.url.pathname === '/secret' ? 'no-store' : 'max-age=10' }));
    const managed = createManagedTransport({ fetch }, { now: () => now, maxCacheEntries: 1 });
    await managed.fetch(request); await managed.fetch(request); expect(fetch).toHaveBeenCalledTimes(1);
    await managed.fetch({ ...request, ifNoneMatch: '"old"' }); expect(fetch).toHaveBeenCalledTimes(2);
    now += 10001; await managed.fetch(request); expect(fetch).toHaveBeenCalledTimes(3);
    const other = { ...request, url: new URL('https://tiles.example.test/b') };
    await managed.fetch(other); await managed.fetch(request); expect(fetch).toHaveBeenCalledTimes(5);
    const secret = { ...request, url: new URL('https://tiles.example.test/secret') };
    await managed.fetch(secret); await managed.fetch(secret); expect(fetch).toHaveBeenCalledTimes(7); await managed.close?.();
  });
  it('never assumes unchanged data is fresh without cache headers', async () => {
    const fetch = vi.fn(async (input: PinnedFetchRequest) => response(input)); const managed = createManagedTransport({ fetch });
    await managed.fetch(request); await managed.fetch(request); expect(fetch).toHaveBeenCalledTimes(2); await managed.close?.();
  });
  it('limits per-host concurrency and aborts queued requests without dispatch', async () => {
    const releases: Array<() => void> = []; let running = 0; let peak = 0;
    const fetch = vi.fn(async (input: PinnedFetchRequest) => { running++; peak = Math.max(peak, running);
      await new Promise<void>((resolve) => releases.push(resolve)); running--; return response(input); });
    const managed = createManagedTransport({ fetch }, { maxPerHost: 1, maxConcurrent: 2 });
    const one = managed.fetch(request); const controller = new AbortController();
    const two = managed.fetch({ ...request, url: new URL('https://tiles.example.test/b'), signal: controller.signal });
    const rejected = expect(two).rejects.toThrow(); await tick(); controller.abort(); await rejected;
    expect(fetch).toHaveBeenCalledOnce(); releases[0]!(); await one; expect(peak).toBe(1); await managed.close?.();
  });
});
