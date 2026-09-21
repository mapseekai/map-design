import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { MapAgentAdapter, MapRunInput } from '../../../src/map-design/agents/types.js';
import type { MapDesignLocalAgentRegistry } from '../../../src/map-design/application/local-agent-registry.js';
import { LocalModelTestService } from '../../../src/map-design/application/local-model-test-service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(startMapRun: MapAgentAdapter['startMapRun'], timeoutMs = 1000) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-tests-')); roots.push(root);
  const registry = { runtimeCatalog: { list: () => [{ id: 'local', available: true, models: [{ id: 'model', enabled: false }] }] },
    getMapAgent: () => ({ startMapRun }) } as unknown as MapDesignLocalAgentRegistry;
  return { root, service: new LocalModelTestService(registry, root, timeoutMs) };
}

it('uses the selected model with no map tools and removes the isolated test directory', async () => {
  let input: MapRunInput | undefined;
  const cancel = vi.fn(async () => undefined);
  const start = vi.fn<MapAgentAdapter['startMapRun']>(async (value, tools, onEvent) => {
    input = value; expect(tools).toEqual([]); onEvent({ kind: 'text', text: 'OK' });
    return { done: Promise.resolve({ status: 'succeeded' }), cancel };
  });
  const { root, service } = await setup(start);
  expect(await service.test('local', 'model', new AbortController().signal)).toMatchObject({ status: 'passed' });
  expect(input).toMatchObject({ model: 'model', toolCallback: { url: 'http://127.0.0.1:1/tools-disabled' } });
  expect(input!.cwd.startsWith(join(root, 'runtime-tests'))).toBe(true);
  expect(await readdir(join(root, 'runtime-tests'))).toEqual([]);
  expect(cancel).toHaveBeenCalledOnce();
});

it('does not call an unknown model or silently use a different runtime', async () => {
  const start = vi.fn<MapAgentAdapter['startMapRun']>();
  const { service } = await setup(start);
  await expect(service.test('local', 'missing', new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(service.test('missing', 'model', new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(start).not.toHaveBeenCalled();
});

it('requires an actual model response and redacts upstream failure details', async () => {
  for (const error of [undefined, { code: 'API_AUTH_FAILED', message: 'secret-token' }]) {
    const { service } = await setup(async () => ({ done: Promise.resolve(error ? { status: 'failed', error } : { status: 'succeeded' }), cancel: async () => undefined }));
    const result = await service.test('local', 'model', new AbortController().signal);
    expect(result).toMatchObject({ status: 'failed', code: error ? 'API_AUTH_FAILED' : 'RUNTIME_TEST_FAILED' });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  }
});

it('cancels timed-out tests and rejects overlapping tests', async () => {
  const cancel = vi.fn(async () => undefined);
  const { service } = await setup(async () => ({ done: new Promise(() => undefined), cancel }), 30);
  const pending = service.test('local', 'model', new AbortController().signal);
  await expect(service.test('local', 'model', new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_TEST_BUSY' });
  await expect(pending).resolves.toMatchObject({ status: 'failed', code: 'RUNTIME_TEST_TIMEOUT' });
  expect(cancel).toHaveBeenCalledOnce();
});
