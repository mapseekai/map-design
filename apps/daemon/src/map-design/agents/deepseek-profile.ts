import { Buffer } from 'node:buffer';
import { spawn as spawnChild } from 'node:child_process';

import type { SafeToolSummary } from '@mapseekai/contracts';
import type { MapToolName } from '@mapseekai/map-design-contracts';

import type { RuntimeAgentDef } from '../../runtimes/types.js';
import { stopMapDesignProcessTree } from '../application/run-service.js';
import type { NativeMapToolDefinition } from '../tools/tool-context.js';
import {
  type DeepSeekProfileBundle,
  stageDeepSeekProfileBundle,
} from './deepseek-profile-bundle.js';
import {
  DEFAULT_DEEPSEEK_PROFILE_MAX_FRAME_BYTES,
  createDeepSeekProfileCancelCommand,
  createDeepSeekProfileExecuteCommand,
  createDeepSeekProfileFrameStream,
  type DeepSeekProfileResultFrame,
  type DeepSeekProfileRuntimeFrame,
} from './deepseek-profile-protocol.js';
import {
  createMapToolCallSignature,
  createMapToolFailureClassSignature,
  createMapToolLoopGuard,
} from './map-tool-loop-guard.js';
import { sanitizeMapAgentLaunchEnvironment } from './launch-environment.js';
import {
  createMemoryMapAgentSessionBroker,
  mapAgentSessionScope,
  type MapAgentSessionBroker,
} from './session-broker.js';
import type {
  MapAgentAdapter,
  MapRunHandle,
  MapRunInput,
  MapRunTerminal,
} from './types.js';

export interface DeepSeekProfileProcess {
  pid?: number | undefined;
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  stdin?: NodeJS.WritableStream | null;
  once(event: 'close', listener: (code: number | null) => void): this;
  once(event: 'error', listener: () => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type DeepSeekProfileSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean },
) => DeepSeekProfileProcess;

export type CreateDeepSeekHarnessMapAgentAdapterOptions = {
  definition: RuntimeAgentDef;
  toolDefinitions: () => readonly NativeMapToolDefinition[];
  spawn?: DeepSeekProfileSpawn;
  environment?: () => NodeJS.ProcessEnv | null;
  environmentKeys?: () => readonly string[];
  profileRoot?: string;
  stageProfile?: (root?: string) => Promise<DeepSeekProfileBundle>;
  sessionBroker?: MapAgentSessionBroker;
  maxFrameBytes?: number;
  readyTimeoutMs?: number;
  probeTimeoutMs?: number;
  probeCwd?: string;
  processStopTimeoutMs?: number;
  stopProcess?: (child: DeepSeekProfileProcess) => Promise<void>;
};

type RunAttempt = {
  sequence: number;
  child: DeepSeekProfileProcess;
  resumeSessionId: string | null;
  parser: ReturnType<typeof createDeepSeekProfileFrameStream>;
  ready: boolean;
  sessionId: string | null;
  closing: boolean;
  exited: boolean;
  stopPromise: Promise<void> | null;
  cancelSent: boolean;
  readyDeadline: NodeJS.Timeout | null;
  calls: Map<string, { name: MapToolName; input: unknown }>;
  completedCalls: Set<string>;
};

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const MAX_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_PROCESS_STOP_TIMEOUT_MS = 250;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const FAILED_CONNECTION = {
  code: 'RUN_FAILED',
  message: 'The DeepSeek Harness profile ended unexpectedly.',
} as const;
const TOOL_LOOP_DETECTED = {
  code: 'TOOL_LOOP_DETECTED',
  message: 'Repeated invalid map tool calls were stopped.',
} as const;

export function createDeepSeekHarnessMapAgentAdapter(
  options: CreateDeepSeekHarnessMapAgentAdapterOptions,
): MapAgentAdapter {
  const sessionBroker = options.sessionBroker ?? createMemoryMapAgentSessionBroker();
  return {
    id: options.definition.id,
    capabilities: { nativeMapTools: true, publicReasoningSummary: true },
    probeNativeMapTools: () => probeDeepSeekHarnessNativeMapTools(options),
    async startMapRun(input, tools, onEvent) {
      if (input.images?.length) {
        const terminal: MapRunTerminal = {
          status: 'failed',
          error: {
            code: 'IMAGE_INPUT_UNSUPPORTED',
            message: 'DeepSeek Harness does not support screenshot input.',
          },
        };
        onEvent({ kind: 'run_finished', status: 'failed' });
        return { done: Promise.resolve(terminal), cancel: async () => undefined };
      }
      const baseEnvironment = options.environment ? options.environment() : process.env;
      if (!baseEnvironment) throw new Error('DeepSeek Harness environment unavailable.');
      const maxFrameBytes = positiveLimit(options.maxFrameBytes);
      const sessionScope = mapAgentSessionScope(input, options.definition.id);
      const knownToolNames = new Set(tools.map((tool) => tool.name));
      const loopGuard = createMapToolLoopGuard();
      let profile: DeepSeekProfileBundle | null = null;
      let currentAttempt: RunAttempt | null = null;
      let sequence = 0;
      let reseeded = false;
      let terminal = false;
      let cancelRequested = false;
      let cancellation: Promise<void> | null = null;
      let restart: Promise<void> | null = null;
      let resolveDone!: (result: MapRunTerminal) => void;
      const done = new Promise<MapRunTerminal>((resolve) => { resolveDone = resolve; });

      const stopAttempt = (attempt: RunAttempt | null): Promise<void> => {
        if (attempt?.readyDeadline) {
          clearTimeout(attempt.readyDeadline);
          attempt.readyDeadline = null;
        }
        if (!attempt || attempt.exited) return Promise.resolve();
        if (attempt.stopPromise) return attempt.stopPromise;
        attempt.closing = true;
        attempt.stopPromise = stopDeepSeekProfileProcess(attempt.child, options);
        return attempt.stopPromise;
      };
      const finish = (result: MapRunTerminal): void => {
        if (terminal) return;
        terminal = true;
        input.signal.removeEventListener('abort', onInputAbort);
        if (result.status !== 'succeeded') sessionBroker.delete(sessionScope);
        onEvent({ kind: 'run_finished', status: result.status });
        resolveDone(result);
        void stopAttempt(currentAttempt);
      };
      const fail = (error: { code: string; message: string } = FAILED_CONNECTION): void => {
        if (terminal || cancelRequested) return;
        finish({ status: 'failed', error });
      };
      const writeCommand = (attempt: RunAttempt, command: unknown): boolean => {
        if (terminal || attempt.closing || attempt.exited || !attempt.child.stdin) return false;
        const encoded = `${JSON.stringify(command)}\n`;
        if (Buffer.byteLength(encoded, 'utf8') > maxFrameBytes) {
          fail({ code: 'DSH_PROFILE_FRAME_TOO_LARGE', message: 'The DeepSeek Harness command is too large.' });
          return false;
        }
        try {
          attempt.child.stdin.write(encoded);
          return true;
        } catch {
          fail();
          return false;
        }
      };
      const sendCancel = (attempt: RunAttempt | null): void => {
        if (!attempt || attempt.cancelSent || attempt.exited || attempt.closing) return;
        attempt.cancelSent = true;
        writeCommand(attempt, createDeepSeekProfileCancelCommand(input.runId));
      };
      const cancel = async (): Promise<void> => {
        if (terminal) return stopAttempt(currentAttempt);
        if (cancellation) return cancellation;
        cancelRequested = true;
        cancellation = (async () => {
          sendCancel(currentAttempt);
          await stopAttempt(currentAttempt);
          finish({ status: 'canceled' });
        })();
        return cancellation;
      };
      const onInputAbort = (): void => { void cancel(); };
      const handle: MapRunHandle = { done, cancel };

      const requireSession = (attempt: RunAttempt): boolean => {
        if (attempt.sessionId) return true;
        fail({
          code: 'DSH_PROFILE_MISSING_SESSION',
          message: 'DeepSeek Harness emitted Run content before establishing a session.',
        });
        return false;
      };
      const restartWithoutResume = (attempt: RunAttempt): void => {
        if (restart || terminal || cancelRequested) return;
        reseeded = true;
        sessionBroker.delete(sessionScope);
        attempt.closing = true;
        restart = (async () => {
          await stopAttempt(attempt);
          if (terminal || cancelRequested || input.signal.aborted) return;
          await spawnAttempt(null);
        })().catch(() => fail());
      };
      const handleResult = (attempt: RunAttempt, frame: DeepSeekProfileResultFrame): void => {
        if (frame.resume_rejected) {
          if (
            !attempt.resumeSessionId
            || frame.session_id !== attempt.resumeSessionId
            || frame.status !== 'failed'
            || attempt.sessionId !== null
          ) {
            fail({
              code: 'DSH_PROFILE_RESUME_MISMATCH',
              message: 'DeepSeek Harness rejected a mismatched session.',
            });
            return;
          }
          if (!reseeded) {
            restartWithoutResume(attempt);
            return;
          }
          fail(profileFailure(frame, 'DSH_PROFILE_RESUME_REJECTED'));
          return;
        }
        if (!requireSession(attempt)) return;
        if (frame.session_id !== attempt.sessionId) {
          fail({
            code: 'DSH_PROFILE_SESSION_MISMATCH',
            message: 'DeepSeek Harness changed the Run session identifier.',
          });
          return;
        }
        if (attempt.calls.size > 0) {
          fail({
            code: 'DSH_PROFILE_PENDING_TOOL_CALL',
            message: 'DeepSeek Harness ended with an incomplete map tool call.',
          });
          return;
        }
        if (frame.status === 'completed') {
          sessionBroker.save(sessionScope, frame.session_id);
          finish({ status: 'succeeded' });
        } else if (frame.status === 'cancelled') {
          if (cancelRequested || input.signal.aborted) finish({ status: 'canceled' });
          else fail({ code: 'DSH_PROFILE_UNEXPECTED_CANCEL', message: 'DeepSeek Harness canceled the Run unexpectedly.' });
        } else {
          fail(profileFailure(frame));
        }
      };
      const handleToolCall = (
        attempt: RunAttempt,
        frame: Extract<DeepSeekProfileRuntimeFrame, { type: 'tool_call' }>,
      ): void => {
        if (!requireSession(attempt)) return;
        const name = frame.name as MapToolName;
        if (!knownToolNames.has(name) || attempt.calls.has(frame.call_id) || attempt.completedCalls.has(frame.call_id)) {
          fail({ code: 'DSH_PROFILE_INVALID_TOOL_CALL', message: 'DeepSeek Harness emitted an invalid map tool call.' });
          return;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(frame.arguments) as unknown; } catch {
          fail({ code: 'DSH_PROFILE_INVALID_TOOL_CALL', message: 'DeepSeek Harness emitted invalid map tool arguments.' });
          return;
        }
        if (!record(parsed)) {
          fail({ code: 'DSH_PROFILE_INVALID_TOOL_CALL', message: 'DeepSeek Harness emitted invalid map tool arguments.' });
          return;
        }
        attempt.calls.set(frame.call_id, { name, input: parsed });
        onEvent({ kind: 'tool_use', id: frame.call_id, name, summary: {} });
      };
      const handleToolResult = (
        attempt: RunAttempt,
        frame: Extract<DeepSeekProfileRuntimeFrame, { type: 'tool_result' }>,
      ): void => {
        if (!requireSession(attempt)) return;
        const call = attempt.calls.get(frame.call_id);
        if (!call || call.name !== frame.name || attempt.completedCalls.has(frame.call_id)) {
          fail({ code: 'DSH_PROFILE_INVALID_TOOL_RESULT', message: 'DeepSeek Harness emitted an uncorrelated map tool result.' });
          return;
        }
        attempt.calls.delete(frame.call_id);
        attempt.completedCalls.add(frame.call_id);
        const status = frame.status === 'cancelled' ? 'canceled' : frame.status;
        const summary = structuredClone(frame.summary);
        onEvent({ kind: 'tool_result', toolUseId: frame.call_id, status, summary });
        if (status === 'succeeded') {
          loopGuard.success(call.name);
          return;
        }
        if (status === 'canceled') return;
        const error = summaryError(summary);
        const verdict = loopGuard.failure(
          call.name,
          createMapToolCallSignature(call.name, call.input),
          createMapToolFailureClassSignature(call.name, error) ?? undefined,
          error.retryable !== true,
        );
        if (verdict?.action === 'halt') {
          sendCancel(attempt);
          finish({ status: 'failed', error: TOOL_LOOP_DETECTED });
        }
      };
      const handleFrame = (attempt: RunAttempt, frame: DeepSeekProfileRuntimeFrame): void => {
        if (terminal || attempt !== currentAttempt || attempt.closing) return;
        if (!attempt.ready) {
          if (frame.type !== 'ready') {
            fail({ code: 'DSH_PROFILE_MISSING_READY', message: 'DeepSeek Harness did not begin with a ready frame.' });
            return;
          }
          attempt.ready = true;
          if (attempt.readyDeadline) {
            clearTimeout(attempt.readyDeadline);
            attempt.readyDeadline = null;
          }
          let command;
          try {
            const runPrompt = attempt.resumeSessionId ? input.resumePrompt : input.prompt;
            command = createDeepSeekProfileExecuteCommand({
              requestId: input.runId,
              cwd: input.cwd,
              prompt: runPrompt,
              model: input.model,
              reasoningEffort: input.reasoning,
              resumeSessionId: attempt.resumeSessionId,
              tools,
              callbackUrl: input.toolCallback.url,
            });
          } catch {
            fail({ code: 'DSH_PROFILE_INVALID_COMMAND', message: 'The DeepSeek Harness command could not be created.' });
            return;
          }
          writeCommand(attempt, command);
          return;
        }
        if (frame.type === 'ready' || frame.type === 'probe') {
          fail({ code: 'DSH_PROFILE_UNEXPECTED_IDENTITY', message: 'DeepSeek Harness emitted an unexpected identity frame.' });
          return;
        }
        if ('request_id' in frame && frame.request_id !== undefined && frame.request_id !== input.runId) return;
        switch (frame.type) {
          case 'session':
            if (attempt.sessionId) {
              fail({ code: 'DSH_PROFILE_DUPLICATE_SESSION', message: 'DeepSeek Harness emitted more than one session frame.' });
              return;
            }
            if (attempt.resumeSessionId) {
              if (!frame.resumed || frame.session_id !== attempt.resumeSessionId) {
                fail({ code: 'DSH_PROFILE_RESUME_MISMATCH', message: 'DeepSeek Harness resumed a mismatched session.' });
                return;
              }
            } else if (frame.resumed) {
              fail({ code: 'DSH_PROFILE_RESUME_MISMATCH', message: 'DeepSeek Harness resumed an unexpected session.' });
              return;
            }
            attempt.sessionId = frame.session_id;
            onEvent({ kind: 'status', label: 'analyzing' });
            return;
          case 'thinking':
            if (requireSession(attempt) && frame.content) onEvent({ kind: 'thinking', text: frame.content });
            return;
          case 'text':
            if (requireSession(attempt) && frame.content) onEvent({ kind: 'text', text: frame.content });
            return;
          case 'tool_call':
            handleToolCall(attempt, frame);
            return;
          case 'tool_result':
            handleToolResult(attempt, frame);
            return;
          case 'usage':
            requireSession(attempt);
            return;
          case 'result':
            handleResult(attempt, frame);
            return;
          case 'protocol_error':
            fail({
              code: safeErrorCode(frame.code, 'DSH_PROFILE_PROTOCOL_ERROR'),
              message: 'DeepSeek Harness reported a profile protocol error.',
            });
            return;
        }
      };
      const spawnAttempt = async (resumeSessionId: string | null): Promise<void> => {
        if (!profile) throw new Error('DeepSeek Harness profile is not staged.');
        const environment = runEnvironment(
          baseEnvironment,
          profile.home,
          input,
          options.definition.id,
          [...(options.definition.inheritedEnvKeys ?? []), ...(options.environmentKeys?.() ?? [])],
        );
        const runPrompt = resumeSessionId ? input.resumePrompt : input.prompt;
        const args = options.definition.buildArgs(
          runPrompt,
          [],
          undefined,
          { model: input.model, reasoning: input.reasoning, serviceTier: input.serviceTier },
          { cwd: input.cwd, resumeSessionId },
        );
        const child = (options.spawn ?? defaultSpawn)(options.definition.bin, args, {
          cwd: input.cwd,
          env: environment,
          detached: process.platform !== 'win32',
        });
        if (!child.stdin || !child.stdout) throw new Error('DeepSeek Harness profile stdio is unavailable.');
        const stdin = child.stdin;
        const stdout = child.stdout;
        const attempt: RunAttempt = {
          sequence: sequence += 1,
          child,
          resumeSessionId,
          parser: null as unknown as ReturnType<typeof createDeepSeekProfileFrameStream>,
          ready: false,
          sessionId: null,
          closing: false,
          exited: false,
          stopPromise: null,
          cancelSent: false,
          readyDeadline: null,
          calls: new Map<string, { name: MapToolName; input: unknown }>(),
          completedCalls: new Set<string>(),
        };
        attempt.parser = createDeepSeekProfileFrameStream({
          maxFrameBytes,
          onFrame: (frame) => handleFrame(attempt, frame),
          onError: (error) => {
            if (attempt === currentAttempt && !attempt.closing) {
              fail({ code: error.code, message: error.message });
            }
          },
        });
        currentAttempt = attempt;
        stdin.on('error', () => {
          if (attempt === currentAttempt && !attempt.closing) fail();
        });
        child.stderr?.resume();
        stdout.on('data', (chunk: Buffer | string) => attempt.parser.feed(chunk));
        stdout.on('end', () => {
          attempt.parser.end();
          if (attempt === currentAttempt && !terminal && !attempt.closing && !attempt.parser.failed) fail();
        });
        stdout.on('error', () => {
          if (attempt === currentAttempt && !attempt.closing) fail();
        });
        child.once('close', () => {
          attempt.exited = true;
          if (attempt === currentAttempt && !terminal && !attempt.closing) fail();
        });
        child.once('error', () => {
          if (attempt === currentAttempt && !attempt.closing) fail();
        });
        attempt.readyDeadline = setTimeout(() => {
          if (attempt !== currentAttempt || attempt.ready || attempt.closing || attempt.exited || terminal) return;
          fail({
            code: 'DSH_PROFILE_READY_TIMEOUT',
            message: 'DeepSeek Harness did not become ready in time.',
          });
        }, boundedTimeout(options.readyTimeoutMs));
        attempt.readyDeadline.unref?.();
        if (terminal || cancelRequested || input.signal.aborted) {
          sendCancel(attempt);
          await stopAttempt(attempt);
        }
      };

      if (input.signal.aborted) {
        finish({ status: 'canceled' });
        return handle;
      }
      input.signal.addEventListener('abort', onInputAbort, { once: true });
      try {
        profile = await (options.stageProfile ?? stageDeepSeekProfileBundle)(options.profileRoot);
        if (terminal || cancelRequested || input.signal.aborted) return handle;
        await spawnAttempt(sessionBroker.load(sessionScope));
        return handle;
      } catch {
        input.signal.removeEventListener('abort', onInputAbort);
        sessionBroker.delete(sessionScope);
        await stopAttempt(currentAttempt);
        if (terminal) return handle;
        throw new Error('DeepSeek Harness MapDesign profile unavailable.');
      }
    },
  };
}

export async function probeDeepSeekHarnessNativeMapTools(
  options: CreateDeepSeekHarnessMapAgentAdapterOptions,
): Promise<boolean> {
  const baseEnvironment = options.environment ? options.environment() : process.env;
  if (!baseEnvironment) return false;
  let child: DeepSeekProfileProcess | null = null;
  let exited = false;
  try {
    const profile = await (options.stageProfile ?? stageDeepSeekProfileBundle)(options.profileRoot);
    const definitions = [...options.toolDefinitions()];
    if (definitions.length === 0) return false;
    const environment = probeEnvironment(
      baseEnvironment,
      profile.home,
      definitions,
      [...(options.definition.inheritedEnvKeys ?? []), ...(options.environmentKeys?.() ?? [])],
    );
    child = (options.spawn ?? defaultSpawn)(options.definition.bin, ['--profile', 'map-design', '--probe'], {
      cwd: options.probeCwd ?? process.cwd(),
      env: environment,
      detached: process.platform !== 'win32',
    });
    if (!child.stdout) return false;
    child.stderr?.resume();
    const expected = definitions.map((tool) => tool.name);
    const expectedNames = new Set<string>(expected);
    let probeSeen = false;
    let valid = true;
    const parser = createDeepSeekProfileFrameStream({
      ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
      onFrame(frame) {
        if (probeSeen || frame.type !== 'probe') {
          valid = false;
          return;
        }
        probeSeen = true;
        valid = valid
          && Array.isArray(frame.host_tools)
          && frame.host_tools.length === expected.length
          && frame.host_tools.every((name) => expectedNames.has(name));
      },
      onError() { valid = false; },
    });
    child.stdout.on('data', (chunk: Buffer | string) => parser.feed(chunk));
    child.stdout.on('end', () => parser.end());
    const code = await waitForProcess(child, boundedTimeout(options.probeTimeoutMs));
    exited = true;
    return code === 0 && valid && probeSeen && !parser.failed;
  } catch {
    return false;
  } finally {
    if (child && !exited) await stopDeepSeekProfileProcess(child, options);
  }
}

function runEnvironment(
  base: NodeJS.ProcessEnv,
  home: string,
  input: MapRunInput,
  agentId: string,
  inheritedEnvKeys: readonly string[],
): NodeJS.ProcessEnv {
  const environment = sanitizedEnvironment(base, inheritedEnvKeys);
  return {
    ...environment,
    DSH_HOME: home,
    MAP_DESIGN_TOOL_TOKEN: input.toolCallback.token,
    MAP_DESIGN_PROJECT_ID: input.projectId,
    MAP_DESIGN_CONVERSATION_ID: input.conversationId,
    MAP_DESIGN_AGENT_ID: agentId,
  };
}

function probeEnvironment(
  base: NodeJS.ProcessEnv,
  home: string,
  tools: readonly NativeMapToolDefinition[],
  inheritedEnvKeys: readonly string[],
): NodeJS.ProcessEnv {
  return {
    ...sanitizedEnvironment(base, inheritedEnvKeys),
    DSH_HOME: home,
    MAP_DESIGN_PROFILE_PROBE_TOOLS: JSON.stringify(tools),
  };
}

function sanitizedEnvironment(
  base: NodeJS.ProcessEnv,
  inheritedEnvKeys: readonly string[],
): NodeJS.ProcessEnv {
  return sanitizeMapAgentLaunchEnvironment(base, inheritedEnvKeys);
}

function profileFailure(
  frame: DeepSeekProfileResultFrame,
  fallbackCode = 'DSH_PROFILE_RUN_FAILED',
): { code: string; message: string } {
  return {
    code: safeErrorCode(frame.error?.code, fallbackCode),
    message: 'The DeepSeek Harness Run failed.',
  };
}

function safeErrorCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && SAFE_ERROR_CODE.test(value) ? value : fallback;
}

function summaryError(summary: SafeToolSummary): {
  code: string;
  message: string;
  retryable: boolean;
  details: SafeToolSummary;
} {
  return {
    code: safeErrorCode(summary.code, 'SDK_TOOL_FAILED'),
    message: 'The map tool call failed.',
    retryable: summary.retryable === true,
    details: summary,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveLimit(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? Math.min(value!, DEFAULT_DEEPSEEK_PROFILE_MAX_FRAME_BYTES)
    : DEFAULT_DEEPSEEK_PROFILE_MAX_FRAME_BYTES;
}

function boundedTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? Math.min(value!, MAX_PROBE_TIMEOUT_MS)
    : DEFAULT_PROBE_TIMEOUT_MS;
}

function waitForProcess(child: DeepSeekProfileProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DeepSeek Harness profile probe timed out.')), timeoutMs);
    child.once('close', (code) => { clearTimeout(timer); resolve(code); });
    child.once('error', () => { clearTimeout(timer); reject(new Error('DeepSeek Harness profile probe failed.')); });
  });
}

function stopDeepSeekProfileProcess(
  child: DeepSeekProfileProcess,
  options: CreateDeepSeekHarnessMapAgentAdapterOptions,
): Promise<void> {
  if (options.stopProcess) return options.stopProcess(child).catch(() => undefined);
  return stopMapDesignProcessTree(
    child,
    options.processStopTimeoutMs ?? DEFAULT_PROCESS_STOP_TIMEOUT_MS,
  ).catch(() => undefined);
}

const defaultSpawn: DeepSeekProfileSpawn = (command, args, options) => spawnChild(command, args, {
  ...options,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
