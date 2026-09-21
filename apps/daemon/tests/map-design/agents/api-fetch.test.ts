import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); });

it('routes model fetch through the environment proxy and respects local bypasses', async () => {
  const targets: string[] = [];
  const proxy = createServer();
  proxy.on('connect', (request, socket) => {
    targets.push(request.url ?? '');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied'));
  });
  const direct = createServer((_request, response) => response.end('direct'));
  try {
    await Promise.all([proxy, direct].map(server => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    })));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) vi.stubEnv(key, proxyUrl);
    for (const key of ['NO_PROXY', 'no_proxy']) vi.stubEnv(key, '127.0.0.1');
    vi.resetModules();
    const { apiFetch } = await import('../../../src/map-design/agents/api-fetch.js');
    const response = await apiFetch('http://model.invalid/v1/models');
    expect(await response.text()).toBe('proxied');
    expect(targets).toEqual(['model.invalid:80']);
    const bypass = await apiFetch(`http://127.0.0.1:${(direct.address() as AddressInfo).port}/models`);
    expect(await bypass.text()).toBe('direct');
    expect(targets).toHaveLength(1);
  } finally {
    await Promise.all([proxy, direct].filter(server => server.listening).map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
  }
});
