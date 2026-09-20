import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PROFILE_NAME = 'map-design';
const PROFILE_PACKAGE_NAME = '@mapseekai/dsh-map-design-runtime';
const PROFILE_VERSION = '1.0.0';
const PROFILE_LAYOUT_VERSION = 'v1';

const PROFILE_PACKAGE_JSON = `${JSON.stringify({
  name: 'map-design-dsh-profile',
  private: true,
  dependencies: { [PROFILE_PACKAGE_NAME]: PROFILE_VERSION },
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', PROFILE_PACKAGE_NAME],
    },
  },
}, null, 2)}\n`;

const RUNTIME_PACKAGE_JSON = `${JSON.stringify({
  name: PROFILE_PACKAGE_NAME,
  version: PROFILE_VERSION,
  private: true,
  type: 'module',
  exports: {
    '.': './runtime.mjs',
    './startup': './startup.mjs',
    './bridge': './bridge.mjs',
  },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2)}\n`;

const PROFILE_PATCH = `# MapDesign's daemon-owned DeepSeek Harness profile surface.
- id: system-prompt
  config:
    persona: >-
      You are a map-design agent running for MapDesign. Use only the registered
      MapDesign host tools to inspect, edit, validate, preview, and commit maps.

- id: hmr
  disabled: true

- insert:
    - id: map-design-startup
      name: '${PROFILE_PACKAGE_NAME}/startup'

    - id: map-design-runtime
      name: '${PROFILE_PACKAGE_NAME}'
      inject: [mapDesignStartup]
`;

const STARTUP_SOURCE = `export const name = 'map-design-startup';
export const inject = ['cmdlineArgs'];

export function apply(ctx) {
  const cmdline = ctx.get('cmdlineArgs');
  const exit = ctx.get('appExit');
  if (!cmdline || typeof cmdline.get !== 'function' || typeof exit !== 'function') {
    throw new Error('map-design-startup requires cmdlineArgs and appExit services');
  }
  const args = [...cmdline.get()];
  const modes = new Map([
    ['--models', 'models'],
    ['--probe', 'probe'],
    ['--stdio', 'stdio'],
  ]);
  const mode = args.length === 1 ? modes.get(args[0]) : undefined;
  if (!mode) {
    process.stderr.write('dsh --profile map-design: exactly one of --models, --probe, or --stdio is required\\n');
    exit(2);
    return;
  }
  ctx.provide('mapDesignStartup', { mode });
}
`;

const BRIDGE_SOURCE = `const MAX_BODY_BYTES = 262144;
const MAX_COMPOSED_PROMPT_BYTES = 524288;
const MAX_IDENTIFIER_LENGTH = 256;
const TOKEN_ENV = 'MAP_DESIGN_TOOL_TOKEN';
const RUN_HEADER = 'x-map-design-run-id';
const PROJECT_HEADER = 'x-map-design-project-id';
const CONVERSATION_HEADER = 'x-map-design-conversation-id';
const AGENT_HEADER = 'x-map-design-agent-id';
const TOOL_USE_HEADER = 'x-map-design-tool-use-id';

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object.');
  return value;
}

function identifier(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH || /[\\r\\n\\u0000-\\u001f\\u007f]/u.test(value)) {
    throw new Error(label + ' must be a safe identifier.');
  }
  return value;
}

function text(value, label, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || new TextEncoder().encode(value).byteLength > MAX_BODY_BYTES) {
    throw new Error(label + ' must be bounded text.');
  }
  return value;
}

function promptText(value) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_COMPOSED_PROMPT_BYTES) {
    throw new Error('prompt must be bounded text.');
  }
  return value;
}

function exactKeys(value, allowed, optional = []) {
  const keys = new Set(allowed);
  const optionalKeys = new Set(optional);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new Error('Unsupported profile command field.');
  if (allowed.some((key) => !optionalKeys.has(key) && !Object.hasOwn(value, key))) throw new Error('Missing profile command field.');
}

function loopbackUrl(value) {
  const url = new URL(text(value, 'callback url'));
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(hostname) || url.username || url.password) {
    throw new Error('The callback URL must use loopback transport.');
  }
  return url.toString().replace(/\\/$/u, '');
}

function cloneJson(value, label) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new Error(label + ' is not serializable.'); }
  if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > MAX_BODY_BYTES) {
    throw new Error(label + ' is too large.');
  }
  return JSON.parse(encoded);
}

function hostTools(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1024) throw new Error('host_tools must be a bounded non-empty array.');
  const names = new Set();
  return value.map((candidate) => {
    const tool = record(candidate, 'host tool');
    exactKeys(tool, ['name', 'description', 'inputSchema']);
    const name = identifier(tool.name, 'host tool name');
    if (names.has(name)) throw new Error('host tool names must be unique.');
    names.add(name);
    return {
      name,
      description: text(tool.description, 'host tool description'),
      inputSchema: cloneJson(record(tool.inputSchema, 'host tool input schema'), 'host tool input schema'),
    };
  });
}

function callbackDescriptor(value) {
  const callback = record(value, 'callback');
  exactKeys(callback, ['url', 'tokenEnv']);
  if (callback.tokenEnv !== TOKEN_ENV) throw new Error('The callback token environment name is invalid.');
  return { url: loopbackUrl(callback.url), tokenEnv: TOKEN_ENV };
}

function modelSelection(value) {
  if (value === undefined) return undefined;
  const model = record(value, 'model');
  exactKeys(model, ['provider', 'id']);
  return { provider: identifier(model.provider, 'model provider'), id: identifier(model.id, 'model id') };
}

export function parseMapDesignHostCommand(value) {
  const input = record(value, 'command');
  if (input.v !== 1) throw new Error('Unsupported profile protocol version.');
  if (input.type === 'cancel') {
    exactKeys(input, ['v', 'type', 'request_id']);
    return { v: 1, type: 'cancel', request_id: identifier(input.request_id, 'request_id') };
  }
  if (input.type !== 'execute') throw new Error('Unsupported profile command type.');
  exactKeys(input, [
    'v', 'type', 'request_id', 'cwd', 'prompt', 'resume_session_id', 'model',
    'reasoning_effort', 'host_tools', 'callback',
  ], ['resume_session_id', 'model', 'reasoning_effort']);
  const model = modelSelection(input.model);
  return {
    v: 1,
    type: 'execute',
    request_id: identifier(input.request_id, 'request_id'),
    cwd: text(input.cwd, 'cwd'),
    prompt: promptText(input.prompt),
    host_tools: hostTools(input.host_tools),
    callback: callbackDescriptor(input.callback),
    ...(input.resume_session_id === undefined ? {} : { resume_session_id: identifier(input.resume_session_id, 'resume_session_id') }),
    ...(model === undefined ? {} : { model }),
    ...(input.reasoning_effort === undefined ? {} : { reasoning_effort: identifier(input.reasoning_effort, 'reasoning_effort') }),
  };
}

function requiredEnvironment(environment, name) {
  return identifier(environment[name], name);
}

function safeError(error, fallbackCode, fallbackMessage) {
  const candidate = error && typeof error === 'object' ? error : {};
  const code = typeof candidate.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(candidate.code)
    ? candidate.code
    : fallbackCode;
  const message = typeof candidate.message === 'string' && candidate.message.length > 0 && candidate.message.length <= 2048
    ? candidate.message
    : fallbackMessage;
  return {
    code,
    message,
    retryable: candidate.retryable === true,
    ...(candidate.details && typeof candidate.details === 'object' && !Array.isArray(candidate.details)
      ? { details: cloneJson(candidate.details, 'error details') }
      : {}),
  };
}

async function boundedResponse(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('MapDesign callback result is too large.');
  if (!response.body || typeof response.body.getReader !== 'function') {
    const value = await response.text();
    if (new TextEncoder().encode(value).byteLength > MAX_BODY_BYTES) throw new Error('MapDesign callback result is too large.');
    return value;
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
      throw new Error('MapDesign callback result is too large.');
    }
    chunks.push(item.value);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

function resultSummary(value) {
  return cloneJson(record(value, 'tool summary'), 'tool summary');
}

export function registerMapDesignHostTools({
  tools,
  request: rawRequest,
  environment,
  onToolResult,
  fetchImpl = globalThis.fetch,
}) {
  if (!tools || typeof tools.register !== 'function' || typeof onToolResult !== 'function' || typeof fetchImpl !== 'function') {
    throw new Error('MapDesign host-tool runtime is unavailable.');
  }
  const request = rawRequest && rawRequest.type === 'execute'
    ? parseMapDesignHostCommand(rawRequest)
    : rawRequest;
  const callback = callbackDescriptor(request.callback);
  const token = requiredEnvironment(environment, callback.tokenEnv);
  const projectId = requiredEnvironment(environment, 'MAP_DESIGN_PROJECT_ID');
  const conversationId = requiredEnvironment(environment, 'MAP_DESIGN_CONVERSATION_ID');
  const agentId = requiredEnvironment(environment, 'MAP_DESIGN_AGENT_ID');
  const seenCallIds = new Set();
  const disposers = [];
  try {
    for (const tool of hostTools(request.host_tools)) {
      const definition = {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(input, execution) {
          const callId = identifier(execution?.callId, 'tool call id');
          if (seenCallIds.has(callId)) throw new Error('Duplicate MapDesign tool call identifier.');
          seenCallIds.add(callId);
          let reported = false;
          const report = (status, summary) => {
            if (reported) return;
            reported = true;
            onToolResult({ call_id: callId, name: tool.name, status, summary });
          };
          try {
            const body = JSON.stringify(cloneJson(input, 'tool input'));
            const response = await fetchImpl(callback.url + '/' + encodeURIComponent(tool.name), {
              method: 'POST',
              headers: {
                authorization: 'Bearer ' + token,
                'content-type': 'application/json',
                [RUN_HEADER]: request.request_id,
                [PROJECT_HEADER]: projectId,
                [CONVERSATION_HEADER]: conversationId,
                [AGENT_HEADER]: agentId,
                [TOOL_USE_HEADER]: callId,
              },
              body,
              signal: execution.signal,
            });
            if (!response.ok) throw new Error('The MapDesign callback failed.');
            let result;
            try { result = JSON.parse(await boundedResponse(response)); } catch { throw new Error('The MapDesign callback returned invalid JSON.'); }
            result = record(result, 'callback result');
            if (result.toolUseId !== callId || typeof result.ok !== 'boolean') throw new Error('The MapDesign callback result is not correlated.');
            if (result.ok) {
              const summary = resultSummary(result.summary);
              const modelContent = result.modelContent === undefined
                ? JSON.stringify(summary)
                : text(result.modelContent, 'model content', true);
              report('succeeded', summary);
              return modelContent;
            }
            const failure = safeError(result.error, 'SDK_TOOL_FAILED', 'The map tool call failed safely.');
            const status = failure.code === 'CANCELED' || failure.code === 'CANCELLED' ? 'cancelled' : 'failed';
            report(status, { ...(failure.details ?? {}), code: failure.code, retryable: failure.retryable });
            throw Object.assign(new Error(JSON.stringify(failure)), { reported: true });
          } catch (error) {
            if (!reported) {
              const canceled = execution?.signal?.aborted === true;
              report(canceled ? 'cancelled' : 'failed', {
                code: canceled ? 'CANCELED' : 'SDK_TOOL_FAILED',
                retryable: false,
              });
            }
            if (error && typeof error === 'object' && error.reported === true) throw error;
            throw new Error('The MapDesign host tool failed safely.');
          }
        },
      };
      disposers.push(tools.register(definition));
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch {}
    }
    throw error;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch {}
    }
  };
}
`;

const RUNTIME_SOURCE = `import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { parseMapDesignHostCommand, registerMapDesignHostTools } from './bridge.mjs';

export const name = 'map-design-runtime';
export const inject = [
  'mapDesignStartup',
  'agentDefaultModel',
  'agents',
  'llm',
  'sessions',
  'sessionPersistence',
  'tools',
];

const PLUGIN_VERSION = '${PROFILE_VERSION}';
const CAPABILITIES = {
  session_resume: true,
  session_cancel: true,
  structured_events: true,
  native_host_tools: true,
  authenticated_callback: true,
};
const MAX_TEXT_FRAME_CHARACTERS = 65536;

function writeFrame(output, frame) {
  output.write(JSON.stringify(frame) + '\\n');
}

function textFrameChunks(value) {
  const chunks = [];
  let characters = [];
  let length = 0;
  for (const character of value) {
    const nextLength = length + character.length;
    if (length > 0 && nextLength > MAX_TEXT_FRAME_CHARACTERS) {
      chunks.push(characters.join(''));
      characters = [];
      length = 0;
    }
    characters.push(character);
    length += character.length;
  }
  if (characters.length > 0) chunks.push(characters.join(''));
  return chunks;
}

function writeTextFrames(output, requestId, value) {
  for (const content of textFrameChunks(value)) {
    writeFrame(output, { v: 1, type: 'text', request_id: requestId, content });
  }
}

function identityFrame(type, hostTools) {
  return {
    v: 1,
    type,
    runtime: 'map-design',
    protocol_version: 1,
    plugin_version: PLUGIN_VERSION,
    capabilities: CAPABILITIES,
    ...(hostTools === undefined ? {} : { host_tools: hostTools }),
  };
}

function errorFacts(error, fallbackCode) {
  const candidate = error && typeof error === 'object' ? error : {};
  const code = typeof candidate.code === 'string' && candidate.code !== '' ? candidate.code : fallbackCode;
  const message = error instanceof Error && error.message !== ''
    ? error.message
    : typeof candidate.message === 'string' && candidate.message !== ''
      ? candidate.message
      : 'DeepSeek Harness reported an execution error.';
  return { code, message };
}

function assistantText(content) {
  return (content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function resultStatus(reason) {
  if (reason?.kind === 'completed' || reason?.kind === 'max-tokens') return 'completed';
  if (reason?.kind === 'aborted') return 'cancelled';
  return 'failed';
}

function resultError(reason) {
  if (resultStatus(reason) !== 'failed') return undefined;
  if (!reason) return { code: 'DSH_PROFILE_MISSING_TURN_END', message: 'DeepSeek Harness became idle without a terminal reason.' };
  if (reason.kind === 'error') return errorFacts(reason.error, 'DSH_PROFILE_TURN_FAILED');
  if (reason.kind === 'blocked') return { code: 'DSH_PROFILE_TURN_BLOCKED', message: 'DeepSeek Harness blocked the turn.' };
  return { code: 'DSH_PROFILE_TURN_FAILED', message: 'DeepSeek Harness did not complete the turn.' };
}

function usageFrame(requestId, provider, model, usage) {
  return {
    v: 1,
    type: 'usage',
    request_id: requestId,
    provider,
    model,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cache_read_tokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cache_write_tokens: usage.cacheWriteTokens }),
  };
}

async function listModelCatalog(ctx) {
  const catalog = [];
  for (const provider of ctx.llm.listProviders()) {
    try {
      for (const model of await ctx.llm.listModels(provider.id)) {
        const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id).catch(() => null);
        catalog.push({
          provider: provider.id,
          provider_name: provider.name,
          id: model.id,
          name: model.name,
          ...(resolved?.reasoning?.efforts.length
            ? {
                reasoning_options: resolved.reasoning.efforts.map((effort) => ({
                  id: String(effort.id),
                  name: effort.name,
                  ...(resolved.reasoning?.defaultEffort === effort.id ? { default: true } : {}),
                })),
              }
            : {}),
        });
      }
    } catch {
      ctx.logger.warn('map-design-runtime: could not list models for provider ' + provider.id);
    }
  }
  return catalog;
}

function createCancellationLatch(cancelActiveAgent) {
  const pending = new Set();
  let active;
  const cancelActive = () => {
    if (!active || active.controller.signal.aborted) return;
    active.controller.abort();
    cancelActiveAgent();
  };
  return {
    activate(requestId, controller) {
      active = { requestId, controller };
      if (pending.delete(requestId)) cancelActive();
    },
    cancel(requestId) {
      if (active?.requestId === requestId) cancelActive();
      else pending.add(requestId);
    },
  };
}

function setupNativeHostTools(agentCtx, selection, hostToolNames) {
  const selected = { current: selection, assembled: undefined };
  installModelSelection(agentCtx, selected);
  if (!agentCtx.tools || typeof agentCtx.tools.restrict !== 'function' || typeof agentCtx.tools.presentAs !== 'function') {
    throw new Error('DeepSeek Harness native host-tool isolation is unavailable.');
  }
  agentCtx.tools.restrict({ allow: hostToolNames });
  agentCtx.tools.presentAs('native');
}

function sameJson(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJson(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
}

function isExactHostToolSurface(schemas, hostTools) {
  if (!Array.isArray(schemas) || schemas.length !== hostTools.length) return false;
  const expected = new Map(hostTools.map((tool) => [tool.name, tool]));
  const seen = new Set();
  for (const schema of schemas) {
    if (!schema || typeof schema !== 'object' || typeof schema.name !== 'string' || seen.has(schema.name)) return false;
    seen.add(schema.name);
    const tool = expected.get(schema.name);
    if (!tool || schema.description !== tool.description || !sameJson(schema.parameters, tool.inputSchema)) return false;
  }
  return seen.size === expected.size;
}

async function probeNativeHostTools(ctx, request) {
  if (!ctx.tools || typeof ctx.tools.schemas !== 'function') {
    throw new Error('DeepSeek Harness scoped host-tool discovery is unavailable.');
  }
  const selection = ctx.agentDefaultModel.currentSelection();
  const hostToolNames = request.host_tools.map((tool) => tool.name);
  let handle;
  let disposeTools = () => {};
  try {
    disposeTools = registerMapDesignHostTools({
      tools: ctx.tools,
      request,
      environment: {
        MAP_DESIGN_TOOL_TOKEN: 'probe',
        MAP_DESIGN_PROJECT_ID: 'probe',
        MAP_DESIGN_CONVERSATION_ID: 'probe',
        MAP_DESIGN_AGENT_ID: 'deepseek-harness',
      },
      onToolResult: () => {},
      fetchImpl: async () => { throw new Error('Probe tools are never executed.'); },
    });
    handle = await ctx.agents.create({
      sessionId: SessionId('map-design-probe-' + randomUUID()),
      meta: { cwd: process.cwd() },
      agentOptions: selection,
      setup: (agentCtx) => setupNativeHostTools(agentCtx, selection, hostToolNames),
    });
    const schemas = ctx.tools.schemas(handle.agent);
    if (!isExactHostToolSurface(schemas, request.host_tools)) {
      throw new Error('DeepSeek Harness did not expose the exact scoped MapDesign host-tool surface.');
    }
    return schemas.map((schema) => schema.name);
  } finally {
    await handle?.dispose().catch(() => undefined);
    disposeTools();
  }
}

async function execute(ctx, request, output, onHandle, signal) {
  const defaultSelection = ctx.agentDefaultModel.currentSelection();
  const baseSelection = request.model
    ? { provider: request.model.provider, model: request.model.id }
    : defaultSelection;
  const selection = request.reasoning_effort
    ? { ...baseSelection, reasoningEffort: ReasoningEffortId(request.reasoning_effort) }
    : baseSelection;
  const sessionId = SessionId(request.resume_session_id ?? 'map-design-' + randomUUID());
  const hostToolNames = request.host_tools.map((tool) => tool.name);
  const hostToolNameSet = new Set(hostToolNames);
  let handle;
  let firstSeq = Number.POSITIVE_INFINITY;
  let turnEnd;
  const streamedTextSteps = new Set();
  let eventsOpen = true;
  let terminalWritten = false;
  const writeTerminal = (frame) => {
    if (terminalWritten) return;
    terminalWritten = true;
    eventsOpen = false;
    writeFrame(output, frame);
  };
  const setup = (agentCtx) => setupNativeHostTools(agentCtx, selection, hostToolNames);
  let disposeEvents = () => {};
  let disposeTools = () => {};
  const onSessionEvent = (session, event) => {
    if (!eventsOpen || String(session.id) !== String(sessionId) || event.seq < firstSeq) return;
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk;
      if (chunk.type === 'text-delta' && chunk.text !== '') {
        streamedTextSteps.add(event.data.turn + '\u0000' + event.data.step);
        writeTextFrames(output, request.request_id, chunk.text);
      } else if (chunk.type === 'reasoning-delta' && chunk.text !== '') {
        writeFrame(output, { v: 1, type: 'thinking', request_id: request.request_id, content: chunk.text });
      }
      return;
    }
    if (event.type === 'tool/call' && hostToolNameSet.has(event.data.name)) {
      writeFrame(output, {
        v: 1,
        type: 'tool_call',
        request_id: request.request_id,
        call_id: String(event.data.callId),
        name: event.data.name,
        arguments: event.data.arguments,
      });
      return;
    }
    if (event.type === 'assistant/message') {
      const stepKey = event.data.turn + '\u0000' + event.data.step;
      if (!streamedTextSteps.has(stepKey)) {
        const assembled = assistantText(event.data.message?.content);
        if (assembled !== '') {
          writeTextFrames(output, request.request_id, assembled);
        }
      }
      if (event.data.usage) {
        writeFrame(output, usageFrame(request.request_id, selection.provider, selection.model, event.data.usage));
      }
      return;
    }
    if (event.type === 'turn/end') turnEnd = event;
  };

  try {
    disposeTools = registerMapDesignHostTools({
      tools: ctx.tools,
      request,
      environment: process.env,
      onToolResult: (result) => {
        if (eventsOpen) writeFrame(output, { v: 1, type: 'tool_result', request_id: request.request_id, ...result });
      },
    });
    try {
      handle = request.resume_session_id
        ? await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: selection, setup, signal })
        : await ctx.agents.create({
            sessionId,
            meta: { cwd: request.cwd },
            agentOptions: selection,
            setup,
            signal,
          });
      onHandle(handle);
    } catch (error) {
      if (signal.aborted) {
        writeTerminal({ v: 1, type: 'result', request_id: request.request_id, status: 'cancelled', session_id: String(sessionId), resume_rejected: false });
        return;
      }
      writeTerminal({
        v: 1,
        type: 'result',
        request_id: request.request_id,
        status: 'failed',
        session_id: String(sessionId),
        resume_rejected: Boolean(request.resume_session_id),
        error: errorFacts(error, request.resume_session_id ? 'DSH_PROFILE_RESUME_REJECTED' : 'DSH_PROFILE_SESSION_CREATE_FAILED'),
      });
      return;
    }

    writeFrame(output, {
      v: 1,
      type: 'session',
      request_id: request.request_id,
      session_id: String(sessionId),
      resumed: Boolean(request.resume_session_id),
    });
    await handle.agent.whenIdle();
    if (signal.aborted) {
      writeTerminal({ v: 1, type: 'result', request_id: request.request_id, status: 'cancelled', session_id: String(sessionId), resume_rejected: false });
      return;
    }
    firstSeq = handle.agent.session.seq + 1;
    disposeEvents = ctx.on('session/event', onSessionEvent);
    await handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: request.prompt }],
      source: { kind: 'user' },
    }));
    await handle.agent.whenIdle();
    await ctx.sessions.flush(handle.agent.session);
    if (signal.aborted) {
      writeTerminal({ v: 1, type: 'result', request_id: request.request_id, status: 'cancelled', session_id: String(sessionId), resume_rejected: false });
      return;
    }
    const reason = turnEnd?.data.reason;
    const status = resultStatus(reason);
    const failure = resultError(reason);
    writeTerminal({
      v: 1,
      type: 'result',
      request_id: request.request_id,
      status,
      session_id: String(sessionId),
      stop_reason: reason?.kind ?? 'unknown',
      resume_rejected: false,
      ...(failure === undefined ? {} : { error: failure }),
    });
  } catch (error) {
    writeTerminal({
      v: 1,
      type: 'result',
      request_id: request.request_id,
      status: signal.aborted ? 'cancelled' : 'failed',
      session_id: String(sessionId),
      resume_rejected: false,
      ...(signal.aborted ? {} : { error: errorFacts(error, 'DSH_PROFILE_EXECUTION_FAILED') }),
    });
  } finally {
    disposeEvents();
    disposeTools();
    await handle?.dispose().catch(() => undefined);
    onHandle(undefined);
  }
}

async function serve(ctx, output, exit, input = process.stdin) {
  writeFrame(output, identityFrame('ready'));
  const lines = createInterface({ input, crlfDelay: Infinity });
  let requestId = null;
  let handle;
  let task;
  const cancellation = createCancellationLatch(() => handle?.agent.cancel({ kind: 'user' }));
  await new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      lines.close();
      input.destroy();
      resolve();
    };
    lines.on('line', (line) => {
      if (line.trim() === '') return;
      let command;
      try { command = parseMapDesignHostCommand(JSON.parse(line)); }
      catch {
        writeFrame(output, {
          v: 1,
          type: 'protocol_error',
          ...(requestId ? { request_id: requestId } : {}),
          code: 'DSH_PROFILE_INVALID_COMMAND',
          message: 'MapDesign sent an invalid profile command.',
        });
        return;
      }
      if (command.type === 'cancel') {
        cancellation.cancel(command.request_id);
        return;
      }
      if (task) {
        writeFrame(output, {
          v: 1,
          type: 'protocol_error',
          request_id: command.request_id,
          code: 'DSH_PROFILE_BUSY',
          message: 'This profile process accepts one execute command.',
        });
        return;
      }
      requestId = command.request_id;
      const controller = new AbortController();
      cancellation.activate(requestId, controller);
      task = execute(ctx, command, output, (nextHandle) => { handle = nextHandle; }, controller.signal);
      void task.finally(settle);
    });
    lines.on('close', () => { if (!task) settle(); });
  });
  exit(0);
}

function probeTools() {
  const raw = process.env.MAP_DESIGN_PROFILE_PROBE_TOOLS;
  if (!raw) throw new Error('MapDesign profile probe tools are missing.');
  const host_tools = JSON.parse(raw);
  return parseMapDesignHostCommand({
    v: 1,
    type: 'execute',
    request_id: 'probe',
    cwd: process.cwd(),
    prompt: '',
    host_tools,
    callback: { url: 'http://127.0.0.1/unused', tokenEnv: 'MAP_DESIGN_TOOL_TOKEN' },
  });
}

export function apply(ctx) {
  const startup = ctx.mapDesignStartup;
  const exit = ctx.get('appExit');
  if (!startup || !exit) throw new Error('map-design-runtime requires startup and appExit services');
  void ctx.get('loader')?.await().then(async () => {
    if (startup.mode === 'models') {
      writeFrame(process.stdout, { v: 1, type: 'models', runtime: 'map-design', models: await listModelCatalog(ctx) });
      exit(0);
      return;
    }
    if (startup.mode === 'probe') {
      const request = probeTools();
      const hostTools = await probeNativeHostTools(ctx, request);
      writeFrame(process.stdout, identityFrame('probe', hostTools));
      exit(0);
      return;
    }
    await serve(ctx, process.stdout, exit);
  }).catch((error) => {
    process.stderr.write('map-design-runtime: ' + (error instanceof Error ? error.message : String(error)) + '\\n');
    exit(1);
  });
}
`;

export interface DeepSeekProfileBundle {
  home: string;
  profileDirectory: string;
  bridgePath: string;
  runtimePath: string;
  startupPath: string;
}

const activeStages = new Map<string, Promise<DeepSeekProfileBundle>>();

export function resolveDeepSeekProfileHome(root?: string): string {
  const dataRoot = resolve(root ?? process.env.MAP_DESIGN_DATA_DIR ?? join(process.cwd(), '.map-design'));
  return join(dataRoot, 'agent-runtimes', 'deepseek-harness', PROFILE_LAYOUT_VERSION, 'dsh-home');
}

export function stageDeepSeekProfileBundle(root?: string): Promise<DeepSeekProfileBundle> {
  const home = resolveDeepSeekProfileHome(root);
  const existing = activeStages.get(home);
  if (existing) return existing;
  const staging = stageDeepSeekProfileBundleOnce(home);
  activeStages.set(home, staging);
  const clear = (): void => {
    if (activeStages.get(home) === staging) activeStages.delete(home);
  };
  void staging.then(clear, clear);
  return staging;
}

async function stageDeepSeekProfileBundleOnce(home: string): Promise<DeepSeekProfileBundle> {
  const profilesDirectory = join(home, 'profiles');
  const sessionsDirectory = join(home, 'sessions');
  const profileDirectory = join(profilesDirectory, PROFILE_NAME);
  const runtimeDirectory = join(
    profileDirectory,
    'node_modules',
    '@mapseekai',
    'dsh-map-design-runtime',
  );
  const bundle = {
    home,
    profileDirectory,
    bridgePath: join(runtimeDirectory, 'bridge.mjs'),
    runtimePath: join(runtimeDirectory, 'runtime.mjs'),
    startupPath: join(runtimeDirectory, 'startup.mjs'),
  } satisfies DeepSeekProfileBundle;

  await mkdir(profilesDirectory, { recursive: true, mode: 0o700 });
  await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    chmod(home, 0o700),
    chmod(profilesDirectory, 0o700),
    chmod(sessionsDirectory, 0o700),
    ensureFixedFile(join(home, 'cordis.patch.yml'), '[]\n'),
  ]);

  if (await exists(join(profileDirectory, 'package.json'))) {
    await verifyProfileBundle(bundle);
    return bundle;
  }

  const temporaryProfile = await mkdtemp(join(profilesDirectory, '.map-design-stage-'));
  try {
    const temporaryRuntime = join(
      temporaryProfile,
      'node_modules',
      '@mapseekai',
      'dsh-map-design-runtime',
    );
    await mkdir(temporaryRuntime, { recursive: true, mode: 0o700 });
    await Promise.all([
      chmod(temporaryProfile, 0o700),
      writePrivateFile(join(temporaryProfile, 'package.json'), PROFILE_PACKAGE_JSON),
      writePrivateFile(join(temporaryProfile, 'cordis.patch.yml'), '[]\n'),
      writePrivateFile(join(temporaryRuntime, 'package.json'), RUNTIME_PACKAGE_JSON),
      writePrivateFile(join(temporaryRuntime, 'cordis.patch.yml'), PROFILE_PATCH),
      writePrivateFile(join(temporaryRuntime, 'bridge.mjs'), BRIDGE_SOURCE),
      writePrivateFile(join(temporaryRuntime, 'runtime.mjs'), RUNTIME_SOURCE),
      writePrivateFile(join(temporaryRuntime, 'startup.mjs'), STARTUP_SOURCE),
    ]);
    try {
      await rename(temporaryProfile, profileDirectory);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await rm(temporaryProfile, { recursive: true, force: true });
    }
    await chmod(profileDirectory, 0o700);
  } catch (error) {
    await rm(temporaryProfile, { recursive: true, force: true });
    throw error;
  }
  await verifyProfileBundle(bundle);
  return bundle;
}

async function verifyProfileBundle(bundle: DeepSeekProfileBundle): Promise<void> {
  const runtimeDirectory = join(bundle.profileDirectory, 'node_modules', '@mapseekai', 'dsh-map-design-runtime');
  const files = [
    [join(bundle.profileDirectory, 'package.json'), PROFILE_PACKAGE_JSON],
    [join(bundle.profileDirectory, 'cordis.patch.yml'), '[]\n'],
    [join(runtimeDirectory, 'package.json'), RUNTIME_PACKAGE_JSON],
    [join(runtimeDirectory, 'cordis.patch.yml'), PROFILE_PATCH],
    [bundle.bridgePath, BRIDGE_SOURCE],
    [bundle.runtimePath, RUNTIME_SOURCE],
    [bundle.startupPath, STARTUP_SOURCE],
  ] as const;
  for (const [path, expected] of files) {
    if (await readFile(path, 'utf8') !== expected) {
      throw new Error('The staged DeepSeek Harness MapDesign profile failed integrity verification.');
    }
  }
}

async function ensureFixedFile(path: string, content: string): Promise<void> {
  try {
    await writePrivateFile(path, content);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    if (await readFile(path, 'utf8') !== content) {
      throw new Error('The daemon-owned DeepSeek Harness home contains an unexpected profile overlay.');
    }
  }
}

function writePrivateFile(path: string, content: string): Promise<void> {
  return writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
