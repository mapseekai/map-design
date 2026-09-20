// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const registered = vi.hoisted(() => ({ load: null as null | (() => Promise<unknown>) }));
vi.mock('next/dynamic', () => ({ default: (load: () => Promise<unknown>) => { registered.load = load; return () => null; } }));
vi.mock('../src/App', () => ({ App: () => null }));
import '../app/[[...slug]]/client-app';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('keeps a fast initial load visible for one animation cycle', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  let ready = false;
  const loading = registered.load!().then(() => { ready = true; });
  await vi.advanceTimersByTimeAsync(1399);
  expect(ready).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await loading;
  expect(ready).toBe(true);
});
it('does not impose an animation delay when reduced motion is requested', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const loading = registered.load!();
  await vi.advanceTimersByTimeAsync(0);
  await expect(loading).resolves.toBeDefined();
});
