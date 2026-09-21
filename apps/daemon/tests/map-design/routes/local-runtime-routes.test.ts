import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { expect, it, vi } from 'vitest';
import { createLocalRuntimeRouter } from '../../../src/map-design/routes/local-runtime-routes.js';
import type { MapDesignLocalAgentRegistry } from '../../../src/map-design/application/local-agent-registry.js';
import type { MapAgentAdapter } from '../../../src/map-design/agents/types.js';

it('refreshes discovery and tests only a catalog model through the local adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-routes-'));
  const order: string[] = [];
  const start = vi.fn<MapAgentAdapter['startMapRun']>(async (_input, _tools, onEvent) => {
    onEvent({ kind: 'text', text: 'OK' });
    return { done: Promise.resolve({ status: 'succeeded' }), cancel: async () => undefined };
  });
  const agents = { probeNativeMapTools: async () => { order.push('probe'); },
    runtimeCatalog: { refresh: async () => { order.push('refresh'); }, list: () => [{ id: 'local', available: true, models: [{ id: 'model' }] }] },
    getMapAgent: () => ({ startMapRun: start }) } as unknown as MapDesignLocalAgentRegistry;
  const app = express(); app.use(createLocalRuntimeRouter(agents, root));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const post = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    expect((await post('/api/agents/refresh')).status).toBe(200);
    expect(order).toEqual(['probe', 'refresh']);
    expect((await post('/api/agents/local/test', { model: 'missing' })).status).toBe(400);
    expect((await post('/api/agents/local/test', { model: 'model', apiKey: 'unexpected' })).status).toBe(400);
    expect(start).not.toHaveBeenCalled();
    const result = await post('/api/agents/local/test', { model: 'model' });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: 'passed' });
    expect(start.mock.calls[0]?.[0]).toMatchObject({ model: 'model' });
  } finally {
    const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed;
    await rm(root, { recursive: true, force: true });
  }
});
