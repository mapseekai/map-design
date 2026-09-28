import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { SafeToolSummarySchema } from '@mapseekai/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_DURABLE_MAP_TOOL_NAMES,
  createCodexMapAgentAdapter,
  probeCodexAppServer,
  type CodexAppServerSpawn,
} from '../../../src/map-design/agents/codex-app-server.js';
import type { MapAgentEvent, MapRunHandle, MapRunInput } from '../../../src/map-design/agents/types.js';
import type {
  MapDesignNativeToolRegistry,
  MapNativeToolResult,
  NativeMapToolDefinition,
} from '../../../src/map-design/tools/tool-context.js';
import { defineMapAgentAdapterConformance } from './adapter-conformance.js';
import {
  createMemoryMapAgentSessionBroker,
  mapAgentSessionScope,
  type MapAgentSessionBroker,
} from '../../../src/map-design/agents/session-broker.js';

type JsonObject = Record<string, unknown>;

class FakeAppServer {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
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
  onClientFrame: ((frame: JsonObject) => void) | null = null;

  private buffer = '';
  private readonly frames: JsonObject[] = [];
  private readonly waiters: Array<(frame: JsonObject) => void> = [];

  constructor() {
    this.stdin.on('data', (chunk: Buffer | string) => {
      this.buffer += String(chunk);
      while (true) {
        const newline = this.buffer.indexOf('\n');
        if (newline < 0) return;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const frame = JSON.parse(line) as JsonObject;
        this.onClientFrame?.(frame);
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame);
        else this.frames.push(frame);
      }
    });
  }

  async nextClientFrame(): Promise<JsonObject> {
    const frame = this.frames.shift();
    if (frame) return frame;
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  send(frame: JsonObject | string): void {
    this.stdout.write(typeof frame === 'string' ? frame : `${JSON.stringify(frame)}\n`);
  }

  exit(code: number | null): void {
    this.stdout.end();
    this.child.emit('close', code);
  }
}

const TOOL: NativeMapToolDefinition = {
  name: 'map_inspect',
  description: 'Inspect the current map.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'object' },
    },
    required: ['target'],
  },
};

it('returns the final answer separately when commentary precedes native source reads', async () => {
  const state = await startRun({ stopProcessTree: async () => undefined });
  const finalResponse = '{"message":"Done","source":"complete specification"}';
  for (const [id, phase, text] of [
    ['commentary-1', 'commentary', 'Inspecting the uploaded QGIS source.'],
    ['answer-1', 'final_answer', finalResponse],
  ]) {
    state.server.send({ method: 'item/agentMessage/delta', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: id, delta: text,
    } });
    state.server.send({ method: 'item/completed', params: {
      threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id, phase, text },
    } });
    if (phase === 'commentary') state.server.send({ method: 'item/completed', params: {
      threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'read-1' },
    } });
  }
  state.server.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } });
  await expect(state.handle.done).resolves.toEqual({ status: 'succeeded', finalResponse });
  expect(state.events.filter(event => event.kind === 'text')).toEqual([
    { kind: 'text', text: 'Inspecting the uploaded QGIS source.' },
    { kind: 'text', text: finalResponse },
  ]);
});
const MUTATION_TOOL: NativeMapToolDefinition = {
  name: 'map_apply_transaction',
  description: 'Apply an atomic map transaction.',
  inputSchema: { type: 'object' },
};

it.each([null, undefined, 'final_answer'] as const)('returns only the completed answer when its phase is %s', async (phase) => {
  const state = await startRun({ stopProcessTree: async () => undefined });
  const finalResponse = '{"source":"complete"}';
  for (const item of [
    { type: 'agentMessage', id: 'progress', text: 'Reading source', phase: null },
    { type: 'agentMessage', id: 'answer', text: finalResponse, ...(phase === undefined ? {} : { phase }) },
    { type: 'reasoning', id: 'private', content: ['private reasoning'] },
  ]) state.server.send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item } });
  state.server.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } });
  await expect(state.handle.done).resolves.toEqual({ status: 'succeeded', finalResponse });
});

it.each([null, undefined, 'final_answer', 'commentary'] as const)('does not reuse streamed text for an empty or commentary-only completion with phase %s', async (phase) => {
  const state = await startRun({ stopProcessTree: async () => undefined });
  state.server.send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer', delta: 'stale or incomplete JSON' } });
  state.server.send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: {
    type: 'agentMessage', id: 'answer', text: phase === 'commentary' ? 'Still reading' : '', ...(phase === undefined ? {} : { phase }),
  } } });
  state.server.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } });
  await expect(state.handle.done).resolves.toEqual({ status: 'succeeded', finalResponse: '' });
});

it.each(['failed', 'interrupted'] as const)('does not return an answer when the turn is %s', async (status) => {
  const state = await startRun({ stopProcessTree: async () => undefined });
  state.server.send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: {
    type: 'agentMessage', id: 'answer', text: '{"source":"partial', phase: null,
  } } });
  state.server.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn(status) } });
  const result = await state.handle.done;
  expect(result.status).toBe(status === 'failed' ? 'failed' : 'canceled');
  expect(result).not.toHaveProperty('finalResponse');
});
const SEARCH_TOOL: NativeMapToolDefinition = {
  name: 'map_search_layers',
  description: 'Search map layers.',
  inputSchema: { type: 'object' },
};

function runInput(
  signal = new AbortController().signal,
  overrides: Partial<MapRunInput> & { resumePrompt?: string } = {},
): MapRunInput {
  return {
    runId: 'run-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    prompt: 'Inspect the label hierarchy.',
    resumePrompt: 'Inspect the latest label change.',
    cwd: '/safe/project',
    model: 'gpt-5.4',
    reasoning: 'high',
    serviceTier: 'priority',
    toolRuntime: {
      execute: async (call) => ({
        ok: false,
        toolUseId: call.toolUseId,
        error: { code: 'UNKNOWN_TOOL', message: 'The map tool call is not registered.', retryable: false },
      }),
      closeRun: () => undefined,
    },
    toolCallback: {
      url: 'http://127.0.0.1:8787/api/map-design/tools',
      token: 'test-only-token',
      close: () => undefined,
    },
    signal,
    ...overrides,
  } as MapRunInput;
}

function settlesWithin(promise: Promise<unknown>, timeoutMs = 50): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function nativeRegistry(result: MapNativeToolResult = {
  ok: true,
  toolUseId: 'call-1',
  summary: { target: 'layer', count: 2 },
}): MapDesignNativeToolRegistry & { call: ReturnType<typeof vi.fn> } {
  return {
    definitions: () => [TOOL],
    call: vi.fn(async () => result),
  };
}

function initializeResult(): JsonObject {
  return {
    userAgent: 'codex-app-server/0.0.0-test',
    codexHome: '/safe/codex-home',
    platformFamily: 'unix',
    platformOs: 'macos',
  };
}

function turn(status: 'completed' | 'failed' | 'interrupted' | 'inProgress', error: JsonObject | null = null): JsonObject {
  return {
    id: 'turn-1',
    items: [],
    itemsView: { type: 'full' },
    status,
    error,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: status === 'inProgress' ? null : 1,
  };
}

function mutationCall(id: number, callId: string, argumentsValue: unknown): JsonObject {
  return {
    id,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId,
      namespace: 'map-design',
      tool: 'map_apply_transaction',
      arguments: argumentsValue,
    },
  };
}

async function startRun(options: {
  server?: FakeAppServer;
  registry?: ReturnType<typeof nativeRegistry>;
  events?: MapAgentEvent[];
  tools?: NativeMapToolDefinition[];
  maxFrameBytes?: number;
  stopProcessTree?: (child: unknown) => Promise<void>;
  input?: MapRunInput;
  expectedSourceReader?: boolean;
  earlyFinalResponse?: string;
} = {}) {
  const server = options.server ?? new FakeAppServer();
  const registry = options.registry ?? nativeRegistry();
  const events = options.events ?? [];
  const tools = options.tools ?? [TOOL];
  const spawn = vi.fn(() => server.child);
  const adapter = createCodexMapAgentAdapter({
    definition: { id: 'codex', bin: '/opt/codex/bin/codex' },
    nativeToolRegistry: registry,
    spawn,
    ...(options.maxFrameBytes ? { maxFrameBytes: options.maxFrameBytes } : {}),
    ...(options.stopProcessTree ? { stopProcessTree: options.stopProcessTree } : {}),
  } as unknown as Parameters<typeof createCodexMapAgentAdapter>[0]);
  const input = options.input ?? runInput();
  const starting = adapter.startMapRun(input, tools, (event) => events.push(event));

  const initialize = await server.nextClientFrame();
  expect(initialize).toEqual({
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: 'map-design', title: 'MapDesign', version: '0.18.2' },
      capabilities: { experimentalApi: true },
    },
  });
  server.send({ id: initialize.id, result: initializeResult() });

  expect(await server.nextClientFrame()).toEqual({ method: 'initialized', params: {} });
  const threadStart = await server.nextClientFrame();
  expect(threadStart).toEqual({
    id: 2,
    method: 'thread/start',
    params: {
      cwd: '/safe/project',
      model: 'gpt-5.4',
      serviceTier: 'priority',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: false,
      environments: [],
      config: {
        model_reasoning_effort: 'high',
        model_reasoning_summary: 'detailed',
      },
      dynamicTools: tools.length || options.expectedSourceReader ? [{
        type: 'namespace',
        name: 'map-design',
        description: 'Transactional map design tools',
        tools: [...tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })), ...(options.expectedSourceReader ? [expect.objectContaining({ type: 'function', name: 'read_cartography_source' })] : [])],
      }] : [],
    },
  });
  server.send({ id: threadStart.id, result: { thread: { id: 'thread-1' } } });

  const turnStart = await server.nextClientFrame();
  expect(turnStart).toEqual({
    id: 3,
    method: 'turn/start',
    params: {
      threadId: 'thread-1',
      input: [
        { type: 'text', text: input.prompt },
        ...(input.images ?? []).map((image) => ({
          type: 'image',
          url: `data:${image.mimeType};base64,${image.data}`,
        })),
      ],
      cwd: '/safe/project',
      model: 'gpt-5.4',
      effort: 'high',
      summary: 'detailed',
      serviceTier: 'priority',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      environments: [],
    },
  });
  if (options.earlyFinalResponse !== undefined) server.send({ method: 'item/completed', params: {
    threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'early-answer', phase: 'final_answer', text: options.earlyFinalResponse },
  } });
  server.send({ id: turnStart.id, result: { turn: turn('inProgress') } });

  return {
    adapter,
    events,
    registry,
    server,
    spawn,
    handle: await starting,
  };
}

it('retains the final answer when its completion arrives before the turn start response', async () => {
  const finalResponse = '{"message":"Done","source":"complete specification"}';
  const state = await startRun({ earlyFinalResponse: finalResponse, stopProcessTree: async () => undefined });
  state.server.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } });
  await expect(state.handle.done).resolves.toEqual({ status: 'succeeded', finalResponse });
});

it('sends screenshots as Codex image URL input items', async () => {
  const state = await startRun({
    input: runInput(undefined, { images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }] }),
  });
  state.server.send({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: turn('completed') },
  });
  await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
});

it('reads only the uploaded cartography documents through a native tool without map mutation authority', async () => {
  const state = await startRun({
    tools: [], expectedSourceReader: true, stopProcessTree: async () => undefined,
    input: runInput(undefined, { taskKind: 'cartography', cartographySources: [{ fileName: 'source/document-1.qgs', content: '<qgis>original styling</qgis>' }] }),
  });
  for (const [index, args, success] of [
    [0, { fileName: 'source/document-1.qgs', offset: 6, length: 8 }, true],
    [1, { fileName: '../secrets' }, false],
    [2, { fileName: 'source/document-1.qgs', length: 16001 }, false],
  ] as const) {
    state.server.send({ id: 300 + index, method: 'item/tool/call', params: {
      threadId: 'thread-1', turnId: 'turn-1', namespace: 'map-design', callId: 'source-' + index,
      tool: 'read_cartography_source', arguments: args,
    } });
    const response = await state.server.nextClientFrame();
    expect(response).toMatchObject({ id: 300 + index, result: { success } });
    if (success) expect(response).toEqual({ id: 300, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({
      fileName: 'source/document-1.qgs', offset: 6, totalLength: 29, nextOffset: 14, content: 'original',
    }) }] } });
  }
  expect(state.registry.call).not.toHaveBeenCalled();
  state.server.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } });
  await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
});

it('accepts an outbound multimodal frame above the shared JSON-RPC default', async () => {
  const state = await startRun({
    input: runInput(undefined, {
      images: [{ data: 'A'.repeat(1_100_000), mimeType: 'image/png' }],
    }),
  });
  state.server.send({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: turn('completed') },
  });
  await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
});

async function beginSessionRun(options: {
  sessionBroker: MapAgentSessionBroker;
  input: MapRunInput;
  definitionId?: string;
  registry?: ReturnType<typeof nativeRegistry>;
}) {
  const server = new FakeAppServer();
  const events: MapAgentEvent[] = [];
  const registry = options.registry ?? nativeRegistry();
  const adapter = createCodexMapAgentAdapter({
    definition: { id: options.definitionId ?? 'codex', bin: '/opt/codex/bin/codex' },
    nativeToolRegistry: registry,
    sessionBroker: options.sessionBroker,
    spawn: () => server.child,
    stopProcessTree: async () => undefined,
  } as unknown as Parameters<typeof createCodexMapAgentAdapter>[0]);
  const starting = adapter.startMapRun(options.input, [TOOL], (event) => events.push(event));
  const initialize = await server.nextClientFrame();
  expect(initialize).toMatchObject({ method: 'initialize' });
  server.send({ id: initialize.id, result: initializeResult() });
  expect(await server.nextClientFrame()).toEqual({ method: 'initialized', params: {} });
  return {
    adapter,
    events,
    registry,
    server,
    starting,
    threadRequest: await server.nextClientFrame(),
  };
}

async function acceptSessionThread(
  state: Awaited<ReturnType<typeof beginSessionRun>>,
  threadRequest: JsonObject,
  threadId: string,
  expectedPrompt: string,
) {
  state.server.send({ id: threadRequest.id, result: { thread: { id: threadId } } });
  const turnStart = await state.server.nextClientFrame();
  expect(turnStart).toMatchObject({
    method: 'turn/start',
    params: {
      threadId,
      input: [{ type: 'text', text: expectedPrompt }],
    },
  });
  state.server.send({ id: turnStart.id, result: { turn: turn('inProgress') } });
  return state.starting;
}

async function completeSessionRun(
  state: Awaited<ReturnType<typeof beginSessionRun>>,
  handle: ReturnType<typeof acceptSessionThread> | Awaited<ReturnType<typeof acceptSessionThread>>,
  threadId: string,
): Promise<void> {
  const accepted = await handle;
  state.server.send({
    method: 'turn/completed',
    params: { threadId, turn: turn('completed') },
  });
  await expect(accepted.done).resolves.toEqual({ status: 'succeeded' });
}

it('starts a fresh cartography thread with current source tools when an older thread is remembered', async () => {
  const sessionBroker = createMemoryMapAgentSessionBroker();
  const input = runInput(undefined, { taskKind: 'cartography',
    cartographySources: [{ fileName: 'source/document-1.qgs', content: '<qgis />' }],
  });
  sessionBroker.save(mapAgentSessionScope(input, 'codex'), 'old-cartography-thread');
  const state = await beginSessionRun({ sessionBroker, input });
  expect(state.threadRequest).toMatchObject({ method: 'thread/start', params: {
    dynamicTools: [{ name: 'map-design', tools: expect.arrayContaining([
      expect.objectContaining({ name: 'read_cartography_source', inputSchema: expect.objectContaining({
        properties: expect.objectContaining({ fileName: expect.objectContaining({ enum: ['source/document-1.qgs'] }) }),
      }) }),
    ]) }],
  } });
  const handle = acceptSessionThread(state, state.threadRequest, 'fresh-cartography-thread', input.prompt);
  await completeSessionRun(state, handle, 'fresh-cartography-thread');
});

async function assertCodexCreateThenResume(): Promise<void> {
  const sessionBroker = createMemoryMapAgentSessionBroker();
  const firstInput = runInput(undefined, {
    runId: 'run-first',
    prompt: 'FULL TRANSCRIPT: first request',
    resumePrompt: 'first request',
  });
  const first = await beginSessionRun({ sessionBroker, input: firstInput });
  expect(first.threadRequest).toMatchObject({
    method: 'thread/start',
    params: { ephemeral: false },
  });
  const firstHandle = acceptSessionThread(
    first,
    first.threadRequest,
    'codex-session-1',
    'FULL TRANSCRIPT: first request',
  );
  await completeSessionRun(first, firstHandle, 'codex-session-1');
  expect(sessionBroker.load(mapAgentSessionScope(firstInput, 'codex'))).toBe('codex-session-1');

  const secondInput = runInput(undefined, {
    runId: 'run-second',
    prompt: 'FULL TRANSCRIPT: first request and second request',
    resumePrompt: 'second request only',
  });
  const second = await beginSessionRun({ sessionBroker, input: secondInput });
  expect(second.threadRequest).toEqual({
    id: 2,
    method: 'thread/resume',
    params: {
      threadId: 'codex-session-1',
      cwd: '/safe/project',
      model: 'gpt-5.4',
      serviceTier: 'priority',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: {
        model_reasoning_effort: 'high',
        model_reasoning_summary: 'detailed',
      },
      excludeTurns: true,
    },
  });
  const secondHandle = acceptSessionThread(
    second,
    second.threadRequest,
    'codex-session-1',
    'second request only',
  );
  const handle = await secondHandle;
  second.server.send({
    id: 90,
    method: 'item/tool/call',
    params: {
      threadId: 'codex-session-1',
      turnId: 'turn-1',
      callId: 'call-1',
      namespace: 'map-design',
      tool: 'map_inspect',
      arguments: { target: { kind: 'root' } },
    },
  });
  expect(await second.server.nextClientFrame()).toMatchObject({ id: 90, result: { success: true } });
  await completeSessionRun(second, Promise.resolve(handle), 'codex-session-1');
  expect(second.registry.call).toHaveBeenCalledWith(
    expect.objectContaining({ toolUseId: 'call-1' }),
    'map_inspect',
    { target: { kind: 'root' } },
  );
}

async function cancelConformanceRun(state: Awaited<ReturnType<typeof startRun>>): Promise<void> {
  const canceling = state.handle.cancel();
  const interrupt = await state.server.nextClientFrame();
  expect(interrupt).toMatchObject({
    method: 'turn/interrupt',
    params: { threadId: 'thread-1', turnId: 'turn-1' },
  });
  state.server.send({ id: interrupt.id, result: {} });
  await canceling;
}

defineMapAgentAdapterConformance('Codex app-server', {
  async registration() {
    const state = await startRun({ tools: [TOOL, SEARCH_TOOL], stopProcessTree: async () => undefined });
    expect(state.registry.definitions()).toEqual([TOOL]);
    await cancelConformanceRun(state);
  },
  async correlatedResult() {
    const state = await startRun({ stopProcessTree: async () => undefined });
    state.server.send({
      id: 101,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1',
        namespace: 'map-design', tool: 'map_inspect', arguments: { target: { kind: 'root' } },
      },
    });
    expect(await state.server.nextClientFrame()).toMatchObject({ id: 101, result: { success: true } });
    expect(state.events).toContainEqual({
      kind: 'tool_result', toolUseId: 'call-1', status: 'succeeded',
      summary: { target: 'layer', count: 2 },
    });
    await cancelConformanceRun(state);
  },
  async normalizedEvents() {
    const state = await startRun({ stopProcessTree: async () => undefined });
    state.server.send({
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reason-1', summaryIndex: 0, delta: 'Checking.' },
    });
    state.server.send({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Done.' },
    });
    state.server.send({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: turn('completed') },
    });
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(state.events).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'thinking', text: 'Checking.' },
      { kind: 'text', text: 'Done.' },
      { kind: 'run_finished', status: 'succeeded' },
    ]);
  },
  async cancellation() {
    const stopProcessTree = vi.fn(async () => undefined);
    const state = await startRun({ stopProcessTree });
    await cancelConformanceRun(state);
    await expect(state.handle.done).resolves.toEqual({ status: 'canceled' });
    expect(stopProcessTree).toHaveBeenCalledOnce();
  },
  async malformedAndOversizedFrames() {
    for (const frame of ['{not-json}\n', `${'x'.repeat(1_025)}\n`]) {
      const state = await startRun({ maxFrameBytes: 1_024, stopProcessTree: async () => undefined });
      state.server.send(frame);
      await expect(state.handle.done).resolves.toMatchObject({ status: 'failed' });
    }
  },
  async duplicateCalls() {
    let release!: (result: MapNativeToolResult) => void;
    const pending = new Promise<MapNativeToolResult>((resolve) => { release = resolve; });
    const registry = nativeRegistry();
    registry.call.mockImplementation(async () => pending);
    const state = await startRun({ registry, stopProcessTree: async () => undefined });
    const params = {
      threadId: 'thread-1', turnId: 'turn-1', callId: 'duplicate-call',
      namespace: 'map-design', tool: 'map_inspect', arguments: { target: { kind: 'root' } },
    };
    state.server.send({ id: 102, method: 'item/tool/call', params });
    state.server.send({ id: 103, method: 'item/tool/call', params });
    expect(await state.server.nextClientFrame()).toMatchObject({ id: 103, result: { success: false } });
    release({ ok: true, toolUseId: 'duplicate-call', summary: { completed: true } });
    expect(await state.server.nextClientFrame()).toMatchObject({ id: 102, result: { success: true } });
    expect(registry.call).toHaveBeenCalledTimes(1);
    await cancelConformanceRun(state);
  },
  async loopGuard() {
    const registry = nativeRegistry();
    registry.call.mockImplementation(async (context) => ({
      ok: false,
      toolUseId: context.toolUseId,
      error: { code: 'INVALID_INPUT', message: 'The map tool input is invalid.', retryable: false },
    }));
    const state = await startRun({
      registry,
      tools: [MUTATION_TOOL],
      stopProcessTree: async () => undefined,
    });
    for (let count = 1; count <= 8; count += 1) {
      state.server.send(mutationCall(110 + count, `loop-${count}`, { expectedRevision: 4 }));
      expect(await state.server.nextClientFrame()).toMatchObject({
        id: 110 + count,
        result: { success: false },
      });
    }
    await expect(state.handle.done).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_LOOP_DETECTED' },
    });
    expect(state.events).toContainEqual(expect.objectContaining({
      kind: 'tool_result',
      toolUseId: 'loop-8',
      summary: expect.objectContaining({ loopHalted: true, failureCount: 8 }),
    }));
  },
  async sessionResumeOrReseed() {
    await assertCodexCreateThenResume();
  },
  async lateEventRejection() {
    const state = await startRun({ stopProcessTree: async () => undefined });
    state.server.send({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: turn('completed') },
    });
    await state.handle.done;
    const terminalEvents = structuredClone(state.events);
    state.server.send({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'late', delta: 'late text' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.events).toEqual(terminalEvents);
  },
});

describe('Codex app-server Map Agent adapter', () => {
  it('falls back from a rejected resume to exactly one durable full-transcript reseed', async () => {
    const sessionBroker = createMemoryMapAgentSessionBroker();
    const input = runInput(undefined, {
      prompt: 'FULL TRANSCRIPT: reseed this conversation',
      resumePrompt: 'latest turn must not be used for reseed',
    });
    sessionBroker.save(mapAgentSessionScope(input, 'codex'), 'missing-session');
    const state = await beginSessionRun({ sessionBroker, input });
    expect(state.threadRequest).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'missing-session' },
    });
    state.server.send({
      id: state.threadRequest.id,
      error: { code: -32_001, message: 'thread not found' },
    });

    const reseed = await state.server.nextClientFrame();
    expect(reseed).toMatchObject({
      method: 'thread/start',
      params: { ephemeral: false },
    });
    const handle = acceptSessionThread(
      state,
      reseed,
      'replacement-session',
      'FULL TRANSCRIPT: reseed this conversation',
    );
    await completeSessionRun(state, handle, 'replacement-session');

    expect(sessionBroker.load(mapAgentSessionScope(input, 'codex'))).toBe('replacement-session');
    expect([
      state.threadRequest.method,
      reseed.method,
    ]).toEqual(['thread/resume', 'thread/start']);
  });

  it.each([
    ['another conversation', 'codex', 'conversation-2'],
    ['another Agent', 'codex-other', 'conversation-1'],
  ])('never reuses a Codex thread for %s', async (_case, definitionId, conversationId) => {
    const sessionBroker = createMemoryMapAgentSessionBroker();
    const originalInput = runInput();
    sessionBroker.save(mapAgentSessionScope(originalInput, 'codex'), 'codex-session-1');
    const state = await beginSessionRun({
      sessionBroker,
      definitionId,
      input: runInput(undefined, { conversationId }),
    });

    expect(state.threadRequest).toMatchObject({
      method: 'thread/start',
      params: { ephemeral: false },
    });
    const handle = acceptSessionThread(state, state.threadRequest, 'isolated-session', 'Inspect the label hierarchy.');
    await completeSessionRun(state, handle, 'isolated-session');
    expect(sessionBroker.load(mapAgentSessionScope(originalInput, 'codex'))).toBe('codex-session-1');
  });

  it('keeps the canonical five durable mutation names aligned with the native registry', () => {
    expect(CODEX_DURABLE_MAP_TOOL_NAMES).toEqual([
      'map_apply_transaction',
      'map_update_semantics',
      'map_render_preview',
      'map_commit_revision',
      'map_discard_draft',
    ]);
  });

  it('keeps a real cold thread-start probe alive beyond five seconds', async () => {
    vi.useFakeTimers();
    try {
      const server = new FakeAppServer();
      const probing = probeCodexAppServer({
        definition: { id: 'codex', bin: '/opt/codex/bin/codex' },
        nativeToolRegistry: nativeRegistry(),
        spawn: () => server.child,
        stopProcessTree: async () => undefined,
      });
      const initialize = await server.nextClientFrame();
      server.send({ id: initialize.id, result: initializeResult() });
      expect(await server.nextClientFrame()).toEqual({ method: 'initialized', params: {} });
      const threadStart = await server.nextClientFrame();
      setTimeout(() => server.send({ id: threadStart.id, result: { thread: { id: 'thread-probe' } } }), 7_500);

      await vi.advanceTimersByTimeAsync(7_500);

      await expect(probing).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a real cold run thread-start alive beyond five seconds', async () => {
    vi.useFakeTimers();
    try {
      const server = new FakeAppServer();
      const adapter = createCodexMapAgentAdapter({
        definition: { id: 'codex', bin: '/opt/codex/bin/codex' },
        nativeToolRegistry: nativeRegistry(),
        spawn: () => server.child,
        stopProcessTree: async () => undefined,
      });
      const starting = adapter.startMapRun(runInput(), [TOOL], () => undefined);
      let startError: unknown;
      void starting.catch((error: unknown) => { startError = error; });
      const initialize = await server.nextClientFrame();
      server.send({ id: initialize.id, result: initializeResult() });
      expect(await server.nextClientFrame()).toEqual({ method: 'initialized', params: {} });
      const threadStart = await server.nextClientFrame();
      setTimeout(() => server.send({ id: threadStart.id, result: { thread: { id: 'thread-1' } } }), 7_500);

      await vi.advanceTimersByTimeAsync(7_500);

      expect(startError).toBeUndefined();
      const turnStart = await server.nextClientFrame();
      server.send({ id: turnStart.id, result: { turn: turn('inProgress') } });
      const handle = await starting;
      server.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } });
      await expect(handle.done).resolves.toEqual({ status: 'succeeded' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('pins the turn-start response and sends a durable read-only thread with clamped reasoning', async () => {
    const server = new FakeAppServer();
    const adapter = createCodexMapAgentAdapter({
      definition: { id: 'codex', bin: '/opt/codex/bin/codex' },
      nativeToolRegistry: nativeRegistry(),
      spawn: () => server.child,
    });
    const starting = adapter.startMapRun({
      ...runInput(),
      model: 'gpt-5.1',
      reasoning: 'xhigh',
    }, [TOOL], () => undefined);

    const initialize = await server.nextClientFrame();
    server.send({ id: initialize.id, result: initializeResult() });
    expect(await server.nextClientFrame()).toEqual({ method: 'initialized', params: {} });

    const threadStart = await server.nextClientFrame();
    expect(threadStart).toEqual({
      id: 2,
      method: 'thread/start',
      params: {
        cwd: '/safe/project',
        model: 'gpt-5.1',
        serviceTier: 'priority',
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: false,
        environments: [],
        config: {
          model_reasoning_effort: 'high',
          model_reasoning_summary: 'detailed',
        },
        dynamicTools: [{
          type: 'namespace',
          name: 'map-design',
          description: 'Transactional map design tools',
          tools: [{
            type: 'function',
            name: 'map_inspect',
            description: 'Inspect the current map.',
            inputSchema: TOOL.inputSchema,
          }],
        }],
      },
    });
    server.send({ id: threadStart.id, result: { thread: { id: 'thread-1' } } });

    const turnStart = await server.nextClientFrame();
    expect(turnStart).toEqual({
      id: 3,
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'Inspect the label hierarchy.' }],
        cwd: '/safe/project',
        model: 'gpt-5.1',
        effort: 'high',
        summary: 'detailed',
        serviceTier: 'priority',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        environments: [],
      },
    });
    server.send({ id: turnStart.id, result: { turn: turn('inProgress') } });
    const handle = await starting;
    server.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } });
    await expect(handle.done).resolves.toEqual({ status: 'succeeded' });
  });

  it('applies the Codex mini-model reasoning clamp to both thread and turn settings', async () => {
    const server = new FakeAppServer();
    const adapter = createCodexMapAgentAdapter({
      definition: { id: 'codex', bin: '/opt/codex/bin/codex' },
      nativeToolRegistry: nativeRegistry(),
      spawn: () => server.child,
      stopProcessTree: async () => undefined,
    });
    const starting = adapter.startMapRun({
      ...runInput(),
      model: 'gpt-5.1-codex-mini',
      reasoning: 'xhigh',
    }, [TOOL], () => undefined);
    const initialize = await server.nextClientFrame();
    server.send({ id: initialize.id, result: initializeResult() });
    await server.nextClientFrame();
    const threadStart = await server.nextClientFrame();
    expect(threadStart).toMatchObject({
      params: { config: { model_reasoning_effort: 'high' } },
    });
    server.send({ id: threadStart.id, result: { thread: { id: 'thread-1' } } });
    const turnStart = await server.nextClientFrame();
    expect(turnStart).toMatchObject({ params: { effort: 'high' } });
    server.send({ id: turnStart.id, result: { turn: turn('inProgress') } });
    const handle = await starting;
    await handle.cancel();
  });

  it('rejects a turn/started notification that does not confirm the exact turn-start id', async () => {
    const state = await startRun();

    state.server.send({
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: { ...turn('inProgress'), id: 'turn-2' },
      },
    });
    state.server.send({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { ...turn('completed'), id: 'turn-2' } },
    });

    await expect(state.handle.done).resolves.toEqual({
      status: 'failed',
      error: {
        code: 'RUN_FAILED',
        message: 'The Codex app-server connection ended unexpectedly.',
      },
    });
  });

  it('stops a coalesced stream after a terminal frame before it can dispatch a later tool call', async () => {
    const state = await startRun();
    const complete = {
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: turn('completed') },
    };
    const call = {
      id: 63,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'late-call',
        namespace: 'map-design',
        tool: 'map_inspect',
        arguments: { target: { kind: 'root' } },
      },
    };

    state.server.send(`${JSON.stringify(complete)}\n${JSON.stringify(call)}\n`);

    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.registry.call).not.toHaveBeenCalled();
  });

  it('bounds each app-server handshake request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = new FakeAppServer();
    const adapter = createCodexMapAgentAdapter({
      definition: { id: 'codex', bin: '/opt/codex/bin/codex' },
      nativeToolRegistry: nativeRegistry(),
      spawn: () => server.child,
      requestTimeoutMs: 5,
      stopProcessTree: async () => undefined,
    } as unknown as Parameters<typeof createCodexMapAgentAdapter>[0]);
    const starting = adapter.startMapRun(runInput(), [TOOL], () => undefined);
    await server.nextClientFrame();

    await expect(settlesWithin(starting)).resolves.toBe(true);
    await expect(starting).rejects.toThrow(/Codex app-server protocol unavailable/u);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"protocolCategory":"timeout"'));
    warn.mockRestore();
  });

  it.each(['thread/start', 'turn/start'] as const)('bounds a hung %s app-server handshake request', async (phase) => {
    const server = new FakeAppServer();
    const adapter = createCodexMapAgentAdapter({
      definition: { id: 'codex', bin: '/opt/codex/bin/codex' },
      nativeToolRegistry: nativeRegistry(),
      spawn: () => server.child,
      requestTimeoutMs: 5,
      stopProcessTree: async () => undefined,
    });
    const starting = adapter.startMapRun(runInput(), [TOOL], () => undefined);
    const initialize = await server.nextClientFrame();
    server.send({ id: initialize.id, result: initializeResult() });
    expect(await server.nextClientFrame()).toEqual({ method: 'initialized', params: {} });
    const threadStart = await server.nextClientFrame();
    if (phase === 'thread/start') {
      await expect(settlesWithin(starting)).resolves.toBe(true);
      await expect(starting).rejects.toThrow(/Codex app-server protocol unavailable/u);
      return;
    }
    server.send({ id: threadStart.id, result: { thread: { id: 'thread-1' } } });
    await server.nextClientFrame();

    await expect(settlesWithin(starting)).resolves.toBe(true);
    await expect(starting).rejects.toThrow(/Codex app-server protocol unavailable/u);
  });

  it('queues a terminal notification until the turn-start response pins its exact id', async () => {
    const server = new FakeAppServer();
    const adapter = createCodexMapAgentAdapter({
      definition: { id: 'codex', bin: '/opt/codex/bin/codex' },
      nativeToolRegistry: nativeRegistry(),
      spawn: () => server.child,
      stopProcessTree: async () => undefined,
    });
    const starting = adapter.startMapRun(runInput(), [TOOL], () => undefined);
    const initialize = await server.nextClientFrame();
    server.send({ id: initialize.id, result: initializeResult() });
    await server.nextClientFrame();
    const threadStart = await server.nextClientFrame();
    server.send({ id: threadStart.id, result: { thread: { id: 'thread-1' } } });
    const turnStart = await server.nextClientFrame();

    server.send(`${JSON.stringify({ id: turnStart.id, result: { turn: turn('inProgress') } })}\n${JSON.stringify({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: turn('completed') },
    })}\n`);

    const handle = await starting;
    await expect(handle.done).resolves.toEqual({ status: 'succeeded' });
  });

  it('sanitizes the app-server environment before spawning the child', async () => {
    const server = new FakeAppServer();
    const spawn = vi.fn((
      _command: string,
      _args: string[],
      _options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean },
    ) => server.child);
    const adapter = createCodexMapAgentAdapter({
      definition: {
        id: 'codex',
        bin: '/opt/codex/bin/codex',
        inheritedEnvKeys: ['CODEX_HOME', 'OPENAI_API_KEY'],
      },
      nativeToolRegistry: nativeRegistry(),
      spawn,
      environment: () => ({
        PATH: '/safe/bin',
        HOME: '/safe/home',
        LANG: 'en_US.UTF-8',
        MAP_DESIGN_API_TOKEN: 'daemon-api-secret',
        MAP_DESIGN_DATA_DIR: '/private/daemon-data',
        MAP_DESIGN_TOOL_CALLBACK_URL: 'http://127.0.0.1/private',
        MAP_DESIGN_TOOL_CALLBACK_TOKEN: 'stale-callback-token',
        MAP_DESIGN_RUN_ID: 'stale-run',
        MAP_DESIGN_PROJECT_ID: 'stale-project',
        MAP_DESIGN_CONVERSATION_ID: 'stale-conversation',
        MAP_DESIGN_AGENT_ID: 'stale-agent',
        MAP_DESIGN_PLUGIN_PROBE_PATH: '/private/stale-probe',
        MAP_DESIGN_PROFILE_PROBE_TOOLS: 'stale-tools',
        DSH_HOME: '/private/stale-profile-home',
        OPENAI_API_KEY: 'secret-api-key',
        MAP_DESIGN_TOOL_TOKEN: 'secret-tool-token',
        AWS_SECRET_ACCESS_KEY: 'ambient-aws-secret',
        DATABASE_URL: 'postgres://ambient-secret',
        UNRELATED_SECRET: 'secret-value',
      }),
    });
    const starting = adapter.startMapRun(runInput(), [TOOL], () => undefined);
    await server.nextClientFrame();

    const environment = spawn.mock.calls[0]?.[2]?.env;
    expect(environment).toMatchObject({ PATH: '/safe/bin', HOME: '/safe/home', LANG: 'en_US.UTF-8' });
    expect(environment).toMatchObject({ OPENAI_API_KEY: 'secret-api-key' });
    expect(environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(environment).not.toHaveProperty('DATABASE_URL');
    expect(environment).not.toHaveProperty('MAP_DESIGN_TOOL_TOKEN');
    expect(environment).not.toHaveProperty('UNRELATED_SECRET');
    expect(Object.keys(environment ?? {}).filter((key) => key.startsWith('MAP_DESIGN_'))).toEqual([]);
    expect(environment).not.toHaveProperty('DSH_HOME');

    server.exit(1);
    await expect(starting).rejects.toThrow(/Codex app-server protocol unavailable/u);
  });

  it('sanitizes daemon-private values from the app-server probe environment', async () => {
    const server = new FakeAppServer();
    const spawn = vi.fn<CodexAppServerSpawn>(() => server.child);
    const probing = probeCodexAppServer({
      definition: {
        id: 'codex',
        bin: '/opt/codex/bin/codex',
        inheritedEnvKeys: ['CODEX_HOME', 'OPENAI_API_KEY'],
      },
      nativeToolRegistry: nativeRegistry(),
      spawn,
      stopProcessTree: async () => undefined,
      environment: () => ({
        PATH: '/safe/bin',
        CODEX_HOME: '/safe/codex-home',
        OPENAI_API_KEY: 'selected-provider-secret',
        AWS_SECRET_ACCESS_KEY: 'ambient-aws-secret',
        DATABASE_URL: 'postgres://ambient-secret',
        UNRELATED_SECRET: 'secret-value',
        MAP_DESIGN_API_TOKEN: 'daemon-api-secret',
        MAP_DESIGN_DATA_DIR: '/private/daemon-data',
        MAP_DESIGN_TOOL_CALLBACK_TOKEN: 'stale-callback-token',
        MAP_DESIGN_PLUGIN_PROBE_PATH: '/private/stale-probe',
        DSH_HOME: '/private/stale-profile-home',
      }),
    });
    const initialize = await server.nextClientFrame();
    server.send({ id: initialize.id, result: initializeResult() });
    await server.nextClientFrame();
    const threadStart = await server.nextClientFrame();
    server.send({ id: threadStart.id, result: { thread: { id: 'probe-thread' } } });

    await expect(probing).resolves.toBe(true);
    const environment = spawn.mock.calls[0]?.[2].env;
    expect(environment).toMatchObject({
      PATH: '/safe/bin',
      CODEX_HOME: '/safe/codex-home',
      OPENAI_API_KEY: 'selected-provider-secret',
    });
    expect(environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(environment).not.toHaveProperty('DATABASE_URL');
    expect(environment).not.toHaveProperty('UNRELATED_SECRET');
    expect(Object.keys(environment ?? {}).filter((key) => key.startsWith('MAP_DESIGN_'))).toEqual([]);
    expect(environment).not.toHaveProperty('DSH_HOME');
  });

  it('uses the process-tree reaper when cancellation interrupts an active app-server turn', async () => {
    const stopProcessTree = vi.fn(async () => undefined);
    const state = await startRun({ stopProcessTree });

    await state.handle.cancel();

    expect(stopProcessTree).toHaveBeenCalledOnce();
    expect(stopProcessTree).toHaveBeenCalledWith(state.server.child);
  });

  it('waits for an in-flight atomic mutation and reports durable success after cancellation', async () => {
    let release!: (result: MapNativeToolResult) => void;
    const registry = nativeRegistry();
    registry.call
      .mockResolvedValueOnce({
        ok: false,
        toolUseId: 'historical-failure',
        error: { code: 'REVISION_CONFLICT', message: 'The map revision changed.', retryable: false },
      })
      .mockImplementationOnce(() => new Promise<MapNativeToolResult>((resolve) => {
        release = resolve;
      }));
    const state = await startRun({ registry, tools: [MUTATION_TOOL], stopProcessTree: async () => undefined });

    state.server.send({
      id: 63,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'historical-failure',
        namespace: 'map-design',
        tool: 'map_apply_transaction',
        arguments: { expectedRevision: 3 },
      },
    });
    expect(await state.server.nextClientFrame()).toMatchObject({ id: 63, result: { success: false } });
    state.server.send({
      id: 64,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-in-flight',
        namespace: 'map-design',
        tool: 'map_apply_transaction',
        arguments: { expectedRevision: 4 },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.call).toHaveBeenCalledTimes(2);

    const cancellation = state.handle.cancel();
    const canceledBeforeSettlement = await settlesWithin(cancellation);
    expect(await state.server.nextClientFrame()).toMatchObject({ method: 'turn/interrupt' });
    release({ ok: true, toolUseId: 'call-in-flight', summary: { revision: 5 } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(canceledBeforeSettlement).toBe(false);
    expect(await state.server.nextClientFrame()).toEqual({
      id: 64,
      result: {
        contentItems: [{ type: 'inputText', text: '{"revision":5}' }],
        success: true,
      },
    });
    await cancellation;

    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(state.events).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'tool_use', id: 'historical-failure', name: 'map_apply_transaction', summary: {} },
      { kind: 'tool_result', toolUseId: 'historical-failure', status: 'failed', summary: { code: 'REVISION_CONFLICT', retryable: false } },
      { kind: 'tool_use', id: 'call-in-flight', name: 'map_apply_transaction', summary: {} },
      { kind: 'tool_result', toolUseId: 'call-in-flight', status: 'succeeded', summary: { revision: 5 } },
      { kind: 'run_finished', status: 'succeeded' },
    ]);
  });

  it('ignores a historical durable failure when the cancellation-snapshot call is canceled precommit', async () => {
    let release!: (result: MapNativeToolResult) => void;
    const registry = nativeRegistry();
    registry.call
      .mockResolvedValueOnce({
        ok: false,
        toolUseId: 'historical-failure',
        error: { code: 'REVISION_CONFLICT', message: 'The map revision changed.', retryable: false },
      })
      .mockImplementationOnce(() => new Promise<MapNativeToolResult>((resolve) => { release = resolve; }));
    const state = await startRun({ registry, tools: [MUTATION_TOOL], stopProcessTree: async () => undefined });
    const request = (id: number, callId: string, expectedRevision: number) => ({
      id,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1', turnId: 'turn-1', callId, namespace: 'map-design',
        tool: 'map_apply_transaction', arguments: { expectedRevision },
      },
    });
    state.server.send(request(63, 'historical-failure', 3));
    expect(await state.server.nextClientFrame()).toMatchObject({ id: 63, result: { success: false } });
    state.server.send(request(64, 'call-in-flight', 4));
    await new Promise((resolve) => setImmediate(resolve));

    const cancellation = state.handle.cancel();
    expect(await state.server.nextClientFrame()).toMatchObject({ method: 'turn/interrupt' });
    release({
      ok: false,
      toolUseId: 'call-in-flight',
      error: { code: 'CANCELED', message: 'The map tool call was canceled.', retryable: false },
    });
    expect(await state.server.nextClientFrame()).toMatchObject({ id: 64, result: { success: false } });
    await cancellation;

    await expect(state.handle.done).resolves.toEqual({ status: 'canceled' });
    expect(state.events).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'tool_use', id: 'historical-failure', name: 'map_apply_transaction', summary: {} },
      { kind: 'tool_result', toolUseId: 'historical-failure', status: 'failed', summary: { code: 'REVISION_CONFLICT', retryable: false } },
      { kind: 'tool_use', id: 'call-in-flight', name: 'map_apply_transaction', summary: {} },
      { kind: 'tool_result', toolUseId: 'call-in-flight', status: 'canceled', summary: { code: 'CANCELED', retryable: false } },
      { kind: 'run_finished', status: 'canceled' },
    ]);
  });

  it('rejects a duplicate call id while the first native tool execution is in flight', async () => {
    let release!: (result: MapNativeToolResult) => void;
    const registry = nativeRegistry();
    registry.call.mockImplementationOnce(() => new Promise<MapNativeToolResult>((resolve) => {
      release = resolve;
    }));
    const state = await startRun({ registry, stopProcessTree: async () => undefined });
    const params = {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'duplicate-call',
      namespace: 'map-design',
      tool: 'map_inspect',
      arguments: { target: { kind: 'root' } },
    };

    state.server.send({ id: 65, method: 'item/tool/call', params });
    state.server.send({ id: 66, method: 'item/tool/call', params });

    expect(await state.server.nextClientFrame()).toEqual({
      id: 66,
      result: {
        contentItems: [{
          type: 'inputText',
          text: '{"code":"UNKNOWN_TOOL","message":"The map tool call is not registered.","retryable":false}',
        }],
        success: false,
      },
    });
    expect(registry.call).toHaveBeenCalledOnce();
    release({ ok: true, toolUseId: 'duplicate-call', summary: { completed: true } });
    expect(await state.server.nextClientFrame()).toEqual({
      id: 65,
      result: {
        contentItems: [{ type: 'inputText', text: '{"completed":true}' }],
        success: true,
      },
    });
    expect(registry.call).toHaveBeenCalledOnce();
  });

  it.each(['error', 'turn/completed'])('distinguishes %s failures and records only the first safe cause', async (method) => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const state = await startRun();
      const error = { message: 'secret prompt https://private.example/token',
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429, secret: 'credential' } } };
      state.server.send({ method, params: method === 'error'
        ? { threadId: 'thread-1', turnId: 'turn-1', willRetry: false, error }
        : { threadId: 'thread-1', turn: turn('failed', error) } });
      expect(await state.handle.done).toMatchObject({ status: 'failed', error: {
        message: 'The Codex turn failed before completion.',
      } });
      state.server.child.emit('close', 1, 'SIGTERM');
      expect(log).toHaveBeenCalledOnce();
      const diagnostic = JSON.parse(String(log.mock.calls[0]![0]));
      expect(diagnostic).toMatchObject({ event: 'codex_app_server_failure', runId: 'run-1', phase: 'turn',
        origin: method === 'error' ? 'error-notification' : 'turn-failed',
        codexErrorInfo: 'httpConnectionFailed', httpStatusCode: 429 });
      expect(JSON.stringify(diagnostic)).not.toMatch(/secret|private|credential/);
    } finally { log.mockRestore(); }
  });

  it('records process exit separately from turn failure', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const state = await startRun();
      state.server.child.emit('close', 7, 'SIGKILL');
      expect(await state.handle.done).toMatchObject({ error: { message: 'The Codex app-server connection ended unexpectedly.' } });
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ origin: 'process-exit', exitCode: 7, signal: 'SIGKILL' });
      expect(log).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });

  it('classifies EOF and never logs an unknown provider category or message', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = await startRun();
      first.server.stdout.end();
      expect(await first.handle.done).toMatchObject({ status: 'failed' });
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ origin: 'rpc', protocolCategory: 'eof' });
      log.mockClear();
      const second = await startRun();
      second.server.send({ method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', willRetry: false,
        error: { message: 'credential', codexErrorInfo: { credential: { httpStatusCode: 401 } } } } });
      await second.handle.done;
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ origin: 'error-notification', codexErrorInfo: 'unknown' });
      expect(String(log.mock.calls[0]![0])).not.toMatch(/credential|httpStatusCode/);
    } finally { log.mockRestore(); }
  });

  it('fails closed when a turn-scoped text delta carries a different turn id', async () => {
    const state = await startRun();

    state.server.send({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        itemId: 'message-1',
        delta: 'wrong turn',
      },
    });

    await expect(state.handle.done).resolves.toEqual({
      status: 'failed',
      error: {
        code: 'RUN_FAILED',
        message: 'The Codex app-server connection ended unexpectedly.',
      },
    });
    expect(state.events).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'run_finished', status: 'failed' },
    ]);
  });

  it('validates retryable turn errors against the pinned thread and turn ids', async () => {
    const state = await startRun();

    state.server.send({
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        willRetry: true,
        error: { message: 'wrong turn' },
      },
    });
    state.server.send({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: turn('completed') },
    });

    await expect(state.handle.done).resolves.toEqual({
      status: 'failed',
      error: {
        code: 'RUN_FAILED',
        message: 'The Codex app-server connection ended unexpectedly.',
      },
    });
  });

  it('uses experimental namespaced dynamic tools and returns only the safe native result', async () => {
    const state = await startRun();

    state.server.send({
      id: 60,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: 'map-design',
        tool: 'map_inspect',
        arguments: { target: { kind: 'root' } },
      },
    });

    expect(await state.server.nextClientFrame()).toEqual({
      id: 60,
      result: {
        contentItems: [{ type: 'inputText', text: '{"target":"layer","count":2}' }],
        success: true,
      },
    });
    expect(state.registry.call).toHaveBeenCalledOnce();
    expect(state.registry.call).toHaveBeenCalledWith({
      runId: 'run-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      toolUseId: 'call-1',
      signal: expect.any(AbortSignal),
    }, 'map_inspect', { target: { kind: 'root' } });
    expect(state.events).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'tool_use', id: 'call-1', name: 'map_inspect', summary: {} },
      { kind: 'tool_result', toolUseId: 'call-1', status: 'succeeded', summary: { target: 'layer', count: 2 } },
    ]);
    expect(state.spawn).toHaveBeenCalledWith('/opt/codex/bin/codex', ['app-server', '--stdio'], expect.objectContaining({ cwd: '/safe/project' }));
    expect(state.server.stderr.readableFlowing).toBe(true);
  });

  it('returns private query records to the model without persisting them in public tool events', async () => {
    const registry = nativeRegistry({
      ok: true,
      toolUseId: 'call-1',
      summary: { returned: 2, truncated: false },
      modelContent: JSON.stringify({
        layers: [
          { id: 'roads', type: 'line' },
          { id: 'parks', type: 'fill' },
        ],
        returned: 2,
        truncated: false,
      }),
    } as MapNativeToolResult);
    const state = await startRun({ registry });

    state.server.send({
      id: 61,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: 'map-design',
        tool: 'map_inspect',
        arguments: { target: { kind: 'root' } },
      },
    });

    expect(await state.server.nextClientFrame()).toEqual({
      id: 61,
      result: {
        contentItems: [{
          type: 'inputText',
          text: '{"layers":[{"id":"roads","type":"line"},{"id":"parks","type":"fill"}],"returned":2,"truncated":false}',
        }],
        success: true,
      },
    });
    expect(state.events).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'tool_use', id: 'call-1', name: 'map_inspect', summary: {} },
      {
        kind: 'tool_result',
        toolUseId: 'call-1',
        status: 'succeeded',
        summary: { returned: 2, truncated: false },
      },
    ]);
    expect(JSON.stringify(state.events)).not.toContain('roads');
    expect(JSON.stringify(state.events)).not.toContain('parks');
  });

  it('returns a safe failed tool result without leaking an arbitrary provider error', async () => {
    const registry = nativeRegistry({
      ok: false,
      toolUseId: 'call-1',
      error: {
        code: 'REVISION_CONFLICT',
        message: 'The map draft revision has changed.',
        retryable: true,
        details: { issueCount: 2, firstPath: 'transaction.operations.0.op' },
      },
    });
    const state = await startRun({ registry });

    state.server.send({
      id: 61,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: 'map-design',
        tool: 'map_inspect',
        arguments: {},
      },
    });

    const response = await state.server.nextClientFrame();
    expect(response).toEqual({
      id: 61,
      result: {
        contentItems: [{
          type: 'inputText',
          text: '{"code":"REVISION_CONFLICT","message":"The map draft revision has changed.","retryable":true,"details":{"issueCount":2,"firstPath":"transaction.operations.0.op"}}',
        }],
      success: false,
      },
    });
    expect(state.events).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'tool_use', id: 'call-1', name: 'map_inspect', summary: {} },
      {
        kind: 'tool_result',
        toolUseId: 'call-1',
        status: 'failed',
        summary: {
          code: 'REVISION_CONFLICT',
          retryable: true,
          issueCount: 2,
          firstPath: 'transaction.operations.0.op',
        },
      },
    ]);
    const contentItems = (response.result as { contentItems: Array<{ text: string }> }).contentItems;
    const modelFailure = JSON.parse(contentItems[0]!.text) as { details: Record<string, unknown> };
    const resultEvent = state.events.find((event) => event.kind === 'tool_result');
    if (!resultEvent || resultEvent.kind !== 'tool_result') throw new TypeError('missing tool result');
    expect(SafeToolSummarySchema.safeParse(modelFailure.details).success).toBe(true);
    expect(SafeToolSummarySchema.safeParse(resultEvent.summary).success).toBe(true);
    expect(modelFailure.details.firstPath).toBe('transaction.operations.0.op');
    expect(resultEvent.summary.firstPath).toBe(modelFailure.details.firstPath);
  });

  it('warns once and halts the exact turn after repeated invalid mutations', async () => {
    const rawSecret = 'raw-transaction-secret';
    const registry = nativeRegistry();
    registry.call.mockImplementation(async (...args: Parameters<MapDesignNativeToolRegistry['call']>) => {
      const [context] = args;
      return {
        ok: false,
        toolUseId: context.toolUseId,
        error: {
          code: 'INVALID_INPUT',
          message: 'The map tool input is invalid.',
          retryable: false,
          details: { issueCount: 1, firstPath: 'transaction.operations.0.op' },
        },
      };
    });
    const state = await startRun({
      registry,
      tools: [MUTATION_TOOL],
      stopProcessTree: async () => undefined,
    });
    const rawArguments = {
      expectedRevision: 3,
      idempotencyKey: rawSecret,
      transaction: { operations: [{ op: 'setPaintProperty', url: 'https://unsafe.example' }] },
    };
    state.server.onClientFrame = (frame) => {
      if (frame.id !== 78) return;
      state.server.send({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: turn('completed') },
      });
    };

    for (let count = 1; count <= 8; count += 1) {
      state.server.send(mutationCall(70 + count, `repeat-${count}`, rawArguments));
      expect(await state.server.nextClientFrame()).toMatchObject({
        id: 70 + count,
        result: { success: false },
      });
      const resultEvent = state.events.at(-1);
      expect(resultEvent).toMatchObject({
        kind: 'tool_result',
        toolUseId: `repeat-${count}`,
        status: 'failed',
      });
      if (count === 4) {
        expect(resultEvent).toMatchObject({
          summary: { loopWarning: true, failureCount: 4 },
        });
      }
    }

    const settled = await settlesWithin(state.handle.done);
    if (!settled) await state.handle.cancel();
    expect(settled).toBe(true);
    const terminal = await state.handle.done;
    expect(terminal).toEqual({
      status: 'failed',
      error: {
        code: 'TOOL_LOOP_DETECTED',
        message: 'Repeated invalid map tool calls were stopped.',
      },
    });
    expect(await state.server.nextClientFrame()).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    expect(state.events).toContainEqual({
      kind: 'tool_result',
      toolUseId: 'repeat-8',
      status: 'failed',
      summary: {
        code: 'INVALID_INPUT',
        retryable: false,
        issueCount: 1,
        firstPath: 'transaction.operations.0.op',
        loopHalted: true,
        failureCount: 8,
      },
    });
    expect(state.events.filter((event) => event.kind === 'thinking')).toEqual([]);

    state.server.send(mutationCall(79, 'repeat-9', rawArguments));
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.call).toHaveBeenCalledTimes(8);
    expect(JSON.stringify({ events: state.events, terminal })).not.toMatch(
      /raw-transaction-secret|unsafe\.example|setPaintProperty/,
    );
  });

  it('halts eight distinct missing-layer inspections in one safe failure class', async () => {
    const registry = nativeRegistry();
    registry.call.mockImplementation(async (...args: Parameters<MapDesignNativeToolRegistry['call']>) => {
      const [context] = args;
      return {
        ok: false,
        toolUseId: context.toolUseId,
        error: {
          code: 'NOT_FOUND',
          message: 'The requested map resource was not found.',
          retryable: false,
        },
      };
    });
    const state = await startRun({ registry, tools: [TOOL], stopProcessTree: async () => undefined });
    const inspectionCall = (id: number, count: number) => ({
      id,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: `guess-${count}`,
        namespace: 'map-design',
        tool: 'map_inspect',
        arguments: { target: { kind: 'layer', layerId: `guessed-layer-${count}` } },
      },
    });

    for (let count = 1; count <= 8; count += 1) {
      state.server.send(inspectionCall(120 + count, count));
      expect(await state.server.nextClientFrame()).toMatchObject({
        id: 120 + count,
        result: { success: false },
      });
      const resultEvent = state.events.at(-1);
      expect(resultEvent).toMatchObject({
        kind: 'tool_result',
        toolUseId: `guess-${count}`,
        status: 'failed',
        summary: { code: 'NOT_FOUND', retryable: false },
      });
      if (count === 4) {
        expect(resultEvent).toMatchObject({ summary: { loopWarning: true, failureCount: 4 } });
      }
      if (count === 8) {
        expect(resultEvent).toMatchObject({ summary: { loopHalted: true, failureCount: 8 } });
      }
      if (!resultEvent || resultEvent.kind !== 'tool_result') throw new TypeError('missing tool result');
      expect(SafeToolSummarySchema.safeParse(resultEvent.summary).success).toBe(true);
    }

    await expect(state.handle.done).resolves.toEqual({
      status: 'failed',
      error: {
        code: 'TOOL_LOOP_DETECTED',
        message: 'Repeated invalid map tool calls were stopped.',
      },
    });
    expect(await state.server.nextClientFrame()).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    state.server.send(inspectionCall(129, 9));
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.call).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(state.events)).not.toContain('guessed-layer-');
  });

  it.each(['REVISION_CONFLICT', 'SOURCE_UNAVAILABLE', 'PREVIEW_FAILED'])(
    'keeps eight distinct retryable %s failures exact-only without terminating the run',
    async (code) => {
      const registry = nativeRegistry();
      registry.call.mockImplementation(async (...args: Parameters<MapDesignNativeToolRegistry['call']>) => {
        const [context] = args;
        return {
          ok: false,
          toolUseId: context.toolUseId,
          error: {
            code,
            message: 'The retryable map tool call failed.',
            retryable: true,
          },
        };
      });
      const state = await startRun({ registry, tools: [TOOL], stopProcessTree: async () => undefined });

      for (let count = 1; count <= 8; count += 1) {
        state.server.send({
          id: 140 + count,
          method: 'item/tool/call',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            callId: `retryable-${count}`,
            namespace: 'map-design',
            tool: 'map_inspect',
            arguments: { target: { kind: 'layer', layerId: `retryable-layer-${count}` } },
          },
        });
        expect(await state.server.nextClientFrame()).toMatchObject({
          id: 140 + count,
          result: { success: false },
        });
        expect(state.events.at(-1)).toMatchObject({
          kind: 'tool_result',
          toolUseId: `retryable-${count}`,
          status: 'failed',
          summary: { code, retryable: true },
        });
        expect(state.events.at(-1)).not.toMatchObject({
          summary: { loopWarning: true },
        });
        expect(state.events.at(-1)).not.toMatchObject({
          summary: { loopHalted: true },
        });
      }

      expect(await settlesWithin(state.handle.done)).toBe(false);
      expect(registry.call).toHaveBeenCalledTimes(8);
      const canceling = state.handle.cancel();
      expect(await state.server.nextClientFrame()).toMatchObject({
        method: 'turn/interrupt',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      });
      await canceling;
      await expect(state.handle.done).resolves.toEqual({ status: 'canceled' });
    },
  );

  it('warns and halts a Run-wide consecutive streak across alternating native tools', async () => {
    const registry = nativeRegistry();
    registry.call.mockImplementation(async (...args: Parameters<MapDesignNativeToolRegistry['call']>) => {
      const [context, , input] = args;
      const attempt = (input as { attempt?: unknown }).attempt;
      return {
        ok: false,
        toolUseId: context.toolUseId,
        error: {
          code: 'INVALID_INPUT',
          message: 'The map tool input is invalid.',
          retryable: false,
          details: { firstPath: `target.${String(attempt)}`, firstIssueCode: `issue_${String(attempt)}` },
        },
      };
    });
    const state = await startRun({
      registry,
      tools: [TOOL, SEARCH_TOOL],
      stopProcessTree: async () => undefined,
    });
    const request = (id: number, count: number) => ({
      id,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: `mixed-${count}`,
        namespace: 'map-design',
        tool: count % 2 === 0 ? 'map_search_layers' : 'map_inspect',
        arguments: { attempt: count },
      },
    });

    for (let count = 1; count <= 10; count += 1) {
      state.server.send(request(160 + count, count));
      expect(await state.server.nextClientFrame()).toMatchObject({ id: 160 + count, result: { success: false } });
      const resultEvent = state.events.find((event) => (
        event.kind === 'tool_result' && event.toolUseId === `mixed-${count}`
      ));
      if (count === 5) expect(resultEvent).toMatchObject({ summary: { loopWarning: true, failureCount: 5 } });
      if (count === 10) expect(resultEvent).toMatchObject({ summary: { loopHalted: true, failureCount: 10 } });
    }
    await expect(state.handle.done).resolves.toMatchObject({ status: 'failed', error: { code: 'TOOL_LOOP_DETECTED' } });
    expect(await state.server.nextClientFrame()).toMatchObject({ method: 'turn/interrupt' });
    state.server.send(request(171, 11));
    await new Promise((resolve) => setImmediate(resolve));
    expect(registry.call).toHaveBeenCalledTimes(10);
  });

  it('drains admitted tool calls and preserves durable success before loop-halt terminal', async () => {
    let releaseMutation!: (result: MapNativeToolResult) => void;
    const registry = nativeRegistry();
    registry.call.mockImplementation((context, name) => {
      if (name === 'map_apply_transaction') {
        return new Promise<MapNativeToolResult>((resolve) => { releaseMutation = resolve; });
      }
      return Promise.resolve({
        ok: false,
        toolUseId: context.toolUseId,
        error: { code: 'NOT_FOUND', message: 'The map layer was not found.', retryable: false },
      });
    });
    const state = await startRun({
      registry,
      tools: [MUTATION_TOOL, TOOL],
      stopProcessTree: async () => undefined,
    });

    state.server.send(mutationCall(200, 'pending-mutation', { expectedRevision: 3 }));
    await new Promise((resolve) => setImmediate(resolve));
    for (let count = 1; count <= 8; count += 1) {
      state.server.send({
        id: 200 + count,
        method: 'item/tool/call',
        params: {
          threadId: 'thread-1', turnId: 'turn-1', callId: `halt-${count}`, namespace: 'map-design',
          tool: 'map_inspect', arguments: { target: { kind: 'layer', layerId: `missing-${count}` } },
        },
      });
      expect(await state.server.nextClientFrame()).toMatchObject({ id: 200 + count, result: { success: false } });
    }

    expect(await settlesWithin(state.handle.done)).toBe(false);
    expect(await state.server.nextClientFrame()).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    releaseMutation({ ok: true, toolUseId: 'pending-mutation', summary: { revision: 4 } });
    expect(await state.server.nextClientFrame()).toEqual({
      id: 200,
      result: { contentItems: [{ type: 'inputText', text: '{"revision":4}' }], success: true },
    });
    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(state.events).toContainEqual({
      kind: 'tool_result', toolUseId: 'pending-mutation', status: 'succeeded', summary: { revision: 4 },
    });
    expect(state.events.at(-1)).toEqual({ kind: 'run_finished', status: 'succeeded' });
    expect(registry.call).toHaveBeenCalledTimes(9);
  });

  it('starts a fresh consecutive-failure epoch after a successful mutation', async () => {
    const registry = nativeRegistry();
    registry.call.mockImplementation(async (...args: Parameters<MapDesignNativeToolRegistry['call']>) => {
      const [context, , input] = args;
      if ((input as { succeed?: boolean }).succeed) {
        return { ok: true, toolUseId: context.toolUseId, summary: { revision: 4 } };
      }
      const attempt = (input as { attempt?: unknown }).attempt;
      return {
        ok: false,
        toolUseId: context.toolUseId,
        error: {
          code: 'INVALID_INPUT',
          message: 'The map tool input is invalid.',
          retryable: false,
          details: { firstPath: `transaction.operations.${String(attempt)}.op` },
        },
      };
    });
    const state = await startRun({
      registry,
      tools: [MUTATION_TOOL],
      stopProcessTree: async () => undefined,
    });

    for (let count = 1; count <= 4; count += 1) {
      state.server.send(mutationCall(80 + count, `before-success-${count}`, { attempt: count }));
      await state.server.nextClientFrame();
    }
    state.server.send(mutationCall(85, 'successful-mutation', { succeed: true }));
    await state.server.nextClientFrame();

    for (let count = 1; count <= 5; count += 1) {
      state.server.send(mutationCall(85 + count, `after-success-${count}`, { attempt: 100 + count }));
      await state.server.nextClientFrame();
      const resultEvent = state.events.at(-1);
      if (count < 5) expect(resultEvent).not.toMatchObject({ summary: { loopWarning: true } });
      else expect(resultEvent).toMatchObject({ summary: { loopWarning: true, failureCount: 5 } });
    }

    await state.handle.cancel();
  });

  it('does not execute a tool request whose turn correlation is unknown', async () => {
    const state = await startRun();

    state.server.send({
      id: 62,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1',
        turnId: 'unknown-turn',
        callId: 'call-unknown',
        namespace: 'map-design',
        tool: 'map_inspect',
        arguments: { target: { kind: 'root' } },
      },
    });

    expect(await state.server.nextClientFrame()).toEqual({
      id: 62,
      result: {
        contentItems: [{
          type: 'inputText',
          text: '{"code":"UNKNOWN_TOOL","message":"The map tool call is not registered.","retryable":false}',
        }],
        success: false,
      },
    });
    expect(state.registry.call).not.toHaveBeenCalled();
    expect(state.events).toEqual([{ kind: 'status', label: 'analyzing' }]);
  });

  it.each([false, true])('joins process cleanup after signal cancellation (during handshake: %s)', async (duringHandshake) => {
    let releaseStop!: () => void;
    const stopping = new Promise<void>((resolve) => { releaseStop = resolve; });
    const stopProcessTree = vi.fn(() => stopping);
    const controller = new AbortController();
    let handle: MapRunHandle;
    if (duringHandshake) {
      const server = new FakeAppServer();
      const adapter = createCodexMapAgentAdapter({
        definition: { id: 'codex', bin: '/opt/codex/bin/codex' },
        nativeToolRegistry: nativeRegistry(), spawn: () => server.child, stopProcessTree,
      });
      const starting = adapter.startMapRun(runInput(controller.signal), [TOOL], () => undefined);
      await server.nextClientFrame();
      controller.abort();
      handle = await starting;
    } else {
      const state = await startRun({ input: runInput(controller.signal), stopProcessTree });
      controller.abort();
      handle = state.handle;
    }
    try {
      await expect(handle.done).resolves.toMatchObject({ status: 'canceled' });
      const joining = handle.cancel();
      expect(await settlesWithin(joining)).toBe(false);
      expect(stopProcessTree).toHaveBeenCalledOnce();
      releaseStop();
      await joining;
    } finally {
      releaseStop();
      await handle.cancel();
    }
  });

  it('interrupts the active turn and resolves cancellation exactly once', async () => {
    const stopProcessTree = vi.fn(async () => undefined);
    const state = await startRun({ stopProcessTree });

    const canceling = state.handle.cancel();
    const interrupt = await state.server.nextClientFrame();
    expect(interrupt).toEqual({
      id: 4,
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    state.server.send({ id: interrupt.id, result: {} });

    await canceling;
    await state.handle.cancel();
    await expect(state.handle.done).resolves.toEqual({ status: 'canceled' });
    expect(state.events.filter((event) => event.kind === 'run_finished')).toEqual([
      { kind: 'run_finished', status: 'canceled' },
    ]);
    expect(stopProcessTree).toHaveBeenCalledOnce();
  });

  it.each([
    ['unknown response id', (server: FakeAppServer) => server.send({ id: 999, result: {} })],
    ['malformed JSON-RPC', (server: FakeAppServer) => server.send('{not-json}\n')],
    ['oversized JSON-RPC frame', (server: FakeAppServer) => server.send(`${'x'.repeat(257)}\n`)],
    ['process exit', (server: FakeAppServer) => server.exit(1)],
  ])('fails closed during handshake on %s', async (name, breakHandshake) => {
    const server = new FakeAppServer();
    const adapter = createCodexMapAgentAdapter({
      definition: { id: 'codex', bin: '/opt/codex/bin/codex' },
      nativeToolRegistry: nativeRegistry(),
      spawn: () => server.child,
      maxFrameBytes: 256,
    });
    const starting = adapter.startMapRun(runInput(), [TOOL], () => undefined);
    await server.nextClientFrame();

    breakHandshake(server);

    await expect(starting).rejects.toThrow(/Codex app-server protocol unavailable/u);
    expect(server.kill).toHaveBeenCalledTimes(name === 'process exit' ? 0 : 1);
  });

  it('fails closed when initialize does not prove the expected app-server handshake', async () => {
    const server = new FakeAppServer();
    const adapter = createCodexMapAgentAdapter({
      definition: { id: 'codex', bin: '/opt/codex/bin/codex' },
      nativeToolRegistry: nativeRegistry(),
      spawn: () => server.child,
    });
    const starting = adapter.startMapRun(runInput(), [TOOL], () => undefined);
    const initialize = await server.nextClientFrame();

    server.send({ id: initialize.id, result: { userAgent: 'not-an-app-server' } });

    await expect(starting).rejects.toThrow(/Codex app-server protocol unavailable/u);
    expect(server.kill).toHaveBeenCalledTimes(1);
  });

  it('maps only public reasoning summaries, assistant text, and one terminal response', async () => {
    const state = await startRun();

    state.server.send({
      method: 'item/reasoning/textDelta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reason-1', delta: 'private reasoning' },
    });
    state.server.send({
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reason-1', summaryIndex: 0, delta: 'Checking layers.' },
    });
    state.server.send({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Two labels need work.' },
    });
    state.server.send({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: turn('completed') },
    });
    state.server.send({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: turn('failed', { message: 'late failure' }) },
    });
    state.server.exit(1);

    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(state.events).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'thinking', text: 'Checking layers.' },
      { kind: 'text', text: 'Two labels need work.' },
      { kind: 'run_finished', status: 'succeeded' },
    ]);
    expect(JSON.stringify(state.events)).not.toContain('private reasoning');
  });

  it('turns a process exit after startup into one failed terminal result', async () => {
    const state = await startRun();

    state.server.exit(2);

    await expect(state.handle.done).resolves.toEqual({
      status: 'failed',
      error: {
        code: 'RUN_FAILED',
        message: 'The Codex app-server connection ended unexpectedly.',
      },
    });
    expect(state.events.filter((event) => event.kind === 'run_finished')).toEqual([
      { kind: 'run_finished', status: 'failed' },
    ]);
  });
});

it('starts tool-free connection tests without an invalid empty tool namespace', async () => {
  const { server, handle } = await startRun({ tools: [] });
  server.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: turn('completed') } });
  await expect(handle.done).resolves.toEqual({ status: 'succeeded' });
});
