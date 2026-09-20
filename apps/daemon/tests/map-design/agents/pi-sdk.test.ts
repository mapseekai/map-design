import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPiMapAgentAdapter,
  probePiNativeMapTools,
  type PiSdkSpawn,
} from '../../../src/map-design/agents/pi-sdk.js';
import { createLocalAgentRegistry } from '../../../src/map-design/application/local-agent-registry.js';
import type {
  MapAgentAdapter,
  MapAgentEvent,
  MapRunInput,
} from '../../../src/map-design/agents/types.js';
import type { NativeMapToolDefinition } from '../../../src/map-design/tools/tool-context.js';
import {
  createMemoryMapAgentSessionBroker,
  mapAgentSessionScope,
  type MapAgentSessionBroker,
} from '../../../src/map-design/agents/session-broker.js';
import { defineMapAgentAdapterConformance } from './adapter-conformance.js';

type Frame = Record<string, unknown>;
type PiExtensionTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string | symbol, unknown>;
  execute(
    toolCallId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text: string }>; details: { summary: unknown } }>;
};

class FakePiRpc {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.child.emit('close', null));
    return true;
  });
  readonly child = Object.assign(new EventEmitter(), {
    pid: 5432,
    stdin: this.stdin,
    stdout: this.stdout,
    stderr: this.stderr,
    kill: this.kill,
  });
  readonly receivedFrames: Frame[] = [];

  private input = '';
  private readonly frames: Frame[] = [];
  private readonly waiters: Array<(frame: Frame) => void> = [];

  constructor(private readonly label = 'unnamed') {
    this.stdin.on('data', (chunk: Buffer | string) => {
      this.input += String(chunk);
      while (this.input.includes('\n')) {
        const newline = this.input.indexOf('\n');
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        if (!line) continue;
        const frame = JSON.parse(line) as Frame;
        this.receivedFrames.push(frame);
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame);
        else this.frames.push(frame);
      }
    });
  }

  send(frame: Frame | string): void {
    this.stdout.write(typeof frame === 'string' ? frame : `${JSON.stringify(frame)}\n`);
  }

  close(code: number | null = 0): void {
    this.child.emit('close', code);
  }

  async nextClientFrame(timeoutMs = 1_000): Promise<Frame> {
    const frame = this.frames.shift();
    if (frame) return frame;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for a Pi client frame from ${this.label}.`)), timeoutMs);
      this.waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
}

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
      properties: { expectedRevision: { type: 'integer' } },
      required: ['expectedRevision'],
    },
  },
];

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function extensionRoot(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), 'map-design-pi-test-'));
  roots.push(root);
  return root;
}

function runInput(
  signal = new AbortController().signal,
  execute: MapRunInput['toolRuntime']['execute'] = vi.fn(async (call) => ({
    ok: true as const,
    toolUseId: call.toolUseId,
    summary: { valid: true },
    modelContent: '{"valid":true}',
  })),
  overrides: Partial<MapRunInput> = {},
): MapRunInput {
  return {
    runId: 'run-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    prompt: 'validate',
    resumePrompt: 'validate latest turn only',
    cwd: '/safe/project',
    model: 'anthropic/claude-sonnet-4-5',
    reasoning: 'high',
    serviceTier: null,
    toolRuntime: { execute, closeRun: () => undefined },
    toolCallback: {
      url: 'http://127.0.0.1:8787/api/map-design/tools',
      token: 'test-token',
      close: () => undefined,
    },
    signal,
    ...overrides,
  };
}

function response(request: Frame, data?: unknown, success = true): Frame {
  return {
    id: request.id,
    type: 'response',
    command: request.type,
    success,
    ...(success ? (data === undefined ? {} : { data }) : { error: 'session unavailable' }),
  };
}

function settlesWithin(promise: Promise<unknown>, timeoutMs = 50): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function loadExtension(path: string): Promise<{
  tools: PiExtensionTool[];
  flags: string[];
}> {
  const href = `${pathToFileURL(path).href}?test=${Math.random()}`;
  const loaded = await import(href) as {
    default(api: {
      registerTool(tool: PiExtensionTool): void;
      registerFlag(name: string): void;
    }): void;
  };
  const tools: PiExtensionTool[] = [];
  const flags: string[] = [];
  loaded.default({
    registerTool: (tool) => tools.push(tool),
    registerFlag: (name) => flags.push(name),
  });
  return { tools, flags };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function start(options: {
  adapter?: MapAgentAdapter;
  server?: FakePiRpc;
  replacementServer?: FakePiRpc;
  input?: MapRunInput;
  events?: MapAgentEvent[];
  root?: string;
  resumePath?: string;
  rejectResume?: boolean;
  resumedCancelled?: boolean;
  sessionFile?: string | null;
  promptResponseAndFrame?: Frame;
  maxFrameBytes?: number;
  stopProcess?: () => Promise<void>;
  spawn?: ReturnType<typeof vi.fn<PiSdkSpawn>>;
} = {}) {
  const root = options.root ?? await extensionRoot();
  const server = options.server ?? new FakePiRpc();
  const events = options.events ?? [];
  const spawn = options.spawn ?? vi.fn<PiSdkSpawn>(() => server.child);
  const adapter = options.adapter ?? createPiMapAgentAdapter({
    definition: { id: 'pi', bin: '/opt/pi/bin/pi' },
    toolDefinitions: () => TOOLS,
    extensionRoot: root,
    spawn,
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    ...(options.stopProcess === undefined ? {} : { stopProcess: options.stopProcess }),
  });
  const spawnCallIndex = spawn.mock.calls.length;
  const run = options.input ?? runInput();
  const starting = adapter.startMapRun(run, TOOLS, (event) => events.push(event));
  await vi.waitFor(() => expect(spawn.mock.calls.length).toBe(spawnCallIndex + 1));
  const [, args, spawnOptions] = spawn.mock.calls[spawnCallIndex]!;
  expect(args).toEqual([
    '--mode', 'rpc', '--no-extensions', '--no-builtin-tools', '--extension', expect.any(String),
    '--model', 'anthropic/claude-sonnet-4-5', '--thinking', 'high',
  ]);
  expect(spawnOptions).toMatchObject({ cwd: '/safe/project', detached: expect.any(Boolean) });
  const extensionPath = args[5]!;
  if (!options.adapter || options.root !== undefined) {
    expect(extensionPath.startsWith(`${root}/`)).toBe(true);
  }
  expect(extensionPath).not.toContain('/.pi/extensions/');

  let activeServer = server;
  if (options.resumePath) {
    const resume = await server.nextClientFrame();
    expect(resume).toEqual({ id: expect.any(String), type: 'switch_session', sessionPath: options.resumePath });
    server.send(response(
      resume,
      options.rejectResume ? undefined : { cancelled: options.resumedCancelled === true },
      options.rejectResume !== true,
    ));
    if ((options.rejectResume || options.resumedCancelled) && options.replacementServer) {
      activeServer = options.replacementServer;
      await vi.waitFor(() => expect(spawn.mock.calls.length).toBe(spawnCallIndex + 2));
    }
  }

  const getState = await activeServer.nextClientFrame();
  expect(getState).toEqual({ id: expect.any(String), type: 'get_state' });
  activeServer.send(response(getState, options.sessionFile === null ? {} : {
    sessionFile: options.sessionFile ?? '/safe/sessions/pi-1.jsonl',
  }));
  const prompt = await activeServer.nextClientFrame();
  const resumed = Boolean(options.resumePath) && !options.rejectResume && !options.resumedCancelled;
  expect(prompt).toEqual({
    id: expect.any(String),
    type: 'prompt',
    message: resumed ? 'validate latest turn only' : 'validate',
    ...(run.images?.length ? {
      images: run.images.map((image) => ({ type: 'image', ...image })),
    } : {}),
  });
  if (options.promptResponseAndFrame) {
    activeServer.send(`${JSON.stringify(response(prompt))}\n${JSON.stringify(options.promptResponseAndFrame)}\n`);
  } else {
    activeServer.send(response(prompt));
  }
  return {
    adapter,
    events,
    extensionPath,
    handle: await starting,
    root,
    server: activeServer,
    spawn,
  };
}

it('sends screenshots as Pi image blocks', async () => {
  const state = await start({
    input: runInput(undefined, undefined, {
      images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
    }),
  });
  state.server.send({ type: 'agent_end', messages: [], willRetry: false });
  state.server.send({ type: 'agent_settled' });
  await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
});

it('accepts an outbound multimodal frame above the shared RPC default', async () => {
  const state = await start({
    input: runInput(undefined, undefined, {
      images: [{ data: 'A'.repeat(1_100_000), mimeType: 'image/png' }],
    }),
  });
  state.server.send({ type: 'agent_end', messages: [], willRetry: false });
  state.server.send({ type: 'agent_settled' });
  await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
});

function settle(server: FakePiRpc, messages: unknown[] = []): void {
  server.send({ type: 'agent_end', messages, willRetry: false });
  server.send({ type: 'agent_settled' });
}

function bridgeFetch(input: MapRunInput) {
  return vi.fn(async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const name = String(url).split('/').at(-1) as NativeMapToolDefinition['name'];
    const result = await input.toolRuntime.execute({
      runId: headers.get('x-map-design-run-id')!,
      projectId: headers.get('x-map-design-project-id')!,
      conversationId: headers.get('x-map-design-conversation-id')!,
      agentId: headers.get('x-map-design-agent-id')!,
      toolUseId: headers.get('x-map-design-tool-use-id')!,
      name,
      input: JSON.parse(String(init?.body)),
      signal: init?.signal as AbortSignal,
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

defineMapAgentAdapterConformance('Pi run-scoped extension', {
  async registration() {
    const state = await start();
    const registered = await loadExtension(state.extensionPath);
    expect(registered.tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: JSON.parse(JSON.stringify(tool.parameters)),
    }))).toEqual(TOOLS.map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })));
    settle(state.server);
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
  },
  async correlatedResult() {
    const execute = vi.fn(async (call: { toolUseId: string }) => ({
      ok: true as const,
      toolUseId: call.toolUseId,
      summary: { valid: true },
      modelContent: '{"valid":true}',
    }));
    const input = runInput(undefined, execute);
    vi.stubGlobal('fetch', bridgeFetch(input));
    const state = await start({ input });
    const registered = await loadExtension(state.extensionPath);
    const result = await registered.tools[1]!.execute(
      'tool-1',
      { expectedRevision: 4 },
      new AbortController().signal,
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"valid":true}' }],
      details: { summary: { valid: true } },
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      agentId: 'pi',
      toolUseId: 'tool-1',
      name: 'map_validate',
      input: { expectedRevision: 4 },
      signal: expect.any(AbortSignal),
    }));
    state.server.send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'map_validate', args: { expectedRevision: 4 } });
    state.server.send({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'map_validate', result, isError: false });
    settle(state.server);
    await state.handle.done;
    expect(state.events).toContainEqual({ kind: 'tool_result', toolUseId: 'tool-1', status: 'succeeded', summary: { valid: true } });
  },
  async normalizedEvents() {
    const state = await start();
    state.server.send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Checking.' } });
    state.server.send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Valid.' } });
    state.server.send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'map_validate', args: { expectedRevision: 4 } });
    state.server.send({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'map_validate',
      result: { content: [{ type: 'text', text: '{"valid":true}' }], details: { summary: { valid: true } } },
      isError: false,
    });
    settle(state.server);
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(state.events).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'text', text: 'Valid.' },
      { kind: 'tool_use', id: 'tool-1', name: 'map_validate', summary: {} },
      { kind: 'tool_result', toolUseId: 'tool-1', status: 'succeeded', summary: { valid: true } },
      { kind: 'run_finished', status: 'succeeded' },
    ]);
  },
  async cancellation() {
    const state = await start();
    const first = state.handle.cancel();
    const second = state.handle.cancel();
    const abort = await state.server.nextClientFrame();
    expect(abort).toEqual({ id: expect.any(String), type: 'abort' });
    state.server.send(response(abort));
    await Promise.all([first, second]);
    await expect(state.handle.done).resolves.toEqual({ status: 'canceled' });
    expect(await settlesWithin(state.server.nextClientFrame(), 20)).toBe(false);
  },
  async malformedAndOversizedFrames() {
    for (const frame of ['{nope}\n', `${'x'.repeat(1_025)}\n`]) {
      const state = await start({ maxFrameBytes: 1_024 });
      state.server.send(frame);
      await expect(state.handle.done).resolves.toMatchObject({ status: 'failed' });
    }
  },
  async duplicateCalls() {
    let release!: () => void;
    const fetch = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response(JSON.stringify({
        ok: true,
        toolUseId: 'tool-1',
        summary: { valid: true },
      }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    const state = await start();
    const registered = await loadExtension(state.extensionPath);
    const first = registered.tools[1]!.execute('tool-1', { expectedRevision: 4 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await expect(registered.tools[1]!.execute('tool-1', { expectedRevision: 4 }))
      .rejects.toThrow('Duplicate Pi tool call identifier.');
    release();
    await expect(first).resolves.toMatchObject({ details: { summary: { valid: true } } });
    expect(fetch).toHaveBeenCalledOnce();
    const cancelling = state.handle.cancel();
    const abort = await state.server.nextClientFrame();
    state.server.send(response(abort));
    await cancelling;
  },
  async loopGuard() {
    const state = await start();
    for (let count = 1; count <= 8; count += 1) {
      state.server.send({
        type: 'tool_execution_start',
        toolCallId: `tool-${count}`,
        toolName: 'map_validate',
        args: { expectedRevision: 4 },
      });
      state.server.send({
        type: 'tool_execution_end',
        toolCallId: `tool-${count}`,
        toolName: 'map_validate',
        result: { content: [{ type: 'text', text: '{"code":"INVALID_INPUT","retryable":false}' }] },
        isError: true,
      });
    }
    await expect(state.handle.done).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_LOOP_DETECTED' },
    });
    await expect(state.server.nextClientFrame()).resolves.toMatchObject({ type: 'abort' });
  },
  async sessionResumeOrReseed() {
    const root = await extensionRoot();
    const firstServer = new FakePiRpc();
    const secondServer = new FakePiRpc();
    const reseedServer = new FakePiRpc();
    const isolatedServer = new FakePiRpc();
    const servers = [firstServer, secondServer, reseedServer, isolatedServer];
    const spawn = vi.fn(() => servers.shift()!.child);
    const adapter = createPiMapAgentAdapter({
      definition: { id: 'pi', bin: '/opt/pi/bin/pi' },
      toolDefinitions: () => TOOLS,
      extensionRoot: root,
      spawn,
    });
    const first = await start({ adapter, server: firstServer, root, spawn, sessionFile: '/safe/sessions/pi-1.jsonl' });
    settle(firstServer);
    await first.handle.done;
    const second = await start({
      adapter,
      server: secondServer,
      replacementServer: reseedServer,
      root,
      spawn,
      resumePath: '/safe/sessions/pi-1.jsonl',
      rejectResume: true,
      sessionFile: '/safe/sessions/pi-2.jsonl',
      input: runInput(undefined, undefined, { runId: 'run-2' }),
    });
    settle(second.server);
    await second.handle.done;
    const isolated = await start({
      adapter,
      server: isolatedServer,
      root,
      spawn,
      sessionFile: '/safe/sessions/pi-isolated.jsonl',
      input: runInput(undefined, undefined, {
        runId: 'run-3',
        conversationId: 'conversation-2',
      }),
    });
    settle(isolatedServer);
    await isolated.handle.done;
    expect(spawn).toHaveBeenCalledTimes(4);
  },
  async lateEventRejection() {
    const state = await start();
    settle(state.server);
    await state.handle.done;
    const terminalEvents = structuredClone(state.events);
    state.server.send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.events).toEqual(terminalEvents);
  },
});

describe('Pi run-scoped extension Map Agent adapter', () => {
  it('sanitizes daemon-private values for both Run and probe children', async () => {
    const dirtyEnvironment = {
      PATH: '/safe/bin',
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
      MAP_DESIGN_PLUGIN_PROBE_PATH: '/private/stale-probe',
      MAP_DESIGN_PROFILE_PROBE_TOOLS: 'stale-tools',
      DSH_HOME: '/private/stale-profile-home',
    };
    const runServer = new FakePiRpc('sanitized-run');
    const runSpawn = vi.fn<PiSdkSpawn>(() => runServer.child);
    const adapter = createPiMapAgentAdapter({
      definition: { id: 'pi', bin: '/opt/pi/bin/pi', inheritedEnvKeys: ['OPENAI_API_KEY'] },
      toolDefinitions: () => TOOLS,
      environment: () => dirtyEnvironment,
      spawn: runSpawn,
    });
    const run = await start({ adapter, server: runServer, spawn: runSpawn });
    const runEnvironment = runSpawn.mock.calls[0]?.[2].env;
    expect(runEnvironment).toMatchObject({
      PATH: '/safe/bin', HOME: '/safe/home', TMPDIR: '/safe/tmp', LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'selected-provider-secret',
    });
    expect(runEnvironment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(runEnvironment).not.toHaveProperty('DATABASE_URL');
    expect(runEnvironment).not.toHaveProperty('UNRELATED_SECRET');
    expect(Object.keys(runEnvironment ?? {}).filter((key) => key.startsWith('MAP_DESIGN_'))).toEqual([]);
    expect(runEnvironment).not.toHaveProperty('DSH_HOME');
    settle(runServer);
    await run.handle.done;

    const probeServer = new FakePiRpc('sanitized-probe');
    const probeSpawn = vi.fn<PiSdkSpawn>((_command, _args, spawnOptions) => {
      expect(spawnOptions.env).toMatchObject({
        PATH: '/safe/bin', HOME: '/safe/home', TMPDIR: '/safe/tmp', LANG: 'en_US.UTF-8',
        OPENAI_API_KEY: 'selected-provider-secret',
      });
      expect(spawnOptions.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
      expect(spawnOptions.env).not.toHaveProperty('DATABASE_URL');
      expect(spawnOptions.env).not.toHaveProperty('UNRELATED_SECRET');
      expect(Object.keys(spawnOptions.env).filter((key) => key.startsWith('MAP_DESIGN_'))).toEqual([]);
      expect(spawnOptions.env).not.toHaveProperty('DSH_HOME');
      queueMicrotask(() => {
        probeServer.stdout.write('  --map-design-native-tools-probe  MapDesign native tool probe\n');
        probeServer.close(0);
      });
      return probeServer.child;
    });
    await expect(probePiNativeMapTools({
      definition: { id: 'pi', bin: '/opt/pi/bin/pi', inheritedEnvKeys: ['OPENAI_API_KEY'] },
      toolDefinitions: () => TOOLS,
      environment: () => dirtyEnvironment,
      spawn: probeSpawn,
      stopProcess: async () => undefined,
    })).resolves.toBe(true);
  });

  it('drops private thinking deltas while retaining normal text and tool activity', async () => {
    const state = await start();
    state.server.send({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'PRIVATE_PI_REASONING' },
    });
    state.server.send({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Public answer.' },
    });
    state.server.send({
      type: 'tool_execution_start',
      toolCallId: 'tool-public',
      toolName: 'map_validate',
      args: { expectedRevision: 4 },
    });
    state.server.send({
      type: 'tool_execution_end',
      toolCallId: 'tool-public',
      toolName: 'map_validate',
      result: {
        content: [{ type: 'text', text: '{"valid":true}' }],
        details: { summary: { valid: true } },
      },
      isError: false,
    });
    settle(state.server);

    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(state.events).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'text', text: 'Public answer.' },
      { kind: 'tool_use', id: 'tool-public', name: 'map_validate', summary: {} },
      { kind: 'tool_result', toolUseId: 'tool-public', status: 'succeeded', summary: { valid: true } },
      { kind: 'run_finished', status: 'succeeded' },
    ]);
    expect(JSON.stringify(state.events)).not.toContain('PRIVATE_PI_REASONING');
  });

  it('launches with built-in tools disabled and exposes only the generated MapDesign inventory', async () => {
    const state = await start();
    const registered = await loadExtension(state.extensionPath);

    expect(state.spawn.mock.calls[0]?.[1]).toContain('--no-builtin-tools');
    expect(registered.tools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
    expect(registered.tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
      'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls',
    ]));

    settle(state.server);
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
  });

  it('probes the actual extension registerTool surface without writing a global Pi extension', async () => {
    const root = await extensionRoot();
    const server = new FakePiRpc();
    let extensionPath = '';
    const spawn = vi.fn((_command: string, args: string[]) => {
      expect(args).toEqual(['--no-extensions', '--extension', expect.any(String), '--help']);
      extensionPath = args[2]!;
      void loadExtension(extensionPath).then(({ tools, flags }) => {
        expect(tools.map((tool) => tool.name)).toEqual(['map_design_native_tools_probe']);
        expect(flags).toEqual(['map-design-native-tools-probe']);
        server.stdout.write('  --map-design-native-tools-probe  MapDesign native tool probe\n');
        server.close(0);
      });
      return server.child;
    });

    await expect(probePiNativeMapTools({
      definition: { id: 'pi', bin: '/opt/pi/bin/pi' },
      toolDefinitions: () => TOOLS,
      extensionRoot: root,
      spawn,
      stopProcess: async () => undefined,
    })).resolves.toBe(true);

    expect(extensionPath.startsWith(`${root}/`)).toBe(true);
    expect(extensionPath).not.toContain('/.pi/extensions/');
    expect(await exists(extensionPath)).toBe(false);
  });

  it('marks Pi unsupported when the executable does not load the required extension feature', async () => {
    const root = await extensionRoot();
    const server = new FakePiRpc();
    const probing = probePiNativeMapTools({
      definition: { id: 'pi', bin: '/opt/pi/bin/pi' },
      toolDefinitions: () => TOOLS,
      extensionRoot: root,
      spawn: () => {
        queueMicrotask(() => {
          server.stdout.write('Pi help without the probe flag\n');
          server.close(0);
        });
        return server.child;
      },
      stopProcess: async () => undefined,
    });

    await expect(probing).resolves.toBe(false);
  });

  it('passes Pi tool cancellation to the daemon callback request signal', async () => {
    const controller = new AbortController();
    const callbackSignal: { value: AbortSignal | null } = { value: null };
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => {
      callbackSignal.value = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        callbackSignal.value?.addEventListener('abort', () => reject(callbackSignal.value?.reason), { once: true });
      });
    }));
    const state = await start();
    const registered = await loadExtension(state.extensionPath);
    const execution = registered.tools[1]!.execute('tool-abort', { expectedRevision: 4 }, controller.signal);
    await vi.waitFor(() => expect(callbackSignal.value).toBe(controller.signal));
    controller.abort(new Error('test abort'));

    await expect(execution).rejects.toThrow('test abort');
    expect(callbackSignal.value?.aborted).toBe(true);
    const cancelling = state.handle.cancel();
    const abort = await state.server.nextClientFrame();
    state.server.send(response(abort));
    await cancelling;
  });

  it('disposes a deferred extension and never spawns when the Run aborts during staging', async () => {
    const root = await extensionRoot();
    const controller = new AbortController();
    const dispose = vi.fn(async () => undefined);
    let releaseStage!: (lease: { path: string; dispose(): Promise<void> }) => void;
    const stageExtension = vi.fn(() => new Promise<{ path: string; dispose(): Promise<void> }>((resolve) => {
      releaseStage = resolve;
    }));
    const spawn = vi.fn(() => new FakePiRpc().child);
    const adapter = createPiMapAgentAdapter({
      definition: { id: 'pi', bin: '/opt/pi/bin/pi' },
      toolDefinitions: () => TOOLS,
      extensionRoot: root,
      stageExtension,
      spawn,
      requestTimeoutMs: 20,
    });
    const starting = adapter.startMapRun(runInput(controller.signal), TOOLS, () => undefined);
    void starting.catch(() => undefined);

    expect(stageExtension).toHaveBeenCalledOnce();
    controller.abort();
    releaseStage({ path: join(root, 'deferred-extension.mjs'), dispose });
    const handle = await starting;

    await expect(handle.done).resolves.toEqual({ status: 'canceled' });
    expect(spawn).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('stops the assigned child and removes the extension when abort fires inside spawn', async () => {
    const root = await extensionRoot();
    const controller = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const stageExtension = vi.fn(async () => ({
      path: join(root, 'staged-extension.mjs'),
      dispose,
    }));
    const server = new FakePiRpc();
    const stopProcess = vi.fn(async () => undefined);
    const spawn = vi.fn(() => {
      controller.abort();
      return server.child;
    });
    const adapter = createPiMapAgentAdapter({
      definition: { id: 'pi', bin: '/opt/pi/bin/pi' },
      toolDefinitions: () => TOOLS,
      extensionRoot: root,
      stageExtension,
      spawn,
      stopProcess,
      requestTimeoutMs: 20,
    });

    const handle = await adapter.startMapRun(runInput(controller.signal), TOOLS, () => undefined);

    await expect(handle.done).resolves.toEqual({ status: 'canceled' });
    expect(spawn).toHaveBeenCalledOnce();
    expect(stopProcess).toHaveBeenCalledWith(server.child);
    expect(dispose).toHaveBeenCalledOnce();
    expect(server.receivedFrames).toEqual([]);
  });

  it('cleans the run extension after terminal completion and never persists the callback token', async () => {
    const state = await start();
    expect(await readFile(state.extensionPath, 'utf8')).toContain('test-token');
    settle(state.server);
    await state.handle.done;
    await vi.waitFor(async () => expect(await exists(state.extensionPath)).toBe(false));
  });

  it('rejects run events emitted before the prompt acknowledgement', async () => {
    const root = await extensionRoot();
    const server = new FakePiRpc();
    const adapter = createPiMapAgentAdapter({
      definition: { id: 'pi', bin: '/opt/pi/bin/pi' },
      toolDefinitions: () => TOOLS,
      extensionRoot: root,
      spawn: () => server.child,
      requestTimeoutMs: 20,
    });
    const starting = adapter.startMapRun(runInput(), TOOLS, () => undefined);
    const getState = await server.nextClientFrame();
    server.send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'early' } });
    await new Promise((resolve) => setImmediate(resolve));
    const handle = await starting;
    await expect(handle.done).resolves.toMatchObject({ status: 'failed' });
    expect(getState.type).toBe('get_state');
  });

  it('accepts a first stream event sharing the prompt acknowledgement chunk', async () => {
    const state = await start({
      promptResponseAndFrame: {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Prompt accepted.' },
      },
    });

    expect(state.events).toContainEqual({ kind: 'text', text: 'Prompt accepted.' });
    settle(state.server);
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
  });

  it('waits through automatic retry and compaction until agent_settled', async () => {
    const state = await start();
    const failedMessage = { role: 'assistant', stopReason: 'error', errorMessage: 'retry me' };
    state.server.send({ type: 'turn_end', message: failedMessage, toolResults: [] });
    state.server.send({ type: 'agent_end', messages: [failedMessage], willRetry: true });
    state.server.send({ type: 'compaction_start', reason: 'overflow' });
    state.server.send({
      type: 'compaction_end',
      reason: 'overflow',
      result: { summary: 'compacted' },
      aborted: false,
      willRetry: true,
    });
    state.server.send({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: 'retry me' });
    expect(await settlesWithin(state.handle.done)).toBe(false);

    state.server.send({ type: 'auto_retry_end', success: true, attempt: 1 });
    state.server.send({ type: 'agent_start' });
    state.server.send({
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'stop', content: [] }],
      willRetry: false,
    });
    expect(await settlesWithin(state.handle.done)).toBe(false);
    state.server.send({ type: 'agent_settled' });

    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
  });

  it('reports a final unretried Pi error only when agent_settled arrives', async () => {
    const state = await start();
    const failedMessage = { role: 'assistant', stopReason: 'error', errorMessage: 'provider failed' };
    state.server.send({ type: 'turn_end', message: failedMessage, toolResults: [] });
    state.server.send({ type: 'agent_end', messages: [failedMessage], willRetry: false });
    expect(await settlesWithin(state.handle.done)).toBe(false);

    state.server.send({ type: 'agent_settled' });

    await expect(state.handle.done).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'RUN_FAILED' },
    });
  });

  it('shares Pi session history across production local-registry adapter instances', async () => {
    const probeServer = new FakePiRpc('registry-probe');
    const firstServer = new FakePiRpc('registry-first-run');
    const secondServer = new FakePiRpc('registry-second-run');
    const runServers = [firstServer, secondServer];
    const spawn = vi.fn<PiSdkSpawn>((_command, args) => {
      if (args.includes('--help')) {
        queueMicrotask(() => {
          probeServer.stdout.write('  --map-design-native-tools-probe  MapDesign native tool probe\n');
          probeServer.close(0);
        });
        return probeServer.child;
      }
      return runServers.shift()!.child;
    });
    const registry = productionPiRegistry(spawn);
    await registry.probeNativeMapTools();
    expect(spawn.mock.calls[0]?.[1]).toEqual(['--no-extensions', '--extension', expect.any(String), '--help']);
    expect(registry.list()).toMatchObject([{ id: 'pi', mapDesign: { nativeMapTools: true } }]);

    const firstAdapter = registry.getMapAgent?.('pi');
    expect(firstAdapter).not.toBeNull();
    const first = await start({
      adapter: firstAdapter!,
      server: firstServer,
      spawn,
      sessionFile: '/safe/sessions/registry-pi-1.jsonl',
    });
    settle(firstServer);
    await first.handle.done;

    const secondAdapter = registry.getMapAgent?.('pi');
    expect(secondAdapter).not.toBe(firstAdapter);
    const second = await start({
      adapter: secondAdapter!,
      server: secondServer,
      spawn,
      resumePath: '/safe/sessions/registry-pi-1.jsonl',
      sessionFile: '/safe/sessions/registry-pi-1.jsonl',
      input: runInput(undefined, undefined, { runId: 'run-2' }),
    });
    settle(secondServer);
    await second.handle.done;

    expect(secondServer.receivedFrames[0]).toMatchObject({
      type: 'switch_session',
      sessionPath: '/safe/sessions/registry-pi-1.jsonl',
    });
  });

  it.each([
    ['mismatched', { sessionFile: '/safe/sessions/other-conversation.jsonl' }],
    ['malformed', {}],
  ])('deletes a %s successful Pi resume and performs one clean full-prompt reseed', async (_kind, resumeState) => {
    const root = await extensionRoot();
    const stale = new FakePiRpc('resume-integrity-stale');
    const replacement = new FakePiRpc('resume-integrity-replacement');
    const servers = [stale, replacement];
    const spawn = vi.fn<PiSdkSpawn>(() => servers.shift()!.child);
    const stopProcess = vi.fn(async () => undefined);
    const memory = createMemoryMapAgentSessionBroker();
    const sessionBroker: MapAgentSessionBroker = {
      load: (scope) => memory.load(scope),
      save: (scope, sessionId) => memory.save(scope, sessionId),
      delete: vi.fn((scope) => memory.delete(scope)),
    };
    const input = runInput(undefined, undefined, { runId: 'run-resume-integrity' });
    const scope = mapAgentSessionScope(input, 'pi');
    memory.save(scope, '/safe/sessions/expected.jsonl');
    const adapter = createPiMapAgentAdapter({
      definition: { id: 'pi', bin: '/opt/pi/bin/pi' },
      toolDefinitions: () => TOOLS,
      extensionRoot: root,
      sessionBroker,
      spawn,
      stopProcess,
    });

    const starting = adapter.startMapRun(input, TOOLS, () => undefined);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const resume = await stale.nextClientFrame();
    expect(resume).toMatchObject({ type: 'switch_session', sessionPath: '/safe/sessions/expected.jsonl' });
    stale.send(response(resume, { cancelled: false }));
    const getState = await stale.nextClientFrame();
    expect(getState).toMatchObject({ type: 'get_state' });
    stale.send(response(getState, resumeState));

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(sessionBroker.delete).toHaveBeenCalledWith(scope);
    expect(stopProcess).toHaveBeenCalledOnce();
    expect(memory.load(scope)).toBeNull();

    const replacementState = await replacement.nextClientFrame();
    expect(replacementState).toMatchObject({ type: 'get_state' });
    replacement.send(response(replacementState, { sessionFile: '/safe/sessions/reseeded.jsonl' }));
    const prompt = await replacement.nextClientFrame();
    expect(prompt).toMatchObject({ type: 'prompt', message: input.prompt });
    replacement.send(response(prompt));
    const handle = await starting;
    settle(replacement);
    await expect(handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(memory.load(scope)).toBe('/safe/sessions/reseeded.jsonl');
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('reseeds exactly one prompt after a production-registry session rejection', async () => {
    const probeServer = new FakePiRpc('reseed-probe');
    const firstServer = new FakePiRpc('reseed-first-run');
    const secondServer = new FakePiRpc('reseed-second-run');
    const replacementServer = new FakePiRpc('reseed-replacement-run');
    const runServers = [firstServer, secondServer, replacementServer];
    const spawn = vi.fn<PiSdkSpawn>((_command, args) => {
      if (args.includes('--help')) {
        queueMicrotask(() => {
          probeServer.stdout.write('  --map-design-native-tools-probe  MapDesign native tool probe\n');
          probeServer.close(0);
        });
        return probeServer.child;
      }
      return runServers.shift()!.child;
    });
    const registry = productionPiRegistry(spawn);
    await registry.probeNativeMapTools();
    expect(registry.list()).toMatchObject([{ id: 'pi', mapDesign: { nativeMapTools: true } }]);
    const first = await start({
      adapter: registry.getMapAgent?.('pi')!,
      server: firstServer,
      spawn,
      sessionFile: '/safe/sessions/registry-reseed-1.jsonl',
    });
    settle(firstServer);
    await first.handle.done;

    const second = await start({
      adapter: registry.getMapAgent?.('pi')!,
      server: secondServer,
      replacementServer,
      spawn,
      resumePath: '/safe/sessions/registry-reseed-1.jsonl',
      rejectResume: true,
      sessionFile: '/safe/sessions/registry-reseed-2.jsonl',
      input: runInput(undefined, undefined, { runId: 'run-2' }),
    });

    expect(second.server.receivedFrames.filter((frame) => frame.type === 'prompt')).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(4);
    settle(second.server);
    await second.handle.done;
  });
});

function productionPiRegistry(spawn: PiSdkSpawn) {
  return createLocalAgentRegistry({
    definitions: [{
      id: 'pi',
      name: 'Pi',
      bin: process.execPath,
      versionArgs: ['--version'],
      fallbackModels: [],
      streamFormat: 'pi-rpc',
      buildArgs: () => ['--mode', 'rpc'],
      mapDesign: { nativeToolAdapter: 'pi-sdk', publicReasoningSummary: false },
    }],
    nativeToolRegistry: {
      definitions: () => TOOLS,
      call: vi.fn(async (context) => ({
        ok: true as const,
        toolUseId: context.toolUseId,
        summary: { valid: true },
      })),
    },
    config: { read: () => ({ agentCliEnv: { pi: { PI_BIN: process.execPath } } }) },
    spawn,
    stageSkill: async () => undefined,
  });
}
