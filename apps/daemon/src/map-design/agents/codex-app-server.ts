import { spawnAgentProcess } from '../../runtimes/spawn.js';

import type { SafeToolSummary } from '@mapseekai/contracts';
import type { MapToolName } from '@mapseekai/map-design-contracts';

import { codexAppServerArgs } from '../../runtimes/defs/codex.js';
import { clampCodexReasoning } from '../../runtimes/defs/shared.js';
import { stopMapDesignProcessTree } from '../application/run-service.js';
import type { MapDesignNativeToolRegistry, NativeMapToolDefinition } from '../tools/tool-context.js';
import {
  createJsonRpcPeer,
  JsonRpcProtocolError,
  type JsonRpcPeer,
} from './json-rpc-peer.js';
import {
  createMapToolCallSignature,
  createMapToolFailureClassSignature,
  createMapToolLoopGuard,
  type MapToolLoopGuard,
} from './map-tool-loop-guard.js';
import type {
  MapAgentAdapter,
  MapAgentEvent,
  MapRunHandle,
  MapRunInput,
  MapRunTerminal,
} from './types.js';
import { MAP_RUN_MAX_FRAME_BYTES } from './types.js';
import {
  createMemoryMapAgentSessionBroker,
  mapAgentSessionScope,
  type MapAgentSessionBroker,
} from './session-broker.js';
import { sanitizeMapAgentLaunchEnvironment } from './launch-environment.js';

export interface CodexAppServerProcess {
  pid?: number | undefined;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  stdin?: NodeJS.WritableStream | null;
  once(event: 'close', listener: (code: number | null, signal?: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: () => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type CodexAppServerSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean },
) => CodexAppServerProcess;

export type CreateCodexMapAgentAdapterOptions = {
  definition: { id: string; bin: string; inheritedEnvKeys?: readonly string[] };
  nativeToolRegistry: MapDesignNativeToolRegistry;
  spawn?: CodexAppServerSpawn;
  environment?: () => NodeJS.ProcessEnv | null;
  environmentKeys?: () => readonly string[];
  maxFrameBytes?: number;
  clientVersion?: string;
  requestTimeoutMs?: number;
  probeTimeoutMs?: number;
  probeCwd?: string;
  processStopTimeoutMs?: number;
  stopProcessTree?: (child: CodexAppServerProcess) => Promise<void>;
  sessionBroker?: MapAgentSessionBroker;
};

const NAMESPACE = 'map-design';
const NAMESPACE_DESCRIPTION = 'Transactional map design tools';
const CLIENT_VERSION = '0.18.2';
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_PROCESS_STOP_TIMEOUT_MS = 250;
const MAX_PENDING_TURN_NOTIFICATIONS = 64;
export const CODEX_DURABLE_MAP_TOOL_NAMES = [
  'map_apply_transaction',
  'map_update_semantics',
  'map_render_preview',
  'map_commit_revision',
  'map_discard_draft',
] as const satisfies readonly MapToolName[];
const DURABLE_MAP_TOOLS = new Set<MapToolName>(CODEX_DURABLE_MAP_TOOL_NAMES);
const SAFE_APP_SERVER_ENVIRONMENT_KEYS = [
  'APPDATA', 'CODEX_HOME', 'COLORTERM', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LOCALAPPDATA', 'NO_COLOR', 'PATH', 'Path', 'PATHEXT',
  'SHELL', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TERM',
  'TERM_PROGRAM', 'TMP', 'TMPDIR', 'USERPROFILE', 'WINDIR', 'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
] as const;
const FAILED_CONNECTION = {
  code: 'RUN_FAILED',
  message: 'The Codex app-server connection ended unexpectedly.',
} as const;
const FAILED_TURN = { code: 'RUN_FAILED', message: 'The Codex turn failed before completion.' } as const;
const TOOL_LOOP_DETECTED = {
  code: 'TOOL_LOOP_DETECTED',
  message: 'Repeated invalid map tool calls were stopped.',
} as const;

export function createCodexMapAgentAdapter(
  options: CreateCodexMapAgentAdapterOptions,
): MapAgentAdapter {
  const sessionBroker = options.sessionBroker ?? createMemoryMapAgentSessionBroker();
  return {
    id: options.definition.id,
    capabilities: {
      nativeMapTools: true,
      publicReasoningSummary: true,
    },
    probeNativeMapTools: () => probeCodexAppServer(options),
    async startMapRun(input, tools, onEvent) {
      const sessionScope = mapAgentSessionScope(input, options.definition.id);
      const reasoning = clampCodexReasoning(input.model, input.reasoning) ?? null;
      const requestTimeoutMs = boundedTimeout(options.requestTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS);
      let resolveDone!: (terminal: MapRunTerminal) => void;
      const done = new Promise<MapRunTerminal>((resolve) => {
        resolveDone = resolve;
      });
      const controller = new AbortController();
      let peer: JsonRpcPeer | null = null;
      let child: CodexAppServerProcess | null = null;
      let threadId: string | null = null;
      let turnId: string | null = null;
      let turnStartReady: Promise<void> | null = null;
      let resolveTurnStartReady: (() => void) | null = null;
      let turnStartSettled = true;
      let handshakeComplete = false;
      let terminal = false;
      let failureRecorded = false;
      let cancelRequested = false;
      let cancellation: Promise<void> | null = null;
      let processExited = false;
      let toolLoopHaltPending = false;
      let stoppingProcess: Promise<void> | null = null;
      const seenToolCalls = new Set<string>();
      const durableToolCalls = new Set<string>();
      const inFlightDurableToolCalls = new Set<string>();
      const durableToolOutcomes = new Map<string, 'succeeded' | 'failed' | 'canceled'>();
      const inFlightToolCalls = new Set<Promise<unknown>>();
      const pendingTurnNotifications: Array<{ method: string; params: unknown }> = [];
      const toolLoopGuard = createMapToolLoopGuard();

      const settleTurnStart = (): void => {
        if (turnStartSettled) return;
        turnStartSettled = true;
        resolveTurnStartReady?.();
        resolveTurnStartReady = null;
      };

      const stopProcess = (): Promise<void> => {
        if (stoppingProcess) return stoppingProcess;
        if (!child || processExited) return Promise.resolve();
        stoppingProcess = stopCodexAppServerProcess(child, options);
        return stoppingProcess;
      };

      const finish = (result: MapRunTerminal): void => {
        if (terminal) return;
        terminal = true;
        settleTurnStart();
        input.signal.removeEventListener('abort', onInputAbort);
        if (!controller.signal.aborted) controller.abort();
        if (result.status === 'succeeded' && threadId) sessionBroker.save(sessionScope, threadId);
        else if (result.status !== 'succeeded') sessionBroker.delete(sessionScope);
        onEvent({ kind: 'run_finished', status: result.status });
        resolveDone(result);
        peer?.close();
        void stopProcess();
      };

      const recordFailure = (origin: string, details: SafeToolSummary = {}): void => {
        if (terminal || failureRecorded || cancelRequested || toolLoopHaltPending) return;
        failureRecorded = true;
        console.warn(JSON.stringify({ event: 'codex_app_server_failure', runId: input.runId,
          phase: turnId ? 'turn' : threadId ? 'thread' : 'initialize', origin, ...details }));
      };
      const failConnection = (origin: string, details: SafeToolSummary = {}): void => {
        if (terminal || cancelRequested || toolLoopHaltPending) return;
        recordFailure(origin, details);
        if (handshakeComplete) finish({ status: 'failed', error: FAILED_CONNECTION });
        else {
          peer?.close(new JsonRpcProtocolError());
          void stopProcess();
        }
      };

      const haltToolLoop = (triggeringCallId: string): void => {
        if (terminal || toolLoopHaltPending) return;
        toolLoopHaltPending = true;
        const exactPeer = peer;
        const exactThreadId = threadId;
        const exactTurnId = turnId;
        const pendingToolCalls = [...inFlightToolCalls];
        const haltDurableCallIds = new Set(
          [...inFlightDurableToolCalls].filter((callId) => callId !== triggeringCallId),
        );
        if (!controller.signal.aborted) controller.abort();
        const interruptScheduled = new Promise<void>((resolve) => setImmediate(() => {
          if (exactPeer && !exactPeer.closed && exactThreadId && exactTurnId) {
            void exactPeer.request('turn/interrupt', {
              threadId: exactThreadId,
              turnId: exactTurnId,
            }).catch(() => undefined);
          }
          resolve();
        }));
        void (async () => {
          await Promise.all([Promise.allSettled(pendingToolCalls), interruptScheduled]);
          if (terminal) return;
          const outcomes = [...haltDurableCallIds].map((callId) => durableToolOutcomes.get(callId));
          if (outcomes.includes('succeeded')) finish({ status: 'succeeded' });
          else if (outcomes.includes('failed')) {
            finish({
              status: 'failed',
              error: { code: 'RUN_FAILED', message: 'The atomic map tool call failed.' },
            });
          } else finish({ status: 'failed', error: TOOL_LOOP_DETECTED });
        })();
      };

      const cancel = async (): Promise<void> => {
        if (terminal || toolLoopHaltPending) return;
        if (cancellation) return cancellation;
        cancelRequested = true;
        if (threadId && turnId && peer && !peer.closed) {
          void peer.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
        }
        const pendingToolCalls = [...inFlightToolCalls];
        const cancellationDurableCallIds = new Set(inFlightDurableToolCalls);
        if (!controller.signal.aborted) controller.abort();
        cancellation = (async () => {
          await Promise.allSettled(pendingToolCalls);
          if (!terminal) {
            const outcomes = [...cancellationDurableCallIds]
              .map((callId) => durableToolOutcomes.get(callId));
            if (outcomes.includes('succeeded')) finish({ status: 'succeeded' });
            else if (outcomes.includes('failed')) {
              finish({
                status: 'failed',
                error: { code: 'RUN_FAILED', message: 'The atomic map tool call failed.' },
              });
            } else finish({ status: 'canceled' });
          }
          await stopProcess();
        })();
        return cancellation;
      };

      function onInputAbort(): void {
        void cancel();
      }

      const processNotification = (method: string, params: unknown): void => {
        if (terminal || toolLoopHaltPending) return;
        const notification = record(params);
        if (!notification) throw new JsonRpcProtocolError();
        if (method === 'item/reasoning/textDelta') {
          requireCurrentTurn(notification, threadId, turnId);
          return;
        }
        if (method === 'item/reasoning/summaryTextDelta') {
          requireCurrentTurn(notification, threadId, turnId);
          if (typeof notification.delta !== 'string') throw new JsonRpcProtocolError();
          onEvent({ kind: 'thinking', text: notification.delta });
          return;
        }
        if (method === 'item/agentMessage/delta') {
          requireCurrentTurn(notification, threadId, turnId);
          if (typeof notification.delta !== 'string') throw new JsonRpcProtocolError();
          onEvent({ kind: 'text', text: notification.delta });
          return;
        }
        if (method === 'turn/started') {
          requireCurrentThread(notification, threadId);
          const currentTurn = record(notification.turn);
          if (!currentTurn || typeof currentTurn.id !== 'string') throw new JsonRpcProtocolError();
          if (!turnId || currentTurn.id !== turnId) throw new JsonRpcProtocolError();
          return;
        }
        if (method === 'turn/completed') {
          requireCurrentThread(notification, threadId);
          const completed = record(notification.turn);
          if (!completed || typeof completed.id !== 'string') throw new JsonRpcProtocolError();
          if (!turnId || completed.id !== turnId) throw new JsonRpcProtocolError();
          if (cancelRequested) return;
          if (completed.status === 'completed') finish({ status: 'succeeded' });
          else if (completed.status === 'interrupted') finish({ status: 'canceled' });
          else if (completed.status === 'failed') {
            recordFailure('turn-failed', safeCodexError(completed.error));
            finish({ status: 'failed', error: FAILED_TURN });
          }
          else throw new JsonRpcProtocolError();
          return;
        }
        if (method === 'error') {
          requireCurrentTurn(notification, threadId, turnId);
          if (cancelRequested) return;
          if (notification.willRetry !== true) {
            recordFailure('error-notification', { ...safeCodexError(notification.error), willRetry: false });
            finish({ status: 'failed', error: FAILED_TURN });
          }
        }
      };

      const handle: MapRunHandle = { done, cancel };
      if (input.signal.aborted) {
        finish({ status: 'canceled' });
        return handle;
      }
      input.signal.addEventListener('abort', onInputAbort, { once: true });

      try {
        const environment = options.environment ? options.environment() : process.env;
        if (!environment) throw new Error('environment unavailable');
        child = (options.spawn ?? defaultSpawn)(
          options.definition.bin,
          codexAppServerArgs(),
          {
            cwd: input.cwd,
            env: sanitizeCodexAppServerEnvironment(environment, [
              ...(options.definition.inheritedEnvKeys ?? []),
              ...(options.environmentKeys?.() ?? []),
            ]),
            detached: process.platform !== 'win32',
          },
        );
        if (!child.stdout || !child.stdin) throw new Error('stdio unavailable');
        child.stderr?.resume();

        peer = createJsonRpcPeer({
          input: child.stdout,
          output: child.stdin,
          maxFrameBytes: options.maxFrameBytes ?? MAP_RUN_MAX_FRAME_BYTES,
          onRequest: async (method, params) => {
            if (!turnStartSettled) await turnStartReady;
            if (cancelRequested || toolLoopHaltPending) {
              return failedToolResponse('CANCELED', 'The map tool call was canceled.', false);
            }
            const request = record(params);
            const callId = nonEmptyString(request?.callId);
            const toolName = nonEmptyString(request?.tool) as MapToolName | null;
            if (callId && toolName && DURABLE_MAP_TOOLS.has(toolName)) {
              durableToolCalls.add(callId);
              inFlightDurableToolCalls.add(callId);
            }
            const publishToolEvent = (event: MapAgentEvent): void => {
              if (event.kind === 'tool_result' && durableToolCalls.has(event.toolUseId)) {
                durableToolOutcomes.set(event.toolUseId, event.status);
              }
              onEvent(event);
            };
            let toolCall!: Promise<unknown>;
            toolCall = handleServerRequest(
              method,
              params,
              input,
              tools,
              options.nativeToolRegistry,
              controller.signal,
              seenToolCalls,
              publishToolEvent,
              threadId,
              turnId,
              () => terminal,
              toolLoopGuard,
              haltToolLoop,
            );
            inFlightToolCalls.add(toolCall);
            try {
              return await toolCall;
            } finally {
              inFlightToolCalls.delete(toolCall);
              if (callId) inFlightDurableToolCalls.delete(callId);
            }
          },
          onNotification: (method, params) => {
            if (!turnStartSettled && isTurnScopedNotification(method)) {
              if (pendingTurnNotifications.length >= MAX_PENDING_TURN_NOTIFICATIONS) {
                throw new JsonRpcProtocolError('Too many turn notifications arrived before turn/start completed.');
              }
              pendingTurnNotifications.push({ method, params });
              return;
            }
            processNotification(method, params);
          },
          onError: (error) => failConnection('rpc', { protocolCategory: safeProtocolCategory(error) }),
        });

        child.once('close', (code, signal) => {
          processExited = true;
          failConnection('process-exit', { exitCode: Number.isInteger(code) ? code! : null,
            signal: signal && /^SIG[A-Z0-9]{1,12}$/.test(signal) ? signal : null });
        });
        child.once('error', () => failConnection('process-error'));

        const initialized = await requestWithDeadline(peer, 'initialize', {
          clientInfo: {
            name: 'map-design',
            title: 'MapDesign',
            version: options.clientVersion ?? CLIENT_VERSION,
          },
          capabilities: { experimentalApi: true },
        }, requestTimeoutMs);
        requireInitializeResult(initialized);
        peer.notify('initialized', {});

        let resumed = false;
        const rememberedThreadId = sessionBroker.load(sessionScope);
        if (rememberedThreadId) {
          try {
            const resumedThread = await requestWithDeadline(
              peer,
              'thread/resume',
              threadResumeParams(
                rememberedThreadId,
                input.cwd,
                input.model,
                input.serviceTier,
                reasoning,
              ),
              requestTimeoutMs,
            );
            threadId = requireThreadId(resumedThread);
            if (threadId !== rememberedThreadId) throw new JsonRpcProtocolError();
            resumed = true;
          } catch {
            sessionBroker.delete(sessionScope);
            threadId = null;
            if (peer.closed) throw new JsonRpcProtocolError();
          }
        }
        if (!threadId) {
          const thread = await requestWithDeadline(
            peer,
            'thread/start',
            threadStartParams(input.cwd, input.model, input.serviceTier, reasoning, tools, false),
            requestTimeoutMs,
          );
          threadId = requireThreadId(thread);
        }

        turnStartSettled = false;
        turnStartReady = new Promise<void>((resolve) => {
          resolveTurnStartReady = resolve;
        });
        const started = await requestWithDeadline(peer, 'turn/start', {
          threadId,
          input: [
            { type: 'text', text: resumed ? input.resumePrompt : input.prompt },
            ...(input.images ?? []).map((image) => ({
              type: 'image',
              url: `data:${image.mimeType};base64,${image.data}`,
            })),
          ],
          cwd: input.cwd,
          ...optional('model', input.model),
          ...optional('effort', reasoning),
          summary: 'detailed',
          ...optional('serviceTier', input.serviceTier),
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          environments: [],
        }, requestTimeoutMs);
        turnId = requireTurnId(started);
        onEvent({ kind: 'status', label: 'analyzing' });
        settleTurnStart();
        while (pendingTurnNotifications.length > 0 && !terminal) {
          const notification = pendingTurnNotifications.shift()!;
          processNotification(notification.method, notification.params);
        }
        handshakeComplete = true;
        return handle;
      } catch (error) {
        recordFailure('handshake', { protocolCategory: safeProtocolCategory(error) });
        settleTurnStart();
        if (terminal) return handle;
        input.signal.removeEventListener('abort', onInputAbort);
        if (!controller.signal.aborted) controller.abort();
        sessionBroker.delete(sessionScope);
        peer?.close(new JsonRpcProtocolError());
        await stopProcess();
        throw new Error('Codex app-server protocol unavailable.');
      }
    },
  };
}

export async function probeCodexAppServer(
  options: CreateCodexMapAgentAdapterOptions,
): Promise<boolean> {
  let child: CodexAppServerProcess | null = null;
  let peer: JsonRpcPeer | null = null;
  let processExited = false;
  try {
    const environment = options.environment ? options.environment() : process.env;
    if (!environment) return false;
    child = (options.spawn ?? defaultSpawn)(
      options.definition.bin,
      codexAppServerArgs(),
      {
        cwd: options.probeCwd ?? process.cwd(),
        env: sanitizeCodexAppServerEnvironment(environment, [
          ...(options.definition.inheritedEnvKeys ?? []),
          ...(options.environmentKeys?.() ?? []),
        ]),
        detached: process.platform !== 'win32',
      },
    );
    if (!child.stdout || !child.stdin) return false;
    child.stderr?.resume();
    peer = createJsonRpcPeer({
      input: child.stdout,
      output: child.stdin,
      ...(options.maxFrameBytes ? { maxFrameBytes: options.maxFrameBytes } : {}),
    });
    child.once('close', () => {
      processExited = true;
      peer?.close(new JsonRpcProtocolError());
    });
    child.once('error', () => peer?.close(new JsonRpcProtocolError()));
    const initialized = await requestWithDeadline(
      peer,
      'initialize',
      initializeParams(options),
      boundedTimeout(options.probeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS),
    );
    requireInitializeResult(initialized);
    peer.notify('initialized', {});
    const thread = await requestWithDeadline(
      peer,
      'thread/start',
      threadStartParams(
        options.probeCwd ?? process.cwd(),
        null,
        null,
        null,
        [...options.nativeToolRegistry.definitions()],
        true,
      ),
      boundedTimeout(options.probeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS),
    );
    requireThreadId(thread);
    return true;
  } catch {
    return false;
  } finally {
    peer?.close();
    if (child && !processExited) await stopCodexAppServerProcess(child, options);
  }
}

function requestWithDeadline(
  peer: JsonRpcPeer,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new JsonRpcProtocolError(`The ${method} request timed out.`));
    }, timeoutMs);
    void peer.request(method, params).then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 0) return fallback;
  return Math.min(value!, MAX_REQUEST_TIMEOUT_MS);
}

function initializeParams(options: CreateCodexMapAgentAdapterOptions): Record<string, unknown> {
  return {
    clientInfo: {
      name: 'map-design',
      title: 'MapDesign',
      version: options.clientVersion ?? CLIENT_VERSION,
    },
    capabilities: { experimentalApi: true },
  };
}

function threadStartParams(
  cwd: string,
  model: string | null,
  serviceTier: string | null,
  reasoning: string | null,
  tools: NativeMapToolDefinition[],
  ephemeral: boolean,
): Record<string, unknown> {
  return {
    cwd,
    ...optional('model', model),
    ...optional('serviceTier', serviceTier),
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral,
    environments: [],
    config: {
      ...optional('model_reasoning_effort', reasoning),
      model_reasoning_summary: 'detailed',
    },
    dynamicTools: tools.length ? [{
      type: 'namespace',
      name: NAMESPACE,
      description: NAMESPACE_DESCRIPTION,
      tools: tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }] : [],
  };
}

function threadResumeParams(
  threadId: string,
  cwd: string,
  model: string | null,
  serviceTier: string | null,
  reasoning: string | null,
): Record<string, unknown> {
  return {
    threadId,
    cwd,
    ...optional('model', model),
    ...optional('serviceTier', serviceTier),
    approvalPolicy: 'never',
    sandbox: 'read-only',
    config: {
      ...optional('model_reasoning_effort', reasoning),
      model_reasoning_summary: 'detailed',
    },
    excludeTurns: true,
  };
}

function stopCodexAppServerProcess(
  child: CodexAppServerProcess,
  options: CreateCodexMapAgentAdapterOptions,
): Promise<void> {
  const timeoutMs = boundedTimeout(options.processStopTimeoutMs, DEFAULT_PROCESS_STOP_TIMEOUT_MS);
  const stop = options.stopProcessTree
    ?? ((process: CodexAppServerProcess) => stopMapDesignProcessTree(process, timeoutMs));
  return stop(child).catch(() => undefined);
}

function sanitizeCodexAppServerEnvironment(
  environment: NodeJS.ProcessEnv,
  inheritedEnvKeys: readonly string[],
): NodeJS.ProcessEnv {
  return sanitizeMapAgentLaunchEnvironment(environment, [
    ...SAFE_APP_SERVER_ENVIRONMENT_KEYS,
    ...inheritedEnvKeys,
  ]);
}

function isTurnScopedNotification(method: string): boolean {
  return method === 'item/reasoning/textDelta'
    || method === 'item/reasoning/summaryTextDelta'
    || method === 'item/agentMessage/delta'
    || method === 'turn/started'
    || method === 'turn/completed'
    || method === 'error';
}

async function handleServerRequest(
  method: string,
  params: unknown,
  input: MapRunInput,
  tools: Parameters<MapAgentAdapter['startMapRun']>[1],
  nativeToolRegistry: MapDesignNativeToolRegistry,
  signal: AbortSignal,
  seenToolCalls: Set<string>,
  onEvent: (event: MapAgentEvent) => void,
  currentThreadId: string | null,
  currentTurnId: string | null,
  isTerminal: () => boolean,
  toolLoopGuard: MapToolLoopGuard,
  onLoopHalt: (triggeringCallId: string) => void,
): Promise<unknown> {
  if (isTerminal()) return failedToolResponse('CANCELED', 'The map tool call was canceled.', false);
  if (method !== 'item/tool/call') throw new JsonRpcProtocolError();
  const request = record(params);
  if (!request) return failedToolResponse('INVALID_INPUT', 'The map tool input is invalid.', false);
  const callId = nonEmptyString(request.callId);
  const name = nonEmptyString(request.tool);
  const namespace = request.namespace;
  if (
    request.threadId !== currentThreadId
    || request.turnId !== currentTurnId
    || !callId
    || !name
    || namespace !== NAMESPACE
    || seenToolCalls.has(callId)
  ) {
    return failedToolResponse('UNKNOWN_TOOL', 'The map tool call is not registered.', false);
  }
  if (!tools.some((tool) => tool.name === name)) {
    return failedToolResponse('UNKNOWN_TOOL', 'The map tool call is not registered.', false);
  }
  seenToolCalls.add(callId);
  onEvent({ kind: 'tool_use', id: callId, name, summary: {} });
  const guardedToolName = name as MapToolName;
  const loopSignature = createMapToolCallSignature(guardedToolName, request.arguments);

  let result;
  try {
    result = await nativeToolRegistry.call({
      runId: input.runId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      toolUseId: callId,
      signal,
    }, name as MapToolName, request.arguments);
  } catch {
    result = {
      ok: false as const,
      toolUseId: callId,
      error: { code: 'INTERNAL', message: 'The map tool call failed.', retryable: false },
    };
  }

  if (isTerminal()) return failedToolResponse('CANCELED', 'The map tool call was canceled.', false);

  if (result.toolUseId !== callId) {
    result = {
      ok: false as const,
      toolUseId: callId,
      error: { code: 'INTERNAL', message: 'The map tool call failed.', retryable: false },
    };
  }
  if (result.ok) {
    toolLoopGuard.success(guardedToolName);
    onEvent({
      kind: 'tool_result',
      toolUseId: callId,
      status: 'succeeded',
      summary: result.summary,
    });
    return {
      contentItems: [{ type: 'inputText', text: result.modelContent ?? JSON.stringify(result.summary) }],
      success: true,
    };
  }
  const summary: SafeToolSummary = {
    ...(result.error.details ?? {}),
    code: result.error.code,
    retryable: result.error.retryable,
  };
  const loopVerdict = loopSignature
    && result.error.code !== 'CANCELED'
    && result.error.code !== 'CANCELLED'
    ? toolLoopGuard.failure(
      guardedToolName,
      loopSignature,
      createMapToolFailureClassSignature(guardedToolName, result.error) ?? undefined,
      result.error.retryable !== true,
    )
    : null;
  if (loopVerdict?.action === 'warn') {
    summary.loopWarning = true;
    summary.failureCount = loopVerdict.count;
  } else if (loopVerdict?.action === 'halt') {
    summary.loopHalted = true;
    summary.failureCount = loopVerdict.count;
  }
  onEvent({
    kind: 'tool_result',
    toolUseId: callId,
    status: result.error.code === 'CANCELED' ? 'canceled' : 'failed',
    summary,
  });
  if (loopVerdict?.action === 'halt') onLoopHalt(callId);
  return failedToolResponse(
    result.error.code,
    result.error.message,
    result.error.retryable,
    result.error.details,
  );
}

function failedToolResponse(
  code: string,
  message: string,
  retryable: boolean,
  details?: SafeToolSummary,
): Record<string, unknown> {
  return {
    contentItems: [{
      type: 'inputText',
      text: JSON.stringify({
        code,
        message,
        retryable,
        ...(details && Object.keys(details).length > 0 ? { details } : {}),
      }),
    }],
    success: false,
  };
}

function requireInitializeResult(value: unknown): void {
  const result = record(value);
  if (
    !result
    || !nonEmptyString(result.userAgent)
    || !nonEmptyString(result.codexHome)
    || !nonEmptyString(result.platformFamily)
    || !nonEmptyString(result.platformOs)
  ) {
    throw new JsonRpcProtocolError();
  }
}

function requireThreadId(value: unknown): string {
  const result = record(value);
  const thread = record(result?.thread);
  const id = nonEmptyString(thread?.id);
  if (!id) throw new JsonRpcProtocolError();
  return id;
}

function requireTurnId(value: unknown): string {
  const result = record(value);
  const started = record(result?.turn);
  const id = nonEmptyString(started?.id);
  if (!id || started?.status !== 'inProgress') throw new JsonRpcProtocolError();
  return id;
}

function requireCurrentThread(params: Record<string, unknown>, threadId: string | null): void {
  if (!threadId || params.threadId !== threadId) throw new JsonRpcProtocolError();
}

function requireCurrentTurn(
  params: Record<string, unknown>,
  threadId: string | null,
  turnId: string | null,
): void {
  requireCurrentThread(params, threadId);
  if (!turnId || params.turnId !== turnId) throw new JsonRpcProtocolError();
}

function optional(key: string, value: string | null): Record<string, string> {
  return value && value !== 'default' ? { [key]: value } : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const defaultSpawn: CodexAppServerSpawn = spawnAgentProcess;

// Never log provider messages, URLs, stderr or arbitrary object keys.
function safeCodexError(value: unknown): SafeToolSummary {
  const info = record(value)?.codexErrorInfo;
  const categories = ['contextWindowExceeded', 'usageLimitExceeded', 'serverOverloaded', 'httpConnectionFailed',
    'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts',
    'badRequest', 'unauthorized', 'internalServerError', 'sandboxError', 'other'];
  const details = record(info);
  const category = categories.find((candidate) => typeof info === 'string' ? info === candidate : details && Object.hasOwn(details, candidate));
  const status = category && details ? record(details[category])?.httpStatusCode : undefined;
  return { codexErrorInfo: category ?? 'unknown',
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatusCode: status } : {}) };
}

function safeProtocolCategory(error: unknown): string {
  if (!(error instanceof JsonRpcProtocolError)) return 'other';
  switch (error.message) {
    case 'The JSON-RPC peer ended unexpectedly.': return 'eof';
    case 'The JSON-RPC peer input failed.': return 'input';
    case 'The JSON-RPC peer output failed.': return 'output';
    case 'The JSON-RPC frame exceeds the configured limit.': return 'frame-limit';
    default: return 'invalid-protocol';
  }
}
