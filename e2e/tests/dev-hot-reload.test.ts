import type { BrowserContext, WebSocketRoute } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { isolateDevHotReload } from '../lib/playwright/runtime-lifecycle.ts';

it.each([['http:', 'ws:'], ['https:', 'wss:']])('isolates only the %s worker’s Next HMR socket', async (http, ws) => {
  const routeWebSocket = vi.fn<BrowserContext['routeWebSocket']>();
  await isolateDevHotReload({ routeWebSocket }, `${http}//127.0.0.1:8171`);
  const matches = routeWebSocket.mock.calls[0]?.[0];
  if (typeof matches !== 'function') throw new Error('Expected a scoped WebSocket URL predicate');

  const endpoint = `${ws}//127.0.0.1:8171/_next/webpack-hmr`;
  const targets = [
    endpoint,
    endpoint + '?id=next-runtime',
    endpoint + '-metrics',
    `${ws}//127.0.0.1:8171/api/events`,
    `${ws}//127.0.0.1:8172/_next/webpack-hmr`,
    `${ws}//example.test:8171/_next/webpack-hmr`,
  ];
  expect(targets.filter(target => matches(new URL(target)))).toEqual(targets.slice(0, 2));
});

it('connects to the dev server and passes through hydration and diagnostics', async () => {
  const routeWebSocket = vi.fn<BrowserContext['routeWebSocket']>();
  await isolateDevHotReload({ routeWebSocket }, 'http://localhost:8171');
  const handler = routeWebSocket.mock.calls[0]![1];
  const onMessage = vi.fn<WebSocketRoute['onMessage']>();
  const client = { connectToServer: () => ({ onMessage }), send: vi.fn() };
  await handler(client as unknown as WebSocketRoute);
  const receive = onMessage.mock.calls[0]![0];
  const forwarded = ['{"type":"sync","hash":"abc"}', Buffer.from([3, 17, 0]), '{"type":"errors"}', 'unrecognized frame'];
  receive('{"type":"serverComponentChanges","hash":"abc"}');
  for (const frame of forwarded) receive(frame);
  expect(client.send.mock.calls).toEqual(forwarded.map(frame => [frame]));
});
