import { Buffer } from 'node:buffer';
import { spawnAgentProcess } from '../../runtimes/spawn.js';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SafeToolSummarySchema,
  type SafeToolSummary,
} from '@mapseekai/contracts';
import type { MapToolName } from '@mapseekai/map-design-contracts';

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
import { MAP_RUN_MAX_FRAME_BYTES } from './types.js';
import { CommandRpcPeer } from './command-rpc-peer.js';

export interface PiSdkProcess {
  pid?: number | undefined;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  stdin?: NodeJS.WritableStream | null;
  once(event: 'close', listener: (code: number | null) => void): this;
  once(event: 'error', listener: () => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type PiSdkSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean },
) => PiSdkProcess;

export type CreatePiMapAgentAdapterOptions = {
  definition: { id: string; bin: string; inheritedEnvKeys?: readonly string[] };
  toolDefinitions: () => readonly NativeMapToolDefinition[];
  spawn?: PiSdkSpawn;
  environment?: () => NodeJS.ProcessEnv | null;
  environmentKeys?: () => readonly string[];
  extensionRoot?: string;
  maxFrameBytes?: number;
  requestTimeoutMs?: number;
  probeTimeoutMs?: number;
  probeCwd?: string;
  processStopTimeoutMs?: number;
  stopProcess?: (child: PiSdkProcess) => Promise<void>;
  stageExtension?: PiStageExtension;
  sessionBroker?: MapAgentSessionBroker;
};

export type PiExtensionLease = {
  path: string;
  dispose(): Promise<void>;
};

export type PiStageExtension = (
  source: string,
  root?: string,
) => Promise<PiExtensionLease>;

const DEFAULT_MAX_FRAME_BYTES = MAP_RUN_MAX_FRAME_BYTES;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PROCESS_STOP_TIMEOUT_MS = 250;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_EVENT_TEXT_LENGTH = 65_536;
const PROBE_FLAG = 'map-design-native-tools-probe';
const FAILED_CONNECTION = {
  code: 'RUN_FAILED',
  message: 'The Pi RPC connection ended unexpectedly.',
} as const;
const TOOL_LOOP_DETECTED = {
  code: 'TOOL_LOOP_DETECTED',
  message: 'Repeated invalid map tool calls were stopped.',
} as const;

type PiRunPhase = 'starting' | 'prompt_accepted' | 'terminal';

/**
 * Pi's supported process-isolated extension surface. Every run gets a private
 * extension path passed with `--extension`; automatic global/project extension
 * discovery is disabled. The extension calls the daemon's authenticated
 * callback route, whose trusted boundary dispatches into SdkMapToolRuntime.
 */
export function createPiMapAgentAdapter(
  options: CreatePiMapAgentAdapterOptions,
): MapAgentAdapter {
  const sessionBroker = options.sessionBroker ?? createMemoryMapAgentSessionBroker();
  return {
    id: options.definition.id,
    capabilities: { nativeMapTools: true, publicReasoningSummary: false },
    probeNativeMapTools: () => probePiNativeMapTools(options),
    async startMapRun(input, tools, onEvent) {
      const baseEnvironment = options.environment ? options.environment() : process.env;
      if (!baseEnvironment) throw new Error('Pi environment unavailable.');
      const environment = sanitizeMapAgentLaunchEnvironment(baseEnvironment, [
        ...(options.definition.inheritedEnvKeys ?? []),
        ...(options.environmentKeys?.() ?? []),
      ]);
      let child: PiSdkProcess | null = null;
      let peer: PiRpcPeer | null = null;
      let extension: PiExtensionLease | null = null;
      let stagingPromise: Promise<PiExtensionLease> | null = null;
      let extensionDisposed = false;
      let processExited = false;
      let terminal = false;
      let cancelRequested = false;
      let cancellation: Promise<void> | null = null;
      let stoppingPromise: Promise<void> | null = null;
      let phase: PiRunPhase = 'starting';
      let observedSessionPath: string | null = null;
      let lastAgentFailed = false;
      let resolveDone!: (result: MapRunTerminal) => void;
      const done = new Promise<MapRunTerminal>((resolve) => { resolveDone = resolve; });
      const toolCalls = new Map<string, { name: MapToolName; input: unknown }>();
      const completedToolCalls = new Set<string>();
      const toolLoopGuard = createMapToolLoopGuard();
      const sessionScope = mapAgentSessionScope(input, options.definition.id);

      const stopProcess = (): Promise<void> => {
        if (stoppingPromise) return stoppingPromise;
        if (!child || processExited) return Promise.resolve();
        stoppingPromise = stopPiProcess(child, options);
        return stoppingPromise;
      };
      const disposeExtension = async (): Promise<void> => {
        if (!extension && stagingPromise) {
          try { extension = await stagingPromise; } catch { return; }
        }
        if (!extension || extensionDisposed) return;
        extensionDisposed = true;
        await extension.dispose();
      };
      const cleanup = async (): Promise<void> => {
        await Promise.all([stopProcess(), disposeExtension()]);
      };
      const discardProcessAttempt = async (): Promise<void> => {
        const discardedChild = child;
        const discardedPeer = peer;
        child = null;
        peer = null;
        processExited = false;
        stoppingPromise = null;
        phase = 'starting';
        discardedPeer?.close();
        if (discardedChild) await stopPiProcess(discardedChild, options);
      };
      const closePeer = (): void => { peer?.close(); };
      const finish = (result: MapRunTerminal): void => {
        if (terminal) return;
        terminal = true;
        phase = 'terminal';
        input.signal.removeEventListener('abort', onInputAbort);
        if (result.status === 'succeeded' && observedSessionPath) {
          sessionBroker.save(sessionScope, observedSessionPath);
        } else if (result.status !== 'succeeded') {
          sessionBroker.delete(sessionScope);
        }
        onEvent({ kind: 'run_finished', status: result.status });
        resolveDone(result);
        peer?.close();
        void cleanup();
      };
      const fail = (): void => {
        if (terminal || cancelRequested) return;
        finish({ status: 'failed', error: FAILED_CONNECTION });
      };
      const cancel = async (): Promise<void> => {
        if (terminal) return cleanup();
        if (cancellation) return cancellation;
        cancelRequested = true;
        cancellation = (async () => {
          try {
            if (peer && !peer.closed) {
              await peer.request('abort', {}, boundedTimeout(
                options.requestTimeoutMs,
                DEFAULT_REQUEST_TIMEOUT_MS,
              ));
            }
          } catch {
            // Cancellation remains authoritative if Pi exits mid-abort.
          }
          finish({ status: 'canceled' });
          await cleanup();
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

      const onFrame = (frame: Record<string, unknown>): void => {
        if (terminal) return;
        const type = nonEmptyString(frame.type);
        if (!type) throw new PiProtocolError();
        if (phase !== 'prompt_accepted') {
          if (isRunScopedFrame(type)) {
            throw new PiProtocolError('Pi emitted a Run frame before prompt acceptance.');
          }
          return;
        }
        if (type === 'message_update') {
          handleMessageUpdate(frame, onEvent);
          return;
        }
        if (type === 'tool_execution_start') {
          const toolCallId = safeIdentifier(frame.toolCallId);
          const toolName = safeIdentifier(frame.toolName) as MapToolName | null;
          if (
            !toolCallId
            || !toolName
            || !record(frame.args)
            || !tools.some((tool) => tool.name === toolName)
            || toolCalls.has(toolCallId)
            || completedToolCalls.has(toolCallId)
          ) {
            throw new PiProtocolError('Pi emitted an invalid tool execution start.');
          }
          toolCalls.set(toolCallId, { name: toolName, input: frame.args });
          onEvent({ kind: 'tool_use', id: toolCallId, name: toolName, summary: {} });
          return;
        }
        if (type === 'tool_execution_update') {
          const toolCallId = safeIdentifier(frame.toolCallId);
          const active = toolCallId ? toolCalls.get(toolCallId) : undefined;
          if (!active || frame.toolName !== active.name) throw new PiProtocolError();
          return;
        }
        if (type === 'tool_execution_end') {
          handleToolExecutionEnd(frame);
          return;
        }
        if (type === 'turn_end') {
          if (!record(frame.message) || !Array.isArray(frame.toolResults)) throw new PiProtocolError();
          return;
        }
        if (type === 'agent_end') {
          if (
            !Array.isArray(frame.messages)
            || typeof frame.willRetry !== 'boolean'
            || toolCalls.size > 0
          ) throw new PiProtocolError();
          lastAgentFailed = frame.willRetry === false && agentMessagesFailed(frame.messages);
          return;
        }
        if (type === 'auto_retry_end') {
          if (typeof frame.success !== 'boolean') throw new PiProtocolError();
          if (frame.success === false) lastAgentFailed = true;
          return;
        }
        if (type === 'agent_settled') {
          if (toolCalls.size > 0) throw new PiProtocolError();
          if (cancelRequested) return;
          if (lastAgentFailed) finish({ status: 'failed', error: FAILED_CONNECTION });
          else finish({ status: 'succeeded' });
          return;
        }
        if (type === 'extension_error') {
          finish({ status: 'failed', error: FAILED_CONNECTION });
        }
      };

      const handleToolExecutionEnd = (frame: Record<string, unknown>): void => {
        const toolCallId = safeIdentifier(frame.toolCallId);
        const active = toolCallId ? toolCalls.get(toolCallId) : undefined;
        if (
          !toolCallId
          || !active
          || frame.toolName !== active.name
          || typeof frame.isError !== 'boolean'
          || !record(frame.result)
        ) {
          throw new PiProtocolError('Pi emitted an invalid tool execution result.');
        }
        toolCalls.delete(toolCallId);
        completedToolCalls.add(toolCallId);
        const result = frame.result as Record<string, unknown>;
        const summary = resultSummary(result, frame.isError);
        const status = frame.isError
          ? isCanceledSummary(summary) ? 'canceled' : 'failed'
          : 'succeeded';
        onEvent({ kind: 'tool_result', toolUseId: toolCallId, status, summary });
        if (!frame.isError) {
          toolLoopGuard.success(active.name);
          return;
        }
        const signature = createMapToolCallSignature(active.name, active.input);
        const error = summaryError(summary);
        const verdict = !isCanceledSummary(summary)
          ? toolLoopGuard.failure(
              active.name,
              signature,
              createMapToolFailureClassSignature(active.name, error) ?? undefined,
              error.retryable !== true,
            )
          : null;
        if (verdict?.action === 'halt') {
          try { peer?.send({ id: peer.nextId(), type: 'abort' }); } catch { /* finishing closes Pi */ }
          finish({ status: 'failed', error: TOOL_LOOP_DETECTED });
        }
      };

      const spawnAttempt = async (resumePath: string | null): Promise<void> => {
        if (!extension) throw new PiProtocolError('Pi extension is unavailable.');
        const args = [
          '--mode', 'rpc',
          '--no-extensions',
          '--no-builtin-tools',
          '--extension', extension.path,
          ...piSelectionArgs(input),
        ];
        const spawned = (options.spawn ?? defaultSpawn)(options.definition.bin, args, {
          cwd: input.cwd,
          env: environment,
          detached: process.platform !== 'win32',
        });
        child = spawned;
        processExited = false;
        stoppingPromise = null;
        if (terminal || cancelRequested || input.signal.aborted) {
          await cleanup();
          return;
        }
        if (!child.stdin || !child.stdout) throw new PiProtocolError('Pi stdio is unavailable.');
        child.stderr?.resume();
        const attemptPeer = new PiRpcPeer({
          input: child.stdout,
          output: child.stdin,
          maxFrameBytes: options.maxFrameBytes ?? MAP_RUN_MAX_FRAME_BYTES,
          onFrame,
          onError: fail,
        });
        peer = attemptPeer;
        spawned.once('close', () => {
          if (child !== spawned) return;
          processExited = true;
          fail();
        });
        spawned.once('error', () => {
          if (child === spawned) fail();
        });
        const timeout = boundedTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
        let resumedSession = false;
        if (resumePath) {
          try {
            const resumed = record(await attemptPeer.request('switch_session', { sessionPath: resumePath }, timeout));
            if (resumed?.cancelled !== false) throw new PiResumeRejectedError();
            resumedSession = true;
          } catch {
            throw new PiResumeRejectedError();
          }
        }
        let state: Record<string, unknown> | null;
        try {
          state = record(await attemptPeer.request('get_state', {}, timeout));
        } catch (error) {
          if (resumePath) throw new PiResumeRejectedError();
          throw error;
        }
        const sessionPath = safeSessionPath(state?.sessionFile);
        if (resumePath && sessionPath !== resumePath) throw new PiResumeRejectedError();
        observedSessionPath = sessionPath;
        await attemptPeer.request('prompt', {
          message: resumedSession ? input.resumePrompt : input.prompt,
          ...(input.images?.length ? {
            images: input.images.map((image) => ({ type: 'image', ...image })),
          } : {}),
        }, timeout, () => {
          phase = 'prompt_accepted';
          onEvent({ kind: 'status', label: 'analyzing' });
        });
      };

      try {
        const stage = options.stageExtension ?? stageExtension;
        stagingPromise = stage(
          buildPiExtensionSource(tools, {
            agentId: options.definition.id,
            callbackUrl: input.toolCallback.url,
            callbackToken: input.toolCallback.token,
            conversationId: input.conversationId,
            projectId: input.projectId,
            runId: input.runId,
          }),
          options.extensionRoot,
        );
        extension = await stagingPromise;
        if (terminal || cancelRequested || input.signal.aborted) {
          await cleanup();
          return handle;
        }
        const resumePath = sessionBroker.load(sessionScope);
        try {
          await spawnAttempt(resumePath);
        } catch (error) {
          if (!resumePath || !(error instanceof PiResumeRejectedError)) throw error;
          sessionBroker.delete(sessionScope);
          observedSessionPath = null;
          await discardProcessAttempt();
          if (terminal || cancelRequested || input.signal.aborted) return handle;
          await spawnAttempt(null);
        }
        return handle;
      } catch {
        if (terminal) return handle;
        input.signal.removeEventListener('abort', onInputAbort);
        sessionBroker.delete(sessionScope);
        closePeer();
        await cleanup();
        throw new Error('Pi native extension protocol unavailable.');
      }
    },
  };
}

export async function probePiNativeMapTools(
  options: CreatePiMapAgentAdapterOptions,
): Promise<boolean> {
  const baseEnvironment = options.environment ? options.environment() : process.env;
  if (!baseEnvironment) return false;
  const environment = sanitizeMapAgentLaunchEnvironment(baseEnvironment, [
    ...(options.definition.inheritedEnvKeys ?? []),
    ...(options.environmentKeys?.() ?? []),
  ]);
  let extension: PiExtensionLease | null = null;
  let child: PiSdkProcess | null = null;
  let processExited = false;
  try {
    extension = await (options.stageExtension ?? stageExtension)(buildPiExtensionSource([{
      name: 'map_design_native_tools_probe' as MapToolName,
      description: 'Verify Pi custom tool extension support.',
      inputSchema: { type: 'object', additionalProperties: false },
    }], {
      agentId: options.definition.id,
      callbackUrl: 'http://127.0.0.1/unused',
      callbackToken: 'unused',
      conversationId: 'probe',
      projectId: 'probe',
      runId: 'probe',
      probeFlag: PROBE_FLAG,
    }), options.extensionRoot);
    child = (options.spawn ?? defaultSpawn)(options.definition.bin, [
      '--no-extensions', '--extension', extension.path, '--help',
    ], {
      cwd: options.probeCwd ?? process.cwd(),
      env: environment,
      detached: process.platform !== 'win32',
    });
    if (!child.stdout) return false;
    child.stderr?.resume();
    const output: Buffer[] = [];
    let outputBytes = 0;
    child.stdout.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes <= DEFAULT_MAX_FRAME_BYTES) output.push(bytes);
    });
    const timeout = boundedTimeout(options.probeTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PiProtocolError('Pi probe timed out.')), timeout);
      child?.once('close', (value) => { processExited = true; clearTimeout(timer); resolve(value); });
      child?.once('error', () => { clearTimeout(timer); reject(new PiProtocolError()); });
    });
    return code === 0
      && outputBytes <= DEFAULT_MAX_FRAME_BYTES
      && Buffer.concat(output).toString('utf8').includes(`--${PROBE_FLAG}`);
  } catch {
    return false;
  } finally {
    if (child && !processExited) await stopPiProcess(child, options);
    await extension?.dispose();
  }
}

type PiRpcPeerOptions = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  maxFrameBytes?: number;
  onFrame?: (frame: Record<string, unknown>) => void;
  onError?: () => void;
};

class PiProtocolError extends Error {
  constructor(message = 'Invalid Pi RPC frame.') {
    super(message);
    this.name = 'PiProtocolError';
  }
}

class PiResumeRejectedError extends Error {}

class PiRpcPeer extends CommandRpcPeer {
  constructor(options: PiRpcPeerOptions) {
    super({
      ...options,
      protocolName: 'Pi RPC',
      defaultMaxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
      createError: (message) => new PiProtocolError(message),
      requestId: (_type, sequence) => `pi-${sequence}`,
    });
  }
}

function handleMessageUpdate(
  frame: Record<string, unknown>,
  onEvent: (event: MapAgentEvent) => void,
): void {
  const update = record(frame.assistantMessageEvent);
  const type = nonEmptyString(update?.type);
  if (!update || !type) throw new PiProtocolError();
  if (type === 'thinking_delta') {
    if (!boundedText(update.delta)) throw new PiProtocolError();
    // Pi exposes model-private thinking here, while this adapter explicitly
    // declares that it has no verified public-reasoning-summary capability.
    // Validate the frame but never cross the public MapAgentEvent boundary.
  } else if (type === 'text_delta') {
    if (!boundedText(update.delta)) throw new PiProtocolError();
    onEvent({ kind: 'text', text: update.delta });
  } else if (type === 'error') {
    throw new PiProtocolError();
  }
}

function resultSummary(
  result: Record<string, unknown>,
  isError: boolean,
): SafeToolSummary {
  const details = record(result.details);
  const parsed = SafeToolSummarySchema.safeParse(details?.summary);
  if (parsed.success) return parsed.data;
  if (!isError) throw new PiProtocolError('Pi omitted the MapDesign tool summary.');
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    const candidate = record(item);
    if (candidate?.type !== 'text' || typeof candidate.text !== 'string') continue;
    try {
      const error = record(JSON.parse(candidate.text));
      if (!error || typeof error.code !== 'string') continue;
      const summary = SafeToolSummarySchema.safeParse({
        ...(record(error.details) ?? {}),
        code: error.code,
        ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
      });
      if (summary.success) return summary.data;
    } catch {
      // Pi may prefix an Error name. A safe generic summary is emitted below.
    }
  }
  return { code: 'SDK_TOOL_FAILED', retryable: false };
}

function summaryError(summary: SafeToolSummary): {
  code: string;
  message: string;
  retryable: boolean;
  details?: SafeToolSummary;
} {
  return {
    code: typeof summary.code === 'string' ? summary.code : 'SDK_TOOL_FAILED',
    message: 'The map tool call failed.',
    retryable: summary.retryable === true,
    details: summary,
  };
}

function isCanceledSummary(summary: SafeToolSummary): boolean {
  return summary.code === 'CANCELED' || summary.code === 'CANCELLED';
}

function piSelectionArgs(input: MapRunInput): string[] {
  const args: string[] = [];
  if (input.model && input.model !== 'default') args.push('--model', input.model);
  if (input.reasoning && input.reasoning !== 'default') args.push('--thinking', input.reasoning);
  return args;
}

function isRunScopedFrame(type: string): boolean {
  return type === 'agent_start'
    || type === 'agent_end'
    || type === 'agent_settled'
    || type === 'turn_start'
    || type === 'turn_end'
    || type === 'message_start'
    || type === 'message_update'
    || type === 'message_end'
    || type === 'tool_execution_start'
    || type === 'tool_execution_update'
    || type === 'tool_execution_end'
    || type === 'compaction_start'
    || type === 'compaction_end'
    || type === 'auto_retry_start'
    || type === 'auto_retry_end'
    || type === 'summarization_retry_scheduled'
    || type === 'extension_error';
}

function agentMessagesFailed(messages: unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = record(messages[index]);
    if (message?.role === 'assistant') return message.stopReason === 'error';
  }
  return false;
}

async function stageExtension(
  source: string,
  root = tmpdir(),
): Promise<PiExtensionLease> {
  const directory = await mkdtemp(join(root, 'map-design-pi-'));
  const path = join(directory, 'map-design-extension.mjs');
  try {
    await writeFile(path, source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rmdir(directory).catch(() => undefined);
    throw error;
  }
  let disposed = false;
  return {
    path,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await unlink(path).catch(() => undefined);
      await rmdir(directory).catch(() => undefined);
    },
  };
}

function buildPiExtensionSource(
  tools: readonly NativeMapToolDefinition[],
  context: {
    agentId: string;
    callbackUrl: string;
    callbackToken: string;
    conversationId: string;
    projectId: string;
    runId: string;
    probeFlag?: string;
  },
): string {
  const definitions = tools.map((tool) => ({
    name: tool.name,
    label: 'label' in tool && typeof tool.label === 'string' ? tool.label : tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const serialized = javascriptLiteral({ context, definitions });
  return `import { Type } from 'typebox';

const MANIFEST = ${serialized};
const seenToolCalls = new Set();

export default function mapDesignPiExtension(pi) {
  for (const definition of MANIFEST.definitions) {
    pi.registerTool({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: Type.Unsafe(definition.inputSchema),
      async execute(toolCallId, input, signal) {
        if (typeof toolCallId !== 'string' || toolCallId.length === 0 || seenToolCalls.has(toolCallId)) {
          throw new Error('Duplicate Pi tool call identifier.');
        }
        if (seenToolCalls.size >= 1024) throw new Error('Pi tool call limit reached.');
        seenToolCalls.add(toolCallId);
        const response = await fetch(\`${'${MANIFEST.context.callbackUrl}'}/${'${encodeURIComponent(definition.name)}'}\`, {
          method: 'POST',
          headers: {
            authorization: \`Bearer ${'${MANIFEST.context.callbackToken}'}\`,
            'content-type': 'application/json',
            '${RUN_TOOL_CALLBACK_RUN_HEADER}': MANIFEST.context.runId,
            '${RUN_TOOL_CALLBACK_PROJECT_HEADER}': MANIFEST.context.projectId,
            '${RUN_TOOL_CALLBACK_CONVERSATION_HEADER}': MANIFEST.context.conversationId,
            '${RUN_TOOL_CALLBACK_AGENT_HEADER}': MANIFEST.context.agentId,
            '${RUN_TOOL_CALLBACK_TOOL_USE_HEADER}': toolCallId,
          },
          body: JSON.stringify(input),
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) throw new Error('The MapDesign tool callback failed.');
        let result;
        try { result = await response.json(); } catch { throw new Error('The MapDesign tool callback returned invalid JSON.'); }
        if (!result || typeof result !== 'object' || result.toolUseId !== toolCallId || typeof result.ok !== 'boolean') {
          throw new Error('The MapDesign tool callback returned an invalid result.');
        }
        if (result.ok) {
          if (!result.summary || typeof result.summary !== 'object' || Array.isArray(result.summary)) {
            throw new Error('The MapDesign tool callback returned an invalid summary.');
          }
          return {
            content: [{ type: 'text', text: typeof result.modelContent === 'string' ? result.modelContent : JSON.stringify(result.summary) }],
            details: { summary: result.summary },
          };
        }
        const error = result.error;
        if (!error || typeof error !== 'object' || typeof error.code !== 'string' || typeof error.message !== 'string') {
          throw new Error('The MapDesign tool callback returned an invalid error.');
        }
        throw new Error(JSON.stringify({
          code: error.code,
          message: error.message,
          retryable: error.retryable === true,
          ...(error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? { details: error.details } : {}),
        }));
      },
    });
  }
  if (MANIFEST.context.probeFlag) {
    pi.registerFlag(MANIFEST.context.probeFlag, {
      type: 'boolean',
      description: 'MapDesign native tool probe',
      default: false,
    });
  }
}
`;
}

function javascriptLiteral(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Pi extension manifest is not serializable.');
  return encoded.replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
}

function stopPiProcess(
  child: PiSdkProcess,
  options: CreatePiMapAgentAdapterOptions,
): Promise<void> {
  if (options.stopProcess) return options.stopProcess(child).catch(() => undefined);
  return stopMapDesignProcessTree(
    child,
    boundedTimeout(options.processStopTimeoutMs, DEFAULT_PROCESS_STOP_TIMEOUT_MS),
  ).catch(() => undefined);
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? Math.min(value!, MAX_REQUEST_TIMEOUT_MS)
    : fallback;
}


function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_EVENT_TEXT_LENGTH;
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && !/[\r\n\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function safeSessionPath(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4_096
    && !/[\r\n\u0000]/u.test(value)
    ? value
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const defaultSpawn: PiSdkSpawn = spawnAgentProcess;
