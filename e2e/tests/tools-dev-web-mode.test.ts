import { afterEach, expect, it, vi } from 'vitest';
import { createToolsDevSuite } from '../lib/tools-dev/runtime.ts';

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, '1'])('starts the isolated Web worker with MAP_DESIGN_WEB_PROD=%s', async flag => {
  vi.stubEnv('MAP_DESIGN_WEB_PROD', flag);
  const runJson = vi.fn().mockResolvedValue({
    daemon: { status: { url: 'http://127.0.0.1:4511' } },
    web: { status: { url: 'http://127.0.0.1:4512' } },
  });
  const suite = createToolsDevSuite({
    codexHomeDir: 'codex', dataDir: 'data', namespace: 'worker-1', root: 'fixture', toolsDevRoot: 'runtime',
  }, {
    runJson,
    allocatePorts: async () => ({ daemonPort: 4511, webPort: 4512, release: async () => {} }),
  });
  const callerEnv = { AMR_HOME: 'worker-agent' };
  await suite.startWeb(callerEnv);
  const [, , args, env] = runJson.mock.calls[0]!;
  expect(args).toEqual([
    'start', 'web', '--namespace', 'worker-1', '--tools-dev-root', 'runtime',
    '--daemon-port', '4511', '--web-port', '4512', '--json', ...(flag === '1' ? ['--prod'] : []),
  ]);
  expect(env).toEqual(callerEnv);
});
