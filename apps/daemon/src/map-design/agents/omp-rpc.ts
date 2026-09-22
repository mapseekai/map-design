import { spawnAgentProcess } from '../../runtimes/spawn.js';

import type { SafeToolSummary } from '@mapseekai/contracts';
import type { MapToolName } from '@mapseekai/map-design-contracts';

import { stopMapDesignProcessTree } from '../application/run-service.js';
import {
  createMapToolCallSignature,
  createMapToolFailureClassSignature,
  createMapToolLoopGuard,
} from './map-tool-loop-guard.js';
import type { SdkMapToolRuntime } from './sdk-tool-runtime.js';
import { sanitizeMapAgentLaunchEnvironment } from './launch-environment.js';
import {
  createMemoryMapAgentSessionBroker,
  mapAgentSessionScope,
  type MapAgentSessionBroker,
} from './session-broker.js';
import type {
  MapAgentAdapter,
  MapAgentEvent,
  MapRunHandle,
  MapRunInput,
  MapRunTerminal,
} from './types.js';
import { MAP_RUN_MAX_FRAME_BYTES } from './types.js';
import type { NativeMapToolDefinition } from '../tools/tool-context.js';
import { CommandRpcPeer } from './command-rpc-peer.js';

export interface OhMyPiRpcProcess {
  pid?: number | undefined;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  stdin?: NodeJS.WritableStream | null;
  once(event: 'close', listener: (code: number | null) => void): this;
  once(event: 'error', listener: () => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type OhMyPiRpcSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean },
) => OhMyPiRpcProcess;

export type CreateOhMyPiMapAgentAdapterOptions = {
  definition: { id: string; bin: string; inheritedEnvKeys?: readonly string[] };
  toolDefinitions: () => readonly NativeMapToolDefinition[];
  spawn?: OhMyPiRpcSpawn;
  environment?: () => NodeJS.ProcessEnv | null;
  environmentKeys?: () => readonly string[];
  maxFrameBytes?: number;
  requestTimeoutMs?: number;
  probeTimeoutMs?: number;
  probeCwd?: string;
  processStopTimeoutMs?: number;
  stopProcess?: (child: OhMyPiRpcProcess) => Promise<void>;
  sessionBroker?: MapAgentSessionBroker;
};

const DEFAULT_MAX_FRAME_BYTES = MAP_RUN_MAX_FRAME_BYTES;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PROCESS_STOP_TIMEOUT_MS = 250;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_EVENT_TEXT_LENGTH = 65_536;
const TOOL_LOOP_DETECTED = {
  code: 'TOOL_LOOP_DETECTED',
  message: 'Repeated invalid map tool calls were stopped.',
} as const;
const FAILED_CONNECTION = {
  code: 'RUN_FAILED',
  message: 'The Oh My Pi RPC connection ended unexpectedly.',
} as const;

type OmpRunPhase = 'awaiting_ready' | 'host_tools_registered' | 'prompt_accepted' | 'terminal';

/**
 * OMP's RPC transport has native host tools. Map calls intentionally cross the
 * SDK runtime boundary rather than going through MCP, a CLI, or child-process
 * callback credentials.
 */
export function createOhMyPiMapAgentAdapter(
  options: CreateOhMyPiMapAgentAdapterOptions,
): MapAgentAdapter {
  const sessionBroker = options.sessionBroker ?? createMemoryMapAgentSessionBroker();
  return {
    id: options.definition.id,
    capabilities: { nativeMapTools: true, publicReasoningSummary: true },
    probeNativeMapTools: () => probeOhMyPiNativeMapTools(options),
    async startMapRun(input, tools, onEvent) {
      const baseEnvironment = options.environment ? options.environment() : process.env;
      if (!baseEnvironment) throw new Error('Oh My Pi environment unavailable.');
      const environment = sanitizeMapAgentLaunchEnvironment(baseEnvironment, [
        ...(options.definition.inheritedEnvKeys ?? []),
        ...(options.environmentKeys?.() ?? []),
      ]);
      const controller = new AbortController();
      let child: OhMyPiRpcProcess | null = null;
      let peer: OmpRpcPeer | null = null;
      let processExited = false;
      let terminal = false;
      let cancelRequested = false;
      let cancellation: Promise<void> | null = null;
      let stopping: Promise<void> | null = null;
      let resolveDone!: (terminal: MapRunTerminal) => void;
      const done = new Promise<MapRunTerminal>((resolve) => { resolveDone = resolve; });
      const seenHostRequestIds = new Set<string>();
      const seenToolCallIds = new Set<string>();
      const inFlightCalls = new Map<string, AbortController>();
      const toolLoopGuard = createMapToolLoopGuard();
      const sessionScope = mapAgentSessionScope(input, options.definition.id);
      let observedSessionPath: string | null = null;
      let verifiedResumePath: string | null = null;
      let phase: OmpRunPhase = 'awaiting_ready';

      const stopProcess = (): Promise<void> => {
        if (stopping) return stopping;
        if (!child || processExited) return Promise.resolve();
        stopping = stopOhMyPiProcess(child, options);
        return stopping;
      };
      const discardAttempt = async (): Promise<void> => {
        const discardedChild = child;
        const discardedPeer = peer;
        child = null;
        peer = null;
        processExited = false;
        stopping = null;
        verifiedResumePath = null;
        phase = 'awaiting_ready';
        discardedPeer?.close();
        if (discardedChild) await stopOhMyPiProcess(discardedChild, options);
      };
      const closePeer = (): void => { peer?.close(); };
      const finish = (result: MapRunTerminal): void => {
        if (terminal) return;
        terminal = true;
        phase = 'terminal';
        input.signal.removeEventListener('abort', onInputAbort);
        if (!controller.signal.aborted) controller.abort();
        if (result.status === 'succeeded' && observedSessionPath) {
          sessionBroker.save(sessionScope, observedSessionPath);
        } else if (result.status !== 'succeeded') {
          sessionBroker.delete(sessionScope);
        }
        onEvent({ kind: 'run_finished', status: result.status });
        resolveDone(result);
        peer?.close();
        void stopProcess();
      };
      const fail = (): void => {
        if (terminal || cancelRequested) return;
        finish({ status: 'failed', error: FAILED_CONNECTION });
      };
      const onInputAbort = (): void => { void cancel(); };
      const cancel = async (): Promise<void> => {
        if (terminal) return;
        if (cancellation) return cancellation;
        cancelRequested = true;
        if (!controller.signal.aborted) controller.abort();
        cancellation = (async () => {
          try {
            if (peer && !peer.closed) await peer.request('abort', {});
          } catch {
            // The result remains canceled even if the peer dies while aborting.
          }
          finish({ status: 'canceled' });
        })();
        return cancellation;
      };
      const handle: MapRunHandle = { done, cancel };

      if (input.signal.aborted) {
        finish({ status: 'canceled' });
        return handle;
      }
      input.signal.addEventListener('abort', onInputAbort, { once: true });

      const onFrame = (frame: Record<string, unknown>): void => {
        if (terminal) return;
        const type = nonEmptyString(frame.type);
        if (!type) throw new OmpProtocolError();
        if (phase !== 'prompt_accepted') {
          if (isRunScopedFrame(type)) {
            throw new OmpProtocolError('Oh My Pi emitted a Run frame before prompt acceptance.');
          }
          // OMP may announce UI/command metadata while its RPC session starts.
          // Those frames do not belong to a MapDesign Run and cannot advance it.
          return;
        }
        if (type === 'host_tool_call') {
          void handleHostToolCall(frame).catch(fail);
          return;
        }
        if (type === 'host_tool_cancel') {
          const targetId = safeIdentifier(frame.targetId);
          if (!targetId) throw new OmpProtocolError();
          inFlightCalls.get(targetId)?.abort();
          return;
        }
        if (type === 'message_update') {
          const update = record(frame.assistantMessageEvent);
          const updateType = nonEmptyString(update?.type);
          const delta = update?.delta;
          if (!updateType) throw new OmpProtocolError();
          if (updateType === 'thinking_delta' || updateType === 'thinking') {
            if (!boundedText(delta)) throw new OmpProtocolError();
            onEvent({ kind: 'thinking', text: delta });
          } else if (updateType === 'text_delta' || updateType === 'text') {
            if (!boundedText(delta)) throw new OmpProtocolError();
            onEvent({ kind: 'text', text: delta });
          }
          return;
        }
        if (type === 'agent_end') {
          if (frame.isTerminal === false || frame.willContinue === true) return;
          if (frame.willContinue !== undefined && typeof frame.willContinue !== 'boolean') {
            throw new OmpProtocolError();
          }
          if (!Array.isArray(frame.messages)) throw new OmpProtocolError();
          if (cancelRequested) return;
          const lastAssistant = frame.messages.map(record).reverse().find((message) => message?.role === 'assistant');
          if (lastAssistant?.stopReason === 'error') {
            // RPC completion does not imply that the upstream model succeeded.
            // Never expose its raw error, which may contain credentials or URLs.
            const denied = typeof lastAssistant.errorMessage === 'string'
              && /^(?:401|403)\b/u.test(lastAssistant.errorMessage);
            finish({ status: 'failed', error: denied
              ? { code: 'API_AUTH_FAILED', message: 'The model API rejected authentication. Check the saved API key and endpoint.' }
              : { code: 'API_REQUEST_FAILED', message: 'The model API request failed. Check the endpoint, response format and model configuration.' } });
            return;
          }
          finish({ status: 'succeeded' });
          return;
        }
        if (type === 'session_info_update') {
          const sessionPath = safeSessionPath(frame.sessionFile ?? frame.sessionPath);
          if (!sessionPath) throw new OmpProtocolError();
          if (verifiedResumePath && sessionPath !== verifiedResumePath) {
            throw new OmpProtocolError('Oh My Pi changed the resumed session identity.');
          }
          observedSessionPath = sessionPath;
          return;
        }
        if (type === 'prompt_result') {
          if (frame.agentInvoked === false) finish({ status: 'succeeded' });
          else if (typeof frame.agentInvoked !== 'boolean') throw new OmpProtocolError();
          return;
        }
        if (type === 'extension_error') {
          finish({ status: 'failed', error: FAILED_CONNECTION });
          return;
        }
        // The protocol has several forward-compatible UI/subagent/status frame
        // families. They do not carry public MapDesign events and are ignored.
      };

      const handleHostToolCall = async (frame: Record<string, unknown>): Promise<void> => {
        const hostId = safeIdentifier(frame.id);
        const toolCallId = safeIdentifier(frame.toolCallId);
        const toolName = safeIdentifier(frame.toolName) as MapToolName | null;
        if (!hostId || !toolCallId || !toolName || !record(frame.arguments)) {
          if (hostId) sendHostError(hostId, 'INVALID_INPUT', 'The map tool input is invalid.');
          else throw new OmpProtocolError();
          return;
        }
        if (seenHostRequestIds.has(hostId)) throw new OmpProtocolError('Duplicate Oh My Pi host tool request id.');
        if (seenToolCallIds.has(toolCallId) || !tools.some((tool) => tool.name === toolName)) {
          seenHostRequestIds.add(hostId);
          sendHostError(hostId, 'UNKNOWN_TOOL', 'The map tool call is not registered.');
          return;
        }
        seenHostRequestIds.add(hostId);
        seenToolCallIds.add(toolCallId);
        onEvent({ kind: 'tool_use', id: toolCallId, name: toolName, summary: {} });
        const callController = new AbortController();
        inFlightCalls.set(hostId, callController);
        const abort = (): void => callController.abort();
        controller.signal.addEventListener('abort', abort, { once: true });
        let result: Awaited<ReturnType<SdkMapToolRuntime['execute']>>;
        try {
          result = await input.toolRuntime.execute({
            runId: input.runId,
            projectId: input.projectId,
            conversationId: input.conversationId,
            agentId: options.definition.id,
            toolUseId: toolCallId,
            name: toolName,
            input: frame.arguments,
            signal: callController.signal,
          });
        } catch {
          result = { ok: false, toolUseId: toolCallId, error: { code: 'SDK_TOOL_FAILED', message: 'The map tool call failed safely.', retryable: false } };
        } finally {
          controller.signal.removeEventListener('abort', abort);
          inFlightCalls.delete(hostId);
        }
        if (terminal) return;
        if (result.toolUseId !== toolCallId) {
          sendHostError(hostId, 'TOOL_PROTOCOL_ERROR', 'The map tool returned an invalid result.');
          return;
        }
        if (result.ok) {
          toolLoopGuard.success(toolName);
          onEvent({ kind: 'tool_result', toolUseId: toolCallId, status: 'succeeded', summary: result.summary });
          sendHostResult(hostId, result.modelContent ?? safeJson(result.summary));
          return;
        }
        const summary: SafeToolSummary = { ...(result.error.details ?? {}), code: result.error.code, retryable: result.error.retryable };
        const loopSignature = createMapToolCallSignature(toolName, frame.arguments);
        const verdict = result.error.code !== 'CANCELED' && result.error.code !== 'CANCELLED'
          ? toolLoopGuard.failure(toolName, loopSignature, createMapToolFailureClassSignature(toolName, result.error) ?? undefined, result.error.retryable !== true)
          : null;
        if (verdict?.action === 'warn') {
          summary.loopWarning = true;
          summary.failureCount = verdict.count;
        } else if (verdict?.action === 'halt') {
          summary.loopHalted = true;
          summary.failureCount = verdict.count;
        }
        onEvent({ kind: 'tool_result', toolUseId: toolCallId, status: result.error.code === 'CANCELED' || result.error.code === 'CANCELLED' ? 'canceled' : 'failed', summary });
        sendHostError(hostId, result.error.code, result.error.message, result.error.details);
        if (verdict?.action === 'halt') {
          peer?.send({ id: peer.nextId('abort'), type: 'abort' });
          finish({ status: 'failed', error: TOOL_LOOP_DETECTED });
        }
      };

      const sendHostResult = (hostId: string, text: string): void => {
        peer?.send({ type: 'host_tool_result', id: hostId, result: { content: [{ type: 'text', text }] } });
      };
      const sendHostError = (hostId: string, code: string, message: string, details?: SafeToolSummary): void => {
        sendHostResultFrame(hostId, safeJson({ code, message, retryable: false, ...(details ? { details } : {}) }), true);
      };
      const sendHostResultFrame = (hostId: string, text: string, isError = false): void => {
        peer?.send({ type: 'host_tool_result', id: hostId, result: { content: [{ type: 'text', text }] }, ...(isError ? { isError: true } : {}) });
      };

      const spawnAttempt = async (resumePath: string | null): Promise<void> => {
        const spawned = (options.spawn ?? defaultSpawn)(options.definition.bin, ['--mode', 'rpc'], {
          cwd: input.cwd,
          env: environment,
          detached: process.platform !== 'win32',
        });
        child = spawned;
        processExited = false;
        stopping = null;
        if (!child.stdin || !child.stdout) throw new OmpProtocolError('Oh My Pi stdio is unavailable.');
        child.stderr?.resume();
        const attemptPeer = new OmpRpcPeer({
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
        await attemptPeer.waitForReady(boundedTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS));
        let resumedSession = false;
        if (resumePath) {
          try {
            const resumed = record(await attemptPeer.request('switch_session', { sessionPath: resumePath }));
            if (resumed?.cancelled !== false) throw new OmpResumeRejectedError();
            resumedSession = true;
          } catch {
            throw new OmpResumeRejectedError();
          }
        }
        const registeredTools = record(await attemptPeer.request('set_host_tools', { tools: hostTools(tools) }));
        requireRegisteredToolNames(registeredTools, tools);
        phase = 'host_tools_registered';
        const selectedModel = splitModel(input.model);
        if (selectedModel) await attemptPeer.request('set_model', selectedModel);
        if (input.reasoning) await attemptPeer.request('set_thinking_level', { level: input.reasoning });
        const state = record(await attemptPeer.request('get_state', {}));
        const sessionPath = safeSessionPath(state?.sessionFile);
        if (resumePath && sessionPath !== resumePath) throw new OmpResumeRejectedError();
        verifiedResumePath = resumePath;
        if (sessionPath) observedSessionPath = sessionPath;
        const promptPayload = {
          message: resumedSession ? input.resumePrompt : input.prompt,
          ...(input.images?.length ? {
            images: input.images.map((image) => ({ type: 'image', ...image })),
          } : {}),
        };
        if (!attemptPeer.requestFits('prompt', promptPayload)) {
          finish({
            status: 'failed',
            error: {
              code: 'IMAGE_INPUT_TOO_LARGE',
              message: 'The screenshots exceed the Oh My Pi RPC frame limit.',
            },
          });
          return;
        }
        await attemptPeer.request('prompt', promptPayload, DEFAULT_REQUEST_TIMEOUT_MS, () => {
          // The peer invokes this synchronously while parsing the correlated
          // response, before it advances to another frame in the same chunk.
          phase = 'prompt_accepted';
          onEvent({ kind: 'status', label: 'analyzing' });
        });
      };

      try {
        const resumePath = sessionBroker.load(sessionScope);
        try {
          await spawnAttempt(resumePath);
        } catch (error) {
          if (!resumePath || !(error instanceof OmpResumeRejectedError)) throw error;
          sessionBroker.delete(sessionScope);
          observedSessionPath = null;
          await discardAttempt();
          if (terminal || cancelRequested || input.signal.aborted) return handle;
          await spawnAttempt(null);
        }
        return handle;
      } catch {
        if (terminal) return handle;
        input.signal.removeEventListener('abort', onInputAbort);
        if (!controller.signal.aborted) controller.abort();
        sessionBroker.delete(sessionScope);
        closePeer();
        await stopProcess();
        throw new Error('Oh My Pi RPC protocol unavailable.');
      }
    },
  };
}

export async function probeOhMyPiNativeMapTools(
  options: CreateOhMyPiMapAgentAdapterOptions,
): Promise<boolean> {
  const baseEnvironment = options.environment ? options.environment() : process.env;
  if (!baseEnvironment) return false;
  const environment = sanitizeMapAgentLaunchEnvironment(baseEnvironment, [
    ...(options.definition.inheritedEnvKeys ?? []),
    ...(options.environmentKeys?.() ?? []),
  ]);
  let child: OhMyPiRpcProcess | null = null;
  let peer: OmpRpcPeer | null = null;
  let processExited = false;
  try {
    child = (options.spawn ?? defaultSpawn)(options.definition.bin, ['--mode', 'rpc'], {
      cwd: options.probeCwd ?? process.cwd(), env: environment, detached: process.platform !== 'win32',
    });
    if (!child.stdin || !child.stdout) return false;
    child.stderr?.resume();
    peer = new OmpRpcPeer({
      input: child.stdout,
      output: child.stdin,
      ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    });
    child.once('close', () => { processExited = true; peer?.close(); });
    child.once('error', () => peer?.close());
    const timeout = boundedTimeout(options.probeTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    await peer.waitForReady(timeout);
    const definitions = options.toolDefinitions();
    const result = record(await peer.request('set_host_tools', { tools: hostTools(definitions) }, timeout));
    requireRegisteredToolNames(result, definitions);
    return true;
  } catch {
    return false;
  } finally {
    peer?.close();
    if (child && !processExited) await stopOhMyPiProcess(child, options);
  }
}

type OmpRpcPeerOptions = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  maxFrameBytes?: number;
  onFrame?: (frame: Record<string, unknown>) => void;
  onError?: () => void;
};

class OmpProtocolError extends Error {
  constructor(message = 'Invalid Oh My Pi RPC frame.') { super(message); this.name = 'OmpProtocolError'; }
}

class OmpResumeRejectedError extends Error {}

class OmpRpcPeer extends CommandRpcPeer {
  private readonly negotiatedLimit: () => number;

  request(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    onSuccess?: () => void,
  ): Promise<unknown> {
    return super.request(type, payload, timeoutMs, onSuccess);
  }

  constructor(options: OmpRpcPeerOptions) {
    let limit = Number.isSafeInteger(options.maxFrameBytes) && (options.maxFrameBytes ?? 0) > 0
      ? options.maxFrameBytes!
      : MAP_RUN_MAX_FRAME_BYTES;
    super({
      ...options,
      protocolName: 'Oh My Pi RPC',
      defaultMaxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
      createError: (message) => new OmpProtocolError(message),
      requestId: (type, sequence) => `${type}-${sequence}`,
      parseReadyFrame(frame) {
        if (frame.type !== 'ready') return undefined;
        const maximum = frame.maxFrameBytes;
        if (frame.protocolVersion !== 1 || !Number.isSafeInteger(maximum) || (maximum as number) <= 0) {
          throw new OmpProtocolError();
        }
        limit = Math.min(limit, maximum as number);
        return maximum as number;
      },
    });
    this.negotiatedLimit = () => limit;
  }

  requestFits(type: string, payload: Record<string, unknown>): boolean {
    const encoded = `${JSON.stringify({ id: `${type}-9999999999`, type, ...payload })}\n`;
    return Buffer.byteLength(encoded) <= this.negotiatedLimit();
  }
}

function hostTools(tools: readonly NativeMapToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({ name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema }));
}

function requireRegisteredToolNames(
  result: Record<string, unknown> | null,
  definitions: readonly NativeMapToolDefinition[],
): void {
  const names = Array.isArray(result?.toolNames) ? result.toolNames : [];
  if (!names.every((name) => typeof name === 'string')
    || !definitions.every((definition) => names.includes(definition.name))) {
    throw new OmpProtocolError('Oh My Pi did not register the complete MapDesign host-tool set.');
  }
}

function isRunScopedFrame(type: string): boolean {
  return type === 'host_tool_call'
    || type === 'host_tool_cancel'
    || type === 'message_update'
    || type === 'agent_end'
    || type === 'prompt_result'
    || type === 'extension_error';
}

function splitModel(value: string | null): { provider: string; modelId: string } | null {
  if (!value || value === 'default') return null;
  const index = value.indexOf('/');
  const provider = index > 0 ? value.slice(0, index) : '';
  const modelId = index > 0 ? value.slice(index + 1) : '';
  return safeIdentifier(provider) && safeIdentifier(modelId) ? { provider, modelId } : null;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return '{"code":"TOOL_PROTOCOL_ERROR","message":"The map tool returned an invalid result.","retryable":false}'; }
}

function safeSessionPath(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096 && !/[\r\n\u0000]/u.test(value) ? value : null;
}

function stopOhMyPiProcess(child: OhMyPiRpcProcess, options: CreateOhMyPiMapAgentAdapterOptions): Promise<void> {
  if (options.stopProcess) return options.stopProcess(child).catch(() => undefined);
  const timeout = boundedTimeout(options.processStopTimeoutMs, DEFAULT_PROCESS_STOP_TIMEOUT_MS);
  return stopMapDesignProcessTree(child, timeout).catch(() => undefined);
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? Math.min(value!, MAX_REQUEST_TIMEOUT_MS) : fallback;
}


function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_EVENT_TEXT_LENGTH;
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH && !/[\r\n\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null { return typeof value === 'string' && value.length > 0 ? value : null; }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const defaultSpawn: OhMyPiRpcSpawn = spawnAgentProcess;
