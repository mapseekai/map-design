import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, it, expect } from 'vitest';
import { PooledPinnedDispatcher } from '../../../src/map-design/ingestion/pinned-pool.js';

const request = () => ({ headers: {}, signal: new AbortController().signal, connectTimeoutMs: 1000, headersTimeoutMs: 1000, bodyTimeoutMs: 1000 });
describe('bounded pinned connection pools', () => {
  it('reuses validated connections, separates authority and closes every socket', async () => {
    let connections = 0; const authorities: string[] = [];
    const server = createServer((request, response) => { authorities.push(request.headers.host!); response.end('{}'); });
    server.on('connection', () => { connections++; }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as AddressInfo).port; const pool = new PooledPinnedDispatcher();
    try {
      for (const host of ['maps.example.com', 'maps.example.com', 'other.example.com']) {
        const response = await pool.request({ url: new URL(`http://${host}:${port}/data`), hostname: host, address: '127.0.0.1', family: 4 }, request());
        for await (const _chunk of response.body) { /* fully consume before reuse */ }
        await response.close?.();
        // Undici marks the drained connection idle on the next I/O turn.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(connections).toBe(2);
      expect(authorities).toEqual([`maps.example.com:${port}`, `maps.example.com:${port}`, `other.example.com:${port}`]);
      await pool.close();
      await expect(pool.request({ url: new URL(`http://maps.example.com:${port}`), hostname: 'maps.example.com', address: '127.0.0.1', family: 4 }, request())).rejects.toThrow('closed');
    } finally { await pool.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
