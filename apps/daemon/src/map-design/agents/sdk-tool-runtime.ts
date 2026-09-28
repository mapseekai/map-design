import { SafeToolSummarySchema } from '@mapseekai/contracts';
import { MapToolNameSchema, type MapToolName } from '@mapseekai/map-design-contracts';

import { requestDigest } from '../application/request-digest.js';
import type { AgentToolName } from './types.js';
import type {
  MapDesignNativeToolRegistry,
  MapNativeToolResult,
} from '../tools/tool-context.js';

const MAX_MODEL_CONTENT_BYTES = 256 * 1024;
const MAX_CALLS_PER_RUN = 1_024;
const MAX_CLOSED_RUNS = 1_024;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;

export interface SdkMapToolCall {
  runId: string;
  projectId: string;
  conversationId: string;
  agentId: string;
  toolUseId: string;
  name: AgentToolName;
  input: unknown;
  signal: AbortSignal;
  /** Internal lifecycle hook; duplicate/rejected calls never receive it. */
  activity?: (phase: 'admitted' | 'completed') => void;
}

export interface SdkMapToolRuntime {
  execute(call: SdkMapToolCall): Promise<MapNativeToolResult>;
  closeRun(runId: string): void;
}

type RunAuthority = Pick<SdkMapToolCall, 'projectId' | 'conversationId' | 'agentId'>;
type CachedCall = { signature: string; result: Promise<MapNativeToolResult> };

export function createSdkMapToolRuntime(
  registry: MapDesignNativeToolRegistry,
): SdkMapToolRuntime {
  const definitions = new Set(registry.definitions().map((definition) => definition.name));
  const runAuthorities = new Map<string, RunAuthority>();
  const runCalls = new Map<string, Map<string, CachedCall>>();
  const closedRuns = new Map<string, true>();

  return {
    execute(call) {
      const toolUseId = safeIdentifier(call.toolUseId) ?? 'invalid-tool-call';
      if (closedRuns.has(call.runId)) return Promise.resolve(failure(toolUseId, 'RUN_CLOSED', 'The map tool Run is closed.'));
      if (!validCallContext(call)) return Promise.resolve(failure(toolUseId, 'INVALID_INPUT', 'The map tool input is invalid.'));
      const mapToolName = MapToolNameSchema.safeParse(call.name);
      if (!mapToolName.success || !definitions.has(mapToolName.data)) {
        return Promise.resolve(failure(toolUseId, 'UNKNOWN_TOOL', 'The map tool call is not registered.'));
      }
      if (call.signal.aborted) return Promise.resolve(canceled(toolUseId));

      const authority = runAuthorities.get(call.runId);
      if (authority && !sameAuthority(authority, call)) {
        return Promise.resolve(failure(toolUseId, 'RUN_NOT_AUTHORIZED', 'The map tool Run is not authorized.'));
      }

      let signature: string;
      try {
        signature = requestDigest({ name: call.name, input: call.input });
      } catch {
        return Promise.resolve(failure(toolUseId, 'INVALID_INPUT', 'The map tool input is invalid.'));
      }
      const calls = runCalls.get(call.runId) ?? new Map<string, CachedCall>();
      const existing = calls.get(call.toolUseId);
      if (existing) {
        return existing.signature === signature
          ? existing.result.then(cloneResult)
          : Promise.resolve(failure(toolUseId, 'DUPLICATE_TOOL_CALL', 'The map tool call identifier was reused.'));
      }
      if (calls.size >= MAX_CALLS_PER_RUN) {
        return Promise.resolve(failure(toolUseId, 'TOOL_CALL_LIMIT', 'The map tool call limit was reached.'));
      }

      runAuthorities.set(call.runId, {
        projectId: call.projectId,
        conversationId: call.conversationId,
        agentId: call.agentId,
      });
      runCalls.set(call.runId, calls);
      const result = Promise.resolve().then(async () => {
        if (closedRuns.has(call.runId)) {
          return failure(call.toolUseId, 'RUN_CLOSED', 'The map tool Run is closed.');
        }
        if (call.signal.aborted) return canceled(call.toolUseId);
        reportActivity(call, 'admitted');
        try {
          const value = await executeRegistryCall(registry, call, mapToolName.data);
          return cloneResult(safeResult(value, call.toolUseId));
        } finally {
          reportActivity(call, 'completed');
        }
      });
      calls.set(call.toolUseId, { signature, result });
      return result.then(cloneResult);
    },
    closeRun(runId) {
      runAuthorities.delete(runId);
      runCalls.delete(runId);
      closedRuns.delete(runId);
      closedRuns.set(runId, true);
      while (closedRuns.size > MAX_CLOSED_RUNS) {
        const oldest = closedRuns.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        closedRuns.delete(oldest);
      }
    },
  };
}

async function executeRegistryCall(
  registry: MapDesignNativeToolRegistry,
  call: SdkMapToolCall,
  name: MapToolName,
): Promise<MapNativeToolResult> {
  try {
    return await registry.call({
      runId: call.runId,
      projectId: call.projectId,
      conversationId: call.conversationId,
      toolUseId: call.toolUseId,
      signal: call.signal,
    }, name, call.input);
  } catch {
    return failure(call.toolUseId, 'SDK_TOOL_FAILED', 'The map tool call failed safely.');
  }
}

function safeResult(result: unknown, toolUseId: string): MapNativeToolResult {
  const candidate = record(result);
  if (!candidate || candidate.toolUseId !== toolUseId || typeof candidate.ok !== 'boolean') {
    return failure(toolUseId, 'TOOL_PROTOCOL_ERROR', 'The map tool returned an invalid result.');
  }
  if (candidate.ok) {
    const summary = SafeToolSummarySchema.safeParse(candidate.summary);
    if (!summary.success) return failure(toolUseId, 'TOOL_PROTOCOL_ERROR', 'The map tool returned an invalid result.');
    if (candidate.modelContent !== undefined) {
      if (typeof candidate.modelContent !== 'string'
        || Buffer.byteLength(candidate.modelContent, 'utf8') > MAX_MODEL_CONTENT_BYTES) {
        return failure(toolUseId, 'TOOL_RESULT_TOO_LARGE', 'The map tool result is too large.');
      }
    }
    return {
      ok: true,
      toolUseId,
      summary: summary.data,
      ...(candidate.modelContent === undefined ? {} : { modelContent: candidate.modelContent }),
    };
  }
  const error = record(candidate.error);
  if (!error) return failure(toolUseId, 'TOOL_PROTOCOL_ERROR', 'The map tool returned an invalid result.');
  const details = error.details === undefined
    ? undefined
    : SafeToolSummarySchema.safeParse(error.details);
  if (
    typeof error.code !== 'string'
    || !SAFE_ERROR_CODE.test(error.code)
    || typeof error.message !== 'string'
    || Buffer.byteLength(error.message, 'utf8') > 2_048
    || typeof error.retryable !== 'boolean'
    || (details !== undefined && !details.success)
  ) {
    return failure(toolUseId, 'TOOL_PROTOCOL_ERROR', 'The map tool returned an invalid result.');
  }
  return {
    ok: false,
    toolUseId,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(details?.success ? { details: details.data } : {}),
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validCallContext(call: SdkMapToolCall): boolean {
  return safeIdentifier(call.runId) === call.runId
    && safeIdentifier(call.projectId) === call.projectId
    && safeIdentifier(call.conversationId) === call.conversationId
    && safeIdentifier(call.agentId) === call.agentId
    && safeIdentifier(call.toolUseId) === call.toolUseId
    && call.signal instanceof AbortSignal
    && (call.activity === undefined || typeof call.activity === 'function');
}

function reportActivity(call: SdkMapToolCall, phase: 'admitted' | 'completed'): void {
  try {
    call.activity?.(phase);
  } catch {
    // Observability must never change the tool result or duplicate semantics.
  }
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\r\n\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function sameAuthority(authority: RunAuthority, call: SdkMapToolCall): boolean {
  return authority.projectId === call.projectId
    && authority.conversationId === call.conversationId
    && authority.agentId === call.agentId;
}

function failure(
  toolUseId: string,
  code: string,
  message: string,
): MapNativeToolResult {
  return { ok: false, toolUseId, error: { code, message, retryable: false } };
}

function canceled(toolUseId: string): MapNativeToolResult {
  return failure(toolUseId, 'CANCELED', 'The map tool call was canceled.');
}

function cloneResult(result: MapNativeToolResult): MapNativeToolResult {
  return structuredClone(result);
}
