import type { BrowserContext } from '@playwright/test';
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
