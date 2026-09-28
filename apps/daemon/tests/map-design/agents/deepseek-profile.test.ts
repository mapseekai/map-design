import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveDeepSeekProfileHome,
  stageDeepSeekProfileBundle,
} from '../../../src/map-design/agents/deepseek-profile-bundle.js';
import {
  createDeepSeekHarnessMapAgentAdapter,
  type DeepSeekProfileProcess,
  type DeepSeekProfileSpawn,
} from '../../../src/map-design/agents/deepseek-profile.js';
import { parseDeepSeekProfileRuntimeFrame } from '../../../src/map-design/agents/deepseek-profile-protocol.js';
import { createLocalAgentRegistry } from '../../../src/map-design/application/local-agent-registry.js';
import type { AgentToolDefinition, MapAgentAdapter, MapAgentEvent, MapRunInput } from '../../../src/map-design/agents/types.js';
import type { NativeMapToolDefinition } from '../../../src/map-design/tools/tool-context.js';
import { defineMapAgentAdapterConformance } from './adapter-conformance.js';

import {
  createMemoryMapAgentSessionBroker,
  mapAgentSessionScope,
  type MapAgentSessionBroker,
} from '../../../src/map-design/agents/session-broker.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, chmod: vi.fn(fs.chmod) };
});

const TOOLS: NativeMapToolDefinition[] = [
  {
    name: 'map_get_context',
    description: 'Read current map context.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    name: 'map_validate',
    description: 'Validate the current map.',
    inputSchema: {
      type: 'object',
      properties: { expectedRevision: { type: 'integer' } },
      required: ['expectedRevision'],
      additionalProperties: false,
    },
  },
];

const CAPABILITIES = {
  session_resume: true,
  session_cancel: true,
  structured_events: true,
  native_host_tools: true,
  authenticated_callback: true,
} as const;

const execFileAsync = promisify(execFile);

const READY = {
  v: 1,
  type: 'ready',
  runtime: 'map-design',
  protocol_version: 1,
  plugin_version: '1.0.0',
  capabilities: CAPABILITIES,
} as const;

function runInput(signal = new AbortController().signal, overrides: Partial<MapRunInput> = {}): MapRunInput {
  return {
    runId: 'run-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    prompt: 'Validate the map.',
    resumePrompt: 'Validate only the latest turn.',
    cwd: '/safe/project',
    model: 'deepseek-official/deepseek-chat',
    reasoning: 'high',
    serviceTier: null,
    toolRuntime: {
      execute: async (call) => ({
        ok: false,
        toolUseId: call.toolUseId,
        error: { code: 'UNKNOWN_TOOL', message: 'The map tool is not registered.', retryable: false },
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
  };
}

class FakeDeepSeekProfile {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly child: DeepSeekProfileProcess;
  readonly commands: Array<Record<string, unknown>> = [];
  private readonly waiters: Array<(frame: Record<string, unknown>) => void> = [];
  private input = '';
  private closed = false;

  constructor() {
    const child = Object.assign(new EventEmitter(), {
      pid: 12_345,
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      kill: vi.fn(() => {
        this.close(null);
        return true;
      }),
    }) as DeepSeekProfileProcess;
    this.child = child;
    this.stdin.on('data', (chunk: Buffer | string) => {
      this.input += String(chunk);
      while (this.input.includes('\n')) {
        const newline = this.input.indexOf('\n');
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        if (!line) continue;
        const command = JSON.parse(line) as Record<string, unknown>;
        const waiter = this.waiters.shift();
        if (waiter) waiter(command);
        else this.commands.push(command);
      }
    });
  }

  send(frame: unknown): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  sendRaw(frame: string): void {
    this.stdout.write(frame);
  }

  nextCommand(): Promise<Record<string, unknown>> {
    const command = this.commands.shift();
    if (command) return Promise.resolve(command);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    queueMicrotask(() => (this.child as unknown as EventEmitter).emit('close', code));
  }
}

function profileResult(
  requestId: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    type: 'result',
    request_id: requestId,
    status: 'completed',
    session_id: sessionId,
    resume_rejected: false,
    ...overrides,
  };
}

function sessionFrame(
  requestId: string,
  sessionId: string,
  resumed = false,
): Record<string, unknown> {
  return {
    v: 1,
    type: 'session',
    request_id: requestId,
    session_id: sessionId,
    resumed,
  };
}

describe('DeepSeek cartography completion', () => {
  it('registers and correlates the uploaded-source tool without map mutation tools', async () => {
    const state = await beginRun({ tools: [{ name: 'read_cartography_source', description: 'Read source.', inputSchema: { type: 'object', properties: { fileName: { type: 'string' } }, required: ['fileName'] } }] });
    expect(state.execute.host_tools).toEqual([expect.objectContaining({ name: 'read_cartography_source' })]);
    state.server.send(sessionFrame('run-1', 'session-1'));
    state.server.send({ v: 1, type: 'tool_call', request_id: 'run-1', call_id: 'read-1', name: 'read_cartography_source', arguments: '{"fileName":"source.qgs"}' });
    state.server.send({ v: 1, type: 'tool_result', request_id: 'run-1', call_id: 'read-1', name: 'read_cartography_source', status: 'succeeded', summary: {} });
    state.server.send(profileResult('run-1', 'session-1', { output: '{}' }));
    await expect(state.handle.done).resolves.toMatchObject({ status: 'succeeded' });
    expect(state.events).toContainEqual({ kind: 'tool_use', id: 'read-1', name: 'read_cartography_source', summary: {} });
  });

  it('uses the terminal output instead of streamed progress text', async () => {
    const state = await beginRun({ input: runInput(undefined, { taskKind: 'cartography' }) });
    state.server.send(sessionFrame('run-1', 'session-1'));
    state.server.send({ v: 1, type: 'text', request_id: 'run-1', content: 'Checking source.' });
    state.server.send(profileResult('run-1', 'session-1', { output: '{"source":"complete"}', stop_reason: 'completed' }));
    await expect(state.handle.done).resolves.toMatchObject({ status: 'succeeded', finalResponse: '{"source":"complete"}' });
  });

  it('rejects max-tokens even when the runtime labels it completed', async () => {
    const state = await beginRun({ input: runInput(undefined, { taskKind: 'cartography' }) });
    state.server.send(sessionFrame('run-1', 'session-1'));
    state.server.send(profileResult('run-1', 'session-1', { stop_reason: 'max-tokens' }));
    await expect(state.handle.done).resolves.toMatchObject({ status: 'failed', error: { code: 'RESPONSE_TRUNCATED' } });
  });
});

function createAdapterHarness(options: {
  servers?: FakeDeepSeekProfile[];
  maxFrameBytes?: number;
  sessionBroker?: MapAgentSessionBroker;
  readyTimeoutMs?: number;
} = {}) {
  const servers = options.servers ?? [new FakeDeepSeekProfile()];
  const queue = [...servers];
  const spawn = vi.fn<DeepSeekProfileSpawn>(() => {
    const server = queue.shift();
    if (!server) throw new Error('No fake DeepSeek Harness profile remains.');
    return server.child;
  });
  const stopProcess = vi.fn(async (child: DeepSeekProfileProcess) => {
    child.kill('SIGTERM');
  });
  const stageProfile = vi.fn(async () => ({
    home: '/safe/map-design-runtime/deepseek-harness/dsh-home',
    profileDirectory: '/safe/map-design-runtime/deepseek-harness/dsh-home/profiles/map-design',
    bridgePath: '/safe/map-design-runtime/deepseek-harness/dsh-home/profiles/map-design/node_modules/@mapseekai/dsh-map-design-runtime/bridge.mjs',
    runtimePath: '/safe/map-design-runtime/deepseek-harness/dsh-home/profiles/map-design/node_modules/@mapseekai/dsh-map-design-runtime/runtime.mjs',
    startupPath: '/safe/map-design-runtime/deepseek-harness/dsh-home/profiles/map-design/node_modules/@mapseekai/dsh-map-design-runtime/startup.mjs',
  }));
  const adapter = createDeepSeekHarnessMapAgentAdapter({
    definition: {
      id: 'deepseek-harness',
      name: 'DeepSeek Harness',
      bin: '/opt/dsh/bin/dsh',
      versionArgs: ['--version'],
      fallbackModels: [],
      buildArgs: () => ['--profile', 'map-design', '--stdio'],
      streamFormat: 'dsh-profile-jsonl',
      inheritedEnvKeys: ['DEEPSEEK_API_KEY'],
      mapDesign: { nativeToolAdapter: 'deepseek-profile', publicReasoningSummary: true },
    },
    toolDefinitions: () => TOOLS,
    spawn,
    stageProfile,
    stopProcess,
    environment: () => ({
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'selected-provider-secret',
      HOME: '/safe/home',
      TMPDIR: '/safe/tmp',
      LANG: 'en_US.UTF-8',
      AWS_SECRET_ACCESS_KEY: 'ambient-aws-secret',
      DATABASE_URL: 'postgres://ambient-secret',
      UNRELATED_SECRET: 'secret-value',
      DSH_HOME: '/Users/operator/.dsh',
      MAP_DESIGN_API_TOKEN: 'daemon-api-secret',
      MAP_DESIGN_DATA_DIR: '/private/daemon-data',
      MAP_DESIGN_TOOL_CALLBACK_TOKEN: 'stale-callback-token',
      MAP_DESIGN_RUN_ID: 'stale-run',
      MAP_DESIGN_TOOL_TOKEN: 'ambient-token',
      MAP_DESIGN_PROJECT_ID: 'ambient-project',
      MAP_DESIGN_CONVERSATION_ID: 'ambient-conversation',
      MAP_DESIGN_AGENT_ID: 'ambient-agent',
      MAP_DESIGN_PLUGIN_PROBE_PATH: '/private/stale-probe',
      MAP_DESIGN_PROFILE_PROBE_TOOLS: 'ambient-probe',
    }),
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    ...(options.sessionBroker === undefined ? {} : { sessionBroker: options.sessionBroker }),
    ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
  });
  return { adapter, servers, spawn, stageProfile, stopProcess };
}

async function beginRun(options: {
  tools?: AgentToolDefinition[];
  adapter?: MapAgentAdapter;
  server?: FakeDeepSeekProfile;
  input?: MapRunInput;
  events?: MapAgentEvent[];
  maxFrameBytes?: number;
} = {}) {
  const server = options.server ?? new FakeDeepSeekProfile();
  const harness = options.adapter
    ? null
    : createAdapterHarness({
        servers: [server],
        ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
      });
  const adapter = options.adapter ?? harness!.adapter;
  const events = options.events ?? [];
  const input = options.input ?? runInput();
  const handle = await adapter.startMapRun(input, options.tools ?? TOOLS, (event) => events.push(event));
  server.send(READY);
  const execute = await server.nextCommand();
  return { adapter, events, execute, handle, input, server, ...harness };
}

async function completeRun(state: Awaited<ReturnType<typeof beginRun>>, sessionId = 'session-1'): Promise<void> {
  state.server.send(sessionFrame(state.input.runId, sessionId, Boolean(state.execute.resume_session_id)));
  state.server.send(profileResult(state.input.runId, sessionId));
  await state.handle.done;
}

async function settlesWithin<T>(promise: Promise<T>, delayMs = 25): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), delayMs)),
  ]);
}

async function installDeepSeekRuntimeModuleStubs(profileDirectory: string): Promise<void> {
  const modules = [
    {
      name: 'dsh-agent',
      source: `export function installModelSelection(context, selection) {
  context.modelSelection = selection;
}
`,
    },
    {
      name: 'dsh-llm',
      source: `export const ReasoningEffortId = (value) => value;
export const createUserMessage = (value) => ({ id: 'user-message', role: 'user', ...value });
`,
    },
    {
      name: 'dsh-session',
      source: `export const SessionId = (value) => value;
`,
    },
  ];
  await Promise.all(modules.map(async (module) => {
    const directory = join(profileDirectory, 'node_modules', '@deepseek-ai', module.name);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(join(directory, 'package.json'), `${JSON.stringify({
        name: `@deepseek-ai/${module.name}`,
        type: 'module',
        exports: './index.mjs',
      })}\n`, 'utf8'),
      writeFile(join(directory, 'index.mjs'), module.source, 'utf8'),
    ]);
  }));
}

async function runStagedProfileProbe(options: {
  leakUnexpectedTool?: boolean;
  reverseScopedSurface?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'map-design-dsh-runtime-probe-'));
  const bundle = await stageDeepSeekProfileBundle(root);
  await installDeepSeekRuntimeModuleStubs(bundle.profileDirectory);
  const runtime = await import(`${pathToFileURL(bundle.runtimePath).href}?probe=${Date.now()}-${Math.random()}`) as {
    apply(context: Record<string, unknown>): void;
  };
  const globalTools = new Map<string, Record<string, unknown>>([
    ['unexpected_shell', {
      name: 'unexpected_shell',
      description: 'An unrelated profile tool.',
      parameters: { type: 'object' },
    }],
  ]);
  const scopes = new WeakMap<object, { allow: Set<string> | null; mode: string | null }>();
  const schemaScopes: object[] = [];
  let createdAgent: object | null = null;
  const disposeAgent = vi.fn(async () => undefined);
  const tools = {
    register(definition: Record<string, unknown>) {
      const name = String(definition.name);
      globalTools.set(name, definition);
      return () => { globalTools.delete(name); };
    },
    schemas(scope?: object) {
      if (scope) schemaScopes.push(scope);
      const restriction = scope ? scopes.get(scope)?.allow : null;
      const schemas = [...globalTools.values()]
        .filter((tool) => options.leakUnexpectedTool === true
          || !restriction
          || restriction.has(String(tool.name)))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }));
      return scope && options.reverseScopedSurface === true ? schemas.reverse() : schemas;
    },
  };
  const create = vi.fn(async (input: {
    setup(context: Record<string, unknown>): void | Promise<void>;
  }) => {
    const agent = {
      session: { seq: 0 },
      whenIdle: async () => undefined,
      followup: async () => undefined,
      cancel: () => undefined,
    };
    createdAgent = agent;
    const state = { allow: null as Set<string> | null, mode: null as string | null };
    scopes.set(agent, state);
    await input.setup({
      tools: {
        restrict(filter: { allow?: readonly string[] }) {
          state.allow = new Set(filter.allow ?? []);
          return () => { state.allow = null; };
        },
        presentAs(mode: string) {
          state.mode = mode;
          return () => { state.mode = null; };
        },
      },
    });
    return { agent, dispose: disposeAgent };
  });
  const output: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    output.push(String(chunk));
    return true;
  }) as never);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  const previousProbeTools = process.env.MAP_DESIGN_PROFILE_PROBE_TOOLS;
  process.env.MAP_DESIGN_PROFILE_PROBE_TOOLS = JSON.stringify(TOOLS);
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const context = {
    mapDesignStartup: { mode: 'probe' },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
    },
    agents: { create },
    tools,
    sessions: { flush: async () => undefined },
    logger: { warn: () => undefined },
    on: () => () => undefined,
    get(name: string) {
      if (name === 'appExit') return resolveExit;
      if (name === 'loader') return { await: async () => undefined };
      return undefined;
    },
  };
  try {
    runtime.apply(context);
    const code = await exited;
    const frames = output.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    return { code, create, createdAgent, disposeAgent, frames, schemaScopes };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    if (previousProbeTools === undefined) delete process.env.MAP_DESIGN_PROFILE_PROBE_TOOLS;
    else process.env.MAP_DESIGN_PROFILE_PROBE_TOOLS = previousProbeTools;
    await rm(root, { recursive: true, force: true });
  }
}

async function runStagedProfileExecution(events: Array<Record<string, unknown>>) {
  const root = await mkdtemp(join(tmpdir(), 'map-design-dsh-runtime-execute-'));
  const bundle = await stageDeepSeekProfileBundle(root);
  await installDeepSeekRuntimeModuleStubs(bundle.profileDirectory);
  const runtime = await import(`${pathToFileURL(bundle.runtimePath).href}?execute=${Date.now()}-${Math.random()}`) as {
    apply(context: Record<string, unknown>): void;
  };
  const globalTools = new Map<string, Record<string, unknown>>();
  const scopes = new WeakMap<object, Set<string>>();
  const tools = {
    register(definition: Record<string, unknown>) {
      const name = String(definition.name);
      globalTools.set(name, definition);
      return () => { globalTools.delete(name); };
    },
    schemas(scope?: object) {
      const allow = scope ? scopes.get(scope) : undefined;
      return [...globalTools.values()]
        .filter((tool) => !allow || allow.has(String(tool.name)))
        .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    },
  };
  let sessionListener: ((session: object, event: Record<string, unknown>) => void) | null = null;
  const disposeAgent = vi.fn(async () => undefined);
  const create = vi.fn(async (input: {
    sessionId: string;
    setup(context: Record<string, unknown>): void | Promise<void>;
  }) => {
    const session = { id: input.sessionId, seq: 0 };
    const agent = {
      session,
      whenIdle: async () => undefined,
      async followup() {
        for (const event of events) {
          session.seq = Number(event.seq);
          sessionListener?.(session, event);
        }
      },
      cancel: () => undefined,
    };
    await input.setup({
      tools: {
        restrict(filter: { allow?: readonly string[] }) {
          scopes.set(agent, new Set(filter.allow ?? []));
          return () => { scopes.delete(agent); };
        },
        presentAs(mode: string) {
          if (mode !== 'native') throw new Error('unexpected presentation mode');
          return () => undefined;
        },
      },
    });
    return { agent, dispose: disposeAgent };
  });
  const input = new PassThrough();
  input.end(`${JSON.stringify({
    v: 1,
    type: 'execute',
    request_id: 'runtime-run-1',
    cwd: '/safe/project',
    prompt: 'Render the assembled response.',
    model: { provider: 'deepseek-official', id: 'deepseek-chat' },
    reasoning_effort: 'high',
    host_tools: TOOLS,
    callback: {
      url: 'http://127.0.0.1:8787/api/map-design/tools',
      tokenEnv: 'MAP_DESIGN_TOOL_TOKEN',
    },
  })}\n`);
  const output: string[] = [];
  const stdin = vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    output.push(String(chunk));
    return true;
  }) as never);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  const reserved = [
    'MAP_DESIGN_TOOL_TOKEN',
    'MAP_DESIGN_PROJECT_ID',
    'MAP_DESIGN_CONVERSATION_ID',
    'MAP_DESIGN_AGENT_ID',
  ] as const;
  const previous = Object.fromEntries(reserved.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    MAP_DESIGN_TOOL_TOKEN: 'runtime-token',
    MAP_DESIGN_PROJECT_ID: 'project-1',
    MAP_DESIGN_CONVERSATION_ID: 'conversation-1',
    MAP_DESIGN_AGENT_ID: 'deepseek-harness',
  });
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const context = {
    mapDesignStartup: { mode: 'stdio' },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
    },
    agents: { create },
    tools,
    sessions: { flush: async () => undefined },
    logger: { warn: () => undefined },
    on(name: string, listener: (session: object, event: Record<string, unknown>) => void) {
      if (name !== 'session/event') throw new Error('unexpected event subscription');
      sessionListener = listener;
      return () => { sessionListener = null; };
    },
    get(name: string) {
      if (name === 'appExit') return resolveExit;
      if (name === 'loader') return { await: async () => undefined };
      return undefined;
    },
  };
  try {
    runtime.apply(context);
    const code = await exited;
    const frames = output.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    return { code, create, disposeAgent, frames };
  } finally {
    stdin.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
    for (const name of reserved) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

defineMapAgentAdapterConformance('DeepSeek Harness MapDesign profile', {
  async registration() {
    const state = await beginRun();
    expect(state.execute).toMatchObject({
      v: 1,
      type: 'execute',
      request_id: 'run-1',
      host_tools: TOOLS,
      callback: {
        url: 'http://127.0.0.1:8787/api/map-design/tools',
        tokenEnv: 'MAP_DESIGN_TOOL_TOKEN',
      },
    });
    expect(state.execute).not.toHaveProperty('mcp_servers');
    await completeRun(state);
  },

  async correlatedResult() {
    const root = await mkdtemp(join(tmpdir(), 'map-design-dsh-bundle-test-'));
    try {
      const bundle = await stageDeepSeekProfileBundle(root);
      const bridge = await import(`${pathToFileURL(bundle.bridgePath).href}?test=${Date.now()}`) as {
        registerMapDesignHostTools(options: {
          tools: { register(definition: Record<string, unknown>): () => void };
          request: Record<string, unknown>;
          environment: Record<string, string | undefined>;
          fetchImpl: typeof fetch;
          onToolResult(result: Record<string, unknown>): void;
        }): () => void;
      };
      const registered: Array<Record<string, unknown>> = [];
      const results: Array<Record<string, unknown>> = [];
      const unregister = vi.fn();
      const fetchImpl = vi.fn(async (_url: string | URL | globalThis.Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Bearer bridge-token');
        expect(headers.get('x-map-design-run-id')).toBe('run-1');
        expect(headers.get('x-map-design-project-id')).toBe('project-1');
        expect(headers.get('x-map-design-conversation-id')).toBe('conversation-1');
        expect(headers.get('x-map-design-agent-id')).toBe('deepseek-harness');
        expect(headers.get('x-map-design-tool-use-id')).toBe('tool-1');
        return new Response(JSON.stringify({
          ok: true,
          toolUseId: 'tool-1',
          summary: { valid: true },
          modelContent: '{"valid":true}',
        }), { headers: { 'content-type': 'application/json' } });
      });
      const dispose = bridge.registerMapDesignHostTools({
        tools: {
          register(definition) {
            registered.push(definition);
            return unregister;
          },
        },
        request: {
          v: 1,
          type: 'execute',
          request_id: 'run-1',
          cwd: '/safe/project',
          prompt: 'Validate the map.',
          host_tools: TOOLS,
          callback: {
            url: 'http://127.0.0.1:8787/api/map-design/tools',
            tokenEnv: 'MAP_DESIGN_TOOL_TOKEN',
          },
        },
        environment: {
          MAP_DESIGN_TOOL_TOKEN: 'bridge-token',
          MAP_DESIGN_PROJECT_ID: 'project-1',
          MAP_DESIGN_CONVERSATION_ID: 'conversation-1',
          MAP_DESIGN_AGENT_ID: 'deepseek-harness',
        },
        fetchImpl,
        onToolResult: (result) => results.push(result),
      });

      expect(registered.map((definition) => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      }))).toEqual(TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      })));
      const execute = registered[1]!.execute as (
        input: unknown,
        context: { callId: string; signal: AbortSignal },
      ) => Promise<unknown>;
      await expect(execute(
        { expectedRevision: 4 },
        { callId: 'tool-1', signal: new AbortController().signal },
      )).resolves.toBe('{"valid":true}');
      expect(fetchImpl).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/api/map-design/tools/map_validate',
        expect.objectContaining({ method: 'POST', body: '{"expectedRevision":4}' }),
      );
      expect(results).toEqual([{
        call_id: 'tool-1',
        name: 'map_validate',
        status: 'succeeded',
        summary: { valid: true },
      }]);
      dispose();
      expect(unregister).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const state = await beginRun();
    state.server.send(sessionFrame('run-1', 'session-1'));
    state.server.send({
      v: 1,
      type: 'tool_call',
      request_id: 'run-1',
      call_id: 'tool-1',
      name: 'map_validate',
      arguments: '{"expectedRevision":4}',
    });
    state.server.send({
      v: 1,
      type: 'tool_result',
      request_id: 'run-1',
      call_id: 'tool-1',
      name: 'map_validate',
      status: 'succeeded',
      summary: { valid: true },
    });
    state.server.send(profileResult('run-1', 'session-1'));
    await state.handle.done;
    expect(state.events).toContainEqual({
      kind: 'tool_result',
      toolUseId: 'tool-1',
      status: 'succeeded',
      summary: { valid: true },
    });
  },

  async normalizedEvents() {
    const state = await beginRun();
    state.server.send(sessionFrame('run-1', 'session-1'));
    state.server.send({ v: 1, type: 'thinking', request_id: 'run-1', content: 'Checking.' });
    state.server.send({ v: 1, type: 'text', request_id: 'run-1', content: 'Valid.' });
    state.server.send({
      v: 1,
      type: 'tool_call',
      request_id: 'run-1',
      call_id: 'tool-1',
      name: 'map_validate',
      arguments: '{"expectedRevision":4}',
    });
    state.server.send({
      v: 1,
      type: 'tool_result',
      request_id: 'run-1',
      call_id: 'tool-1',
      name: 'map_validate',
      status: 'succeeded',
      summary: { valid: true },
    });
    state.server.send({
      v: 1,
      type: 'usage',
      request_id: 'run-1',
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      input_tokens: 100,
      output_tokens: 20,
    });
    state.server.send(profileResult('run-1', 'session-1'));

    await expect(state.handle.done).resolves.toEqual({ status: 'succeeded' });
    expect(state.events).toEqual([
      { kind: 'status', label: 'analyzing' },
      { kind: 'thinking', text: 'Checking.' },
      { kind: 'text', text: 'Valid.' },
      { kind: 'tool_use', id: 'tool-1', name: 'map_validate', summary: {} },
      { kind: 'tool_result', toolUseId: 'tool-1', status: 'succeeded', summary: { valid: true } },
      { kind: 'run_finished', status: 'succeeded' },
    ]);
  },

  async cancellation() {
    const state = await beginRun();
    const first = state.handle.cancel();
    const second = state.handle.cancel();
    expect(await state.server.nextCommand()).toEqual({ v: 1, type: 'cancel', request_id: 'run-1' });

    await Promise.all([first, second]);
    await expect(state.handle.done).resolves.toEqual({ status: 'canceled' });
    expect(state.stopProcess).toHaveBeenCalledOnce();
    expect(await settlesWithin(state.server.nextCommand())).toBe(false);
  },

  async malformedAndOversizedFrames() {
    for (const raw of ['{nope}\n', `${'x'.repeat(1_025)}\n`]) {
      const server = new FakeDeepSeekProfile();
      const harness = createAdapterHarness({ servers: [server], maxFrameBytes: 1_024 });
      const events: MapAgentEvent[] = [];
      const handle = await harness.adapter.startMapRun(runInput(), TOOLS, (event) => events.push(event));
      server.sendRaw(raw);
      await expect(handle.done).resolves.toMatchObject({ status: 'failed' });
      expect(events.filter((event) => event.kind === 'run_finished')).toHaveLength(1);
    }
  },

  async duplicateCalls() {
    const state = await beginRun();
    state.server.send(sessionFrame('run-1', 'session-1'));
    const call = {
      v: 1,
      type: 'tool_call',
      request_id: 'run-1',
      call_id: 'tool-1',
      name: 'map_validate',
      arguments: '{"expectedRevision":4}',
    };
    state.server.send(call);
    state.server.send(call);

    await expect(state.handle.done).resolves.toMatchObject({ status: 'failed' });
    expect(state.events.filter((event) => event.kind === 'tool_use')).toHaveLength(1);
  },

  async loopGuard() {
    const state = await beginRun();
    state.server.send(sessionFrame('run-1', 'session-1'));
    for (let count = 1; count <= 8; count += 1) {
      state.server.send({
        v: 1,
        type: 'tool_call',
        request_id: 'run-1',
        call_id: `tool-${count}`,
        name: 'map_validate',
        arguments: '{"expectedRevision":4}',
      });
      state.server.send({
        v: 1,
        type: 'tool_result',
        request_id: 'run-1',
        call_id: `tool-${count}`,
        name: 'map_validate',
        status: 'failed',
        summary: { code: 'INVALID_INPUT', retryable: false },
      });
    }

    await expect(state.handle.done).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_LOOP_DETECTED' },
    });
    expect(await state.server.nextCommand()).toEqual({ v: 1, type: 'cancel', request_id: 'run-1' });
  },

  async sessionResumeOrReseed() {
    const first = new FakeDeepSeekProfile();
    const rejected = new FakeDeepSeekProfile();
    const reseeded = new FakeDeepSeekProfile();
    const isolated = new FakeDeepSeekProfile();
    const harness = createAdapterHarness({ servers: [first, rejected, reseeded, isolated] });

    const firstRun = await beginRun({ adapter: harness.adapter, server: first });
    await completeRun(firstRun, 'session-1');

    const secondInput = runInput(undefined, { runId: 'run-2' });
    const events: MapAgentEvent[] = [];
    const secondHandle = await harness.adapter.startMapRun(secondInput, TOOLS, (event) => events.push(event));
    rejected.send(READY);
    expect(await rejected.nextCommand()).toMatchObject({
      type: 'execute',
      request_id: 'run-2',
      resume_session_id: 'session-1',
      prompt: 'Validate only the latest turn.',
    });
    rejected.send(profileResult('run-2', 'session-1', {
      status: 'failed',
      resume_rejected: true,
      error: { code: 'DSH_PROFILE_RESUME_REJECTED', message: 'Session is unavailable.' },
    }));
    reseeded.send(READY);
    const reseed = await reseeded.nextCommand();
    expect(reseed).toMatchObject({ type: 'execute', request_id: 'run-2', prompt: 'Validate the map.' });
    expect(reseed).not.toHaveProperty('resume_session_id');
    reseeded.send(sessionFrame('run-2', 'session-2'));
    reseeded.send(profileResult('run-2', 'session-2'));
    await expect(secondHandle.done).resolves.toEqual({ status: 'succeeded' });

    const isolatedInput = runInput(undefined, {
      runId: 'run-3',
      conversationId: 'conversation-2',
    });
    const isolatedHandle = await harness.adapter.startMapRun(isolatedInput, TOOLS, () => undefined);
    isolated.send(READY);
    expect(await isolated.nextCommand()).not.toHaveProperty('resume_session_id');
    isolated.send(sessionFrame('run-3', 'session-isolated'));
    isolated.send(profileResult('run-3', 'session-isolated'));
    await expect(isolatedHandle.done).resolves.toEqual({ status: 'succeeded' });
    expect(harness.spawn).toHaveBeenCalledTimes(4);
  },

  async lateEventRejection() {
    const state = await beginRun();
    state.server.send(sessionFrame('run-1', 'session-1'));
    state.server.send(profileResult('run-1', 'session-1'));
    await state.handle.done;
    const terminalEvents = structuredClone(state.events);

    state.server.send({ v: 1, type: 'text', request_id: 'run-1', content: 'late' });
    state.server.send(profileResult('run-1', 'session-1'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(state.events).toEqual(terminalEvents);
    expect(state.events.filter((event) => event.kind === 'run_finished')).toHaveLength(1);
  },
});

describe('DeepSeek Harness MapDesign profile adapter', () => {
  it('fails explicitly before launch when screenshots are supplied', async () => {
    const harness = createAdapterHarness();
    const events: MapAgentEvent[] = [];
    const handle = await harness.adapter.startMapRun(runInput(undefined, {
      images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
    }), TOOLS, (event) => events.push(event));

    await expect(handle.done).resolves.toEqual({
      status: 'failed',
      error: {
        code: 'IMAGE_INPUT_UNSUPPORTED',
        message: 'DeepSeek Harness does not support screenshot input.',
      },
    });
    expect(harness.spawn).not.toHaveBeenCalled();
    expect(events).toEqual([{ kind: 'run_finished', status: 'failed' }]);
  });

  it('bounds the ready handshake for both initial and reseeded attempts', async () => {
    const initial = new FakeDeepSeekProfile();
    const initialHarness = createAdapterHarness({ servers: [initial], readyTimeoutMs: 20 });
    const initialHandle = await initialHarness.adapter.startMapRun(runInput(), TOOLS, () => undefined);
    const initialResult = await Promise.race([
      initialHandle.done,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    if (initialResult === null) await initialHandle.cancel();
    expect(initialResult).toMatchObject({
      status: 'failed',
      error: { code: 'DSH_PROFILE_READY_TIMEOUT' },
    });
    expect(initialHarness.stopProcess).toHaveBeenCalledOnce();

    const input = runInput(undefined, { runId: 'run-reseed-timeout' });
    const sessionBroker = createMemoryMapAgentSessionBroker();
    sessionBroker.save(mapAgentSessionScope(input, 'deepseek-harness'), 'session-stale');
    const rejected = new FakeDeepSeekProfile();
    const silentReplacement = new FakeDeepSeekProfile();
    const events: MapAgentEvent[] = [];
    const reseedHarness = createAdapterHarness({
      servers: [rejected, silentReplacement],
      sessionBroker,
      readyTimeoutMs: 20,
    });
    const reseedHandle = await reseedHarness.adapter.startMapRun(input, TOOLS, (event) => events.push(event));
    rejected.send(READY);
    await rejected.nextCommand();
    rejected.send(profileResult(input.runId, 'session-stale', {
      status: 'failed',
      resume_rejected: true,
      error: { code: 'DSH_PROFILE_RESUME_REJECTED', message: 'Missing.' },
    }));
    await vi.waitFor(() => expect(reseedHarness.spawn).toHaveBeenCalledTimes(2));

    const reseedResult = await Promise.race([
      reseedHandle.done,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    if (reseedResult === null) await reseedHandle.cancel();
    expect(reseedResult).toMatchObject({
      status: 'failed',
      error: { code: 'DSH_PROFILE_READY_TIMEOUT' },
    });
    expect(reseedHarness.stopProcess).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.kind === 'run_finished')).toEqual([
      { kind: 'run_finished', status: 'failed' },
    ]);
  });

  it('injects callback credentials only into the Run-scoped profile environment', async () => {
    const state = await beginRun();
    expect(state.spawn).toBeDefined();
    const [, args, spawnOptions] = state.spawn!.mock.calls[0]!;

    expect(args).toEqual(['--profile', 'map-design', '--stdio']);
    expect(spawnOptions.env).toMatchObject({
      DEEPSEEK_API_KEY: 'selected-provider-secret',
      HOME: '/safe/home',
      TMPDIR: '/safe/tmp',
      LANG: 'en_US.UTF-8',
      DSH_HOME: '/safe/map-design-runtime/deepseek-harness/dsh-home',
      MAP_DESIGN_TOOL_TOKEN: 'test-only-token',
      MAP_DESIGN_PROJECT_ID: 'project-1',
      MAP_DESIGN_CONVERSATION_ID: 'conversation-1',
      MAP_DESIGN_AGENT_ID: 'deepseek-harness',
    });
    expect(spawnOptions.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(spawnOptions.env).not.toHaveProperty('DATABASE_URL');
    expect(spawnOptions.env).not.toHaveProperty('UNRELATED_SECRET');
    expect(spawnOptions.env).not.toHaveProperty('MAP_DESIGN_PROFILE_PROBE_TOOLS');
    expect(Object.keys(spawnOptions.env).filter((key) => key.startsWith('MAP_DESIGN_')).sort()).toEqual([
      'MAP_DESIGN_AGENT_ID',
      'MAP_DESIGN_CONVERSATION_ID',
      'MAP_DESIGN_PROJECT_ID',
      'MAP_DESIGN_TOOL_TOKEN',
    ]);
    await completeRun(state);
  });

  it('contains an asynchronous child-stdin EPIPE after the ready handshake', async () => {
    const state = await beginRun();
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    let emittedWithoutThrow = true;
    try {
      state.server.stdin.emit('error', epipe);
    } catch {
      emittedWithoutThrow = false;
      state.server.close(null);
    }

    expect(emittedWithoutThrow).toBe(true);
    await expect(state.handle.done).resolves.toEqual({
      status: 'failed',
      error: {
        code: 'RUN_FAILED',
        message: 'The DeepSeek Harness profile ended unexpectedly.',
      },
    });
    expect(state.events.filter((event) => event.kind === 'run_finished')).toEqual([
      { kind: 'run_finished', status: 'failed' },
    ]);
    expect(state.stopProcess).toHaveBeenCalledOnce();
  });

  it('isolates foreign request frames and fails a terminal session mismatch', async () => {
    const state = await beginRun();
    state.server.send({ v: 1, type: 'text', request_id: 'other-run', content: 'foreign' });
    state.server.send(profileResult('other-run', 'foreign-session'));
    state.server.send(sessionFrame('run-1', 'session-1'));
    state.server.send(profileResult('run-1', 'session-2'));

    await expect(state.handle.done).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'DSH_PROFILE_SESSION_MISMATCH' },
    });
    expect(state.events).not.toContainEqual(expect.objectContaining({ text: 'foreign' }));
  });

  it('permits only one reseed after a rejected resume', async () => {
    const sessionBroker = createMemoryMapAgentSessionBroker();
    const input = runInput();
    sessionBroker.save(mapAgentSessionScope(input, 'deepseek-harness'), 'session-old');
    const rejected = new FakeDeepSeekProfile();
    const rejectedAgain = new FakeDeepSeekProfile();
    const harness = createAdapterHarness({ servers: [rejected, rejectedAgain], sessionBroker });
    const handle = await harness.adapter.startMapRun(input, TOOLS, () => undefined);
    rejected.send(READY);
    await rejected.nextCommand();
    rejected.send(profileResult('run-1', 'session-old', {
      status: 'failed',
      resume_rejected: true,
      error: { code: 'DSH_PROFILE_RESUME_REJECTED', message: 'Missing.' },
    }));
    rejectedAgain.send(READY);
    expect(await rejectedAgain.nextCommand()).not.toHaveProperty('resume_session_id');
    rejectedAgain.send(profileResult('run-1', 'new-session', {
      status: 'failed',
      resume_rejected: true,
      error: { code: 'DSH_PROFILE_RESUME_REJECTED', message: 'Still missing.' },
    }));

    await expect(handle.done).resolves.toMatchObject({ status: 'failed' });
    expect(harness.spawn).toHaveBeenCalledTimes(2);
  });

  it('fails a truncated frame and emits exactly one public terminal event', async () => {
    const server = new FakeDeepSeekProfile();
    const harness = createAdapterHarness({ servers: [server] });
    const events: MapAgentEvent[] = [];
    const handle = await harness.adapter.startMapRun(runInput(), TOOLS, (event) => events.push(event));
    server.sendRaw('{"v":1,"type":"ready"');
    server.close(0);

    await expect(handle.done).resolves.toMatchObject({ status: 'failed' });
    expect(events.filter((event) => event.kind === 'run_finished')).toHaveLength(1);
  });

  it('stages a private daemon-owned profile without replacing its session state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'map-design-dsh-profile-test-'));
    vi.mocked(chmod).mockClear();
    try {
      const first = await stageDeepSeekProfileBundle(root);
      expect(first.home).toBe(resolveDeepSeekProfileHome(root));
      expect(first.profileDirectory.startsWith(`${root}${sep}`)).toBe(true);
      expect(first.profileDirectory).toBe(join(first.home, 'profiles', 'map-design'));
      const profile = JSON.parse(await readFile(join(first.profileDirectory, 'package.json'), 'utf8')) as {
        dsh: { profile: { bundles: string[] } };
      };
      expect(profile.dsh.profile.bundles).toEqual([
        '@deepseek-ai/dsh-base',
        '@mapseekai/dsh-map-design-runtime',
      ]);
      expect(chmod).toHaveBeenCalledWith(first.profileDirectory, 0o700);
      // Windows stat mode exposes read/write flags, not directory ACL permissions.
      expect((await stat(first.profileDirectory)).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o700);
      await Promise.all([
        execFileAsync(process.execPath, ['--check', first.bridgePath]),
        execFileAsync(process.execPath, ['--check', first.runtimePath]),
        execFileAsync(process.execPath, ['--check', first.startupPath]),
      ]);
      const startup = await import(`${pathToFileURL(first.startupPath).href}?test=${Date.now()}`) as {
        apply(context: {
          get(name: string): unknown;
          provide(name: string, value: unknown): void;
        }): void;
      };
      const provided: Array<{ name: string; value: unknown }> = [];
      startup.apply({
        get(name) {
          if (name === 'cmdlineArgs') return { get: () => ['--probe'] };
          if (name === 'appExit') return () => undefined;
          return undefined;
        },
        provide: (name, value) => provided.push({ name, value }),
      });
      expect(provided).toEqual([{ name: 'mapDesignStartup', value: { mode: 'probe' } }]);

      const session = join(first.home, 'sessions', 'keep.jsonl');
      await writeFile(session, '{"session":true}\n', { encoding: 'utf8', mode: 0o600 });
      const second = await stageDeepSeekProfileBundle(root);
      expect(second).toEqual(first);
      expect(await readFile(session, 'utf8')).toBe('{"session":true}\n');
      await writeFile(first.bridgePath, 'tampered\n', 'utf8');
      await expect(stageDeepSeekProfileBundle(root)).rejects.toThrow('integrity');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies the composed-prompt byte limit in the actual staged profile parser', async () => {
    const root = await mkdtemp(join(tmpdir(), 'map-design-dsh-prompt-test-'));
    try {
      const bundle = await stageDeepSeekProfileBundle(root);
      const bridge = await import(`${pathToFileURL(bundle.bridgePath).href}?prompt=${Date.now()}`) as {
        parseMapDesignHostCommand(value: unknown): { prompt: string };
      };
      const command = (prompt: string) => ({
        v: 1,
        type: 'execute',
        request_id: 'run-prompt',
        cwd: '/safe/project',
        prompt,
        host_tools: TOOLS,
        callback: {
          url: 'http://127.0.0.1:8787/api/map-design/tools',
          tokenEnv: 'MAP_DESIGN_TOOL_TOKEN',
        },
      });
      const composed = 'x'.repeat(524_288);

      expect(bridge.parseMapDesignHostCommand(command(composed)).prompt).toBe(composed);
      expect(() => bridge.parseMapDesignHostCommand(command('界'.repeat(174_763)))).toThrow('prompt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('probes the staged registered host-tool surface and scrubs ambient Run secrets', async () => {
    const server = new FakeDeepSeekProfile();
    const harness = createAdapterHarness({ servers: [server] });
    const probing = harness.adapter.probeNativeMapTools!();
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledOnce());
    const [, args, spawnOptions] = harness.spawn.mock.calls[0]!;
    expect(args).toEqual(['--profile', 'map-design', '--probe']);
    expect(spawnOptions.env).toMatchObject({
      DEEPSEEK_API_KEY: 'selected-provider-secret',
      HOME: '/safe/home',
      TMPDIR: '/safe/tmp',
      LANG: 'en_US.UTF-8',
      DSH_HOME: '/safe/map-design-runtime/deepseek-harness/dsh-home',
      MAP_DESIGN_PROFILE_PROBE_TOOLS: JSON.stringify(TOOLS),
    });
    expect(spawnOptions.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(spawnOptions.env).not.toHaveProperty('DATABASE_URL');
    expect(spawnOptions.env).not.toHaveProperty('UNRELATED_SECRET');
    expect(spawnOptions.env).not.toHaveProperty('MAP_DESIGN_TOOL_TOKEN');
    expect(spawnOptions.env).not.toHaveProperty('MAP_DESIGN_PROJECT_ID');
    expect(Object.keys(spawnOptions.env).filter((key) => key.startsWith('MAP_DESIGN_'))).toEqual([
      'MAP_DESIGN_PROFILE_PROBE_TOOLS',
    ]);
    server.send({ ...READY, type: 'probe', host_tools: TOOLS.map((tool) => tool.name).reverse() });
    server.close(0);

    await expect(probing).resolves.toBe(true);
  });

  it('runs the staged profile probe through an exact Agent-scoped native tool surface', async () => {
    const result = await runStagedProfileProbe({ reverseScopedSurface: true });

    expect(result.code).toBe(0);
    expect(result.create).toHaveBeenCalledOnce();
    expect(result.createdAgent).not.toBeNull();
    expect(result.schemaScopes).toEqual([result.createdAgent]);
    expect(result.disposeAgent).toHaveBeenCalledOnce();
    expect(result.frames).toEqual([{
      ...READY,
      type: 'probe',
      host_tools: TOOLS.map((tool) => tool.name).reverse(),
    }]);
  });

  it('fails the staged profile probe when the scoped surface contains an unexpected tool', async () => {
    const result = await runStagedProfileProbe({ leakUnexpectedTool: true });

    expect(result.code).toBe(1);
    expect(result.create).toHaveBeenCalledOnce();
    expect(result.disposeAgent).toHaveBeenCalledOnce();
    expect(result.frames).toEqual([]);
  });

  it('fails the staged runtime when the model exhausts its output tokens', async () => {
    const result = await runStagedProfileExecution([
      { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'max-tokens' } } },
    ]);
    expect(result.frames.find((frame) => frame.type === 'result')).toMatchObject({
      status: 'failed', stop_reason: 'max-tokens', error: { code: 'RESPONSE_TRUNCATED' },
    });
  });

  it('emits authoritative assembled assistant text when no text delta was observed', async () => {
    const result = await runStagedProfileExecution([
      {
        type: 'assistant/message',
        seq: 1,
        data: {
          turn: 1,
          step: 1,
          message: {
            content: [{ type: 'text', text: 'Assembled only.' }],
          },
        },
      },
      { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);

    expect(result.code).toBe(0);
    expect(result.frames.filter((frame) => frame.type === 'text')).toEqual([{
      v: 1,
      type: 'text',
      request_id: 'runtime-run-1',
      content: 'Assembled only.',
    }]);
    const terminal = result.frames.find((frame) => frame.type === 'result');
    expect(terminal).toMatchObject({ status: 'completed' });
    expect(terminal).toHaveProperty('output', 'Assembled only.');
  });

  it('does not duplicate assembled assistant text after streaming its delta', async () => {
    const result = await runStagedProfileExecution([
      {
        type: 'assistant/chunk',
        seq: 1,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'Streamed once.' } },
      },
      {
        type: 'assistant/message',
        seq: 2,
        data: {
          turn: 1,
          step: 1,
          message: {
            content: [{ type: 'text', text: 'Streamed once.' }],
          },
        },
      },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);

    expect(result.code).toBe(0);
    expect(result.frames.filter((frame) => frame.type === 'text')).toEqual([{
      v: 1,
      type: 'text',
      request_id: 'runtime-run-1',
      content: 'Streamed once.',
    }]);
    const terminal = result.frames.find((frame) => frame.type === 'result');
    expect(terminal).toMatchObject({ status: 'completed' });
    expect(terminal).toHaveProperty('output', 'Streamed once.');
  });

  it('chunks a large assembled-only message into valid surrogate-safe text frames', async () => {
    const assembled = `${'x'.repeat(65_535)}😀tail`;
    const result = await runStagedProfileExecution([
      {
        type: 'assistant/message',
        seq: 1,
        data: {
          turn: 1,
          step: 1,
          message: { content: [{ type: 'text', text: assembled }] },
        },
      },
      { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);
    const textFrames = result.frames.filter((frame) => frame.type === 'text');

    expect(textFrames.length).toBeGreaterThan(1);
    expect(textFrames.map((frame) => String(frame.content)).join('')).toBe(assembled);
    for (const frame of textFrames) {
      expect(() => parseDeepSeekProfileRuntimeFrame(frame)).not.toThrow();
      expect(String(frame.content)).not.toMatch(/[\uD800-\uDBFF]$/u);
      expect(String(frame.content)).not.toMatch(/^[\uDC00-\uDFFF]/u);
    }
    const terminal = result.frames.find((frame) => frame.type === 'result');
    expect(terminal).toHaveProperty('output', assembled);
    expect(() => parseDeepSeekProfileRuntimeFrame(terminal)).not.toThrow();
  });

  it('preserves cumulative assembled text beyond the result limit only in valid text frames', async () => {
    const first = 'a'.repeat(40_000);
    const second = 'b'.repeat(40_000);
    const result = await runStagedProfileExecution([
      {
        type: 'assistant/message',
        seq: 1,
        data: {
          turn: 1,
          step: 1,
          message: { content: [{ type: 'text', text: first }] },
        },
      },
      {
        type: 'assistant/message',
        seq: 2,
        data: {
          turn: 1,
          step: 2,
          message: { content: [{ type: 'text', text: second }] },
        },
      },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);
    const textFrames = result.frames.filter((frame) => frame.type === 'text');
    const terminal = result.frames.find((frame) => frame.type === 'result');

    expect(textFrames.map((frame) => String(frame.content)).join('')).toBe(first + second);
    for (const frame of textFrames) {
      expect(() => parseDeepSeekProfileRuntimeFrame(frame)).not.toThrow();
    }
    expect(terminal).toHaveProperty('output', second);
    expect(() => parseDeepSeekProfileRuntimeFrame(terminal)).not.toThrow();
  });

  it('does not recover a failed host probe after a leading non-probe frame', async () => {
    const server = new FakeDeepSeekProfile();
    const harness = createAdapterHarness({ servers: [server] });
    const probing = harness.adapter.probeNativeMapTools!();
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledOnce());
    server.send(READY);
    server.send({ ...READY, type: 'probe', host_tools: TOOLS.map((tool) => tool.name) });
    server.close(0);

    await expect(probing).resolves.toBe(false);
  });

  it('wires the concrete factory through the local registry only after its real profile probe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'map-design-dsh-registry-test-'));
    const server = new FakeDeepSeekProfile();
    const spawn = vi.fn<DeepSeekProfileSpawn>(() => {
      queueMicrotask(() => {
        server.send({ ...READY, type: 'probe', host_tools: TOOLS.map((tool) => tool.name) });
        server.close(0);
      });
      return server.child;
    });
    try {
      const registry = createLocalAgentRegistry({
        definitions: [{
          id: 'deepseek-harness',
          name: 'DeepSeek Harness',
          bin: 'node',
          versionArgs: ['--version'],
          fallbackModels: [],
          buildArgs: () => ['--profile', 'map-design', '--stdio'],
          streamFormat: 'dsh-profile-jsonl',
          mapDesign: { nativeToolAdapter: 'deepseek-profile', publicReasoningSummary: true },
        }],
        nativeToolRegistry: {
          definitions: () => TOOLS,
          call: vi.fn(),
        },
        config: { read: () => ({ agentCliEnv: { 'deepseek-harness': { PATH: '/usr/bin' } } }) },
        deepSeekProfileRoot: root,
        spawn,
        stageSkill: async () => undefined,
      });

      expect(registry.getMapAgent?.('deepseek-harness')).toBeNull();
      await registry.probeNativeMapTools();
      expect(registry.getMapAgent?.('deepseek-harness')).toMatchObject({
        id: 'deepseek-harness',
        capabilities: { nativeMapTools: true, publicReasoningSummary: true },
      });
      expect(spawn.mock.calls[0]?.[2].env.DSH_HOME).toBe(resolveDeepSeekProfileHome(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
