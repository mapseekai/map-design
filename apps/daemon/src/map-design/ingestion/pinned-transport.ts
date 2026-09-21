import type { LookupFunction } from 'node:net';

import { Agent } from 'undici';
import { PooledPinnedDispatcher } from './pinned-pool.js';
import { decodeResponseBody } from './decoded-body.js';

import { FETCH_LIMITS, type FetchLimit, type FetchPurpose } from './fetch-limits.js';
import {
  resolvePinnedTarget,
  type DnsResolver,
  type PinnedTarget,
} from './network-policy.js';
import { safeErrorMessage } from './redaction.js';

export interface PinnedFetchRequest {
  url: URL;
  purpose: FetchPurpose;
  accept?: readonly string[];
  ifNoneMatch?: string;
  ifModifiedSince?: string;
  range?: { start: number; endInclusive: number };
  signal?: AbortSignal;
}

export interface PinnedFetchResponse {
  requestedUrl: URL;
  finalUrl: URL;
  redirects: readonly URL[];
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export interface PinnedTransport {
  fetch(request: PinnedFetchRequest): Promise<PinnedFetchResponse>;
  close?(): Promise<void>;
}

export interface DestroyableBody extends AsyncIterable<Uint8Array> {
  destroy(error?: Error): void;
}

export interface PinnedDispatchRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly connectTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly bodyTimeoutMs: number;
}

export interface RawPinnedResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: DestroyableBody;
  close?(): Promise<void>;
  destroy?(error: Error): void | Promise<void>;
}

export interface PinnedRequestDispatcher {
  request(target: PinnedTarget, request: PinnedDispatchRequest): Promise<RawPinnedResponse>;
  close?(): Promise<void>;
}

export interface TransportClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface CreatePinnedTransportOptions {
  readonly resolver?: DnsResolver;
  readonly dispatcher?: PinnedRequestDispatcher;
  readonly clock?: TransportClock;
  readonly limits?: Readonly<Partial<Record<FetchPurpose, FetchLimit>>>;
  readonly allowProxyVirtualAddresses?: boolean;
}

export class PinnedTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PinnedTransportError';
  }
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HEADER_VALUE_MAX_LENGTH = 8_192;
const ACCEPT_MAX_VALUES = 16;
const ACCEPT_VALUE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;\s*[^\u0000-\u001f\u007f]+)?$/u;

const systemClock: TransportClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new PinnedTransportError('Upstream request aborted');
}

function assertSafeHeaderValue(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.length > HEADER_VALUE_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new PinnedTransportError(`Invalid ${label} header value`);
  }
}

function buildHeaders(request: PinnedFetchRequest): Readonly<Record<string, string>> {
  const headers: Record<string, string> = { 'accept-encoding': request.range ? 'identity' : 'gzip, deflate, br' };
  if (request.accept !== undefined) {
    if (request.accept.length === 0 || request.accept.length > ACCEPT_MAX_VALUES) {
      throw new PinnedTransportError('Invalid Accept header values');
    }
    for (const value of request.accept) {
      assertSafeHeaderValue(value, 'Accept');
      if (!ACCEPT_VALUE.test(value)) throw new PinnedTransportError('Invalid Accept media type');
    }
    headers.accept = request.accept.join(', ');
  }
  if (request.range !== undefined) {
    const { start, endInclusive } = request.range;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(endInclusive) ||
      start < 0 ||
      endInclusive < start
    ) {
      throw new PinnedTransportError('Invalid byte Range');
    }
    headers.range = `bytes=${start}-${endInclusive}`;
  }
  if (request.ifNoneMatch !== undefined) {
    assertSafeHeaderValue(request.ifNoneMatch, 'If-None-Match');
    headers['if-none-match'] = request.ifNoneMatch;
  }
  if (request.ifModifiedSince !== undefined) {
    assertSafeHeaderValue(request.ifModifiedSince, 'If-Modified-Since');
    headers['if-modified-since'] = request.ifModifiedSince;
  }
  return Object.freeze(headers);
}

function normalizeHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    normalized[name.toLowerCase()] = typeof value === 'string' ? value : [...value].join(', ');
  }
  return Object.freeze(normalized);
}

function effectiveLimit(purpose: FetchPurpose, override: FetchLimit | undefined): FetchLimit {
  const ceiling = FETCH_LIMITS[purpose];
  const clamp = (value: number | undefined, maximum: number): number =>
    value !== undefined && Number.isSafeInteger(value) && value > 0
      ? Math.min(value, maximum)
      : maximum;
  return {
    maxBodyBytes: clamp(override?.maxBodyBytes, ceiling.maxBodyBytes),
    connectTimeoutMs: clamp(override?.connectTimeoutMs, ceiling.connectTimeoutMs),
    headersTimeoutMs: clamp(override?.headersTimeoutMs, ceiling.headersTimeoutMs),
    totalTimeoutMs: clamp(override?.totalTimeoutMs, ceiling.totalTimeoutMs),
  };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function pinnedLookup(target: PinnedTarget): LookupFunction {
  return ((
    _hostname: string,
    options: { all?: boolean },
    callback: (...arguments_: unknown[]) => void,
  ) => {
    if (options.all) {
      callback(null, [{ address: target.address, family: target.family }]);
    } else {
      callback(null, target.address, target.family);
    }
  }) as unknown as LookupFunction;
}

export type PinnedAgentFactory = (options: Agent.Options) => Agent;

export class UndiciPinnedDispatcher implements PinnedRequestDispatcher {
  constructor(
    private readonly createAgent: PinnedAgentFactory = (options) => new Agent(options),
  ) {}

  async request(target: PinnedTarget, request: PinnedDispatchRequest): Promise<RawPinnedResponse> {
    const agent = this.createAgent({
      headersTimeout: request.headersTimeoutMs,
      bodyTimeout: request.bodyTimeoutMs,
      connect: {
        timeout: request.connectTimeoutMs,
        lookup: pinnedLookup(target),
        servername: target.hostname,
      },
    });
    try {
      const response = await agent.request({
        origin: target.url.origin,
        path: `${target.url.pathname}${target.url.search}`,
        method: 'GET',
        headers: request.headers,
        signal: request.signal,
        headersTimeout: request.headersTimeoutMs,
        bodyTimeout: request.bodyTimeoutMs,
      });
      return {
        statusCode: response.statusCode,
        headers: response.headers,
        body: response.body,
        close: async () => agent.close(),
        destroy: async (error) => agent.destroy(error),
      };
    } catch (error) {
      await agent.destroy(error instanceof Error ? error : new Error('Upstream request failed'));
      throw error;
    }
  }
}

async function destroyResponse(response: RawPinnedResponse, error: Error): Promise<void> {
  response.body.destroy(error);
  await response.destroy?.(error);
}

async function readBoundedBody(
  response: RawPinnedResponse,
  maxBodyBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await abortable(Promise.resolve(iterator.next()), signal);
      if (next.done) break;
      if (signal.aborted) throw abortError(signal);
      const chunk = next.value;
      if (chunk.byteLength > maxBodyBytes - length) {
        throw new PinnedTransportError(`Upstream response exceeds ${maxBodyBytes} byte size limit`);
      }
      chunks.push(chunk);
      length += chunk.byteLength;
    }
    if (signal.aborted) throw abortError(signal);
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    await abortable(response.close?.() ?? Promise.resolve(), signal);
    if (signal.aborted) throw abortError(signal);
    return body;
  } catch (error) {
    const reason = error instanceof Error ? error : new Error('Upstream body read failed');
    await destroyResponse(response, reason);
    throw reason;
  }
}

export function createPinnedTransport(options: CreatePinnedTransportOptions = {}): PinnedTransport {
  const resolver = options.resolver;
  const dispatcher = options.dispatcher ?? new PooledPinnedDispatcher();
  const clock = options.clock ?? systemClock;

  return {
    close: async () => { await dispatcher.close?.(); },
    async fetch(request): Promise<PinnedFetchResponse> {
      const requestedUrl = new URL(request.url.href);
      const headers = buildHeaders(request);
      const limit = effectiveLimit(request.purpose, options.limits?.[request.purpose]);
      const controller = new AbortController();
      const startedAt = clock.now();
      const onCallerAbort = () => controller.abort(request.signal?.reason);
      if (request.signal?.aborted) controller.abort(request.signal.reason);
      else request.signal?.addEventListener('abort', onCallerAbort, { once: true });
      const timeout = clock.setTimeout(
        () => controller.abort(new PinnedTransportError('Upstream request total timeout exceeded')),
        limit.totalTimeoutMs,
      );
      const redirects: URL[] = [];
      let currentUrl = requestedUrl;

      try {
        for (;;) {
          if (controller.signal.aborted) throw abortError(controller.signal);
          const target = await abortable(resolvePinnedTarget(currentUrl, resolver, {
            ...(options.allowProxyVirtualAddresses === undefined
              ? {}
              : { allowProxyVirtualAddresses: options.allowProxyVirtualAddresses }),
          }), controller.signal);
          const elapsed = Math.max(0, clock.now() - startedAt);
          const remaining = limit.totalTimeoutMs - elapsed;
          if (remaining <= 0) {
            throw new PinnedTransportError('Upstream request total timeout exceeded');
          }
          const dispatched = dispatcher.request(target, {
            headers,
            signal: controller.signal,
            connectTimeoutMs: limit.connectTimeoutMs,
            headersTimeoutMs: limit.headersTimeoutMs,
            bodyTimeoutMs: remaining,
          });
          void dispatched.then(
            (lateResponse) => {
              if (controller.signal.aborted) {
                void destroyResponse(lateResponse, abortError(controller.signal)).catch(
                  () => undefined,
                );
              }
            },
            () => undefined,
          );
          const headerDeadline = clock.setTimeout(
            () =>
              controller.abort(
                new PinnedTransportError('Upstream response header timeout exceeded'),
              ),
            limit.headersTimeoutMs,
          );
          let response: RawPinnedResponse;
          try {
            response = await abortable(dispatched, controller.signal);
          } finally {
            clock.clearTimeout(headerDeadline);
          }
          const responseHeaders = normalizeHeaders(response.headers);
          if (REDIRECT_STATUSES.has(response.statusCode)) {
            const location = responseHeaders.location;
            if (!location) {
              await destroyResponse(response, new PinnedTransportError('Redirect is missing Location'));
              throw new PinnedTransportError('Redirect is missing Location');
            }
            if (redirects.length >= MAX_REDIRECTS) {
              await destroyResponse(response, new PinnedTransportError('Upstream redirect limit exceeded'));
              throw new PinnedTransportError('Upstream redirect limit exceeded');
            }
            let redirected: URL;
            try {
              redirected = new URL(location, currentUrl);
            } catch (error) {
              const reason = new PinnedTransportError('Redirect Location is invalid', { cause: error });
              await destroyResponse(response, reason);
              throw reason;
            }
            await destroyResponse(response, new PinnedTransportError('Redirect response discarded'));
            currentUrl = redirected;
            redirects.push(new URL(redirected.href));
            continue;
          }

          const wireBody = await readBoundedBody(response, limit.maxBodyBytes, controller.signal);
          const body = await decodeResponseBody(wireBody, responseHeaders['content-encoding'],
            limit.maxBodyBytes, controller.signal, request.range !== undefined);
          let decodedHeaders = responseHeaders;
          if (body !== wireBody) {
            const headers: Record<string, string> = { ...responseHeaders, 'content-length': String(body.byteLength) };
            delete headers['content-encoding'];
            delete headers['content-md5'];
            delete headers.etag;
            decodedHeaders = headers;
          }
          return {
            requestedUrl,
            finalUrl: new URL(currentUrl.href),
            redirects,
            status: response.statusCode,
            headers: decodedHeaders,
            body,
          };
        }
      } catch (error) {
        if (error instanceof PinnedTransportError) throw error;
        throw new PinnedTransportError(`Upstream request failed: ${safeErrorMessage(error)}`, {
          cause: error,
        });
      } finally {
        clock.clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onCallerAbort);
      }
    },
  };
}
