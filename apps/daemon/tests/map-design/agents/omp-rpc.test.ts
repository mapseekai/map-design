import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  createOhMyPiMapAgentAdapter,
  probeOhMyPiNativeMapTools,
  type OhMyPiRpcSpawn,
} from '../../../src/map-design/agents/omp-rpc.js';
import { createLocalAgentRegistry } from '../../../src/map-design/application/local-agent-registry.js';
import type { MapAgentAdapter, MapAgentEvent, MapRunInput } from '../../../src/map-design/agents/types.js';
import type { NativeMapToolDefinition } from '../../../src/map-design/tools/tool-context.js';
import { defineMapAgentAdapterConformance } from './adapter-conformance.js';
import {
  createMemoryMapAgentSessionBroker,
  mapAgentSessionScope,
  type MapAgentSessionBroker,
} from '../../../src/map-design/agents/session-broker.js';

type Frame = Record<string, unknown>;

class FakeOmpRpc {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.child.emit('close', null));
    return true;
  });
  readonly child = Object.assign(new EventEmitter(), {
    pid: 4321,
    stdin: this.stdin,
    stdout: this.stdout,
    stderr: this.stderr,
    kill: this.kill,
  });

  private input = '';
  private readonly frames: Frame[] = [];
  private readonly waiters: Array<(frame: Frame) => void> = [];

  constructor() {
    this.stdin.on('data', (chunk: Buffer | string) => {
      this.input += String(chunk);
      while (this.input.includes('\n')) {
        const newline = this.input.indexOf('\n');
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        if (!line) continue;
        const frame = JSON.parse(line) as Frame;
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame);
        else this.frames.push(frame);
      }
    });
  }

  send(frame: Frame | string): void {
    this.stdout.write(typeof frame === 'string' ? frame : `${JSON.stringify(frame)}\n`);
  }

  ready(maxFrameBytes = 1_024): void {
    this.send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes, maxReassembledFrameBytes: maxFrameBytes });
  }

  async nextClientFrame(): Promise<Frame> {
    const frame = this.frames.shift();
    if (frame) return frame;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

const TOOL: NativeMapToolDefinition = {
  name: 'map_validate',
  description: 'Validate the draft.',
  inputSchema: { type: 'object' },
};

function input(
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
    model: 'anthropic/sonnet-4.5',
    reasoning: 'high',
    serviceTier: null,
    toolRuntime: { execute, closeRun: () => undefined },
    toolCallback: { url: 'http://127.0.0.1:8787/api/map-design/tools', token: 'test-token', close: () => undefined },
    signal,
    ...overrides,
  };
}

function response(request: Frame, command = request.type): Frame {
  return { id: request.id, type: 'response', command, success: true };
}

function settlesWithin(promise: Promise<unknown>, timeoutMs = 50): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function start(options: {
  server?: FakeOmpRpc;
  replacementServer?: FakeOmpRpc;
  runInput?: MapRunInput;
  events?: MapAgentEvent[];
  adapter?: MapAgentAdapter;
  resumePath?: string;
  rejectResume?: boolean;
  resumeCancelled?: boolean;
  sessionFile?: string | null;
  promptResponseAndFrame?: Frame;
  maxFrameBytes?: number;
  stopProcess?: () => Promise<void>;
  imageTooLarge?: boolean;
} = {}) {
  const server = options.server ?? new FakeOmpRpc();
  const events = options.events ?? [];
  const spawn = vi.fn(() => server.child);
  const adapter = options.adapter ?? createOhMyPiMapAgentAdapter({
    definition: { id: 'oh-my-pi', bin: '/opt/omp/bin/omp' },
    toolDefinitions: () => [TOOL],
    spawn,
    ...(options.stopProcess === undefined ? {} : { stopProcess: options.stopProcess }),
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
  });
  const run = options.runInput ?? input();
  const starting = adapter.startMapRun(run, [TOOL], (event) => events.push(event));
  server.ready();
  let activeServer = server;

  if (options.resumePath) {
    const resume = await server.nextClientFrame();
    expect(resume).toEqual({ id: expect.any(String), type: 'switch_session', sessionPath: options.resumePath });
    server.send({
      ...response(resume),
      success: options.rejectResume !== true,
      ...(options.rejectResume ? { error: 'session unavailable', code: 'session_missing' } : {}),
      ...(!options.rejectResume ? { data: { cancelled: options.resumeCancelled === true } } : {}),
    });
    if ((options.rejectResume || options.resumeCancelled) && options.replacementServer) {
      activeServer = options.replacementServer;
      activeServer.ready();
    }
  }

  const setTools = await activeServer.nextClientFrame();
  expect(setTools).toEqual({
    id: expect.any(String),
    type: 'set_host_tools',
    tools: [{ name: 'map_validate', label: 'map_validate', description: 'Validate the draft.', parameters: { type: 'object' } }],
  });
  activeServer.send({ ...response(setTools), data: { toolNames: ['map_validate'] } });
  const setModel = await activeServer.nextClientFrame();
  expect(setModel).toEqual({
    id: expect.any(String), type: 'set_model', provider: 'anthropic', modelId: 'sonnet-4.5',
  });
  activeServer.send(response(setModel));
  const setThinking = await activeServer.nextClientFrame();
  expect(setThinking).toEqual({ id: expect.any(String), type: 'set_thinking_level', level: 'high' });
  activeServer.send(response(setThinking));
  const getState = await activeServer.nextClientFrame();
  expect(getState).toEqual({ id: expect.any(String), type: 'get_state' });
  activeServer.send({
    ...response(getState),
    data: options.sessionFile === null ? {} : { sessionFile: options.sessionFile ?? '/safe/sessions/omp-1.jsonl' },
  });
  if (options.imageTooLarge) {
    return { adapter, events, server: activeServer, spawn, handle: await starting };
  }
  const prompt = await activeServer.nextClientFrame();
  const resumed = Boolean(options.resumePath) && !options.rejectResume && !options.resumeCancelled;
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
  } else activeServer.send(response(prompt));
  return { adapter, events, server: activeServer, spawn, handle: await starting };
}

it('sends screenshots as Oh My Pi image blocks', async () => {
  const state = await start({
    runInput: input(undefined, undefined, {
      images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
    }),
  });
  state.server.send({ type: 'agent_end', isTerminal: true, messages: [] });
  await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
});

it('fails explicitly before sending images above the negotiated OMP frame limit', async () => {
  const state = await start({
    imageTooLarge: true,
    runInput: input(undefined, undefined, {
      images: [{ data: 'A'.repeat(1_100), mimeType: 'image/png' }],
    }),
  });
  await expect(state.handle.done).resolves.toEqual({
    status: 'failed',
    error: {
      code: 'IMAGE_INPUT_TOO_LARGE',
      message: 'The screenshots exceed the Oh My Pi RPC frame limit.',
    },
  });
});

async function configureOmpAttempt(
  server: FakeOmpRpc,
  sessionFile: string,
  expectedPrompt: string,
): Promise<void> {
  const setTools = await server.nextClientFrame();
  expect(setTools).toMatchObject({ type: 'set_host_tools' });
  server.send({ ...response(setTools), data: { toolNames: ['map_validate'] } });
  const setModel = await server.nextClientFrame();
  expect(setModel).toMatchObject({ type: 'set_model' });
  server.send(response(setModel));
  const setThinking = await server.nextClientFrame();
  expect(setThinking).toMatchObject({ type: 'set_thinking_level' });
  server.send(response(setThinking));
  const getState = await server.nextClientFrame();
  expect(getState).toMatchObject({ type: 'get_state' });
  server.send({ ...response(getState), data: { sessionFile } });
  const prompt = await server.nextClientFrame();
  expect(prompt).toMatchObject({ type: 'prompt', message: expectedPrompt });
  server.send(response(prompt));
}

defineMapAgentAdapterConformance('Oh My Pi RPC', {
  async registration() {
    const state = await start();
    state.server.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
  },
  async correlatedResult() {
    const execute = vi.fn(async (call: { toolUseId: string }) => ({ ok: true as const, toolUseId: call.toolUseId, summary: { valid: true }, modelContent: '{"valid":true}' }));
    const state = await start({ runInput: input(undefined, execute) });
    state.server.send({ type: 'host_tool_call', id: 'host-1', toolCallId: 'tool-1', toolName: 'map_validate', arguments: { expectedRevision: 4 } });
    await expect(state.server.nextClientFrame()).resolves.toEqual({
      type: 'host_tool_result', id: 'host-1', result: { content: [{ type: 'text', text: '{"valid":true}' }] },
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1', projectId: 'project-1', conversationId: 'conversation-1', agentId: 'oh-my-pi',
      toolUseId: 'tool-1', name: 'map_validate', input: { expectedRevision: 4 }, signal: expect.any(AbortSignal),
    }));
    state.server.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await state.handle.done;
  },
  async normalizedEvents() {
    const state = await start();
    state.server.send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Checking.' } });
    state.server.send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Valid.' } });
    state.server.send({ type: 'agent_end', isTerminal: true, messages: [{ role: 'assistant', usage: { input: 11, output: 5 } }] });
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(state.events).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'thinking', text: 'Checking.' },
      { kind: 'text', text: 'Valid.' },
      { kind: 'run_finished', status: 'succeeded' },
    ]);
  },
  async cancellation() {
    const state = await start();
    const cancel = state.handle.cancel();
    const abort = await state.server.nextClientFrame();
    expect(abort).toMatchObject({ type: 'abort', id: expect.any(String) });
    state.server.send(response(abort));
    await cancel;
    await expect(state.handle.done).resolves.toEqual({ status: 'canceled' });
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
    const execute = vi.fn(async (call: { toolUseId: string }) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: true as const, toolUseId: call.toolUseId, summary: { valid: true } };
    });
    const state = await start({ runInput: input(undefined, execute) });
    const call = { type: 'host_tool_call', id: 'host-1', toolCallId: 'tool-1', toolName: 'map_validate', arguments: {} };
    state.server.send(call);
    state.server.send({ ...call, id: 'host-2' });
    await expect(state.server.nextClientFrame()).resolves.toMatchObject({ type: 'host_tool_result', id: 'host-2', isError: true });
    release();
    await expect(state.server.nextClientFrame()).resolves.toMatchObject({ type: 'host_tool_result', id: 'host-1' });
    expect(execute).toHaveBeenCalledOnce();
    const cancelling = state.handle.cancel();
    const abort = await state.server.nextClientFrame();
    state.server.send(response(abort));
    await cancelling;
  },
  async loopGuard() {
    const execute = vi.fn(async (call: { toolUseId: string }) => ({
      ok: false as const, toolUseId: call.toolUseId,
      error: { code: 'INVALID_INPUT', message: 'Invalid map input.', retryable: false },
    }));
    const state = await start({ runInput: input(undefined, execute) });
    for (let count = 1; count <= 8; count += 1) {
      state.server.send({ type: 'host_tool_call', id: `host-${count}`, toolCallId: `tool-${count}`, toolName: 'map_validate', arguments: { expectedRevision: 4 } });
      await expect(state.server.nextClientFrame()).resolves.toMatchObject({ type: 'host_tool_result', id: `host-${count}`, isError: true });
    }
    await expect(state.handle.done).resolves.toMatchObject({ status: 'failed', error: { code: 'TOOL_LOOP_DETECTED' } });
  },
  async sessionResumeOrReseed() {
    const first = await start();
    first.server.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await first.handle.done;
    // The adapter must isolate any remembered OMP session by the Agent identity.
    expect(first.spawn).toHaveBeenCalledWith('/opt/omp/bin/omp', ['--mode', 'rpc'], expect.objectContaining({ cwd: '/safe/project' }));
  },
  async lateEventRejection() {
    const state = await start();
    state.server.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await state.handle.done;
    const terminalEvents = structuredClone(state.events);
    state.server.send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.events).toEqual(terminalEvents);
  },
});

describe('Oh My Pi RPC Map Agent adapter', () => {
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
    const runServer = new FakeOmpRpc();
    const runSpawn = vi.fn<OhMyPiRpcSpawn>(() => runServer.child);
    const adapter = createOhMyPiMapAgentAdapter({
      definition: { id: 'oh-my-pi', bin: '/opt/omp/bin/omp', inheritedEnvKeys: ['OPENAI_API_KEY'] },
      toolDefinitions: () => [TOOL],
      environment: () => dirtyEnvironment,
      spawn: runSpawn,
      stopProcess: async () => undefined,
    });
    const run = await start({ server: runServer, adapter });
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
    runServer.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await run.handle.done;

    const probeServer = new FakeOmpRpc();
    const probeSpawn = vi.fn<OhMyPiRpcSpawn>(() => probeServer.child);
    const probing = probeOhMyPiNativeMapTools({
      definition: { id: 'oh-my-pi', bin: '/opt/omp/bin/omp', inheritedEnvKeys: ['OPENAI_API_KEY'] },
      toolDefinitions: () => [TOOL],
      environment: () => dirtyEnvironment,
      spawn: probeSpawn,
      stopProcess: async () => undefined,
    });
    probeServer.ready();
    const tools = await probeServer.nextClientFrame();
    probeServer.send({ ...response(tools), data: { toolNames: ['map_validate'] } });
    await expect(probing).resolves.toBe(true);
    const probeEnvironment = probeSpawn.mock.calls[0]?.[2].env;
    expect(probeEnvironment).toMatchObject({
      PATH: '/safe/bin', HOME: '/safe/home', TMPDIR: '/safe/tmp', LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'selected-provider-secret',
    });
    expect(probeEnvironment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(probeEnvironment).not.toHaveProperty('DATABASE_URL');
    expect(probeEnvironment).not.toHaveProperty('UNRELATED_SECRET');
    expect(Object.keys(probeEnvironment ?? {}).filter((key) => key.startsWith('MAP_DESIGN_'))).toEqual([]);
    expect(probeEnvironment).not.toHaveProperty('DSH_HOME');
  });

  it('probes host-tool support through RPC instead of treating an executable as capability evidence', async () => {
    const server = new FakeOmpRpc();
    const probing = probeOhMyPiNativeMapTools({
      definition: { id: 'oh-my-pi', bin: '/opt/omp/bin/omp' },
      toolDefinitions: () => [TOOL],
      spawn: () => server.child,
      stopProcess: async () => undefined,
    });
    server.ready();
    const tools = await server.nextClientFrame();
    server.send({ ...response(tools), data: { toolNames: ['map_validate'] } });
    await expect(probing).resolves.toBe(true);
  });

  it('sends only the latest turn after a successful session resume', async () => {
    const first = new FakeOmpRpc();
    const second = new FakeOmpRpc();
    const servers = [first, second];
    const adapter = createOhMyPiMapAgentAdapter({
      definition: { id: 'oh-my-pi', bin: '/opt/omp/bin/omp' },
      toolDefinitions: () => [TOOL],
      spawn: () => servers.shift()!.child,
      stopProcess: async () => undefined,
    });
    const firstRun = await start({ server: first, adapter });
    first.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await firstRun.handle.done;

    const resumed = await start({
      server: second,
      adapter,
      resumePath: '/safe/sessions/omp-1.jsonl',
      runInput: { ...input(), runId: 'run-2' },
    });
    second.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await resumed.handle.done;
  });

  it('fails closed instead of persisting a resumed session path that changes after prompt acceptance', async () => {
    const server = new FakeOmpRpc();
    const memory = createMemoryMapAgentSessionBroker();
    const sessionBroker: MapAgentSessionBroker = {
      load: (scope) => memory.load(scope),
      save: (scope, sessionId) => memory.save(scope, sessionId),
      delete: vi.fn((scope) => memory.delete(scope)),
    };
    const runInput = { ...input(), runId: 'run-resume-path-change' };
    const scope = mapAgentSessionScope(runInput, 'oh-my-pi');
    memory.save(scope, '/safe/sessions/expected.jsonl');
    const stopProcess = vi.fn(async () => undefined);
    const adapter = createOhMyPiMapAgentAdapter({
      definition: { id: 'oh-my-pi', bin: '/opt/omp/bin/omp' },
      toolDefinitions: () => [TOOL],
      sessionBroker,
      spawn: () => server.child,
      stopProcess,
    });
    const resumed = await start({
      server,
      adapter,
      resumePath: '/safe/sessions/expected.jsonl',
      sessionFile: '/safe/sessions/expected.jsonl',
      runInput,
    });

    server.send({
      type: 'session_info_update',
      sessionFile: '/safe/sessions/other-conversation.jsonl',
    });
    server.send({ type: 'agent_end', isTerminal: true, messages: [] });

    await expect(resumed.handle.done).resolves.toMatchObject({ status: 'failed' });
    expect(sessionBroker.delete).toHaveBeenCalledWith(scope);
    expect(memory.load(scope)).toBeNull();
    await vi.waitFor(() => expect(stopProcess).toHaveBeenCalledOnce());
  });

  it.each([
    ['mismatched', { sessionFile: '/safe/sessions/other-conversation.jsonl' }],
    ['malformed', {}],
  ])('deletes a %s successful resume and performs one clean full-prompt reseed', async (_kind, resumeState) => {
    const stale = new FakeOmpRpc();
    const replacement = new FakeOmpRpc();
    const servers = [stale, replacement];
    const spawn = vi.fn(() => servers.shift()!.child);
    const stopProcess = vi.fn(async () => undefined);
    const memory = createMemoryMapAgentSessionBroker();
    const sessionBroker: MapAgentSessionBroker = {
      load: (scope) => memory.load(scope),
      save: (scope, sessionId) => memory.save(scope, sessionId),
      delete: vi.fn((scope) => memory.delete(scope)),
    };
    const runInput = { ...input(), runId: 'run-resume-integrity' };
    const scope = mapAgentSessionScope(runInput, 'oh-my-pi');
    memory.save(scope, '/safe/sessions/expected.jsonl');
    const adapter = createOhMyPiMapAgentAdapter({
      definition: { id: 'oh-my-pi', bin: '/opt/omp/bin/omp' },
      toolDefinitions: () => [TOOL],
      sessionBroker,
      spawn,
      stopProcess,
    });

    const starting = adapter.startMapRun(runInput, [TOOL], () => undefined);
    stale.ready();
    const resume = await stale.nextClientFrame();
    expect(resume).toMatchObject({ type: 'switch_session', sessionPath: '/safe/sessions/expected.jsonl' });
    stale.send({ ...response(resume), data: { cancelled: false } });
    const setTools = await stale.nextClientFrame();
    stale.send({ ...response(setTools), data: { toolNames: ['map_validate'] } });
    const setModel = await stale.nextClientFrame();
    stale.send(response(setModel));
    const setThinking = await stale.nextClientFrame();
    stale.send(response(setThinking));
    const getState = await stale.nextClientFrame();
    expect(getState).toMatchObject({ type: 'get_state' });
    stale.send({ ...response(getState), data: resumeState });

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(sessionBroker.delete).toHaveBeenCalledWith(scope);
    expect(stopProcess).toHaveBeenCalledOnce();
    expect(memory.load(scope)).toBeNull();

    replacement.ready();
    await configureOmpAttempt(replacement, '/safe/sessions/reseeded.jsonl', runInput.prompt);
    const handle = await starting;
    replacement.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await expect(handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(memory.load(scope)).toBe('/safe/sessions/reseeded.jsonl');
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('shares OMP sessions across production registry adapter recreation without crossing conversations', async () => {
    const probe = new FakeOmpRpc();
    const first = new FakeOmpRpc();
    const second = new FakeOmpRpc();
    const isolated = new FakeOmpRpc();
    const servers = [probe, first, second, isolated];
    const spawn = vi.fn(() => servers.shift()!.child);
    const registry = productionOmpRegistry(spawn);
    expect(registry.list()).toMatchObject([{
      id: 'oh-my-pi',
      available: true,
      mapDesign: { nativeMapTools: false, reason: 'native-tools-unavailable' },
    }]);
    const probing = registry.probeNativeMapTools();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    probe.ready();
    const probeTools = await probe.nextClientFrame();
    probe.send({ ...response(probeTools), data: { toolNames: ['map_validate'] } });
    await probing;

    const firstAdapter = registry.getMapAgent?.('oh-my-pi');
    const firstRun = await start({ server: first, adapter: firstAdapter! });
    first.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await firstRun.handle.done;

    const secondAdapter = registry.getMapAgent?.('oh-my-pi');
    expect(secondAdapter).not.toBe(firstAdapter);
    const secondRun = await start({
      server: second,
      adapter: secondAdapter!,
      resumePath: '/safe/sessions/omp-1.jsonl',
      runInput: { ...input(), runId: 'run-2' },
    });
    second.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await secondRun.handle.done;

    const isolatedRun = await start({
      server: isolated,
      adapter: registry.getMapAgent?.('oh-my-pi')!,
      runInput: { ...input(), runId: 'run-3', conversationId: 'conversation-2' },
    });
    isolated.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await isolatedRun.handle.done;
  });

  it('clears a rejected production-registry OMP resume and records one full reseed', async () => {
    const probe = new FakeOmpRpc();
    const first = new FakeOmpRpc();
    const rejected = new FakeOmpRpc();
    const reseeded = new FakeOmpRpc();
    const resumedReplacement = new FakeOmpRpc();
    const servers = [probe, first, rejected, reseeded, resumedReplacement];
    const spawn = vi.fn(() => servers.shift()!.child);
    const registry = productionOmpRegistry(spawn);
    const probing = registry.probeNativeMapTools();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    probe.ready();
    const probeTools = await probe.nextClientFrame();
    probe.send({ ...response(probeTools), data: { toolNames: ['map_validate'] } });
    await probing;

    const firstRun = await start({ server: first, adapter: registry.getMapAgent?.('oh-my-pi')! });
    first.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await firstRun.handle.done;

    const reseed = await start({
      server: rejected,
      replacementServer: reseeded,
      adapter: registry.getMapAgent?.('oh-my-pi')!,
      resumePath: '/safe/sessions/omp-1.jsonl',
      rejectResume: true,
      sessionFile: '/safe/sessions/omp-2.jsonl',
      runInput: { ...input(), runId: 'run-2' },
    });
    reseed.server.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await reseed.handle.done;

    const thirdRun = await start({
      server: resumedReplacement,
      adapter: registry.getMapAgent?.('oh-my-pi')!,
      resumePath: '/safe/sessions/omp-2.jsonl',
      sessionFile: '/safe/sessions/omp-2.jsonl',
      runInput: { ...input(), runId: 'run-3' },
    });
    resumedReplacement.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await thirdRun.handle.done;
  });

  it('does not reuse an OMP session path for another Agent identity', async () => {
    const sessionBroker = createMemoryMapAgentSessionBroker();
    const originalInput = input();
    sessionBroker.save(mapAgentSessionScope(originalInput, 'oh-my-pi'), '/safe/sessions/omp-1.jsonl');
    const server = new FakeOmpRpc();
    const adapter = createOhMyPiMapAgentAdapter({
      definition: { id: 'other-omp', bin: '/opt/omp/bin/omp' },
      toolDefinitions: () => [TOOL],
      sessionBroker,
      spawn: () => server.child,
      stopProcess: async () => undefined,
    });

    const state = await start({ server, adapter });
    server.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await state.handle.done;

    expect(sessionBroker.load(mapAgentSessionScope(originalInput, 'oh-my-pi'))).toBe('/safe/sessions/omp-1.jsonl');
    expect(sessionBroker.load(mapAgentSessionScope(originalInput, 'other-omp'))).toBe('/safe/sessions/omp-1.jsonl');
  });

  it('reseeds exactly once when OMP accepts switch_session but reports the target was cancelled', async () => {
    const first = new FakeOmpRpc();
    const second = new FakeOmpRpc();
    const third = new FakeOmpRpc();
    const fourth = new FakeOmpRpc();
    const spawn = vi.fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child)
      .mockReturnValueOnce(third.child)
      .mockReturnValueOnce(fourth.child);
    const adapter = createOhMyPiMapAgentAdapter({
      definition: { id: 'oh-my-pi', bin: '/opt/omp/bin/omp' },
      toolDefinitions: () => [TOOL],
      spawn,
      stopProcess: async () => undefined,
    });
    const firstRun = await start({ server: first, adapter });
    first.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await expect(firstRun.handle.done).resolves.toEqual({ status: 'succeeded' });

    const secondRun = await start({
      server: second,
      replacementServer: third,
      adapter,
      resumePath: '/safe/sessions/omp-1.jsonl',
      resumeCancelled: true,
      sessionFile: null,
      runInput: { ...input(), runId: 'run-2' },
    });
    secondRun.server.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await expect(secondRun.handle.done).resolves.toEqual({ status: 'succeeded' });
    const thirdRun = await start({
      server: fourth,
      adapter,
      runInput: { ...input(), runId: 'run-3' },
    });
    fourth.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await expect(thirdRun.handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(spawn).toHaveBeenCalledTimes(4);
  });

  it('rejects host tools and terminal events that arrive before prompt acceptance', async () => {
    for (const earlyFrame of [
      { type: 'host_tool_call', id: 'host-early', toolCallId: 'tool-early', toolName: 'map_validate', arguments: {} },
      { type: 'agent_end', isTerminal: true, messages: [] },
    ]) {
      const server = new FakeOmpRpc();
      const execute = vi.fn(async (call: { toolUseId: string }) => ({
        ok: true as const, toolUseId: call.toolUseId, summary: { valid: true },
      }));
      const adapter = createOhMyPiMapAgentAdapter({
        definition: { id: 'oh-my-pi', bin: '/opt/omp/bin/omp' },
        toolDefinitions: () => [TOOL],
        spawn: () => server.child,
        stopProcess: async () => undefined,
        requestTimeoutMs: 20,
      });
      const starting = adapter.startMapRun(input(undefined, execute), [TOOL], () => undefined);
      server.ready();
      await server.nextClientFrame();
      server.send(earlyFrame);
      await new Promise((resolve) => setImmediate(resolve));
      expect(execute).not.toHaveBeenCalled();
      const handle = await starting;
      await expect(handle.done).resolves.toMatchObject({ status: 'failed' });
    }
  });

  it('keeps the Run alive when OMP reports an agent_end continuation', async () => {
    const state = await start();
    state.server.send({ type: 'agent_end', willContinue: true, messages: [] });
    expect(await settlesWithin(state.handle.done)).toBe(false);
    state.server.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
  });

  it('accepts the first Run event when it shares an output chunk with the prompt acknowledgement', async () => {
    const state = await start({
      promptResponseAndFrame: {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Prompt accepted.' },
      },
    });

    expect(state.events).toContainEqual({ kind: 'text', text: 'Prompt accepted.' });
    state.server.send({ type: 'agent_end', isTerminal: true, messages: [] });
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
  });
});

function productionOmpRegistry(spawn: () => FakeOmpRpc['child']) {
  return createLocalAgentRegistry({
    definitions: [{
      id: 'oh-my-pi',
      name: 'Oh My Pi',
      bin: 'node',
      versionArgs: ['--version'],
      fallbackModels: [],
      streamFormat: 'omp-rpc',
      buildArgs: () => ['--mode', 'rpc'],
      mapDesign: { nativeToolAdapter: 'omp-rpc', publicReasoningSummary: true },
    }],
    nativeToolRegistry: {
      definitions: () => [TOOL],
      call: vi.fn(),
    },
    spawn,
    stageSkill: async () => undefined,
  });
}
