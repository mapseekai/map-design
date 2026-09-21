import type { PinnedFetchRequest, PinnedFetchResponse, PinnedTransport } from './pinned-transport.js';

type Flight = { controller: AbortController; promise: Promise<PinnedFetchResponse>; users: number; settled: boolean };
type Queued = { host: string; signal: AbortSignal; start(): void; cancel(): void };
type Cached = { response: PinnedFetchResponse; expires: number; bytes: number };
export interface ManagedTransportOptions {
  maxConcurrent?: number; maxPerHost?: number; maxQueued?: number;
  maxCacheBytes?: number; maxCacheEntries?: number; maxCacheAgeMs?: number;
  now?: () => number;
}

/** Bounded scheduling and single-flight sharing; one canceled subscriber cannot cancel the others. */
export function createManagedTransport(inner: PinnedTransport, options: ManagedTransportOptions = {}): PinnedTransport {
  const limit = options.maxConcurrent ?? 24; const perHost = options.maxPerHost ?? 6;
  const maxQueued = options.maxQueued ?? 128; const maxBytes = options.maxCacheBytes ?? 32 * 1024 * 1024;
  const maxEntries = options.maxCacheEntries ?? 256; const maxAge = options.maxCacheAgeMs ?? 60_000;
  const now = options.now ?? Date.now;
  const flights = new Map<string, Flight>(); const cache = new Map<string, Cached>();
  const hosts = new Map<string, number>(); const queue: Queued[] = [];
  let active = 0; let cacheBytes = 0; let closed = false;
  const erase = (key: string) => { const entry = cache.get(key); if (entry) cacheBytes -= entry.bytes; cache.delete(key); };
  const pump = () => {
    while (!closed && active < limit) {
      const index = queue.findIndex((entry) => (hosts.get(entry.host) ?? 0) < perHost);
      if (index < 0) break;
      const entry = queue.splice(index, 1)[0]!;
      entry.signal.removeEventListener('abort', entry.cancel);
      if (entry.signal.aborted) { entry.cancel(); continue; }
      active++; hosts.set(entry.host, (hosts.get(entry.host) ?? 0) + 1); entry.start();
    }
  };
  const schedule = (request: PinnedFetchRequest, signal: AbortSignal): Promise<PinnedFetchResponse> => new Promise((resolve, reject) => {
    if (closed || signal.aborted) { reject(signal.reason ?? new Error('Map transport closed')); return; }
    if (queue.length >= maxQueued) { reject(new Error('Map request queue is full')); return; }
    const host = request.url.origin;
    const entry: Queued = { host, signal,
      cancel() { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); reject(signal.reason ?? new Error('Canceled')); },
      start() {
        void Promise.resolve().then(() => inner.fetch({ ...request, signal })).then(resolve, reject).finally(() => {
          active--; const count = (hosts.get(host) ?? 1) - 1;
          if (count) hosts.set(host, count); else hosts.delete(host);
          pump();
        });
      },
    };
    signal.addEventListener('abort', entry.cancel, { once: true }); queue.push(entry); pump();
  });
  return {
    async fetch(request) {
      request.signal?.throwIfAborted();
      if (closed) throw new Error('Map transport closed');
      const key = JSON.stringify([request.url.href, request.purpose, request.accept,
        request.range, request.ifNoneMatch, request.ifModifiedSince]);
      for (const [key_, value] of cache) if (value.expires <= now()) erase(key_);
      const cached = cache.get(key);
      if (cached) { cache.delete(key); cache.set(key, cached); return copyResponse(cached.response); }
      let flight = flights.get(key);
      if (!flight || flight.controller.signal.aborted) {
        const controller = new AbortController();
        const current: Flight = { controller, users: 0, settled: false, promise: Promise.resolve(null as never) };
        current.promise = schedule(request, controller.signal).then((response) => {
          const age = request.range || request.ifNoneMatch || request.ifModifiedSince ? 0 : freshness(response, now(), maxAge);
          if (!controller.signal.aborted && age > 0 && response.body.byteLength <= maxBytes) {
            erase(key);
            const bytes = response.body.byteLength + JSON.stringify(response.headers).length + key.length;
            while (cache.size && (cache.size >= maxEntries || cacheBytes + bytes > maxBytes)) erase(cache.keys().next().value!);
            if (bytes <= maxBytes && maxEntries > 0) {
              cache.set(key, { response: copyResponse(response), expires: now() + age, bytes }); cacheBytes += bytes;
            }
          }
          return response;
        });
        flights.set(key, current);
        const finish = () => { current.settled = true; if (flights.get(key) === current) flights.delete(key); };
        void current.promise.then(finish, finish); flight = current;
      }
      return subscribe(flight, request.signal);
    },
    async close() {
      closed = true;
      for (const entry of flights.values()) entry.controller.abort(new Error('Map transport closed'));
      flights.clear(); cache.clear(); cacheBytes = 0;
      await inner.close?.();
    },
  };
}

function subscribe(flight: Flight, signal?: AbortSignal): Promise<PinnedFetchResponse> {
  flight.users++;
  return new Promise((resolve, reject) => {
    let done = false;
    const release = () => {
      if (done) return false;
      done = true; signal?.removeEventListener('abort', abort);
      if (--flight.users === 0 && !flight.settled) flight.controller.abort(new Error('No map request subscribers'));
      return true;
    };
    const abort = () => { if (release()) reject(signal?.reason ?? new Error('Canceled')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    void flight.promise.then((response) => { if (release()) resolve(copyResponse(response)); }, (error) => { if (release()) reject(error); });
  });
}

function copyResponse(response: PinnedFetchResponse): PinnedFetchResponse {
  return { ...response, requestedUrl: new URL(response.requestedUrl.href), finalUrl: new URL(response.finalUrl.href),
    redirects: response.redirects.map((url) => new URL(url.href)), headers: { ...response.headers }, body: response.body.slice() };
}

function freshness(response: PinnedFetchResponse, now: number, maximum: number): number {
  if (response.status !== 200) return 0;
  const policy = response.headers['cache-control'] ?? '';
  if (/(?:^|,)\s*(?:no-store|no-cache)\b/iu.test(policy) || response.headers['set-cookie']) return 0;
  const vary = response.headers.vary?.toLowerCase().split(',').map((part) => part.trim()) ?? [];
  if (vary.some((value) => value !== 'accept' && value !== 'accept-encoding')) return 0;
  const seconds = policy.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)/iu)?.[1];
  if (!seconds) return 0;
  const originDate = Date.parse(response.headers.date ?? '');
  const age = Math.max(Number(response.headers.age ?? 0) * 1000, Number.isFinite(originDate) ? now - originDate : 0);
  const remaining = Number(seconds) * 1000 - age;
  return Number.isFinite(remaining) ? Math.max(0, Math.min(maximum, remaining)) : 0;
}
