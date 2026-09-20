import { once } from 'node:events';

import express, { type Express } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { MapDesignRunEvent, StartMapDesignRunRequest } from '@mapseekai/contracts';

import { MAP_DESIGN_COMMANDS, runMapDesignCli, type MapDesignCliIo } from '../src/map-design-cli.js';
import { requireLocalDaemonRequest } from '../src/http/local-daemon-request.js';
import { createMapDesignRunRouter } from '../src/map-design/routes/run-routes.js';

function fixture(fetchImpl: typeof fetch = vi.fn() as unknown as typeof fetch): { io: MapDesignCliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { fetch: fetchImpl, stdout: { write: (value: string) => stdout.push(value) }, stderr: { write: (value: string) => stderr.push(value) }, env: { MAP_DESIGN_DAEMON_URL: 'http://127.0.0.1:3210' } },
    stdout,
    stderr,
  };
}

describe('retained md CLI', () => {
  it('exposes exactly the retained command manifest', () => {
    expect(MAP_DESIGN_COMMANDS).toEqual(['agents', 'config', 'doctor', 'project', 'run', 'status', 'tool']);
  });

  it.each(['media', 'mcp', 'workspace', 'automation', 'research', 'resource', 'artifact', 'brand', 'design-system', 'deploy', 'handoff', 'export'])(
    'rejects retired %s commands without contacting a daemon',
    async (command) => {
      const request = vi.fn();
      const state = fixture(request as unknown as typeof fetch);
      await expect(runMapDesignCli([command], state.io)).resolves.toBe(2);
      expect(request).not.toHaveBeenCalled();
      expect(state.stderr.join('')).toContain('md');
    },
  );

  it('uses the health endpoint for JSON status output', async () => {
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:3210/api/health');
      expect(init).toMatchObject({ method: 'GET' });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const state = fixture(request as unknown as typeof fetch);
    await expect(runMapDesignCli(['status', '--json'], state.io)).resolves.toBe(0);
    expect(state.stdout).toEqual(['{"ok":true}\n']);
  });

  it('rejects duplicate, unknown, and missing required flags before making a request', async () => {
    const request = vi.fn();
    for (const argv of [['status', '--json', '--json'], ['status', '--unexpected'], ['project', 'create', '--name', 'map'], ['run', 'start', '--project-id', 'map'], ['tool', 'map_get_context']]) {
      const state = fixture(request as unknown as typeof fetch);
      await expect(runMapDesignCli(argv, state.io)).resolves.toBe(2);
      expect(`${state.stdout.join('')}${state.stderr.join('')}`).toContain('md');
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('lists agents only with the exact agents list command', async () => {
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:3210/api/agents');
      expect(init).toMatchObject({ method: 'GET' });
      return new Response(JSON.stringify({ agents: [] }), { status: 200 });
    });
    const state = fixture(request as unknown as typeof fetch);
    await expect(runMapDesignCli(['agents', 'list', '--json'], state.io)).resolves.toBe(0);
    expect(state.stdout).toEqual(['{"agents":[]}\n']);
  });

  it('gets configuration values from the config envelope and returns null for missing keys', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ config: { theme: 'dark', density: 2 } }), { status: 200 }));
    const state = fixture(request as unknown as typeof fetch);

    await expect(runMapDesignCli(['config', 'get', 'theme', '--json'], state.io)).resolves.toBe(0);
    await expect(runMapDesignCli(['config', 'get', 'missing', '--json'], state.io)).resolves.toBe(0);

    expect(state.stdout).toEqual(['"dark"\n', 'null\n']);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('uses the config endpoint for whole and structured updates', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ config: { theme: 'dark' } }), { status: 200 });
    });
    const state = fixture(request as unknown as typeof fetch);
    await expect(runMapDesignCli(['config', 'get', '--json'], state.io)).resolves.toBe(0);
    await expect(runMapDesignCli(['config', 'set', 'theme', '--value-json', '{"density":2}', '--json'], state.io)).resolves.toBe(0);
    expect(requests).toEqual([
      { url: 'http://127.0.0.1:3210/api/config', init: { method: 'GET' } },
      { url: 'http://127.0.0.1:3210/api/config', init: expect.objectContaining({ method: 'PUT', body: '{"theme":{"density":2}}' }) },
    ]);
  });

  it('posts the exact retained run request contract through the run route', async () => {
    const posted: StartMapDesignRunRequest[] = [];
    const runs = {
      start: vi.fn(async (request: StartMapDesignRunRequest) => {
        posted.push(request);
        return { runId: 'run-1', projectId: request.projectId, conversationId: request.conversationId, status: 'running' as const };
      }),
      get: vi.fn(() => null),
      cancel: vi.fn(async () => null),
      subscribe: vi.fn((_runId: string, _listener: (event: MapDesignRunEvent) => void) => () => {}),
    };
    const app: Express = express();
    app.get('/api/map-design/projects/:projectId', (_request, response) => response.json({ conversationId: 'conversation-1' }));
    app.use(createMapDesignRunRouter({ runService: runs, requireLocalDaemonRequest }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not listen');

    const state = fixture(fetch);
    state.io.env = { MAP_DESIGN_DAEMON_URL: `http://127.0.0.1:${address.port}` };
    state.io.readFile = async () => 'design a map';
    state.io.randomId = (() => { let n = 0; return () => `id-${++n}`; })();
    const byokProvider = { protocol: 'openai' as const, apiKey: 'secret', baseUrl: 'http://127.0.0.1:4000/v1' };
    const expectedBody = {
      projectId: 'map',
      conversationId: 'conversation-1',
      prompt: 'design a map',
      runtimeRevision: 4,
      clientRequestId: 'id-1',
      userMessageId: 'id-2',
      assistantMessageId: 'id-3',
      byokProvider,
    } satisfies StartMapDesignRunRequest;

    try {
      await expect(runMapDesignCli([
        'run', 'start',
        '--project-id', 'map',
        '--runtime-revision', '4',
        '--prompt-file', 'prompt.txt',
        '--byok-provider', JSON.stringify(byokProvider),
        '--json',
      ], state.io)).resolves.toBe(0);
      expect(posted).toEqual([expectedBody]);
      expect(runs.start).toHaveBeenCalledTimes(1);
    } finally {
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
  });

  it('uses the project primary conversation by default and an explicit conversation for a run override', async () => {
    const posted: StartMapDesignRunRequest[] = [];
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/map-design/projects/map')) {
        return new Response(JSON.stringify({ aggregate: { conversationId: 'primary-conversation' } }), { status: 200 });
      }
      posted.push(JSON.parse(String(init?.body)) as StartMapDesignRunRequest);
      return new Response(JSON.stringify({ runId: `run-${posted.length}` }), { status: 200 });
    });
    const state = fixture(request as unknown as typeof fetch);
    state.io.readFile = async () => 'design a map';
    state.io.randomId = (() => { let n = 0; return () => `id-${++n}`; })();

    await expect(runMapDesignCli([
      'run', 'start', '--project-id', 'map', '--runtime-revision', '0', '--prompt-file', 'prompt.txt', '--json',
    ], state.io)).resolves.toBe(0);
    await expect(runMapDesignCli([
      'run', 'start', '--project-id', 'map', '--conversation-id', 'selected-conversation', '--runtime-revision', '2', '--prompt-file', 'prompt.txt', '--json',
    ], state.io)).resolves.toBe(0);

    expect(posted.map((body) => body.conversationId)).toEqual(['primary-conversation', 'selected-conversation']);
    expect(request.mock.calls.filter(([url]) => String(url).endsWith('/api/map-design/projects/map'))).toHaveLength(1);
  });

  it('documents the optional conversation override in command help', async () => {
    const state = fixture();

    await expect(runMapDesignCli(['--help'], state.io)).resolves.toBe(0);

    expect(state.stdout.join('')).toContain('md run start accepts --conversation-id');
  });

  it.each(['runtime', 'model', 'reasoning', 'service-tier', 'agent'])(
    'rejects retired run authority option --%s before contacting the daemon',
    async (option) => {
      const request = vi.fn();
      const state = fixture(request as unknown as typeof fetch);
      state.io.readFile = async () => 'design a map';

      await expect(runMapDesignCli([
        'run', 'start', '--project-id', 'map', '--runtime-revision', '0',
        `--${option}`, 'legacy-authority', '--prompt-file', 'prompt.txt',
      ], state.io)).resolves.toBe(2);

      expect(request).not.toHaveBeenCalled();
    },
  );

  it('rejects prompt inputs above either bounded limit before contacting the daemon', async () => {
    const request = vi.fn();
    const state = fixture(request as unknown as typeof fetch);
    state.io.readFile = async () => 'x'.repeat(16_385);
    await expect(runMapDesignCli(['run', 'start', '--project-id', 'map', '--runtime-revision', '0', '--prompt-file', 'prompt.txt'], state.io)).resolves.toBe(2);
    expect(request).not.toHaveBeenCalled();
    expect(state.stderr.join('')).toContain('16,384 character or 64 KiB');
  });
  it.each([1, 2, 3, 4, 5])('preserves a UTF-8 prompt split at byte boundary %i', async (boundary) => {
    const prompt = 'A😀B';
    const bytes = Buffer.from(prompt);
    const request = vi.fn(async (url: string) => new Response(
      JSON.stringify(url.includes('/api/map-design/projects/') ? { conversationId: 'conversation-1' } : { runId: 'run-1' }),
      { status: 200 },
    ));
    const state = fixture(request as unknown as typeof fetch);
    state.io.stdin = (async function* () {
      yield bytes.subarray(0, boundary);
      yield bytes.subarray(boundary);
    })();
    state.io.randomId = () => 'id';

    await expect(runMapDesignCli(['run', 'start', '--project-id', 'map', '--runtime-revision', '0', '--prompt-file', '-'], state.io)).resolves.toBe(0);
    const [, init] = request.mock.calls[1]! as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ prompt });
  });

  it('uses only strict run status and cancel forms', async () => {
    const request = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify({ url, method: init?.method }), { status: 200 }));
    const state = fixture(request as unknown as typeof fetch);
    await expect(runMapDesignCli(['run', 'status', 'run/one', '--json'], state.io)).resolves.toBe(0);
    await expect(runMapDesignCli(['run', 'cancel', 'run/one', '--json'], state.io)).resolves.toBe(0);
    await expect(runMapDesignCli(['run', 'cancel', 'one', 'extra'], state.io)).resolves.toBe(2);
    expect(request).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:3210/api/runs/run%2Fone', { method: 'GET' });
    expect(request).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:3210/api/runs/run%2Fone/cancel', { method: 'POST' });
  });
  it('prints daemon errors as machine JSON without usage text', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'RUN_NOT_AUTHORIZED', message: 'denied', retryable: false } }), { status: 403 }));
    const state = fixture(request as unknown as typeof fetch);
    await expect(runMapDesignCli(['agents', 'list', '--json'], state.io)).resolves.toBe(4);
    expect(state.stderr).toEqual(['{"code":"RUN_NOT_AUTHORIZED","message":"denied","retryable":false,"status":403}\n']);
  });
});
