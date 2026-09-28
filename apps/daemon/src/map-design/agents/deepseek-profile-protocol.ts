import { Buffer } from 'node:buffer';

import { SafeToolSummarySchema, type SafeToolSummary } from '@mapseekai/contracts';

import type { AgentToolDefinition } from './types.js';

export const DEEPSEEK_PROFILE_PROTOCOL_VERSION = 1 as const;
export const DEEPSEEK_PROFILE_RUNTIME = 'map-design' as const;
export const DEEPSEEK_PROFILE_TOKEN_ENV = 'MAP_DESIGN_TOOL_TOKEN' as const;
export const DEFAULT_DEEPSEEK_PROFILE_MAX_FRAME_BYTES = 1_048_576;

export type DeepSeekProfileCapabilities = {
  session_resume: true;
  session_cancel: true;
  structured_events: true;
  native_host_tools: true;
  authenticated_callback: true;
};

export type DeepSeekProfileCallbackDescriptor = {
  url: string;
  tokenEnv: typeof DEEPSEEK_PROFILE_TOKEN_ENV;
};

export type DeepSeekProfileExecuteCommand = {
  v: 1;
  type: 'execute';
  request_id: string;
  cwd: string;
  prompt: string;
  resume_session_id?: string;
  model?: { provider: string; id: string };
  reasoning_effort?: string;
  host_tools: AgentToolDefinition[];
  callback: DeepSeekProfileCallbackDescriptor;
};

export type DeepSeekProfileCancelCommand = {
  v: 1;
  type: 'cancel';
  request_id: string;
};

export type DeepSeekProfileHostCommand =
  | DeepSeekProfileExecuteCommand
  | DeepSeekProfileCancelCommand;

export type DeepSeekProfileIdentityFrame = {
  v: 1;
  type: 'ready' | 'probe';
  runtime: 'map-design';
  protocol_version: 1;
  plugin_version: string;
  capabilities: DeepSeekProfileCapabilities;
  host_tools?: string[];
};

export type DeepSeekProfileSessionFrame = {
  v: 1;
  type: 'session';
  request_id: string;
  session_id: string;
  resumed: boolean;
};

export type DeepSeekProfileContentFrame = {
  v: 1;
  type: 'thinking' | 'text';
  request_id: string;
  content: string;
};

export type DeepSeekProfileToolCallFrame = {
  v: 1;
  type: 'tool_call';
  request_id: string;
  call_id: string;
  name: string;
  arguments: string;
};

export type DeepSeekProfileToolResultFrame = {
  v: 1;
  type: 'tool_result';
  request_id: string;
  call_id: string;
  name: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  summary: SafeToolSummary;
};

export type DeepSeekProfileUsageFrame = {
  v: 1;
  type: 'usage';
  request_id: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
};

export type DeepSeekProfileResultFrame = {
  v: 1;
  type: 'result';
  request_id: string;
  status: 'completed' | 'cancelled' | 'failed';
  session_id: string;
  resume_rejected: boolean;
  output?: string;
  stop_reason?: string;
  error?: { code: string; message: string };
};

export type DeepSeekProfileProtocolErrorFrame = {
  v: 1;
  type: 'protocol_error';
  request_id?: string;
  code: string;
  message: string;
};

export type DeepSeekProfileRuntimeFrame =
  | DeepSeekProfileIdentityFrame
  | DeepSeekProfileSessionFrame
  | DeepSeekProfileContentFrame
  | DeepSeekProfileToolCallFrame
  | DeepSeekProfileToolResultFrame
  | DeepSeekProfileUsageFrame
  | DeepSeekProfileResultFrame
  | DeepSeekProfileProtocolErrorFrame;

export type DeepSeekProfileStreamErrorCode =
  | 'DSH_PROFILE_FRAME_TOO_LARGE'
  | 'DSH_PROFILE_MALFORMED_FRAME'
  | 'DSH_PROFILE_INVALID_FRAME'
  | 'DSH_PROFILE_TRUNCATED_FRAME';

export type DeepSeekProfileStreamError = {
  code: DeepSeekProfileStreamErrorCode;
  message: string;
  line: number;
};

type JsonObject = Record<string, unknown>;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_EVENT_TEXT_LENGTH = 65_536;
const MAX_COMPOSED_PROMPT_BYTES = 512 * 1_024;
const IDENTITY_CAPABILITIES: DeepSeekProfileCapabilities = {
  session_resume: true,
  session_cancel: true,
  structured_events: true,
  native_host_tools: true,
  authenticated_callback: true,
};

export class DeepSeekProfileProtocolError extends Error {
  constructor(message = 'Invalid DeepSeek Harness MapDesign profile protocol.') {
    super(message);
    this.name = 'DeepSeekProfileProtocolError';
  }
}

export function createDeepSeekProfileExecuteCommand(input: {
  requestId: string;
  cwd: string;
  prompt: string;
  model?: string | null;
  reasoningEffort?: string | null;
  resumeSessionId?: string | null;
  tools: readonly AgentToolDefinition[];
  callbackUrl: string;
}): DeepSeekProfileExecuteCommand {
  const requestId = requireIdentifier(input.requestId, 'request_id');
  const cwd = requireText(input.cwd, 'cwd', 4_096, false);
  const prompt = requireByteText(input.prompt, 'prompt', MAX_COMPOSED_PROMPT_BYTES, true);
  const resumeSessionId = input.resumeSessionId
    ? requireIdentifier(input.resumeSessionId, 'resume_session_id')
    : undefined;
  const reasoningEffort = input.reasoningEffort && input.reasoningEffort !== 'default'
    ? requireIdentifier(input.reasoningEffort, 'reasoning_effort')
    : undefined;
  const selectedModel = splitModel(input.model);
  const callbackUrl = requireLoopbackUrl(input.callbackUrl);
  const tools = input.tools.map(cloneToolDefinition);
  requireUniqueToolNames(tools);
  return {
    v: DEEPSEEK_PROFILE_PROTOCOL_VERSION,
    type: 'execute',
    request_id: requestId,
    cwd,
    prompt,
    ...(resumeSessionId ? { resume_session_id: resumeSessionId } : {}),
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    host_tools: tools,
    callback: { url: callbackUrl, tokenEnv: DEEPSEEK_PROFILE_TOKEN_ENV },
  };
}

export function createDeepSeekProfileCancelCommand(requestId: string): DeepSeekProfileCancelCommand {
  return {
    v: DEEPSEEK_PROFILE_PROTOCOL_VERSION,
    type: 'cancel',
    request_id: requireIdentifier(requestId, 'request_id'),
  };
}

export function parseDeepSeekProfileRuntimeFrame(value: unknown): DeepSeekProfileRuntimeFrame {
  const frame = requireObject(value, 'frame');
  if (frame.v !== DEEPSEEK_PROFILE_PROTOCOL_VERSION) {
    throw new DeepSeekProfileProtocolError('The DeepSeek profile protocol version is unsupported.');
  }
  const type = requireIdentifier(frame.type, 'type');
  switch (type) {
    case 'ready':
      assertExactKeys(frame, ['v', 'type', 'runtime', 'protocol_version', 'plugin_version', 'capabilities']);
      validateIdentity(frame);
      break;
    case 'probe':
      assertExactKeys(frame, ['v', 'type', 'runtime', 'protocol_version', 'plugin_version', 'capabilities', 'host_tools']);
      validateIdentity(frame);
      stringArray(frame.host_tools, 'host_tools');
      break;
    case 'session':
      assertExactKeys(frame, ['v', 'type', 'request_id', 'session_id', 'resumed']);
      requireRequestId(frame);
      requireIdentifier(frame.session_id, 'session_id');
      requireBoolean(frame.resumed, 'resumed');
      break;
    case 'thinking':
    case 'text':
      assertExactKeys(frame, ['v', 'type', 'request_id', 'content']);
      requireRequestId(frame);
      requireText(frame.content, 'content', MAX_EVENT_TEXT_LENGTH, true);
      break;
    case 'tool_call':
      assertExactKeys(frame, ['v', 'type', 'request_id', 'call_id', 'name', 'arguments']);
      requireRequestId(frame);
      requireIdentifier(frame.call_id, 'call_id');
      requireIdentifier(frame.name, 'name');
      requireText(frame.arguments, 'arguments', MAX_EVENT_TEXT_LENGTH, true);
      break;
    case 'tool_result': {
      assertExactKeys(frame, ['v', 'type', 'request_id', 'call_id', 'name', 'status', 'summary']);
      requireRequestId(frame);
      requireIdentifier(frame.call_id, 'call_id');
      requireIdentifier(frame.name, 'name');
      if (!['succeeded', 'failed', 'cancelled'].includes(String(frame.status))) {
        throw new DeepSeekProfileProtocolError('The tool_result status is unsupported.');
      }
      if (!SafeToolSummarySchema.safeParse(frame.summary).success) {
        throw new DeepSeekProfileProtocolError('The tool_result summary is invalid.');
      }
      break;
    }
    case 'usage':
      assertExactKeys(frame, [
        'v', 'type', 'request_id', 'provider', 'model', 'input_tokens', 'output_tokens',
        'cache_read_tokens', 'cache_write_tokens',
      ], ['cache_read_tokens', 'cache_write_tokens']);
      requireRequestId(frame);
      requireIdentifier(frame.provider, 'provider');
      requireIdentifier(frame.model, 'model');
      requireTokenCount(frame.input_tokens, 'input_tokens');
      requireTokenCount(frame.output_tokens, 'output_tokens');
      if (frame.cache_read_tokens !== undefined) requireTokenCount(frame.cache_read_tokens, 'cache_read_tokens');
      if (frame.cache_write_tokens !== undefined) requireTokenCount(frame.cache_write_tokens, 'cache_write_tokens');
      break;
    case 'result': {
      assertExactKeys(frame, [
        'v', 'type', 'request_id', 'status', 'session_id', 'resume_rejected',
        'output', 'stop_reason', 'error',
      ], ['output', 'stop_reason', 'error']);
      requireRequestId(frame);
      if (!['completed', 'cancelled', 'failed'].includes(String(frame.status))) {
        throw new DeepSeekProfileProtocolError('The result status is unsupported.');
      }
      requireIdentifier(frame.session_id, 'session_id');
      requireBoolean(frame.resume_rejected, 'resume_rejected');
      if (frame.output !== undefined) requireText(frame.output, 'output', 512 * 1024, true);
      if (frame.stop_reason !== undefined) requireIdentifier(frame.stop_reason, 'stop_reason');
      if (frame.error !== undefined) validateWireError(frame.error);
      if (frame.status === 'failed' && frame.error === undefined) {
        throw new DeepSeekProfileProtocolError('A failed result must include an error.');
      }
      break;
    }
    case 'protocol_error':
      assertExactKeys(frame, ['v', 'type', 'request_id', 'code', 'message'], ['request_id']);
      if (frame.request_id !== undefined) requireIdentifier(frame.request_id, 'request_id');
      requireIdentifier(frame.code, 'code');
      requireText(frame.message, 'message', 2_048, false);
      break;
    default:
      throw new DeepSeekProfileProtocolError('The DeepSeek profile frame type is unsupported.');
  }
  return frame as DeepSeekProfileRuntimeFrame;
}

export function createDeepSeekProfileFrameStream(options: {
  onFrame(frame: DeepSeekProfileRuntimeFrame): void;
  onError(error: DeepSeekProfileStreamError): void;
  maxFrameBytes?: number;
}): {
  feed(chunk: Buffer | string | Uint8Array): void;
  end(): void;
  readonly failed: boolean;
} {
  const limit = positiveLimit(options.maxFrameBytes);
  let buffer = Buffer.alloc(0);
  let line = 0;
  let failed = false;
  const fail = (code: DeepSeekProfileStreamErrorCode, message: string, errorLine: number): void => {
    if (failed) return;
    failed = true;
    buffer = Buffer.alloc(0);
    options.onError({ code, message, line: errorLine });
  };
  const parseLine = (bytes: Buffer): void => {
    line += 1;
    const normalized = bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
    if (normalized.length === 0 || normalized.toString('utf8').trim() === '') return;
    if (normalized.length > limit) {
      fail('DSH_PROFILE_FRAME_TOO_LARGE', 'DeepSeek Harness emitted an oversized profile frame.', line);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(normalized.toString('utf8')) as unknown;
    } catch {
      fail('DSH_PROFILE_MALFORMED_FRAME', 'DeepSeek Harness emitted malformed profile JSON.', line);
      return;
    }
    try {
      options.onFrame(parseDeepSeekProfileRuntimeFrame(value));
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'frame validation failed';
      fail('DSH_PROFILE_INVALID_FRAME', `DeepSeek Harness emitted an invalid profile frame: ${detail}`, line);
    }
  };
  return {
    feed(chunk) {
      if (failed) return;
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      buffer = buffer.length === 0 ? bytes : Buffer.concat([buffer, bytes]);
      while (!failed) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        if (newline > limit) {
          fail('DSH_PROFILE_FRAME_TOO_LARGE', 'DeepSeek Harness emitted an oversized profile frame.', line + 1);
          break;
        }
        const current = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        parseLine(current);
      }
      if (!failed && buffer.length > limit) {
        fail('DSH_PROFILE_FRAME_TOO_LARGE', 'DeepSeek Harness emitted an oversized profile frame.', line + 1);
      }
    },
    end() {
      if (failed || buffer.length === 0) return;
      if (buffer.toString('utf8').trim() === '') {
        buffer = Buffer.alloc(0);
        return;
      }
      fail('DSH_PROFILE_TRUNCATED_FRAME', 'DeepSeek Harness ended with a truncated profile frame.', line + 1);
    },
    get failed() {
      return failed;
    },
  };
}

function validateIdentity(frame: JsonObject): void {
  if (frame.runtime !== DEEPSEEK_PROFILE_RUNTIME) {
    throw new DeepSeekProfileProtocolError('The DeepSeek profile runtime identity is invalid.');
  }
  if (frame.protocol_version !== DEEPSEEK_PROFILE_PROTOCOL_VERSION) {
    throw new DeepSeekProfileProtocolError('The DeepSeek profile protocol version is unsupported.');
  }
  requireIdentifier(frame.plugin_version, 'plugin_version');
  const capabilities = requireObject(frame.capabilities, 'capabilities');
  assertExactKeys(capabilities, Object.keys(IDENTITY_CAPABILITIES));
  for (const [name, expected] of Object.entries(IDENTITY_CAPABILITIES)) {
    if (capabilities[name] !== expected) {
      throw new DeepSeekProfileProtocolError('The DeepSeek profile capabilities are incomplete.');
    }
  }
}

function validateWireError(value: unknown): void {
  const error = requireObject(value, 'error');
  assertExactKeys(error, ['code', 'message']);
  requireIdentifier(error.code, 'error.code');
  requireText(error.message, 'error.message', 2_048, false);
}

function cloneToolDefinition(value: AgentToolDefinition): AgentToolDefinition {
  const tool = requireObject(value, 'host tool');
  assertExactKeys(tool, ['name', 'description', 'inputSchema']);
  const name = requireIdentifier(tool.name, 'host tool name') as AgentToolDefinition['name'];
  const description = requireText(tool.description, 'host tool description', 4_096, false);
  const inputSchema = requireObject(tool.inputSchema, 'host tool input schema');
  let cloned: Record<string, unknown>;
  try {
    cloned = structuredClone(inputSchema);
    JSON.stringify(cloned);
  } catch {
    throw new DeepSeekProfileProtocolError('The host tool input schema is not serializable.');
  }
  return { name, description, inputSchema: cloned };
}

function requireUniqueToolNames(tools: readonly AgentToolDefinition[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new DeepSeekProfileProtocolError('Host tool names must be unique.');
    names.add(tool.name);
  }
}

function splitModel(value: string | null | undefined): { provider: string; id: string } | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized === 'default') return undefined;
  const separator = normalized.indexOf('/');
  if (separator <= 0 || separator === normalized.length - 1) {
    throw new DeepSeekProfileProtocolError('The DeepSeek Harness model must use provider/model format.');
  }
  return {
    provider: requireIdentifier(normalized.slice(0, separator), 'model provider'),
    id: requireIdentifier(normalized.slice(separator + 1), 'model id'),
  };
}

function requireLoopbackUrl(value: unknown): string {
  const raw = requireText(value, 'callback url', 2_048, false);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DeepSeekProfileProtocolError('The DeepSeek profile callback URL is invalid.');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(hostname)
    || url.username
    || url.password
  ) {
    throw new DeepSeekProfileProtocolError('The DeepSeek profile callback URL must use loopback transport.');
  }
  return url.toString().replace(/\/$/u, '');
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeepSeekProfileProtocolError(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function requireRequestId(frame: JsonObject): string {
  return requireIdentifier(frame.request_id, 'request_id');
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_IDENTIFIER_LENGTH
    || /[\r\n\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new DeepSeekProfileProtocolError(`${label} must be a safe non-empty identifier.`);
  }
  return value;
}

function requireText(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximumLength) {
    throw new DeepSeekProfileProtocolError(`${label} must be bounded text.`);
  }
  return value;
}

function requireByteText(
  value: unknown,
  label: string,
  maximumBytes: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new DeepSeekProfileProtocolError(`${label} must be bounded text.`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new DeepSeekProfileProtocolError(`${label} must be a boolean.`);
  return value;
}

function requireTokenCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DeepSeekProfileProtocolError(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new DeepSeekProfileProtocolError(`${label} must be an array.`);
  const result = value.map((item) => requireIdentifier(item, `${label} item`));
  if (new Set(result).size !== result.length) {
    throw new DeepSeekProfileProtocolError(`${label} must contain unique identifiers.`);
  }
  return result;
}

function assertExactKeys(
  value: JsonObject,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new DeepSeekProfileProtocolError('The DeepSeek profile frame contains unsupported fields.');
  }
  const optionalKeys = new Set(optional);
  if (allowed.some((key) => !optionalKeys.has(key) && !Object.hasOwn(value, key))) {
    throw new DeepSeekProfileProtocolError('The DeepSeek profile frame is missing required fields.');
  }
}

function positiveLimit(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? Math.min(value!, DEFAULT_DEEPSEEK_PROFILE_MAX_FRAME_BYTES)
    : DEFAULT_DEEPSEEK_PROFILE_MAX_FRAME_BYTES;
}
