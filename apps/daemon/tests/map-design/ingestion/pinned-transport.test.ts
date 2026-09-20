import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';

import { describe, expect, it, vi } from 'vitest';
import type { Agent } from 'undici';

import { FETCH_LIMITS } from '../../../src/map-design/ingestion/fetch-limits.js';
import {
  createPinnedTransport,
  UndiciPinnedDispatcher,
  type PinnedDispatchRequest,
  type PinnedRequestDispatcher,
  type RawPinnedResponse,
} from '../../../src/map-design/ingestion/pinned-transport.js';
import type { DnsResolver, PinnedTarget } from '../../../src/map-design/ingestion/network-policy.js';

class TestBody implements AsyncIterable<Uint8Array> {
  readonly destroy = vi.fn();

  constructor(private readonly chunks: readonly Uint8Array[]) {}

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (const chunk of this.chunks) yield chunk;
  }
}

class QueueDispatcher implements PinnedRequestDispatcher {
  readonly calls: Array<{ target: PinnedTarget; request: PinnedDispatchRequest }> = [];

  constructor(private readonly responses: RawPinnedResponse[]) {}

  async request(target: PinnedTarget, request: PinnedDispatchRequest): Promise<RawPinnedResponse> {
    this.calls.push({ target, request });
    const response = this.responses.shift();
    if (!response) throw new Error('missing queued response');
    return response;
  }
}

function response(
  statusCode: number,
  body: TestBody,
  headers: Readonly<Record<string, string | readonly string[] | undefined>> = {},
): RawPinnedResponse {
  return { statusCode, headers, body };
}

const publicResolver: DnsResolver = async () => [{ address: '93.184.216.34', family: 4 }];

describe('pinned MapDesign transport', () => {
  it('uses the production Undici dispatcher to reach only the pinned IP and preserve the HTTP authority', async () => {
    let observedHost: string | undefined;
    let observedPath: string | undefined;
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer((request, response_) => {
      observedHost = request.headers.host;
      observedPath = request.url;
      response_.writeHead(200, { 'content-type': 'application/json' });
      response_.end('{}');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const dispatcher = new UndiciPinnedDispatcher();
    try {
      const upstream = await dispatcher.request(
        {
          url: new URL(`http://not-in-dns.invalid:${port}/source?part=1`),
          hostname: 'not-in-dns.invalid',
          address: '127.0.0.1',
          family: 4,
        },
        {
          headers: { accept: 'application/json' },
          signal: new AbortController().signal,
          connectTimeoutMs: 5_000,
          headersTimeoutMs: 10_000,
          bodyTimeoutMs: 15_000,
        },
      );
      const chunks: Uint8Array[] = [];
      for await (const chunk of upstream.body) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString('utf8')).toBe('{}');
      expect(observedHost).toBe(`not-in-dns.invalid:${port}`);
      expect(observedPath).toBe('/source?part=1');
      expect(sockets.size).toBe(1);
      await upstream.close?.();
      if (sockets.size > 0) await Promise.race([...sockets].map((socket) => once(socket, 'close')));
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    }
  });

  it('passes the pinned lookup, address family, TLS name, and connect timeout into its Agent seam', async () => {
    let capturedOptions: Agent.Options | undefined;
    const body = new TestBody([]);
    const agent = {
      request: vi.fn(async () => ({ statusCode: 204, headers: {}, body })),
      close: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
    } as unknown as Agent;
    const dispatcher = new UndiciPinnedDispatcher((options) => {
      capturedOptions = options;
      return agent;
    });
    const target: PinnedTarget = {
      url: new URL('https://origin.example:1/source'),
      hostname: 'origin.example',
      address: '::1',
      family: 6,
    };

    const upstream = await dispatcher.request(target, {
      headers: { accept: 'application/json' },
      signal: new AbortController().signal,
      connectTimeoutMs: 4_321,
      headersTimeoutMs: 5_432,
      bodyTimeoutMs: 6_543,
    });

    const connect = capturedOptions?.connect as
      | { timeout?: number; servername?: string; lookup?: LookupFunction }
      | undefined;
    expect(connect?.timeout).toBe(4_321);
    expect(connect?.servername).toBe('origin.example');
    const lookup = connect?.lookup as unknown as (
      hostname: string,
      options: { all?: boolean },
      callback: (...arguments_: unknown[]) => void,
    ) => void;
    const allResult = await new Promise<unknown[]>((resolve) => {
      lookup('origin.example', { all: true }, (...arguments_) => resolve(arguments_));
    });
    expect(allResult).toEqual([
      null,
      [{ address: '::1', family: 6 }],
    ]);
    const scalarResult = await new Promise<unknown[]>((resolve) => {
      lookup('origin.example', {}, (...arguments_) => resolve(arguments_));
    });
    expect(scalarResult).toEqual([null, '::1', 6]);
    expect(agent.request).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'https://origin.example:1',
        path: '/source',
        headersTimeout: 5_432,
        bodyTimeout: 6_543,
      }),
    );
    await upstream.close?.();
    expect(agent.close).toHaveBeenCalledTimes(1);
    expect(agent.destroy).not.toHaveBeenCalled();
  });

  it('destroys the production Agent when dispatch fails', async () => {
    const dispatchError = new Error('dispatch failed');
    const agent = {
      request: vi.fn(async () => Promise.reject(dispatchError)),
      close: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
    } as unknown as Agent;
    const dispatcher = new UndiciPinnedDispatcher(() => agent);

    await expect(
      dispatcher.request(
        {
          url: new URL('https://origin.example:1/source'),
          hostname: 'origin.example',
          address: '127.0.0.1',
          family: 4,
        },
        {
          headers: {},
          signal: new AbortController().signal,
          connectTimeoutMs: 5_000,
          headersTimeoutMs: 10_000,
          bodyTimeoutMs: 15_000,
        },
      ),
    ).rejects.toBe(dispatchError);
    expect(agent.destroy).toHaveBeenCalledWith(dispatchError);
    expect(agent.close).not.toHaveBeenCalled();
  });

  it('destroys the real Agent socket when production dispatch hits a header error', async () => {
    // Real time is intentional: this exercises Undici's socket/header lifecycle below TransportClock.
    const sockets = new Set<import('node:net').Socket>();
    let markConnected!: () => void;
    const connected = new Promise<void>((resolve) => {
      markConnected = resolve;
    });
    const server = createServer(() => undefined);
    server.on('connection', (socket) => {
      sockets.add(socket);
      markConnected();
      socket.once('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const dispatcher = new UndiciPinnedDispatcher();
    try {
      const pending = dispatcher.request(
        {
          url: new URL(`http://header-timeout.invalid:${port}/stall`),
          hostname: 'header-timeout.invalid',
          address: '127.0.0.1',
          family: 4,
        },
        {
          headers: {},
          signal: new AbortController().signal,
          connectTimeoutMs: 5_000,
          headersTimeoutMs: 25,
          bodyTimeoutMs: 100,
        },
      );
      const rejection = expect(pending).rejects.toThrow(/header/i);
      await connected;
      const [socket] = sockets;
      const peerClosed = socket && !socket.destroyed ? once(socket, 'close') : undefined;
      await rejection;
      await peerClosed;
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    }
  });

  it('constructs only the typed outbound headers and pins the validated address', async () => {
    const body = new TestBody([new TextEncoder().encode('{}')]);
    const dispatcher = new QueueDispatcher([response(200, body)]);
    const transport = createPinnedTransport({ resolver: publicResolver, dispatcher });

    await transport.fetch({
      url: new URL('https://example.com/style.json'),
      purpose: 'document',
      accept: ['application/json', 'application/geo+json'],
      ifNoneMatch: '"v1"',
      ifModifiedSince: 'Wed, 21 Oct 2015 07:28:00 GMT',
      range: { start: 4, endInclusive: 9 },
    });

    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]?.target).toMatchObject({
      hostname: 'example.com',
      address: '93.184.216.34',
      family: 4,
    });
    expect(dispatcher.calls[0]?.request.headers).toEqual({
      accept: 'application/json, application/geo+json',
      range: 'bytes=4-9',
      'if-none-match': '"v1"',
      'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT',
    });
    expect(dispatcher.calls[0]?.request.connectTimeoutMs).toBe(5_000);
    expect(dispatcher.calls[0]?.request.headersTimeoutMs).toBe(10_000);
    expect(Object.keys(dispatcher.calls[0]?.request.headers ?? {})).not.toEqual(
      expect.arrayContaining([
        'host',
        'authorization',
        'cookie',
        'proxy-authorization',
        'forwarded',
        'connection',
        'transfer-encoding',
      ]),
    );
  });

  it('threads the explicit proxy virtual-DNS trust into address pinning', async () => {
    const body = new TestBody([new TextEncoder().encode('{}')]);
    const dispatcher = new QueueDispatcher([response(200, body)]);
    const transport = createPinnedTransport({
      resolver: async () => [{ address: '198.18.0.7', family: 4 }],
      dispatcher,
      allowProxyVirtualAddresses: true,
    });

    await expect(transport.fetch({
      url: new URL('https://tiles.example.com/style.json'),
      purpose: 'document',
    })).resolves.toMatchObject({ status: 200 });
    expect(dispatcher.calls[0]?.target).toMatchObject({
      hostname: 'tiles.example.com',
      address: '198.18.0.7',
      family: 4,
    });
  });

  it.each([
    { range: { start: -1, endInclusive: 1 } },
    { range: { start: 2, endInclusive: 1 } },
    { accept: ['application/json\r\nAuthorization: secret'] },
    { ifNoneMatch: 'ok\r\nCookie: secret' },
    { ifModifiedSince: 'ok\nForwarded: for=127.0.0.1' },
  ])('rejects malformed typed header input %#', async (partial) => {
    const dispatcher = new QueueDispatcher([]);
    const transport = createPinnedTransport({ resolver: publicResolver, dispatcher });
    await expect(
      transport.fetch({
        url: new URL('https://example.com/source'),
        purpose: 'document',
        ...partial,
      }),
    ).rejects.toThrow();
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('manually follows at most five redirects and records each validated URL', async () => {
    const dispatcher = new QueueDispatcher([
      response(302, new TestBody([]), { location: '/two' }),
      response(307, new TestBody([]), { location: 'https://cdn.example.com/three' }),
      response(200, new TestBody([new Uint8Array([7])]), { 'content-type': 'application/octet-stream' }),
    ]);
    const resolvedHosts: string[] = [];
    const transport = createPinnedTransport({
      resolver: async (hostname) => {
        resolvedHosts.push(hostname);
        return [{ address: hostname === 'cdn.example.com' ? '1.1.1.1' : '93.184.216.34', family: 4 }];
      },
      dispatcher,
    });

    await expect(
      transport.fetch({ url: new URL('https://example.com/one'), purpose: 'resource' }),
    ).resolves.toMatchObject({
      finalUrl: new URL('https://cdn.example.com/three'),
      redirects: [new URL('https://example.com/two'), new URL('https://cdn.example.com/three')],
      status: 200,
      body: new Uint8Array([7]),
    });
    expect(resolvedHosts).toEqual(['example.com', 'example.com', 'cdn.example.com']);
  });

  it('rejects redirect credentials and fragments before another request is dispatched', async () => {
    for (const location of ['https://user@other.example/secret', 'https://other.example/a#fragment']) {
      const dispatcher = new QueueDispatcher([response(302, new TestBody([]), { location })]);
      const transport = createPinnedTransport({ resolver: publicResolver, dispatcher });
      await expect(
        transport.fetch({ url: new URL('https://example.com/one'), purpose: 'document' }),
      ).rejects.toThrow();
      expect(dispatcher.calls).toHaveLength(1);
    }
  });

  it('rejects a sixth redirect', async () => {
    const dispatcher = new QueueDispatcher(
      Array.from({ length: 6 }, (_, index) =>
        response(302, new TestBody([]), { location: `/redirect-${index + 1}` }),
      ),
    );
    const transport = createPinnedTransport({ resolver: publicResolver, dispatcher });
    await expect(
      transport.fetch({ url: new URL('https://example.com/start'), purpose: 'document' }),
    ).rejects.toThrow(/redirect/i);
    expect(dispatcher.calls).toHaveLength(6);
  });

  it('blocks DNS rebinding on a redirect hop when any new answer becomes private', async () => {
    let resolution = 0;
    const dispatcher = new QueueDispatcher([
      response(302, new TestBody([]), { location: 'https://example.com/next' }),
    ]);
    const transport = createPinnedTransport({
      resolver: async () => {
        resolution += 1;
        return resolution === 1
          ? [{ address: '93.184.216.34', family: 4 }]
          : [
              { address: '93.184.216.34', family: 4 },
              { address: '127.0.0.1', family: 4 },
            ];
      },
      dispatcher,
    });

    await expect(
      transport.fetch({ url: new URL('https://example.com/start'), purpose: 'document' }),
    ).rejects.toThrow(/forbidden/i);
    expect(dispatcher.calls).toHaveLength(1);
  });

  it.each([
    ['document', 5 * 1024 * 1024],
    ['pmtiles-range', 1 * 1024 * 1024],
    ['tile', 20 * 1024 * 1024],
    ['glyph', 20 * 1024 * 1024],
    ['sprite', 20 * 1024 * 1024],
    ['resource', 20 * 1024 * 1024],
  ] as const)('destroys a streamed %s response immediately after it exceeds %i bytes', async (purpose, limit) => {
    const body = new TestBody([new Uint8Array(limit), new Uint8Array([1])]);
    const dispatcher = new QueueDispatcher([response(200, body)]);
    const transport = createPinnedTransport({ resolver: publicResolver, dispatcher });

    await expect(
      transport.fetch({ url: new URL('https://example.com/data'), purpose }),
    ).rejects.toThrow(/size|large|limit/i);
    expect(body.destroy).toHaveBeenCalledTimes(1);
    expect(FETCH_LIMITS[purpose].maxBodyBytes).toBe(limit);
  });

  it('does not allow injected purpose limits to relax the security ceilings', async () => {
    const body = new TestBody([new Uint8Array(5 * 1024 * 1024 + 1)]);
    const dispatcher = new QueueDispatcher([response(200, body)]);
    const transport = createPinnedTransport({
      resolver: publicResolver,
      dispatcher,
      limits: {
        document: {
          maxBodyBytes: 6 * 1024 * 1024,
          connectTimeoutMs: 6_000,
          headersTimeoutMs: 11_000,
          totalTimeoutMs: 31_000,
        },
      },
    });

    await expect(
      transport.fetch({ url: new URL('https://example.com/style.json'), purpose: 'document' }),
    ).rejects.toThrow(/size|large|limit/i);
    expect(dispatcher.calls[0]?.request.connectTimeoutMs).toBe(5_000);
    expect(dispatcher.calls[0]?.request.headersTimeoutMs).toBe(10_000);
    expect(dispatcher.calls[0]?.request.bodyTimeoutMs).toBeLessThanOrEqual(30_000);
  });

  it('aborts the request and destroys an obtained upstream body at the total deadline', async () => {
    vi.useFakeTimers();
    try {
      const body = new TestBody([]);
      const dispatcher: PinnedRequestDispatcher = {
        request: vi.fn(async (_target, request) => {
          await new Promise<void>((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
          });
          return response(200, body);
        }),
      };
      const transport = createPinnedTransport({ resolver: publicResolver, dispatcher });
      const pending = transport.fetch({
        url: new URL('https://example.com/style.json'),
        purpose: 'document',
      });
      const rejection = expect(pending).rejects.toThrow(/timeout/i);
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces the ten-second header deadline even when an injected dispatcher ignores it', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    try {
      const dispatcher: PinnedRequestDispatcher = {
        request: vi.fn(async () => new Promise<RawPinnedResponse>(() => undefined)),
      };
      const transport = createPinnedTransport({ resolver: publicResolver, dispatcher });
      let rejection: unknown;
      const pending = transport
        .fetch({
          url: new URL('https://example.com/style.json'),
          purpose: 'document',
          signal: caller.signal,
        })
        .catch((error: unknown) => {
          rejection = error;
        });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toMatch(/header.*timeout/i);
      await pending;
    } finally {
      caller.abort(new Error('test cleanup'));
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('aborts and destroys a body that stalls between streamed chunks at the total deadline', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const body = new TestBody([]);
    body[Symbol.asyncIterator] = async function* () {
      yield new Uint8Array([1]);
      markStarted();
      await stalled;
      yield new Uint8Array([2]);
    };
    try {
      const transport = createPinnedTransport({
        resolver: publicResolver,
        dispatcher: new QueueDispatcher([response(200, body)]),
      });
      let rejection: unknown;
      const pending = transport
        .fetch({ url: new URL('https://example.com/style.json'), purpose: 'document' })
        .catch((error: unknown) => {
          rejection = error;
        });
      await started;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toMatch(/total timeout/i);
      expect(body.destroy).toHaveBeenCalledTimes(1);
      await pending;
    } finally {
      release();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('propagates caller abort and destroys a body while it is streaming', async () => {
    const controller = new AbortController();
    let releaseChunk!: () => void;
    let markStarted!: () => void;
    const waiting = new Promise<void>((resolve) => {
      releaseChunk = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const body = new TestBody([]);
    body[Symbol.asyncIterator] = async function* () {
      yield new Uint8Array([1]);
      markStarted();
      await waiting;
      yield new Uint8Array([2]);
    };
    const transport = createPinnedTransport({
      resolver: publicResolver,
      dispatcher: new QueueDispatcher([response(200, body)]),
    });
    const pending = transport.fetch({
      url: new URL('https://example.com/style.json'),
      purpose: 'document',
      signal: controller.signal,
    });
    await started;
    controller.abort(new Error('caller stopped'));
    releaseChunk();
    await expect(pending).rejects.toThrow(/caller stopped|abort/i);
    expect(body.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects caller abort while closing a successfully read response', async () => {
    const caller = new AbortController();
    const body = new TestBody([new Uint8Array([1])]);
    let markCloseStarted!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    let releaseClose!: () => void;
    const mayClose = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const upstream = response(200, body);
    upstream.close = vi.fn(async () => {
      markCloseStarted();
      await mayClose;
    });
    upstream.destroy = vi.fn();
    const transport = createPinnedTransport({
      resolver: publicResolver,
      dispatcher: new QueueDispatcher([upstream]),
    });

    const pending = transport.fetch({
      url: new URL('https://example.com/style.json'),
      purpose: 'document',
      signal: caller.signal,
    });
    const rejection = expect(pending).rejects.toThrow(/caller stopped while closing|abort/i);
    await closeStarted;
    caller.abort(new Error('caller stopped while closing'));
    releaseClose();

    await rejection;
    expect(body.destroy).toHaveBeenCalledTimes(1);
    expect(upstream.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects the total deadline while closing a successfully read response', async () => {
    vi.useFakeTimers();
    const body = new TestBody([new Uint8Array([1])]);
    let markCloseStarted!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    let releaseClose!: () => void;
    const mayClose = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const upstream = response(200, body);
    upstream.close = vi.fn(async () => {
      markCloseStarted();
      await mayClose;
    });
    upstream.destroy = vi.fn();
    try {
      const transport = createPinnedTransport({
        resolver: publicResolver,
        dispatcher: new QueueDispatcher([upstream]),
      });
      const pending = transport.fetch({
        url: new URL('https://example.com/style.json'),
        purpose: 'document',
      });
      const rejection = expect(pending).rejects.toThrow(/total timeout/i);
      await closeStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      releaseClose();

      await rejection;
      expect(body.destroy).toHaveBeenCalledTimes(1);
      expect(upstream.destroy).toHaveBeenCalledTimes(1);
    } finally {
      releaseClose();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('destroys a body returned late by a dispatcher after abort', async () => {
    const controller = new AbortController();
    const body = new TestBody([]);
    let returnResponse!: () => void;
    const mayReturn = new Promise<void>((resolve) => {
      returnResponse = resolve;
    });
    let dispatchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const dispatcher: PinnedRequestDispatcher = {
      request: vi.fn(async () => {
        dispatchStarted();
        await mayReturn;
        return response(200, body);
      }),
    };
    const transport = createPinnedTransport({ resolver: publicResolver, dispatcher });
    const pending = transport.fetch({
      url: new URL('https://example.com/style.json'),
      purpose: 'document',
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toThrow(/caller stopped|abort/i);
    await started;
    controller.abort(new Error('caller stopped'));
    returnResponse();
    await rejection;
    await Promise.resolve();
    expect(body.destroy).toHaveBeenCalledTimes(1);
  });
});
