import {required} from './required.js';

import {EventEmitter} from 'node:events';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import type {AddressInfo} from 'node:net';
import {gzipSync} from 'node:zlib';

import {create} from '@mapbox/mvt-fixtures';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const transportMocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  httpRequest: vi.fn(),
  httpsRequest: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({lookup: transportMocks.lookup}));
vi.mock('node:http', () => ({request: transportMocks.httpRequest}));
vi.mock('node:https', () => ({request: transportMocks.httpsRequest}));

import {
  sampleTiles,
  tileCandidates,
  type SamplerOptions,
  type TileFetcher,
} from '../src/sampling.js';
import {stableJson} from '../src/stable-json.js';

function options(overrides: Partial<SamplerOptions> = {}): SamplerOptions {
  return {
    template: 'https://tiles.example/{z}/{x}/{y}.pbf',
    bounds: [-180, -85, 180, 85],
    zooms: [4, 5],
    concurrency: 4,
    maxRequests: 40,
    maxNonEmpty: 30,
    stableStop: 8,
    timeoutMs: 10_000,
    retries: 2,
    maxResponseBytes: 5 * 1024 * 1024,
    maxTotalBytes: 50 * 1024 * 1024,
    allowPrivateNetwork: false,
    ...overrides,
  };
}

function pointTile(layerName = 'places'): Uint8Array {
  return create({
    layers: [
      {
        version: 2,
        name: layerName,
        keys: ['name'],
        values: [{string_value: 'Harbor'}],
        extent: 4096,
        features: [{id: 1, tags: [0, 0], type: 1, geometry: [9, 50, 34]}],
      },
    ],
  }).buffer;
}

function unsafeIntegerTile(): Uint8Array {
  return create({
    layers: [
      {
        version: 2,
        name: 'unsafe',
        keys: ['value'],
        values: [{uint_value: Number.MAX_SAFE_INTEGER + 1}],
        extent: 4096,
        features: [{tags: [0, 0], type: 1, geometry: [9, 50, 34]}],
      },
    ],
  }).buffer;
}

interface FakeResponse {
  stream: Readable & {statusCode: number; headers: Record<string, string>};
  destroySpy: ReturnType<typeof vi.fn>;
}

function fakeResponse(
  statusCode: number,
  headers: Record<string, string> = {},
  body: Uint8Array = new Uint8Array(),
): FakeResponse {
  let sent = false;
  const stream = new Readable({
    read() {
      if (sent) return;
      sent = true;
      if (body.byteLength > 0) this.push(body);
      this.push(null);
    },
  }) as FakeResponse['stream'];
  stream.statusCode = statusCode;
  stream.headers = headers;
  const originalDestroy = stream.destroy.bind(stream);
  const destroySpy = vi.fn((error?: Error) => originalDestroy(error));
  stream.destroy = destroySpy as typeof stream.destroy;
  return {stream, destroySpy};
}

function installHttpResponses(responses: FakeResponse[], lookupAll = false): {
  pinnedAddresses: string[];
  requestedHosts: string[];
  servernames: Array<string | undefined>;
  agents: unknown[];
} {
  const queue = [...responses];
  const pinnedAddresses: string[] = [];
  const requestedHosts: string[] = [];
  const servernames: Array<string | undefined> = [];
  const agents: unknown[] = [];
  const request = vi.fn(
    (
      input: URL,
      requestOptions: Record<string, unknown>,
      callback: (response: FakeResponse['stream']) => void,
    ) => {
      const response = queue.shift();
      if (!response) throw new Error('Unexpected outbound request.');
      requestedHosts.push(input.hostname);
      servernames.push(
        typeof requestOptions.servername === 'string' ? requestOptions.servername : undefined,
      );
      agents.push(requestOptions.agent);
      const requestEmitter = new EventEmitter() as EventEmitter & {
        end(): void;
        destroy(error?: Error): void;
      };
      requestEmitter.destroy = (error?: Error) => {
        if (error) requestEmitter.emit('error', error);
      };
      requestEmitter.end = () => {
        const pinnedLookup = requestOptions.lookup as
          | ((
              hostname: string,
              options: Record<string, unknown>,
              callback: (
                error: Error | null,
                address: string | Array<{address: string; family: number}>,
                family?: number,
              ) => void,
            ) => void)
          | undefined;
        if (!pinnedLookup) {
          queueMicrotask(() => callback(response.stream));
          return;
        }
        pinnedLookup(input.hostname, {all: lookupAll}, (error, address) => {
          if (error) {
            requestEmitter.emit('error', error);
            return;
          }
          if (lookupAll) {
            if (!Array.isArray(address) || address.length !== 1) {
              requestEmitter.emit('error', new TypeError('ERR_INVALID_IP_ADDRESS'));
              return;
            }
            pinnedAddresses.push(address[0]!.address);
          } else {
            if (typeof address !== 'string') {
              requestEmitter.emit('error', new TypeError('ERR_INVALID_IP_ADDRESS'));
              return;
            }
            pinnedAddresses.push(address);
          }
          callback(response.stream);
        });
      };
      return requestEmitter;
    },
  );
  transportMocks.httpRequest.mockImplementation(request);
  transportMocks.httpsRequest.mockImplementation(request);
  return {pinnedAddresses, requestedHosts, servernames, agents};
}

beforeEach(() => {
  transportMocks.lookup.mockReset();
  transportMocks.httpRequest.mockReset();
  transportMocks.httpsRequest.mockReset();
  transportMocks.lookup.mockResolvedValue([{address: '93.184.216.34', family: 4}]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Global fetch must not perform the verified connection.');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tileCandidates', () => {
  it('sorts zooms and coordinates while removing duplicate center, corner, and quarter tiles', () => {
    expect(tileCandidates([-180, -85, 180, 85], [1, 0, 1])).toEqual([
      {z: 0, x: 0, y: 0},
      {z: 1, x: 0, y: 0},
      {z: 1, x: 0, y: 1},
      {z: 1, x: 1, y: 0},
      {z: 1, x: 1, y: 1},
    ]);
  });

  it('keeps center, four corners, and four quarter points distinct at high zoom', () => {
    expect(tileCandidates([-10, 40, 10, 50], [14])).toEqual([
      {z: 14, x: 7736, y: 5556},
      {z: 14, x: 7736, y: 6202},
      {z: 14, x: 7964, y: 5729},
      {z: 14, x: 7964, y: 6051},
      {z: 14, x: 8192, y: 5893},
      {z: 14, x: 8419, y: 5729},
      {z: 14, x: 8419, y: 6051},
      {z: 14, x: 8647, y: 5556},
      {z: 14, x: 8647, y: 6202},
    ]);
  });
});

describe('sampleTiles', () => {
  it('never exceeds the configured fetch concurrency', async () => {
    let active = 0;
    let peak = 0;
    const fetcher: TileFetcher = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return new Uint8Array();
    };

    const result = await sampleTiles(options({maxRequests: 12, retries: 0}), fetcher);

    expect(peak).toBe(4);
    expect(result.summary.requested).toBe(12);
    expect(result.summary.stopReason).toBe('budget-exhausted');
  });

  it('performs only the initial attempt plus two configured retries', async () => {
    let attempts = 0;
    const fetcher: TileFetcher = async () => {
      attempts += 1;
      throw new Error('temporary failure');
    };

    const result = await sampleTiles(
      options({bounds: [0, 0, 0, 0], zooms: [0], maxRequests: 20}),
      fetcher,
    );

    expect(attempts).toBe(3);
    expect(result.summary).toMatchObject({requested: 3, failed: 1});
    expect(result.unresolved.map((item) => item.code)).toEqual(['tile-fetch-failed']);
    expect(result.summary.stopReason).toBe('candidates-exhausted');
  });

  it('counts retry attempts against maxRequests and never retries forever', async () => {
    let attempts = 0;
    const fetcher: TileFetcher = async () => {
      attempts += 1;
      throw new Error('still unavailable');
    };

    const result = await sampleTiles(options({maxRequests: 5, retries: 20}), fetcher);

    expect(attempts).toBe(5);
    expect(result.summary.requested).toBe(5);
    expect(result.summary.stopReason).toBe('budget-exhausted');
  });

  it('reports candidates exhausted when the final successful candidate exactly meets the budget', async () => {
    const result = await sampleTiles(
      options({
        bounds: [0, 0, 0, 0],
        zooms: [0],
        maxRequests: 1,
        retries: 2,
      }),
      async () => pointTile(),
    );

    expect(result.summary.requested).toBe(1);
    expect(result.summary.stopReason).toBe('candidates-exhausted');
    expect(result.unresolved.map((item) => item.code)).not.toContain(
      'sampling-budget-exhausted',
    );
  });

  it('stops after eight consecutive non-empty observations add no structure', async () => {
    const tile = pointTile();
    const fetcher: TileFetcher = async () => tile;

    const result = await sampleTiles(options({concurrency: 1, retries: 0}), fetcher);

    expect(result.observations).toHaveLength(9);
    expect(result.summary).toMatchObject({requested: 9, decoded: 9, empty: 0, failed: 0});
    expect(result.summary.stopReason).toBe('structure-stable');
  });

  it.each(['native', 'forward-slash'] as const)(
    'samples explicit local file templates with %s separators without network access',
    async (separators) => {
      const directory = await mkdtemp(join(tmpdir(), 'cartography-sampling-'));
      try {
        await writeFile(join(directory, '0-0-0.pbf'), pointTile('local'));

        const result = await sampleTiles(
          options({
            template: separators === 'native'
              ? join(directory, '{z}-{x}-{y}.pbf')
              : join(directory, '{z}-{x}-{y}.pbf').replaceAll('\\', '/'),
            bounds: [0, 0, 0, 0],
            zooms: [0],
            retries: 0,
          }),
        );

        expect(result.summary).toMatchObject({requested: 1, decoded: 1, failed: 0});
        expect(required(result.observations[0]?.observation.layers.local).featureCount).toBe(1);
        expect(transportMocks.lookup).not.toHaveBeenCalled();
        expect(transportMocks.httpRequest).not.toHaveBeenCalled();
        expect(transportMocks.httpsRequest).not.toHaveBeenCalled();
      } finally {
        await rm(directory, {recursive: true});
      }
    },
  );

  it('returns unsupported protocols as unresolved without retaining URL credentials', async () => {
    const result = await sampleTiles(
      options({
        template:
          'ftp://user:password@tiles.example/{z}/{x}/{y}.pbf?token=top-secret#private',
      }),
    );
    const serialized = JSON.stringify(result);

    expect(result.summary.requested).toBe(0);
    expect(result.unresolved.map((item) => item.code)).toEqual([
      'tile-template-not-inspectable',
    ]);
    expect(serialized).not.toContain('user');
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('top-secret');
    expect(serialized).not.toContain('private');
  });

  it('blocks loopback HTTP targets by default before issuing a fetch', async () => {
    const result = await sampleTiles(
      options({
        template: 'http://127.0.0.1/{z}/{x}/{y}.pbf',
        bounds: [0, 0, 0, 0],
        zooms: [0],
        retries: 0,
      }),
    );

    expect(result.summary).toMatchObject({requested: 0, decoded: 0, failed: 1});
    expect(result.unresolved.map((item) => item.code)).toEqual([
      'tile-private-network-blocked',
    ]);
  });

  it.each(['[::1]', '[fc00::1]', '[fe80::1]'])(
    'blocks loopback, private, and link-local IPv6 target %s',
    async (host) => {
      const result = await sampleTiles(
        options({
          template: `http://${host}/{z}/{x}/{y}.pbf`,
          bounds: [0, 0, 0, 0],
          zooms: [0],
          retries: 0,
        }),
      );

      expect(result.unresolved.map((item) => item.code)).toEqual([
        'tile-private-network-blocked',
      ]);
    },
  );

  it('connects through the exact address returned by policy-checked DNS', async () => {
    const response = fakeResponse(
      200,
      {'content-length': String(pointTile().byteLength)},
      pointTile(),
    );
    const transport = installHttpResponses([response]);

    const result = await sampleTiles(
      options({
        bounds: [0, 0, 0, 0],
        zooms: [0],
        retries: 0,
      }),
    );

    expect(transportMocks.lookup).toHaveBeenCalledTimes(1);
    expect(transport.pinnedAddresses).toEqual(['93.184.216.34']);
    expect(transport.requestedHosts).toEqual(['tiles.example']);
    expect(transport.servernames).toEqual(['tiles.example']);
    expect(transport.agents).toEqual([false]);
    expect(result.summary).toMatchObject({requested: 1, decoded: 1, failed: 0});
  });

  it('returns a pinned address array when Node requests lookup all mode', async () => {
    const tile = pointTile();
    const transport = installHttpResponses(
      [fakeResponse(200, {'content-length': String(tile.byteLength)}, tile)],
      true,
    );

    const result = await sampleTiles(
      options({bounds: [0, 0, 0, 0], zooms: [0], retries: 0}),
    );

    expect(transport.pinnedAddresses).toEqual(['93.184.216.34']);
    expect(result.summary).toMatchObject({requested: 1, decoded: 1, failed: 0});
  });

  it('uses a fresh pinned connection for every same-host request in a real redirect chain', async () => {
    const {createServer} = await vi.importActual<typeof import('node:http')>('node:http');
    const tile = pointTile('real');
    let connections = 0;
    const server = createServer((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, {location: '/tile'});
        response.end();
        return;
      }
      response.writeHead(200, {'content-length': String(tile.byteLength)});
      response.end(tile);
    });
    server.on('connection', () => {
      connections += 1;
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });

    const dnsLookup = vi.fn(async () => [{address: '127.0.0.1', family: 4}]);
    try {
      vi.resetModules();
      vi.doMock('node:dns/promises', () => ({lookup: dnsLookup}));
      vi.doUnmock('node:http');
      vi.doUnmock('node:https');
      const realSampling = await import('../src/sampling.js');
      const port = (server.address() as AddressInfo).port;

      const result = await realSampling.sampleTiles(
        options({
          template: `http://pinned.invalid:${port}/start`,
          bounds: [0, 0, 0, 0],
          zooms: [0],
          maxRequests: 2,
          retries: 0,
          allowPrivateNetwork: true,
        }),
      );

      expect(result.summary).toMatchObject({requested: 2, decoded: 1, failed: 0});
      expect(dnsLookup).toHaveBeenCalledTimes(2);
      expect(connections).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      vi.resetModules();
    }
  });

  it('arbitrates real HTTP total bytes by candidate order regardless of response delays', async () => {
    const {createServer} = await vi.importActual<typeof import('node:http')>('node:http');
    const firstTile = pointTile('alpha');
    const secondTile = pointTile('bravo');
    expect(firstTile.byteLength).toBe(secondTile.byteLength);
    const delays = [
      {first: 30, second: 0},
      {first: 0, second: 30},
    ];
    let runIndex = 0;
    const server = createServer((request, response) => {
      const currentRun = runIndex;
      const first = request.url?.endsWith('/1/0/0.pbf') === true;
      const body = first ? firstTile : secondTile;
      const delay = first ? delays[currentRun]!.first : delays[currentRun]!.second;
      setTimeout(() => {
        response.writeHead(200, {'content-length': String(body.byteLength)});
        response.end(body);
      }, delay);
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });

    try {
      vi.resetModules();
      vi.doUnmock('node:dns/promises');
      vi.doUnmock('node:http');
      vi.doUnmock('node:https');
      const realSampling = await import('../src/sampling.js');
      const port = (server.address() as AddressInfo).port;
      const results = [];
      for (runIndex = 0; runIndex < delays.length; runIndex += 1) {
        results.push(await realSampling.sampleTiles(options({
          template: `http://127.0.0.1:${port}/{z}/{x}/{y}.pbf`,
          bounds: [-180, -85, 180, 85],
          zooms: [1],
          concurrency: 2,
          maxRequests: 2,
          retries: 0,
          maxResponseBytes: firstTile.byteLength,
          maxTotalBytes: firstTile.byteLength,
          allowPrivateNetwork: true,
        })));
      }

      expect(stableJson(results[0])).toBe(stableJson(results[1]));
      expect(results[0]!.observations.map(({coordinate}) => coordinate)).toEqual([
        {z: 1, x: 0, y: 0},
      ]);
      expect(Object.keys(results[0]!.observations[0]!.observation.layers)).toEqual(['alpha']);
      expect(results[0]!.summary.bytes).toBe(firstTile.byteLength + secondTile.byteLength);
      expect(results[0]!.unresolved.map((item) => item.code)).toContain(
        'tile-total-bytes-exceeded',
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      vi.resetModules();
    }
  });

  it('cancels bodies before rejecting invalid lengths, oversized lengths, and non-OK status', async () => {
    const cases = [
      fakeResponse(200, {'content-length': 'invalid'}, pointTile()),
      fakeResponse(200, {'content-length': '999'}, pointTile()),
      fakeResponse(400, {}, pointTile()),
    ];

    for (const response of cases) {
      transportMocks.httpRequest.mockClear();
      installHttpResponses([response]);
      await sampleTiles(
        options({
          bounds: [0, 0, 0, 0],
          zooms: [0],
          retries: 0,
          maxResponseBytes: 100,
          allowPrivateNetwork: true,
        }),
      );
      expect(response.destroySpy).toHaveBeenCalledTimes(1);
    }
  });

  it('permits at most three manual redirects', async () => {
    const responses = Array.from({length: 4}, () => fakeResponse(302, {location: '/next'}));
    installHttpResponses(responses);
    const result = await sampleTiles(
      options({
        template: 'http://127.0.0.1/{z}/{x}/{y}.pbf',
        bounds: [0, 0, 0, 0],
        zooms: [0],
        retries: 0,
        allowPrivateNetwork: true,
      }),
    );

    expect(transportMocks.httpRequest).toHaveBeenCalledTimes(4);
    expect(responses.every((response) => response.destroySpy.mock.calls.length === 1)).toBe(true);
    expect(result.unresolved.map((item) => item.code)).toEqual(['tile-redirect-limit']);
  });

  it('revalidates the protocol of every manual redirect target', async () => {
    const response = fakeResponse(302, {location: 'file:///private/tile.pbf'});
    installHttpResponses([response]);
    const result = await sampleTiles(
      options({
        template: 'http://127.0.0.1/{z}/{x}/{y}.pbf',
        bounds: [0, 0, 0, 0],
        zooms: [0],
        retries: 0,
        allowPrivateNetwork: true,
      }),
    );

    expect(transportMocks.httpRequest).toHaveBeenCalledTimes(1);
    expect(response.destroySpy).toHaveBeenCalledTimes(1);
    expect(result.unresolved.map((item) => item.code)).toEqual([
      'tile-template-not-inspectable',
    ]);
  });

  it('shares the 40-request budget across candidate attempts and redirect hops', async () => {
    const responses = Array.from({length: 40}, () =>
      fakeResponse(302, {location: '/next'}),
    );
    installHttpResponses(responses);

    const result = await sampleTiles(
      options({
        template: 'http://tiles.example/{z}/{x}/{y}.pbf',
        maxRequests: 40,
        retries: 0,
        allowPrivateNetwork: true,
      }),
    );

    expect(transportMocks.httpRequest).toHaveBeenCalledTimes(40);
    expect(result.summary.requested).toBe(40);
    expect(result.summary.stopReason).toBe('budget-exhausted');
  });

  it('enforces response and total-byte caps for injected fetchers', async () => {
    const oversized = await sampleTiles(
      options({
        bounds: [0, 0, 0, 0],
        zooms: [0],
        retries: 20,
        maxResponseBytes: 2,
      }),
      async () => new Uint8Array(3),
    );
    const totalLimited = await sampleTiles(
      options({maxRequests: 10, retries: 0, maxResponseBytes: 10, maxTotalBytes: 4}),
      async () => new Uint8Array(3),
    );

    expect(oversized.summary).toMatchObject({requested: 1, bytes: 0, failed: 1});
    expect(oversized.unresolved.map((item) => item.code)).toEqual([
      'tile-response-too-large',
    ]);
    expect(totalLimited.summary.bytes).toBeLessThanOrEqual(4);
    expect(totalLimited.summary.stopReason).toBe('budget-exhausted');
    expect(totalLimited.unresolved.map((item) => item.code)).toContain(
      'tile-total-bytes-exceeded',
    );
  });

  it('classifies gzip decoded-output overflow against the response budget', async () => {
    const compressed = gzipSync(new Uint8Array(2 * 1024));
    expect(compressed.byteLength).toBeLessThan(1024);

    const result = await sampleTiles(
      options({
        bounds: [0, 0, 0, 0],
        zooms: [0],
        maxRequests: 1,
        retries: 0,
        maxResponseBytes: 1024,
        maxTotalBytes: 1024,
      }),
      async () => compressed,
    );

    expect(result.summary).toMatchObject({requested: 1, decoded: 0, failed: 1});
    expect(result.unresolved.map((item) => item.code)).toEqual(['tile-decoded-too-large']);
  });

  it('reports an evidence-bearing unresolved item for unsafe 64-bit tile values', async () => {
    const result = await sampleTiles(
      options({bounds: [0, 0, 0, 0], zooms: [0], maxRequests: 1, retries: 0}),
      async () => unsafeIntegerTile(),
    );

    expect(result.observations).toEqual([]);
    expect(result.unresolved).toContainEqual(expect.objectContaining({
      code: 'tile-unsafe-64-bit-value',
      location: '#/tiles/0/0/0',
      evidence: [expect.objectContaining({location: '#/tiles/0/0/0'})],
    }));
    expect(JSON.stringify(result)).not.toContain(String(Number.MAX_SAFE_INTEGER + 1));
  });

  it('applies injected-fetch byte budgets in candidate order, not completion order', async () => {
    const firstTile = pointTile('alpha');
    const secondTile = pointTile('bravo');
    expect(firstTile.byteLength).toBe(secondTile.byteLength);

    const result = await sampleTiles(
      options({
        bounds: [-180, -85, 180, 85],
        zooms: [1],
        concurrency: 2,
        maxRequests: 2,
        retries: 0,
        maxResponseBytes: firstTile.byteLength,
        maxTotalBytes: firstTile.byteLength,
      }),
      async (coordinate) => {
        if (coordinate.y === 0) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return firstTile;
        }
        return secondTile;
      },
    );

    expect(result.observations.map(({coordinate}) => coordinate)).toEqual([{z: 1, x: 0, y: 0}]);
    expect(Object.keys(result.observations[0]!.observation.layers)).toEqual(['alpha']);
    expect(result.summary.stopReason).toBe('budget-exhausted');
  });

  it('times out an injected fetcher even when it ignores the abort signal', async () => {
    const result = await sampleTiles(
      options({
        bounds: [0, 0, 0, 0],
        zooms: [0],
        retries: 0,
        timeoutMs: 5,
      }),
      async () => new Promise<Uint8Array>(() => undefined),
    );

    expect(result.summary).toMatchObject({requested: 1, failed: 1});
    expect(result.unresolved.map((item) => item.code)).toEqual(['tile-fetch-timeout']);
  });
});
