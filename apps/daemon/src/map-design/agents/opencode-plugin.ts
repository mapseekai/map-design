import { Buffer } from 'node:buffer';
import { spawn as spawnChild } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SafeToolSummarySchema, type SafeToolSummary } from '@mapseekai/contracts';
import type { MapToolName } from '@mapseekai/map-design-contracts';

import type { RuntimeAgentDef } from '../../runtimes/types.js';
import { stopMapDesignProcessTree } from '../application/run-service.js';
import type { NativeMapToolDefinition } from '../tools/tool-context.js';
import { sanitizeMapAgentLaunchEnvironment } from './launch-environment.js';
import {
  createMemoryMapAgentSessionBroker,
  mapAgentSessionScope,
  type MapAgentSessionBroker,
} from './session-broker.js';
import {
  createMapToolCallSignature,
  createMapToolFailureClassSignature,
  createMapToolLoopGuard,
} from './map-tool-loop-guard.js';
import {
  RUN_TOOL_CALLBACK_AGENT_HEADER,
  RUN_TOOL_CALLBACK_CONVERSATION_HEADER,
  RUN_TOOL_CALLBACK_PROJECT_HEADER,
  RUN_TOOL_CALLBACK_RUN_HEADER,
  RUN_TOOL_CALLBACK_TOOL_USE_HEADER,
} from './tool-callback.js';
import type {
  MapAgentAdapter,
  MapAgentEvent,
  MapRunHandle,
  MapRunInput,
  MapRunTerminal,
} from './types.js';

export interface OpenCodePluginProcess {
  pid?: number | undefined;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  stdin?: NodeJS.WritableStream | null;
  once(event: 'close', listener: (code: number | null) => void): this;
  once(event: 'error', listener: () => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type OpenCodePluginSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean },
) => OpenCodePluginProcess;

export type OpenCodeRunPlugin = {
  source: string;
  env: NodeJS.ProcessEnv;
};

export type OpenCodePluginLease = {
  path: string;
  probePath: string;
  dispose(): Promise<void>;
};

export type OpenCodeStagePlugin = (
  plugin: OpenCodeRunPlugin,
  root?: string,
) => Promise<OpenCodePluginLease>;

type OpenCodeEventParserOptions = {
  tools: readonly NativeMapToolDefinition[];
  maxFrameBytes?: number;
  onEvent(event: MapAgentEvent): void;
  onSession(sessionId: string): void;
  onFailure(error?: { code: string; message: string }): void;
};

type OpenCodeEventParserLike = {
  readonly activeToolCalls: number;
  failed: boolean;
  feed(chunk: Buffer | string): void;
  flush(): void;
};

export type CreateOpenCodeMapAgentAdapterOptions = {
  definition: RuntimeAgentDef;
  toolDefinitions: () => readonly NativeMapToolDefinition[];
  spawn?: OpenCodePluginSpawn;
  environment?: () => NodeJS.ProcessEnv | null;
  environmentKeys?: () => readonly string[];
  pluginRoot?: string;
  stagePlugin?: OpenCodeStagePlugin;
  parserFactory?: (options: OpenCodeEventParserOptions) => OpenCodeEventParserLike;
  sessionBroker?: MapAgentSessionBroker;
  maxFrameBytes?: number;
  probeTimeoutMs?: number;
  probeCwd?: string;
  processStopTimeoutMs?: number;
  stopProcess?: (child: OpenCodePluginProcess) => Promise<void>;
};

const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const MAX_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_PROCESS_STOP_TIMEOUT_MS = 250;
const MAX_EVENT_TEXT_LENGTH = 65_536;
const MAX_REJECTION_STDERR_BYTES = 8_192;
const FAILED_CONNECTION = {
  code: 'RUN_FAILED',
  message: 'The OpenCode process ended unexpectedly.',
} as const;
const TOOL_LOOP_DETECTED = {
  code: 'TOOL_LOOP_DETECTED',
  message: 'Repeated invalid map tool calls were stopped.',
} as const;

export function createOpenCodeMapAgentAdapter(
  options: CreateOpenCodeMapAgentAdapterOptions,
): MapAgentAdapter {
  const sessionBroker = options.sessionBroker ?? createMemoryMapAgentSessionBroker();
  return {
    id: options.definition.id,
    capabilities: { nativeMapTools: true, publicReasoningSummary: false },
    probeNativeMapTools: () => probeOpenCodeNativeMapTools(options),
    async startMapRun(input, tools, onEvent) {
      const baseEnvironment = options.environment ? options.environment() : process.env;
      if (!baseEnvironment) throw new Error('OpenCode environment unavailable.');
      type Attempt = {
        child: OpenCodePluginProcess | null;
        lease: OpenCodePluginLease;
        parser: OpenCodeEventParserLike | null;
        resumeSessionId: string | null;
        resumeAttempted: boolean;
        stderr: string;
        stderrOverflow: boolean;
        substantive: boolean;
        exited: boolean;
        closing: boolean;
        disposed: boolean;
        stopPromise: Promise<void> | null;
      };
      let currentAttempt: Attempt | null = null;
      let terminal = false;
      let cancelRequested = false;
      let cancellation: Promise<void> | null = null;
      let reseeded = false;
      let observedSessionId: string | null = null;
      let resolveDone!: (result: MapRunTerminal) => void;
      const done = new Promise<MapRunTerminal>((resolve) => { resolveDone = resolve; });
      const sessionScope = mapAgentSessionScope(input, options.definition.id);

      const stopAttempt = (attempt: Attempt | null): Promise<void> => {
        if (!attempt || !attempt.child || attempt.exited) return Promise.resolve();
        if (attempt.stopPromise) return attempt.stopPromise;
        attempt.closing = true;
        attempt.stopPromise = stopOpenCodeProcess(attempt.child, options).catch(() => undefined);
        return attempt.stopPromise;
      };
      const disposeAttempt = async (attempt: Attempt | null): Promise<void> => {
        if (!attempt || attempt.disposed) return;
        attempt.disposed = true;
        await attempt.lease.dispose().catch(() => undefined);
      };
      const cleanupAttempt = async (attempt: Attempt | null): Promise<void> => {
        await stopAttempt(attempt);
        await disposeAttempt(attempt);
      };
      const finish = (result: MapRunTerminal): void => {
        if (terminal) return;
        terminal = true;
        input.signal.removeEventListener('abort', onInputAbort);
        if (result.status === 'succeeded' && observedSessionId) {
          sessionBroker.save(sessionScope, observedSessionId);
        } else if (result.status !== 'succeeded') {
          sessionBroker.delete(sessionScope);
        }
        onEvent({ kind: 'run_finished', status: result.status });
        resolveDone(result);
        void cleanupAttempt(currentAttempt);
      };
      const fail = (error: { code: string; message: string } = FAILED_CONNECTION): void => {
        if (terminal || cancelRequested) return;
        finish({ status: 'failed', error });
      };
      const cancel = async (): Promise<void> => {
        if (terminal) return cleanupAttempt(currentAttempt);
        if (cancellation) return cancellation;
        cancelRequested = true;
        cancellation = (async () => {
          await cleanupAttempt(currentAttempt);
          finish({ status: 'canceled' });
          await cleanupAttempt(currentAttempt);
        })();
        return cancellation;
      };
      const onInputAbort = (): void => { void cancel(); };
      const handle: MapRunHandle = { done, cancel };

      if (input.signal.aborted) {
        finish({ status: 'canceled' });
        return handle;
      }
      input.signal.addEventListener('abort', onInputAbort, { once: true });

      const spawnAttempt = async (resumeSessionId: string | null): Promise<void> => {
        const plugin = buildOpenCodeRunPlugin(tools, input, options.definition.id);
        const lease = await (options.stagePlugin ?? stageOpenCodePlugin)(plugin, options.pluginRoot);
        let imagePaths: string[];
        try {
          imagePaths = await stageOpenCodeImages(input.images, lease.path);
        } catch (error) {
          await lease.dispose().catch(() => undefined);
          throw error;
        }
        const attempt: Attempt = {
          child: null,
          lease,
          parser: null,
          resumeSessionId,
          resumeAttempted: false,
          stderr: '',
          stderrOverflow: false,
          substantive: false,
          exited: false,
          closing: false,
          disposed: false,
          stopPromise: null,
        };
        currentAttempt = attempt;
        if (terminal || cancelRequested || input.signal.aborted) {
          await cleanupAttempt(attempt);
          return;
        }
        const environment = composeOpenCodePluginEnvironment(
          baseEnvironment,
          plugin.env,
          lease.path,
          [...(options.definition.inheritedEnvKeys ?? []), ...(options.environmentKeys?.() ?? [])],
        );
        const runPrompt = resumeSessionId ? input.resumePrompt : input.prompt;
        const args = options.definition.buildArgs(
          runPrompt,
          imagePaths,
          undefined,
          { model: input.model, reasoning: input.reasoning, serviceTier: input.serviceTier },
          { cwd: input.cwd, resumeSessionId },
        );
        if (input.reasoning && input.reasoning !== 'default' && !args.includes('--variant')) {
          args.push('--variant', input.reasoning);
        }
        for (const imagePath of imagePaths) args.push('--file', imagePath);
        attempt.resumeAttempted = hasExactOpenCodeResumeArgs(args, resumeSessionId);
        const child = (options.spawn ?? defaultSpawn)(options.definition.bin, args, {
          cwd: input.cwd,
          env: environment,
          detached: process.platform !== 'win32',
        });
        attempt.child = child;
        if (terminal || cancelRequested || input.signal.aborted) {
          await cleanupAttempt(attempt);
          return;
        }
        if (!child.stdin || !child.stdout) throw new OpenCodeProtocolError('OpenCode stdio is unavailable.');
        const parser = (options.parserFactory ?? ((parserOptions) => new OpenCodeEventParser(parserOptions)))({
          tools,
          ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
          onEvent: (event) => {
            if (event.kind === 'text' || event.kind === 'tool_use' || event.kind === 'tool_result') {
              attempt.substantive = true;
            }
            onEvent(event);
          },
          onSession: (sessionId) => {
            if (
              (attempt.resumeSessionId && sessionId !== attempt.resumeSessionId)
              || (observedSessionId && observedSessionId !== sessionId)
            ) {
              sessionBroker.delete(sessionScope);
              fail({ code: 'OPENCODE_SESSION_MISMATCH', message: 'OpenCode resumed a mismatched session.' });
              return;
            }
            observedSessionId = sessionId;
          },
          onFailure: (error) => fail(error),
        });
        attempt.parser = parser;
        const failAttempt = (): void => {
          if (attempt === currentAttempt && !attempt.closing) fail();
        };
        child.stdin.on('error', failAttempt);
        child.stdout.on('data', (chunk: Buffer | string) => {
          if (terminal || attempt !== currentAttempt || attempt.closing) return;
          try { parser.feed(chunk); } catch { fail(); }
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
          const next = `${attempt.stderr}${String(chunk)}`;
          if (Buffer.byteLength(next, 'utf8') > MAX_REJECTION_STDERR_BYTES) {
            attempt.stderrOverflow = true;
            return;
          }
          attempt.stderr = next;
        });
        child.stdout.on('error', failAttempt);
        child.once('close', (code) => {
          attempt.exited = true;
          if (terminal || attempt !== currentAttempt || attempt.closing) return;
          if (cancelRequested) {
            finish({ status: 'canceled' });
            return;
          }
          try { parser.flush(); } catch { fail(); return; }
          if (isRejectedOpenCodeResume(
            attempt.resumeSessionId,
            attempt.resumeAttempted,
            attempt.stderr,
            attempt.stderrOverflow,
            code,
            attempt.substantive,
          )) {
            if (!reseeded) {
              reseeded = true;
              sessionBroker.delete(sessionScope);
              attempt.closing = true;
              void (async () => {
                await cleanupAttempt(attempt);
                if (terminal || cancelRequested || input.signal.aborted) return;
                observedSessionId = null;
                await spawnAttempt(null);
              })().catch(() => fail());
              return;
            }
          }
          if (code === 0 && !parser.failed && parser.activeToolCalls === 0) {
            finish({ status: 'succeeded' });
          } else {
            fail();
          }
        });
        child.once('error', failAttempt);
        child.stdin.write(runPrompt);
        child.stdin.end();
      };

      try {
        await spawnAttempt(sessionBroker.load(sessionScope));
        return handle;
      } catch {
        input.signal.removeEventListener('abort', onInputAbort);
        sessionBroker.delete(sessionScope);
        await cleanupAttempt(currentAttempt);
        if (terminal) return handle;
        throw new Error('OpenCode native plugin protocol unavailable.');
      }
    },
  };
}

async function stageOpenCodeImages(
  images: MapRunInput['images'],
  pluginPath: string,
): Promise<string[]> {
  return Promise.all((images ?? []).map(async (image, index) => {
    const path = join(dirname(pluginPath), `screenshot-${index + 1}.png`);
    await writeFile(path, Buffer.from(image.data, 'base64'), { flag: 'wx', mode: 0o600 });
    return path;
  }));
}

function isRejectedOpenCodeResume(
  resumeSessionId: string | null,
  resumeAttempted: boolean,
  stderr: string,
  stderrOverflow: boolean,
  exitCode: number | null,
  substantive: boolean,
): boolean {
  if (!resumeSessionId || !resumeAttempted || substantive || stderrOverflow || exitCode !== 1) return false;
  const lines = stderr.replace(/\r/gu, '').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length === 1 && /^(?:Error:\s*)?Session not found$/u.test(lines[0]!);
}

function hasExactOpenCodeResumeArgs(args: readonly string[], resumeSessionId: string | null): boolean {
  if (!resumeSessionId) return false;
  const indexes = args.flatMap((arg, index) => arg === '-s' ? [index] : []);
  return indexes.length === 1 && args[indexes[0]! + 1] === resumeSessionId;
}

export async function probeOpenCodeNativeMapTools(
  options: CreateOpenCodeMapAgentAdapterOptions,
): Promise<boolean> {
  const baseEnvironment = options.environment ? options.environment() : process.env;
  if (!baseEnvironment) return false;
  const tools = [...options.toolDefinitions()];
  const plugin = buildOpenCodeRunPlugin(tools, {
    runId: 'probe',
    projectId: 'probe',
    conversationId: 'probe',
    toolCallback: { url: 'http://127.0.0.1/unused', token: 'probe', close: () => undefined },
  }, options.definition.id);
  let lease: OpenCodePluginLease | null = null;
  let child: OpenCodePluginProcess | null = null;
  let processExited = false;
  try {
    lease = await (options.stagePlugin ?? stageOpenCodePlugin)(plugin, options.pluginRoot);
    const environment = composeOpenCodePluginEnvironment(baseEnvironment, {
      MAP_DESIGN_PLUGIN_PROBE_PATH: lease.probePath,
    }, lease.path, [
      ...(options.definition.inheritedEnvKeys ?? []),
      ...(options.environmentKeys?.() ?? []),
    ]);
    child = (options.spawn ?? defaultSpawn)(options.definition.bin, ['debug', 'agent', 'build'], {
      cwd: options.probeCwd ?? process.cwd(),
      env: environment,
      detached: process.platform !== 'win32',
    });
    child.stderr?.resume();
    const code = await waitForProcess(child, boundedTimeout(options.probeTimeoutMs));
    processExited = true;
    if (code !== 0) return false;
    const names = JSON.parse(await readFile(lease.probePath, 'utf8')) as unknown;
    return Array.isArray(names)
      && names.length === tools.length
      && names.every((name, index) => name === tools[index]?.name);
  } catch {
    return false;
  } finally {
    if (child && !processExited) await stopOpenCodeProcess(child, options);
    await lease?.dispose().catch(() => undefined);
  }
}

function buildOpenCodeRunPlugin(
  tools: readonly NativeMapToolDefinition[],
  input: Pick<MapRunInput, 'runId' | 'projectId' | 'conversationId' | 'toolCallback'>,
  agentId: string,
): OpenCodeRunPlugin {
  const definitions = Object.fromEntries(tools.map((definition) => [definition.name, {
    description: definition.description,
    inputSchema: definition.inputSchema,
  }]));
  const surface = tools.map((definition) => `${definition.name}: tool({
      description: DEFINITIONS[${JSON.stringify(definition.name)}].description,
      args: schemaArguments(DEFINITIONS[${JSON.stringify(definition.name)}].inputSchema),
      execute: executeTool(${JSON.stringify(definition.name)}),
    })`).join(',\n    ');
  const source = `import { tool } from '@opencode-ai/plugin';

const DEFINITIONS = ${javascriptLiteral(definitions)};
const MAX_BODY_BYTES = 262144;

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error('MapDesign plugin environment unavailable.');
  return value;
}

function schemaArguments(inputSchema) {
  const schema = tool.schema.fromJSONSchema(inputSchema);
  if (!schema || typeof schema !== 'object' || !schema.shape) {
    throw new Error('MapDesign tool input schema is invalid.');
  }
  return schema.shape;
}

function boundedJson(value, label) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new Error(\`MapDesign tool ${'${label}'} is invalid.\`); }
  if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > MAX_BODY_BYTES) {
    throw new Error(\`MapDesign tool ${'${label}'} is too large.\`);
  }
  return encoded;
}

function boundedOutput(value) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_BODY_BYTES) {
    throw new Error('MapDesign tool result is too large.');
  }
  return value;
}

async function boundedResponse(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('MapDesign tool result is too large.');
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error('MapDesign tool result is too large.');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error('MapDesign tool result is too large.');
    }
    chunks.push(item.value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

function executeTool(name) {
  return async (input, context) => {
    const callbackUrl = requiredEnvironment('MAP_DESIGN_TOOL_CALLBACK_URL');
    const callbackToken = requiredEnvironment('MAP_DESIGN_TOOL_CALLBACK_TOKEN');
    const runId = requiredEnvironment('MAP_DESIGN_RUN_ID');
    const projectId = requiredEnvironment('MAP_DESIGN_PROJECT_ID');
    const conversationId = requiredEnvironment('MAP_DESIGN_CONVERSATION_ID');
    const agentId = requiredEnvironment('MAP_DESIGN_AGENT_ID');
    const toolUseId = globalThis.crypto.randomUUID();
    const body = boundedJson(input, 'input');
    const response = await fetch(\`${'${callbackUrl}'}/${'${encodeURIComponent(name)}'}\`, {
      method: 'POST',
      headers: {
        authorization: \`Bearer ${'${callbackToken}'}\`,
        'content-type': 'application/json',
        '${RUN_TOOL_CALLBACK_RUN_HEADER}': runId,
        '${RUN_TOOL_CALLBACK_PROJECT_HEADER}': projectId,
        '${RUN_TOOL_CALLBACK_CONVERSATION_HEADER}': conversationId,
        '${RUN_TOOL_CALLBACK_AGENT_HEADER}': agentId,
        '${RUN_TOOL_CALLBACK_TOOL_USE_HEADER}': toolUseId,
      },
      body,
      ...(context && context.abort ? { signal: context.abort } : {}),
    });
    if (!response.ok) throw new Error('The MapDesign tool callback failed.');
    const text = await boundedResponse(response);
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('The MapDesign tool callback returned invalid JSON.'); }
    if (!result || typeof result !== 'object' || result.toolUseId !== toolUseId || typeof result.ok !== 'boolean') {
      throw new Error('The MapDesign tool callback returned an invalid result.');
    }
    if (!result.ok) {
      const error = result.error;
      if (!error || typeof error !== 'object' || typeof error.code !== 'string' || typeof error.message !== 'string') {
        throw new Error('The MapDesign tool callback returned an invalid error.');
      }
      throw new Error(boundedJson({
        code: error.code,
        message: error.message,
        retryable: error.retryable === true,
        ...(error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? { details: error.details } : {}),
      }, 'result'));
    }
    if (!result.summary || typeof result.summary !== 'object' || Array.isArray(result.summary)) {
      throw new Error('The MapDesign tool callback returned an invalid summary.');
    }
    return typeof result.modelContent === 'string'
      ? boundedOutput(result.modelContent)
      : boundedJson(result.summary, 'result');
  };
}

export async function MapDesignOpenCodePlugin() {
  const surface = {
    ${surface}
  };
  const probePath = process.env.MAP_DESIGN_PLUGIN_PROBE_PATH;
  if (probePath) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(probePath, JSON.stringify(Object.keys(surface)), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  return { tool: surface };
}
`;
  return {
    source,
    env: {
      MAP_DESIGN_TOOL_CALLBACK_URL: input.toolCallback.url,
      MAP_DESIGN_TOOL_CALLBACK_TOKEN: input.toolCallback.token,
      MAP_DESIGN_RUN_ID: input.runId,
      MAP_DESIGN_PROJECT_ID: input.projectId,
      MAP_DESIGN_CONVERSATION_ID: input.conversationId,
      MAP_DESIGN_AGENT_ID: agentId,
    },
  };
}

async function stageOpenCodePlugin(
  plugin: OpenCodeRunPlugin,
  root = tmpdir(),
): Promise<OpenCodePluginLease> {
  const directory = await mkdtemp(join(root, 'map-design-opencode-'));
  const path = join(directory, 'map-design-plugin.ts');
  const probePath = join(directory, 'tool-surface.json');
  try {
    await writeFile(path, plugin.source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  return {
    path,
    probePath,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function composeOpenCodePluginEnvironment(
  base: NodeJS.ProcessEnv,
  plugin: NodeJS.ProcessEnv,
  pluginPath: string,
  inheritedEnvKeys: readonly string[],
): NodeJS.ProcessEnv {
  const inherited = sanitizeMapAgentLaunchEnvironment(base, inheritedEnvKeys);
  let existing: Record<string, unknown> = {};
  const content = inherited.OPENCODE_CONFIG_CONTENT;
  if (content) {
    const parsed = JSON.parse(content) as unknown;
    const parsedRecord = record(parsed);
    if (!parsedRecord) throw new OpenCodeProtocolError('OpenCode config content is invalid.');
    existing = parsedRecord;
  }
  const configured = existing.plugin;
  if (configured !== undefined && !Array.isArray(configured)) {
    throw new OpenCodeProtocolError('OpenCode plugin config is invalid.');
  }
  return {
    ...inherited,
    ...plugin,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...existing,
      plugin: [...(configured ?? []), pathToFileURL(pluginPath).href],
    }),
  };
}

class OpenCodeEventParser implements OpenCodeEventParserLike {
  private buffer = Buffer.alloc(0);
  private readonly limit: number;
  private readonly toolNames: Set<string>;
  private readonly calls = new Map<string, { name: MapToolName; input: unknown }>();
  private readonly completed = new Set<string>();
  private readonly loopGuard = createMapToolLoopGuard();
  private statusEmitted = false;
  failed = false;

  constructor(private readonly options: OpenCodeEventParserOptions) {
    this.limit = positiveLimit(options.maxFrameBytes);
    this.toolNames = new Set(options.tools.map((tool) => tool.name));
  }

  get activeToolCalls(): number {
    return this.calls.size;
  }

  feed(chunk: Buffer | string): void {
    if (this.failed) return;
    const bytes = Buffer.from(chunk);
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > this.limit) this.protocolFailure();
        return;
      }
      if (newline + 1 > this.limit) return this.protocolFailure();
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length === 0) continue;
      this.parseLine(line.toString('utf8'));
      if (this.failed) return;
    }
  }

  flush(): void {
    if (this.failed) return;
    if (this.buffer.length === 0) return;
    if (this.buffer.length > this.limit) return this.protocolFailure();
    const line = this.buffer.toString('utf8').trim();
    this.buffer = Buffer.alloc(0);
    if (line) this.parseLine(line);
  }

  private parseLine(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return this.protocolFailure(); }
    const event = record(value);
    if (!event || typeof event.type !== 'string') return this.protocolFailure();
    const part = record(event.part) ?? {};
    if (event.type === 'step_start') {
      const sessionId = safeIdentifier(event.sessionID);
      if (!sessionId) return this.protocolFailure();
      this.options.onSession(sessionId);
      if (!this.statusEmitted) {
        this.statusEmitted = true;
        this.options.onEvent({ kind: 'status', label: 'analyzing' });
      }
      return;
    }
    if (event.type === 'text') {
      if (typeof part.text !== 'string' || part.text.length === 0 || part.text.length > MAX_EVENT_TEXT_LENGTH) {
        return this.protocolFailure();
      }
      this.options.onEvent({ kind: 'text', text: part.text });
      return;
    }
    if (event.type === 'tool_use') this.handleToolUse(part);
    if (event.type === 'error') this.protocolFailure();
  }

  private handleToolUse(part: Record<string, unknown>): void {
    const name = safeIdentifier(part.tool) as MapToolName | null;
    const id = safeIdentifier(part.callID);
    const state = record(part.state);
    if (!name || !id || !state || !this.toolNames.has(name)) return this.protocolFailure();
    const input = parsePossibleJson(state.input);
    if (this.completed.has(id)) return;
    const existing = this.calls.get(id);
    if (!existing) {
      this.calls.set(id, { name, input });
      this.options.onEvent({ kind: 'tool_use', id, name, summary: {} });
    } else if (existing.name !== name) {
      return this.protocolFailure();
    }
    if (state.status === 'completed') {
      this.calls.delete(id);
      this.completed.add(id);
      const summary = safeSummary(state.output, {});
      this.loopGuard.success(name);
      this.options.onEvent({ kind: 'tool_result', toolUseId: id, status: 'succeeded', summary });
      return;
    }
    if (state.status === 'error') {
      this.calls.delete(id);
      this.completed.add(id);
      const summary = safeSummary(state.error ?? state.output, { code: 'SDK_TOOL_FAILED', retryable: false });
      const status = summary.code === 'CANCELED' || summary.code === 'CANCELLED' ? 'canceled' : 'failed';
      this.options.onEvent({ kind: 'tool_result', toolUseId: id, status, summary });
      if (status === 'failed') {
        const error = summaryError(summary);
        const verdict = this.loopGuard.failure(
          name,
          createMapToolCallSignature(name, input),
          createMapToolFailureClassSignature(name, error) ?? undefined,
          error.retryable !== true,
        );
        if (verdict?.action === 'halt') {
          this.failed = true;
          this.options.onFailure(TOOL_LOOP_DETECTED);
        }
      }
    }
  }

  private protocolFailure(): void {
    if (this.failed) return;
    this.failed = true;
    this.options.onFailure(FAILED_CONNECTION);
  }
}

function safeSummary(value: unknown, fallback: SafeToolSummary): SafeToolSummary {
  const parsed = SafeToolSummarySchema.safeParse(parsePossibleJson(value));
  return parsed.success ? parsed.data : fallback;
}

function summaryError(summary: SafeToolSummary): {
  code: string;
  message: string;
  retryable: boolean;
  details: SafeToolSummary;
} {
  return {
    code: typeof summary.code === 'string' ? summary.code : 'SDK_TOOL_FAILED',
    message: 'The map tool call failed.',
    retryable: summary.retryable === true,
    details: summary,
  };
}

function parsePossibleJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\r\n\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function positiveLimit(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_FRAME_BYTES;
}

function boundedTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_PROBE_TIMEOUT_MS)
    : DEFAULT_PROBE_TIMEOUT_MS;
}

function waitForProcess(child: OpenCodePluginProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new OpenCodeProtocolError('OpenCode plugin probe timed out.')), timeoutMs);
    child.once('close', (code) => { clearTimeout(timer); resolve(code); });
    child.once('error', () => { clearTimeout(timer); reject(new OpenCodeProtocolError()); });
  });
}

function stopOpenCodeProcess(
  child: OpenCodePluginProcess,
  options: CreateOpenCodeMapAgentAdapterOptions,
): Promise<void> {
  return options.stopProcess
    ? options.stopProcess(child)
    : stopMapDesignProcessTree(child, options.processStopTimeoutMs ?? DEFAULT_PROCESS_STOP_TIMEOUT_MS);
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean },
): OpenCodePluginProcess {
  return spawnChild(command, args, {
    ...options,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function javascriptLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}

class OpenCodeProtocolError extends Error {
  constructor(message = 'Invalid OpenCode plugin protocol.') {
    super(message);
    this.name = 'OpenCodeProtocolError';
  }
}
