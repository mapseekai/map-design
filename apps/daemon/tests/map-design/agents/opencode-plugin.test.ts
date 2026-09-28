import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { opencodeAgentDef } from '../../../src/runtimes/defs/opencode.js';
import {
  createOpenCodeMapAgentAdapter,
  probeOpenCodeNativeMapTools,
  type OpenCodePluginLease,
  type OpenCodePluginSpawn,
  type OpenCodeRunPlugin,
} from '../../../src/map-design/agents/opencode-plugin.js';
import { createLocalAgentRegistry } from '../../../src/map-design/application/local-agent-registry.js';
import type { AgentToolDefinition, MapAgentEvent, MapRunInput } from '../../../src/map-design/agents/types.js';
import type { NativeMapToolDefinition } from '../../../src/map-design/tools/tool-context.js';
import { defineMapAgentAdapterConformance } from './adapter-conformance.js';
import {
  createMemoryMapAgentSessionBroker,
  mapAgentSessionScope,
  type MapAgentSessionBroker,
} from '../../../src/map-design/agents/session-broker.js';

const TOOLS: NativeMapToolDefinition[] = [
  {
    name: 'map_get_context',
    description: 'Read the current map context.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    name: 'map_validate',
    description: 'Validate the draft.',
    inputSchema: {
      type: 'object',
      properties: { expectedRevision: { type: 'integer', minimum: 0 } },
      required: ['expectedRevision'],
      additionalProperties: false,
    },
  },
];

class FakeOpenCodeProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly input: string[] = [];
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.child.emit('close', null));
    return true;
  });
  readonly child = Object.assign(new EventEmitter(), {
    stdin: this.stdin,
    stdout: this.stdout,
    stderr: this.stderr,
    kill: this.kill,
  });

  constructor() {
    this.stdin.on('data', (chunk: Buffer | string) => this.input.push(String(chunk)));
  }

  send(frame: Record<string, unknown> | string): void {
    this.stdout.write(typeof frame === 'string' ? frame : `${JSON.stringify(frame)}\n`);
  }

  close(code: number | null = 0): void {
    this.child.emit('close', code);
  }
}

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 20,
  })));
});

async function pluginRoot(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), 'map-design-opencode-test-'));
  roots.push(root);
  return root;
}

function runInput(
  signal = new AbortController().signal,
  overrides: Partial<MapRunInput> = {},
): MapRunInput {
  return {
    runId: 'run-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    prompt: 'Validate the map.',
    resumePrompt: 'Validate only the latest turn.',
    cwd: '/safe/project',
    model: 'openai/gpt-5.6-terra',
    reasoning: 'high',
    serviceTier: null,
    toolRuntime: {
      execute: async (call) => ({
        ok: true,
        toolUseId: call.toolUseId,
        summary: { valid: true },
        modelContent: '{"valid":true}',
      }),
      closeRun: () => undefined,
    },
    toolCallback: {
      url: 'http://127.0.0.1:8787/api/map-design/tools',
      token: 'test-only-secret-token',
      close: () => undefined,
    },
    signal,
    ...overrides,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function trackedPluginLease(
  root: string,
  plugin: OpenCodeRunPlugin,
): Promise<{ directory: string; dispose: ReturnType<typeof vi.fn>; lease: OpenCodePluginLease }> {
  const directory = await mkdtemp(join(root, 'tracked-opencode-lease-'));
  const path = join(directory, 'map-design-plugin.ts');
  const probePath = join(directory, 'probe.json');
  await writeFile(path, plugin.source, 'utf8');
  const dispose = vi.fn(async () => rm(directory, { recursive: true, force: true }));
  return { directory, dispose, lease: { path, probePath, dispose } };
}

async function loadGeneratedPlugin(
  plugin: OpenCodeRunPlugin,
  environment: NodeJS.ProcessEnv = plugin.env,
): Promise<{ tool: Record<string, { description: string; args: Record<string, z.ZodType>; execute(args: unknown, context: Record<string, unknown>): Promise<string> }> }> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const href = `data:text/javascript;base64,${Buffer.from(plugin.source).toString('base64')}#${Math.random()}`;
    const loaded = await import(href) as { MapDesignOpenCodePlugin(): Promise<{ tool: Record<string, { execute(...args: unknown[]): Promise<string> }> }> };
    const surface = await loaded.MapDesignOpenCodePlugin();
    for (const definition of Object.values(surface.tool)) {
      const execute = definition.execute;
      definition.execute = async (...args: unknown[]) => withEnvironment(environment, () => execute(...args));
    }
    return surface as never;
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withEnvironment<T>(environment: NodeJS.ProcessEnv, operation: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function start(options: {
  server?: FakeOpenCodeProcess;
  root?: string;
  input?: MapRunInput;
  events?: MapAgentEvent[];
  sessionBroker?: MapAgentSessionBroker;
  maxFrameBytes?: number;
  environment?: NodeJS.ProcessEnv;
  tools?: AgentToolDefinition[];
} = {}) {
  const root = options.root ?? await pluginRoot();
  const server = options.server ?? new FakeOpenCodeProcess();
  const events = options.events ?? [];
  const spawn = vi.fn<OpenCodePluginSpawn>(() => server.child);
  const adapter = createOpenCodeMapAgentAdapter({
    definition: { ...opencodeAgentDef, bin: '/opt/opencode/bin/opencode' },
    toolDefinitions: () => TOOLS,
    pluginRoot: root,
    spawn,
    environmentKeys: () => ['OPENCODE_CONFIG_CONTENT'],
    ...(options.sessionBroker === undefined ? {} : { sessionBroker: options.sessionBroker }),
    environment: () => options.environment ?? ({
      PATH: '/usr/bin',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        mcp: { existing: { type: 'remote', url: 'http://127.0.0.1:9000/mcp' } },
      }),
    }),
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
  });
  const handle = await adapter.startMapRun(options.input ?? runInput(), options.tools ?? TOOLS, (event) => events.push(event));
  const [, args, spawnOptions] = spawn.mock.calls.at(-1)!;
  const config = JSON.parse(String(spawnOptions.env.OPENCODE_CONFIG_CONTENT)) as Record<string, unknown>;
  const pluginPath = fileURLToPath((config.plugin as string[]).at(-1)!);
  return { adapter, args, config, events, handle, pluginPath, root, server, spawn, spawnOptions };
}

describe('OpenCode cartography completion', () => {
  it('accepts a complete specification whose JSON envelope exceeds 64 KiB', async () => {
    const reply = JSON.stringify({ message: 'Updated.', source: 'x'.repeat(65_536), sampleBindings: {} });
    const state = await start({ input: runInput(undefined, { taskKind: 'cartography' }) });
    state.server.send({ type: 'step_start', sessionID: 'ses_1', part: {} });
    state.server.send({ type: 'text', part: { text: reply } });
    state.server.send({ type: 'step_finish', part: { reason: 'stop' } });
    state.server.close();
    await expect(state.handle.done).resolves.toMatchObject({ status: 'succeeded', finalResponse: reply });
  });

  it('rejects a final step whose combined text parts exceed 512 KiB', async () => {
    const state = await start({ input: runInput(undefined, { taskKind: 'cartography' }) });
    state.server.send({ type: 'step_start', sessionID: 'ses_1', part: {} });
    for (let index = 0; index < 9; index += 1) {
      state.server.send({ type: 'text', part: { text: 'x'.repeat(65_536) } });
    }
    state.server.send({ type: 'step_finish', part: { reason: 'stop' } });
    state.server.close();
    await expect(state.handle.done).resolves.toMatchObject({ status: 'failed', error: { code: 'RESPONSE_TOO_LARGE' } });
  });

  it('registers and correlates the uploaded-source tool without map mutation tools', async () => {
    const state = await start({ tools: [{ name: 'read_cartography_source', description: 'Read source.', inputSchema: { type: 'object', properties: { fileName: { type: 'string' } }, required: ['fileName'] } }] });
    const source = await readFile(state.pluginPath, 'utf8');
    const surface = await loadGeneratedPlugin({ source, env: state.spawnOptions.env });
    expect(Object.keys(surface.tool)).toEqual(['read_cartography_source']);
    state.server.send({ type: 'tool_use', part: { tool: 'read_cartography_source', callID: 'read-1', state: { status: 'completed', input: { fileName: 'source.qgs' }, output: '{}' } } });
    state.server.close();
    await expect(state.handle.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(state.events).toContainEqual({ kind: 'tool_use', id: 'read-1', name: 'read_cartography_source', summary: {} });
  });

  it('returns only the final step when a prior step contains progress text', async () => {
    const state = await start({ input: runInput(undefined, { taskKind: 'cartography' }) });
    state.server.send({ type: 'step_start', sessionID: 'ses_1', part: {} });
    state.server.send({ type: 'text', part: { text: 'Checking the uploaded source.' } });
    state.server.send({ type: 'step_finish', part: { reason: 'tool-calls' } });
    state.server.send({ type: 'step_start', sessionID: 'ses_1', part: {} });
    state.server.send({ type: 'text', part: { text: '{"source":"complete"}' } });
    state.server.send({ type: 'step_finish', part: { reason: 'stop' } });
    state.server.close();
    await expect(state.handle.done).resolves.toMatchObject({ status: 'succeeded', finalResponse: '{"source":"complete"}' });
  });

  it('rejects a token-limited response despite a successful process exit', async () => {
    const state = await start({ input: runInput(undefined, { taskKind: 'cartography' }) });
    state.server.send({ type: 'step_start', sessionID: 'ses_1', part: {} });
    state.server.send({ type: 'text', part: { text: '{"source":' } });
    state.server.send({ type: 'step_finish', part: { reason: 'length' } });
    state.server.close();
    await expect(state.handle.done).resolves.toMatchObject({ status: 'failed', error: { code: 'RESPONSE_TRUNCATED' } });
  });
});

defineMapAgentAdapterConformance('OpenCode run-scoped plugin', {
  async registration() {
    const state = await start();
    const source = await readFile(state.pluginPath, 'utf8');
    const surface = await loadGeneratedPlugin({ source, env: state.spawnOptions.env });
    expect(Object.keys(surface.tool)).toEqual(TOOLS.map((tool) => tool.name));
    state.server.close(0);
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
  },
  async correlatedResult() {
    const state = await start();
    const source = await readFile(state.pluginPath, 'utf8');
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const id = new Headers(init?.headers).get('x-map-design-tool-use-id');
      return new Response(JSON.stringify({ ok: true, toolUseId: id, summary: { valid: true } }));
    }));
    const surface = await loadGeneratedPlugin({ source, env: state.spawnOptions.env });
    await expect(surface.tool.map_validate!.execute(
      { expectedRevision: 4 },
      { abort: new AbortController().signal },
    )).resolves.toBe('{"valid":true}');
    state.server.close(0);
    await state.handle.done;
  },
  async normalizedEvents() {
    const state = await start();
    state.server.send({ type: 'step_start', sessionID: 'ses_1', part: {} });
    state.server.send({ type: 'text', sessionID: 'ses_1', part: { text: 'Done.' } });
    state.server.send({
      type: 'tool_use', sessionID: 'ses_1',
      part: { tool: 'map_validate', callID: 'call-1', state: { status: 'completed', input: { expectedRevision: 4 }, output: { valid: true } } },
    });
    state.server.close(0);
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(state.events).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'text', text: 'Done.' },
      { kind: 'tool_use', id: 'call-1', name: 'map_validate', summary: {} },
      { kind: 'tool_result', toolUseId: 'call-1', status: 'succeeded', summary: { valid: true } },
      { kind: 'run_finished', status: 'succeeded' },
    ]);
  },
  async cancellation() {
    const state = await start();
    await Promise.all([state.handle.cancel(), state.handle.cancel()]);
    expect(state.server.kill).toHaveBeenCalledOnce();
    await expect(state.handle.done).resolves.toEqual({ status: 'canceled' });
  },
  async malformedAndOversizedFrames() {
    for (const frame of ['{broken}\n', `${'x'.repeat(1_025)}\n`]) {
      const state = await start({ maxFrameBytes: 1_024 });
      state.server.send(frame);
      await expect(state.handle.done).resolves.toMatchObject({ status: 'failed' });
    }
  },
  async duplicateCalls() {
    const state = await start();
    const frame = {
      type: 'tool_use', sessionID: 'ses_1',
      part: { tool: 'map_validate', callID: 'call-1', state: { status: 'completed', input: { expectedRevision: 4 }, output: { valid: true } } },
    };
    state.server.send(frame);
    state.server.send(frame);
    state.server.close(0);
    await state.handle.done;
    expect(state.events.filter((event) => event.kind === 'tool_use')).toHaveLength(1);
    expect(state.events.filter((event) => event.kind === 'tool_result')).toHaveLength(1);
  },
  async loopGuard() {
    const state = await start();
    for (let count = 1; count <= 8; count += 1) {
      state.server.send({
        type: 'tool_use', sessionID: 'ses_1',
        part: {
          tool: 'map_validate', callID: `call-${count}`,
          state: {
            status: 'error', input: { expectedRevision: 4 },
            error: { code: 'INVALID_INPUT', retryable: false },
          },
        },
      });
    }
    await expect(state.handle.done).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_LOOP_DETECTED' },
    });
  },
  async sessionResumeOrReseed() {
    const root = await pluginRoot();
    const sessionBroker = createMemoryMapAgentSessionBroker();
    const first = await start({ root, sessionBroker });
    first.server.send({ type: 'step_start', sessionID: 'ses_resume', part: {} });
    first.server.close(0);
    await first.handle.done;
    const second = await start({ root, sessionBroker, input: runInput(undefined, { runId: 'run-2' }) });
    expect(second.args).toContain('ses_resume');
    expect(second.server.input).toEqual(['Validate only the latest turn.']);
    second.server.close(0);
    await second.handle.done;
  },
  async lateEventRejection() {
    const state = await start();
    state.server.close(0);
    await state.handle.done;
    const terminal = structuredClone(state.events);
    state.server.send({ type: 'text', sessionID: 'ses_1', part: { text: 'late' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.events).toEqual(terminal);
  },
});

describe('OpenCode run-scoped plugin Map Agent adapter', () => {
  it('attaches screenshots as run-scoped PNG files and removes them after the run', async () => {
    const state = await start({
      input: runInput(undefined, {
        images: [{ data: Buffer.from('png bytes').toString('base64'), mimeType: 'image/png' }],
      }),
    });
    const fileFlag = state.args.indexOf('--file');
    expect(fileFlag).toBeGreaterThan(-1);
    const imagePath = state.args[fileFlag + 1]!;
    expect(await readFile(imagePath)).toEqual(Buffer.from('png bytes'));

    state.server.close(0);
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
    await vi.waitFor(async () => expect(await exists(imagePath)).toBe(false));
  });

  it('owns a staged lease across every synchronous setup boundary', async () => {
    for (const boundary of ['environment', 'args', 'spawn', 'stdio', 'parser'] as const) {
      const root = await pluginRoot();
      const leases: Array<Awaited<ReturnType<typeof trackedPluginLease>>> = [];
      const process = new FakeOpenCodeProcess();
      const stopProcess = vi.fn(async () => undefined);
      const stagePlugin = vi.fn(async (plugin: OpenCodeRunPlugin) => {
        const tracked = await trackedPluginLease(root, plugin);
        leases.push(tracked);
        return tracked.lease;
      });
      const definition = {
        ...opencodeAgentDef,
        bin: '/opt/opencode/bin/opencode',
        ...(boundary === 'args'
          ? { buildArgs: () => { throw new Error('args failed'); } }
          : {}),
      };
      const spawn = boundary === 'spawn'
        ? vi.fn<OpenCodePluginSpawn>(() => { throw new Error('spawn failed'); })
        : boundary === 'stdio'
          ? vi.fn<OpenCodePluginSpawn>(() => Object.assign(new EventEmitter(), {
              stdin: null, stdout: null, stderr: null, kill: () => true,
            }))
          : vi.fn<OpenCodePluginSpawn>(() => process.child);
      const adapter = createOpenCodeMapAgentAdapter({
        definition,
        toolDefinitions: () => TOOLS,
        pluginRoot: root,
        stagePlugin,
        spawn,
        stopProcess,
        environment: () => boundary === 'environment'
          ? { OPENCODE_CONFIG_CONTENT: '{' }
          : { PATH: '/usr/bin' },
        environmentKeys: () => ['OPENCODE_CONFIG_CONTENT'],
        ...(boundary === 'parser'
          ? { parserFactory: () => { throw new Error('parser failed'); } }
          : {}),
      });

      await expect(adapter.startMapRun(runInput(), TOOLS, () => undefined))
        .rejects.toThrow(/OpenCode native plugin protocol unavailable/u);
      expect(stagePlugin).toHaveBeenCalledOnce();
      expect(leases).toHaveLength(1);
      expect(leases[0]!.dispose).toHaveBeenCalledOnce();
      expect(await exists(leases[0]!.directory)).toBe(false);
      expect(stopProcess).toHaveBeenCalledTimes(boundary === 'stdio' || boundary === 'parser' ? 1 : 0);
    }
  });

  it('cleans the staged lease exactly once when stdin fails asynchronously', async () => {
    const root = await pluginRoot();
    const process = new FakeOpenCodeProcess();
    type TrackedLease = Awaited<ReturnType<typeof trackedPluginLease>>;
    let resolveTracked!: (lease: TrackedLease) => void;
    const trackedReady = new Promise<TrackedLease>((resolve) => { resolveTracked = resolve; });
    const stopProcess = vi.fn(async () => undefined);
    const adapter = createOpenCodeMapAgentAdapter({
      definition: { ...opencodeAgentDef, bin: '/opt/opencode/bin/opencode' },
      toolDefinitions: () => TOOLS,
      spawn: () => process.child,
      stopProcess,
      stagePlugin: async (plugin) => {
        const tracked = await trackedPluginLease(root, plugin);
        resolveTracked(tracked);
        return tracked.lease;
      },
      environment: () => ({ PATH: '/usr/bin' }),
    });
    const handle = await adapter.startMapRun(runInput(), TOOLS, () => undefined);
    const lease = await trackedReady;

    expect(() => process.stdin.emit('error', new Error('stdin failed'))).not.toThrow();

    await expect(handle.done).resolves.toMatchObject({ status: 'failed' });
    await vi.waitFor(() => expect(stopProcess).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(lease.dispose).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect(await exists(lease.directory)).toBe(false));
  });

  it('cleans a rejected resume and reseeds exactly once with the full prompt', async () => {
    const root = await pluginRoot();
    const input = runInput();
    const sessionBroker = createMemoryMapAgentSessionBroker();
    sessionBroker.save(mapAgentSessionScope(input, 'opencode'), 'ses_stale');
    const rejected = new FakeOpenCodeProcess();
    const replacement = new FakeOpenCodeProcess();
    const servers = [rejected, replacement];
    const spawn = vi.fn<OpenCodePluginSpawn>(() => servers.shift()!.child);
    const trackedLeases: Array<Awaited<ReturnType<typeof trackedPluginLease>>> = [];
    const stagePlugin = async (plugin: OpenCodeRunPlugin) => {
      const tracked = await trackedPluginLease(root, plugin);
      trackedLeases.push(tracked);
      return tracked.lease;
    };
    const events: MapAgentEvent[] = [];
    const adapter = createOpenCodeMapAgentAdapter({
      definition: { ...opencodeAgentDef, bin: '/opt/opencode/bin/opencode' },
      toolDefinitions: () => TOOLS,
      pluginRoot: root,
      sessionBroker,
      spawn,
      stagePlugin,
    });

    const handle = await adapter.startMapRun(input, TOOLS, (event) => events.push(event));
    const firstArgs = spawn.mock.calls[0]![1];
    const firstEnvironment = spawn.mock.calls[0]![2].env;
    const firstConfig = JSON.parse(String(firstEnvironment.OPENCODE_CONFIG_CONTENT)) as { plugin: string[] };
    const firstPluginPath = fileURLToPath(firstConfig.plugin.at(-1)!);
    expect(firstArgs).toContain('ses_stale');
    expect(rejected.input).toEqual([input.resumePrompt]);

    rejected.stderr.write('Error: Session not found\n');
    rejected.close(1);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

    const replacementArgs = spawn.mock.calls[1]![1];
    const replacementEnvironment = spawn.mock.calls[1]![2].env;
    const replacementConfig = JSON.parse(String(replacementEnvironment.OPENCODE_CONFIG_CONTENT)) as { plugin: string[] };
    const replacementPluginPath = fileURLToPath(replacementConfig.plugin.at(-1)!);
    expect(replacementArgs).not.toContain('-s');
    expect(replacement.input).toEqual([input.prompt]);
    expect(replacementPluginPath).not.toBe(firstPluginPath);
    expect(await exists(firstPluginPath)).toBe(false);
    expect(await exists(replacementPluginPath)).toBe(true);

    replacement.send({ type: 'step_start', sessionID: 'ses_replacement', part: {} });
    replacement.close(0);
    await expect(handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(sessionBroker.load(mapAgentSessionScope(input, 'opencode'))).toBe('ses_replacement');
    expect(events.filter((event) => event.kind === 'run_finished')).toEqual([
      { kind: 'run_finished', status: 'succeeded' },
    ]);
    await vi.waitFor(() => expect(trackedLeases.map((lease) => lease.dispose.mock.calls.length)).toEqual([1, 1]));
    await vi.waitFor(async () => expect(
      await Promise.all(trackedLeases.map((lease) => exists(lease.directory))),
    ).toEqual([false, false]));
  });

  it.each([
    ['exit zero', 0, 'Error: Session not found\n', false, true],
    ['exit two', 2, 'Error: Session not found\n', false, true],
    ['signal exit', null, 'Error: Session not found\n', false, true],
    ['arbitrary stderr', 1, 'Provider failed: Session not found\n', false, true],
    ['post-output failure', 1, 'Error: Session not found\n', true, true],
    ['non-resume argv', 1, 'Error: Session not found\n', false, false],
    ['overflowed rejection stderr', 1, `Error: Session not found\n${' '.repeat(9_000)}`, false, true],
  ] as const)(
    'does not reseed for %s outside the exact OpenCode rejection shape',
    async (_label, exitCode, stderr, substantive, actualResumeArgv) => {
      const root = await pluginRoot();
      const input = runInput();
      const sessionBroker = createMemoryMapAgentSessionBroker();
      sessionBroker.save(mapAgentSessionScope(input, 'opencode'), 'ses_stale');
      const first = new FakeOpenCodeProcess();
      const replacement = new FakeOpenCodeProcess();
      const servers = [first, replacement];
      const spawn = vi.fn<OpenCodePluginSpawn>(() => servers.shift()!.child);
      const definition = actualResumeArgv
        ? { ...opencodeAgentDef, bin: '/opt/opencode/bin/opencode' }
        : {
            ...opencodeAgentDef,
            bin: '/opt/opencode/bin/opencode',
            buildArgs: () => ['run', '--format', 'json'],
          };
      const adapter = createOpenCodeMapAgentAdapter({
        definition,
        toolDefinitions: () => TOOLS,
        pluginRoot: root,
        sessionBroker,
        spawn,
      });
      const handle = await adapter.startMapRun(input, TOOLS, () => undefined);
      if (substantive) {
        first.send({ type: 'text', sessionID: 'ses_stale', part: { text: 'Partial answer.' } });
      }
      first.stderr.write(stderr);
      first.close(exitCode);
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (spawn.mock.calls.length > 1) replacement.close(1);
      await handle.done;

      expect(spawn).toHaveBeenCalledOnce();
    },
  );

  it('never loops a reseed or retries a rejected resume after substantive output', async () => {
    for (const substantiveOutput of [false, true]) {
      const root = await pluginRoot();
      const input = runInput(undefined, { runId: `run-${String(substantiveOutput)}` });
      const sessionBroker = createMemoryMapAgentSessionBroker();
      sessionBroker.save(mapAgentSessionScope(input, 'opencode'), 'ses_stale');
      const first = new FakeOpenCodeProcess();
      const second = new FakeOpenCodeProcess();
      const servers = [first, second];
      const spawn = vi.fn<OpenCodePluginSpawn>(() => servers.shift()!.child);
      const adapter = createOpenCodeMapAgentAdapter({
        definition: { ...opencodeAgentDef, bin: '/opt/opencode/bin/opencode' },
        toolDefinitions: () => TOOLS,
        pluginRoot: root,
        sessionBroker,
        spawn,
      });
      const handle = await adapter.startMapRun(input, TOOLS, () => undefined);
      if (substantiveOutput) {
        first.send({ type: 'text', sessionID: 'ses_stale', part: { text: 'Partial answer.' } });
      }
      first.stderr.write('Session not found\n');
      first.close(1);

      if (substantiveOutput) {
        await expect(handle.done).resolves.toMatchObject({ status: 'failed' });
        expect(spawn).toHaveBeenCalledOnce();
      } else {
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
        second.stderr.write('Session not found\n');
        second.close(1);
        await expect(handle.done).resolves.toMatchObject({ status: 'failed' });
        expect(spawn).toHaveBeenCalledTimes(2);
      }
      expect(sessionBroker.load(mapAgentSessionScope(input, 'opencode'))).toBeNull();
    }
  });

  it('strips an ambient probe path from normal Runs without writing or failing', async () => {
    const root = await pluginRoot();
    const ambientProbePath = join(root, 'must-not-change.json');
    await writeFile(ambientProbePath, 'operator-owned', 'utf8');
    const state = await start({
      root,
      environment: {
        PATH: '/usr/bin',
        HOME: '/safe/home',
        TMPDIR: '/safe/tmp',
        LANG: 'en_US.UTF-8',
        OPENAI_API_KEY: 'selected-provider-secret',
        AWS_SECRET_ACCESS_KEY: 'ambient-aws-secret',
        DATABASE_URL: 'postgres://ambient-secret',
        UNRELATED_SECRET: 'secret-value',
        MAP_DESIGN_API_TOKEN: 'daemon-api-secret',
        MAP_DESIGN_DATA_DIR: '/private/daemon-data',
        MAP_DESIGN_TOOL_CALLBACK_TOKEN: 'stale-callback-token',
        MAP_DESIGN_RUN_ID: 'stale-run',
        MAP_DESIGN_PROJECT_ID: 'stale-project',
        MAP_DESIGN_CONVERSATION_ID: 'stale-conversation',
        MAP_DESIGN_AGENT_ID: 'stale-agent',
        MAP_DESIGN_PLUGIN_PROBE_PATH: ambientProbePath,
        MAP_DESIGN_PROFILE_PROBE_TOOLS: 'stale-tools',
        DSH_HOME: '/private/stale-profile-home',
      },
    });
    const source = await readFile(state.pluginPath, 'utf8');

    expect(state.spawnOptions.env).not.toHaveProperty('MAP_DESIGN_PLUGIN_PROBE_PATH');
    expect(state.spawnOptions.env).toMatchObject({
      PATH: '/usr/bin', HOME: '/safe/home', TMPDIR: '/safe/tmp', LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'selected-provider-secret',
    });
    expect(state.spawnOptions.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(state.spawnOptions.env).not.toHaveProperty('DATABASE_URL');
    expect(state.spawnOptions.env).not.toHaveProperty('UNRELATED_SECRET');
    expect(Object.keys(state.spawnOptions.env).filter((key) => key.startsWith('MAP_DESIGN_')).sort()).toEqual([
      'MAP_DESIGN_AGENT_ID',
      'MAP_DESIGN_CONVERSATION_ID',
      'MAP_DESIGN_PROJECT_ID',
      'MAP_DESIGN_RUN_ID',
      'MAP_DESIGN_TOOL_CALLBACK_TOKEN',
      'MAP_DESIGN_TOOL_CALLBACK_URL',
    ]);
    expect(state.spawnOptions.env).not.toHaveProperty('DSH_HOME');
    await expect(loadGeneratedPlugin({ source, env: state.spawnOptions.env })).resolves.toMatchObject({
      tool: { map_validate: expect.any(Object) },
    });
    await expect(readFile(ambientProbePath, 'utf8')).resolves.toBe('operator-owned');

    state.server.close(0);
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
  });

  it('stages exact tool definitions without embedding callback authority in source or argv', async () => {
    const state = await start();
    const source = await readFile(state.pluginPath, 'utf8');

    expect(source).not.toContain('test-only-secret-token');
    expect(state.args.join(' ')).not.toContain('test-only-secret-token');
    expect(state.spawnOptions.env).toMatchObject({
      MAP_DESIGN_TOOL_CALLBACK_URL: expect.any(String),
      MAP_DESIGN_TOOL_CALLBACK_TOKEN: 'test-only-secret-token',
      MAP_DESIGN_RUN_ID: 'run-1',
      MAP_DESIGN_PROJECT_ID: 'project-1',
      MAP_DESIGN_CONVERSATION_ID: 'conversation-1',
      MAP_DESIGN_AGENT_ID: 'opencode',
    });
    const surface = await loadGeneratedPlugin({ source, env: state.spawnOptions.env });
    expect(Object.entries(surface.tool).map(([name, value]) => ({
      name,
      description: value.description,
      args: z.toJSONSchema(z.object(value.args)).properties ?? {},
    }))).toMatchObject(TOOLS.map((definition) => ({
      name: definition.name,
      description: definition.description,
      args: (definition.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
    })));

    state.server.close(0);
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
  });

  it('posts exact input with bearer and complete Run identity, returning bounded model content', async () => {
    const state = await start();
    const source = await readFile(state.pluginPath, 'utf8');
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer test-only-secret-token');
      expect(headers.get('x-map-design-run-id')).toBe('run-1');
      expect(headers.get('x-map-design-project-id')).toBe('project-1');
      expect(headers.get('x-map-design-conversation-id')).toBe('conversation-1');
      expect(headers.get('x-map-design-agent-id')).toBe('opencode');
      expect(headers.get('x-map-design-tool-use-id')).toMatch(/^[0-9a-f-]{36}$/u);
      expect(init?.body).toBe('{"expectedRevision":4}');
      return new Response(JSON.stringify({
        ok: true,
        toolUseId: headers.get('x-map-design-tool-use-id'),
        summary: { valid: true },
        modelContent: '{"valid":true}',
      }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    const surface = await loadGeneratedPlugin({ source, env: state.spawnOptions.env });

    await expect(surface.tool.map_validate!.execute(
      { expectedRevision: 4 },
      { abort: new AbortController().signal },
    )).resolves.toBe('{"valid":true}');
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/map-design/tools/map_validate',
      expect.objectContaining({ method: 'POST' }),
    );

    state.server.close(0);
    await state.handle.done;
  });

  it('preserves existing config, forwards model variant, captures a session, and resumes it', async () => {
    const root = await pluginRoot();
    const sessionBroker = createMemoryMapAgentSessionBroker();
    const first = await start({ root, sessionBroker });
    expect(first.args).toEqual([
      'run', '--format', 'json', '-m', 'openai/gpt-5.6-terra', '--variant', 'high',
    ]);
    expect(first.config).toMatchObject({
      mcp: { existing: { type: 'remote', url: 'http://127.0.0.1:9000/mcp' } },
      plugin: [expect.stringMatching(/^file:/u)],
    });
    first.server.send({ type: 'step_start', sessionID: 'ses_opencode_1', part: {} });
    first.server.close(0);
    await first.handle.done;

    const second = await start({
      root,
      sessionBroker,
      input: runInput(undefined, { runId: 'run-2' }),
    });
    expect(second.args).toEqual([
      'run', '--format', 'json', '-s', 'ses_opencode_1',
      '-m', 'openai/gpt-5.6-terra', '--variant', 'high',
    ]);
    expect(second.server.input.join('')).toBe('Validate only the latest turn.');
    second.server.close(0);
    await second.handle.done;
  });

  it('normalizes OpenCode JSON events and rejects duplicate or late events', async () => {
    const state = await start();
    state.server.send({ type: 'step_start', sessionID: 'ses_1', part: {} });
    state.server.send({ type: 'text', sessionID: 'ses_1', part: { text: 'Valid.' } });
    const completed = {
      type: 'tool_use', sessionID: 'ses_1',
      part: { tool: 'map_validate', callID: 'call-1', state: { status: 'completed', input: { expectedRevision: 4 }, output: { valid: true } } },
    };
    state.server.send(completed);
    state.server.send(completed);
    state.server.close(0);
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(state.events).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'text', text: 'Valid.' },
      { kind: 'tool_use', id: 'call-1', name: 'map_validate', summary: {} },
      { kind: 'tool_result', toolUseId: 'call-1', status: 'succeeded', summary: { valid: true } },
      { kind: 'run_finished', status: 'succeeded' },
    ]);
    state.server.send({ type: 'text', sessionID: 'ses_1', part: { text: 'late' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.events.at(-1)).toEqual({ kind: 'run_finished', status: 'succeeded' });
  });

  it('cancels exactly once and removes the private plugin after terminal state', async () => {
    const state = await start();
    expect(await exists(state.pluginPath)).toBe(true);

    await Promise.all([state.handle.cancel(), state.handle.cancel()]);

    await expect(state.handle.done).resolves.toEqual({ status: 'canceled' });
    expect(state.server.kill).toHaveBeenCalledOnce();
    await vi.waitFor(async () => expect(await exists(state.pluginPath)).toBe(false));
  });

  it.each([
    ['malformed', '{not-json}\n', 1_024],
    ['oversized', `${'x'.repeat(1_025)}\n`, 1_024],
  ])('fails closed on a %s stdout frame and cleans the plugin', async (_label, frame, maxFrameBytes) => {
    const state = await start({ maxFrameBytes });
    state.server.send(frame);

    await expect(state.handle.done).resolves.toMatchObject({ status: 'failed' });
    await vi.waitFor(async () => expect(await exists(state.pluginPath)).toBe(false));
  });

  it('rejects oversized callback input and result bodies inside the plugin', async () => {
    const state = await start();
    const source = await readFile(state.pluginPath, 'utf8');
    const surface = await loadGeneratedPlugin({ source, env: state.spawnOptions.env });

    await expect(surface.tool.map_validate!.execute(
      { payload: 'x'.repeat(300_000) },
      { abort: new AbortController().signal },
    )).rejects.toThrow('input is too large');

    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const toolUseId = new Headers(init?.headers).get('x-map-design-tool-use-id');
      return new Response(JSON.stringify({ ok: true, toolUseId, summary: {}, modelContent: 'x'.repeat(300_000) }));
    }));
    await expect(surface.tool.map_validate!.execute(
      { expectedRevision: 4 },
      { abort: new AbortController().signal },
    )).rejects.toThrow('result is too large');

    state.server.close(0);
    await state.handle.done;
  });

  it('probes the actual loaded plugin tool surface without changing project or global config', async () => {
    const root = await pluginRoot();
    const server = new FakeOpenCodeProcess();
    const spawn = vi.fn((_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(args).toEqual(['debug', 'agent', 'build']);
      queueMicrotask(async () => {
        const config = JSON.parse(String(options.env.OPENCODE_CONFIG_CONTENT)) as { plugin: string[] };
        const source = await readFile(fileURLToPath(config.plugin[0]!), 'utf8');
        await loadGeneratedPlugin({ source, env: options.env });
        server.close(0);
      });
      return server.child;
    });

    await expect(probeOpenCodeNativeMapTools({
      definition: { ...opencodeAgentDef, bin: '/opt/opencode/bin/opencode' },
      toolDefinitions: () => TOOLS,
      pluginRoot: root,
      environment: () => ({
        PATH: '/usr/bin',
        HOME: '/safe/home',
        TMPDIR: '/safe/tmp',
        LANG: 'en_US.UTF-8',
        OPENAI_API_KEY: 'selected-provider-secret',
        AWS_SECRET_ACCESS_KEY: 'ambient-aws-secret',
        DATABASE_URL: 'postgres://ambient-secret',
        UNRELATED_SECRET: 'secret-value',
        MAP_DESIGN_API_TOKEN: 'daemon-api-secret',
        MAP_DESIGN_DATA_DIR: '/private/daemon-data',
        MAP_DESIGN_TOOL_CALLBACK_TOKEN: 'stale-callback-token',
        MAP_DESIGN_RUN_ID: 'stale-run',
        DSH_HOME: '/private/stale-profile-home',
        OPENCODE_CONFIG_CONTENT: '{"mcp":{"existing":{"type":"local","command":["safe"]}}}',
      }),
      spawn,
    })).resolves.toBe(true);

    expect(spawn).toHaveBeenCalledOnce();
    const probeEnvironment = spawn.mock.calls[0]?.[2].env;
    expect(probeEnvironment).toMatchObject({
      PATH: '/usr/bin', HOME: '/safe/home', TMPDIR: '/safe/tmp', LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'selected-provider-secret',
    });
    expect(probeEnvironment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(probeEnvironment).not.toHaveProperty('DATABASE_URL');
    expect(probeEnvironment).not.toHaveProperty('UNRELATED_SECRET');
    expect(Object.keys(probeEnvironment ?? {}).filter((key) => key.startsWith('MAP_DESIGN_'))).toEqual([
      'MAP_DESIGN_PLUGIN_PROBE_PATH',
    ]);
    expect(probeEnvironment).not.toHaveProperty('DSH_HOME');
    expect(await exists(join(root, '.opencode'))).toBe(false);
  });

  it('registers the production OpenCode factory and gates it on the plugin surface probe', async () => {
    const server = new FakeOpenCodeProcess();
    const spawn = vi.fn((_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(args).toEqual(['debug', 'agent', 'build']);
      queueMicrotask(async () => {
        const config = JSON.parse(String(options.env.OPENCODE_CONFIG_CONTENT)) as { plugin: string[] };
        const source = await readFile(fileURLToPath(config.plugin.at(-1)!), 'utf8');
        await loadGeneratedPlugin({ source, env: options.env });
        server.close(0);
      });
      return server.child;
    });
    const registry = createLocalAgentRegistry({
      definitions: [{ ...opencodeAgentDef, bin: process.execPath, fallbackBins: [] }],
      nativeToolRegistry: { definitions: () => TOOLS, call: vi.fn() },
      config: { read: () => ({ agentCliEnv: { opencode: { OPENCODE_BIN: process.execPath } } }) },
      spawn,
      stageSkill: async () => undefined,
    });

    await registry.probeNativeMapTools();

    expect(registry.list()).toMatchObject([{ id: 'opencode', mapDesign: { nativeMapTools: true } }]);
    expect(registry.getMapAgent?.('opencode')).toMatchObject({ id: 'opencode' });
  });
});
