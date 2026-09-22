import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { createCommandInvocation } from '../../../packages/platform/src/command.js';

export function spawnFakeMapProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): ChildProcessWithoutNullStreams {
  const invocation = createCommandInvocation({ command, args, env });
  return spawn(invocation.command, invocation.args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

export type FakeMapAgentId = 'codex' | 'oh-my-pi' | 'pi' | 'opencode' | 'deepseek-harness';

export interface FakeMapAcpRuntime {
  bin: string;
  env: {
    CLAUDE_BIN: string;
    CODEX_BIN: string;
    KIMI_BIN: string;
    MAP_DESIGN_MCP_CLI_PATH: string;
    OPENCODE_BIN: string;
    PATH: string;
    PI_BIN: string;
  };
  executables: Record<FakeMapAgentId, string>;
  capturePath: string;
  interceptors: { mapCli: string; mapMcpServer: string };
  sessionsFor(conversationId: string): Partial<Record<FakeMapAgentId, string[]>>;
  readonly crossAgentSessionReuse: boolean;
}

export interface FakeMapAcpCaptureEvent {
  type: string;
  branch?: 'activity-success' | 'cross-agent' | 'dark-theme' | 'legacy-loop' | 'long-validation' | 'sanitized-failure' | 'native-transaction' | 'revision-one' | 'revision-two' | 'generic';
  phase?: string;
  method?: string;
  tool?: string;
  tools?: string[];
  success?: boolean;
  summary?: Record<string, unknown>;
  skillObserved?: boolean;
  argv?: string[];
  adapterPath?: string;
  agentId?: FakeMapAgentId | 'claude';
  conversationId?: string;
  prompt?: string;
  resumed?: boolean;
  sessionId?: string;
  visibleTranscript?: string;
}

export async function createFakeMapAcpRuntime(
  options: { root?: string } = {},
): Promise<FakeMapAcpRuntime> {
  const root = options.root ?? join(tmpdir(), `map-design-fake-codex-${process.pid}`);
  await mkdir(root, { recursive: true });
  const capturePath = join(root, 'capture.jsonl');
  const executableBaseNames = {
    codex: 'codex.cjs',
    'oh-my-pi': 'omp.cjs',
    pi: 'pi.cjs',
    opencode: 'opencode-cli.cjs',
    'deepseek-harness': 'dsh.cjs',
  } as const satisfies Record<FakeMapAgentId, string>;
  const scriptPaths = Object.fromEntries(Object.entries(executableBaseNames)
    .map(([agentId, name]) => [agentId, join(root, name)])) as Record<FakeMapAgentId, string>;
  const executableNames = {
    codex: 'codex',
    'oh-my-pi': 'omp',
    pi: 'pi',
    opencode: 'opencode-cli',
    'deepseek-harness': 'dsh',
  } as const satisfies Record<FakeMapAgentId, string>;
  const executables = process.platform === 'win32'
    ? Object.fromEntries(Object.entries(executableNames)
        .map(([agentId, name]) => [agentId, join(root, `${name}.cmd`)])) as Record<FakeMapAgentId, string>
    : scriptPaths;
  const claudeScript = join(root, 'claude.cjs');
  const claudeBin = process.platform === 'win32' ? join(root, 'claude.cmd') : claudeScript;
  const mapCliScript = join(root, 'md.cjs');
  const mapCliBin = process.platform === 'win32' ? join(root, 'md.cmd') : join(root, 'md');
  const mapMcpServer = join(root, 'map-design-mcp-cli.cjs');
  const script = renderFakeCodexScript(capturePath);
  await writeFile(capturePath, '', 'utf8');
  await Promise.all([...Object.values(scriptPaths), claudeScript].map(async (path) => {
    await writeFile(path, script, 'utf8');
    await chmod(path, 0o755);
  }));
  await Promise.all(([
    [mapCliScript, 'map-cli-invocation'],
    [mapMcpServer, 'map-mcp-server'],
  ] as const).map(async ([path, type]) => {
    await writeFile(path, renderLaunchInterceptor(capturePath, type), 'utf8');
    await chmod(path, 0o755);
  }));
  if (process.platform === 'win32') {
    await Promise.all([
      ...Object.entries(executableNames).map(([agentId, name]) => [name, scriptPaths[agentId as FakeMapAgentId]] as const),
      ['claude', claudeScript] as const,
      ['md', mapCliScript] as const,
    ].map(async ([name, target]) => {
      await writeFile(
        join(root, `${name}.cmd`),
        `@echo off\r\n"${process.execPath}" "%~dp0\\${target.slice(root.length + 1)}" %*\r\n`,
        'utf8',
      );
    }));
  } else {
    await Promise.all([
      ['omp', './omp.cjs'],
      ['dsh', './dsh.cjs'],
      ['md', './md.cjs'],
    ].map(async ([name, target]) => {
      const path = join(root, name!);
      await writeFile(path, `#!/usr/bin/env node\nimport ${JSON.stringify(target)};\n`, 'utf8');
      await chmod(path, 0o755);
    }));
  }
  const captureEvents = (): FakeMapAcpCaptureEvent[] => readFileSync(capturePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as FakeMapAcpCaptureEvent]; } catch { return []; }
    });
  const sessionsFor = (conversationId: string): Partial<Record<FakeMapAgentId, string[]>> => {
    const sessions: Partial<Record<FakeMapAgentId, string[]>> = {};
    for (const event of captureEvents()) {
      if (event.type !== 'fake-session' || event.conversationId !== conversationId
        || !event.agentId || event.agentId === 'claude' || !event.sessionId) continue;
      const agentSessions = sessions[event.agentId] ?? [];
      if (!agentSessions.includes(event.sessionId)) agentSessions.push(event.sessionId);
      sessions[event.agentId] = agentSessions;
    }
    return sessions;
  };
  const runtime = {
    bin: executables.codex,
    env: {
      CLAUDE_BIN: claudeBin,
      CODEX_BIN: executables.codex,
      KIMI_BIN: executables.codex,
      MAP_DESIGN_MCP_CLI_PATH: mapMcpServer,
      OPENCODE_BIN: executables.opencode,
      PATH: `${root}${delimiter}${process.env.PATH ?? ''}`,
      PI_BIN: executables.pi,
    },
    executables,
    capturePath,
    interceptors: { mapCli: mapCliBin, mapMcpServer },
    sessionsFor,
    get crossAgentSessionReuse() {
      const owners = new Map<string, FakeMapAgentId>();
      for (const event of captureEvents()) {
        if (event.type !== 'fake-session' || !event.agentId || event.agentId === 'claude' || !event.sessionId) continue;
        const owner = owners.get(event.sessionId);
        if (owner && owner !== event.agentId) return true;
        owners.set(event.sessionId, event.agentId);
      }
      return false;
    },
  } satisfies FakeMapAcpRuntime;
  return runtime;
}

function renderLaunchInterceptor(
  capturePath: string,
  type: 'map-cli-invocation' | 'map-mcp-server',
): string {
  return [
    '#!/usr/bin/env node',
    "'use strict';",
    "const { appendFileSync } = require('node:fs');",
    'const CAPTURE_PATH = ' + JSON.stringify(capturePath) + ';',
    'const EVENT_TYPE = ' + JSON.stringify(type) + ';',
    "appendFileSync(CAPTURE_PATH, JSON.stringify({ type: EVENT_TYPE, argv: process.argv.slice(2) }) + '\\n', 'utf8');",
    'process.exit(97);',
    '',
  ].join('\n');
}

function renderFakeCodexScript(capturePath: string): string {
  return `#!/usr/bin/env node
'use strict';

const { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

const CAPTURE_PATH = ${JSON.stringify(capturePath)};
const AGENT_ID = agentIdentity(basename(process.argv[1] || 'codex'));
const CONVERSATION_ID = process.env.MAP_DESIGN_FAKE_CONVERSATION_ID
  || process.env.MAP_DESIGN_CONVERSATION_ID
  || null;
let THREAD_ID = null;
let THREAD_RESUMED = false;
const TURN_ID = 'mapdesign-e2e-turn';
const PRIVATE_REASONING = 'PRIVATE_REASONING_MUST_NOT_RENDER';
const PRIVATE_PATH = '/private/tmp/map-design-secret.json';
const PRIVATE_SOURCE_URL = 'https://private.example.test/complete-style.json';
const COMPLETE_STYLE_SENTINEL = 'COMPLETE_STYLE_MUST_NOT_RENDER';
const RAW_PROVIDER_ERROR = 'RAW_PROVIDER_ERROR_MUST_NOT_RENDER';
const LITERAL_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtYXAtZGVzaWduIn0.c2lnbmF0dXJlMTIzNDU2';
const MAP_TOOL_NAMES = [
  'map_get_context',
  'map_inspect',
  'map_search_layers',
  'map_apply_transaction',
  'map_update_semantics',
  'map_validate',
  'map_render_preview',
  'map_commit_revision',
  'map_discard_draft',
];

function record(event) {
  appendFileSync(CAPTURE_PATH, JSON.stringify(event) + '\\n', 'utf8');
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

if (process.argv.includes('--version')) {
  process.stdout.write(versionFor(AGENT_ID) + '\\n');
  process.exit(0);
} else if (AGENT_ID === 'codex' && process.argv[2] === 'debug' && process.argv[3] === 'models') {
  process.stdout.write(JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'gpt-5.5' }] }) + '\\n');
  process.exit(0);
} else if (AGENT_ID === 'codex' && process.argv[2] === 'login' && process.argv[3] === 'status') {
  process.stdout.write('Logged in\\n');
  process.exit(0);
} else if (AGENT_ID === 'oh-my-pi' && process.argv[2] === 'models' && process.argv[3] === 'ls') {
  process.stdout.write(JSON.stringify({ models: [{ provider: 'openai', id: 'gpt-5.6-terra', selector: 'openai/gpt-5.6-terra', name: 'GPT 5.6 Terra' }] }) + '\\n');
  process.exit(0);
} else if (AGENT_ID === 'pi' && process.argv.includes('--list-models')) {
  process.stdout.write('provider model\\nopenai gpt-5.6-terra\\n');
  process.exit(0);
} else if (AGENT_ID === 'opencode' && process.argv[2] === 'models') {
  process.stdout.write('openai/gpt-5.6-terra\\n');
  process.exit(0);
} else if (AGENT_ID === 'deepseek-harness' && process.argv.includes('--models')) {
  write({ v: 1, type: 'models', runtime: 'map-design', models: [{ provider: 'deepseek', provider_name: 'DeepSeek', id: 'chat', name: 'DeepSeek Chat' }] });
  process.exit(0);
} else if (AGENT_ID === 'opencode' && process.argv[2] === 'debug' && process.argv[3] === 'agent' && process.argv[4] === 'build') {
  runOpenCodeProbe();
} else if (AGENT_ID === 'pi' && process.argv.includes('--help')) {
  runPiProbe();
} else if (AGENT_ID === 'deepseek-harness' && process.argv.includes('--probe')) {
  runDeepSeekProbe();
} else if (AGENT_ID === 'oh-my-pi' && process.argv[2] === '--mode' && process.argv[3] === 'rpc') {
  runOmpRuntime();
} else if (AGENT_ID === 'pi' && process.argv[2] === '--mode' && process.argv[3] === 'rpc') {
  runPiRuntime();
} else if (AGENT_ID === 'opencode' && process.argv[2] === 'run') {
  runOpenCodeRuntime();
} else if (AGENT_ID === 'deepseek-harness' && process.argv.includes('--stdio')) {
  runDeepSeekRuntime();
} else if (AGENT_ID !== 'codex' || !(process.argv[2] === 'app-server' && process.argv[3] === '--stdio')) {
  record({ type: 'unsupported-run-spawn', agentId: AGENT_ID, argv: process.argv.slice(2) });
  process.exit(1);
} else {
record({ type: 'app-server-process', agentId: AGENT_ID, argv: process.argv.slice(2) });
recordForbiddenDelivery(AGENT_ID, process.argv.slice(2));
process.stdin.setEncoding('utf8');
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message && message.method) {
      Promise.resolve(handleClientMessage(message)).catch((error) => {
        if (message.id !== undefined) write({ id: message.id, error: { code: -32000, message: 'fixture failure' } });
        record({ type: 'fixture-failure', phase: String(error && error.message || error) });
      });
      continue;
    }
    const waiter = pending.get(message && message.id);
    if (!waiter) continue;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error('client response failed'));
    else waiter.resolve(message.result);
  }
});

process.stdin.on('end', () => process.stdout.end());
}

let nextServerId = 100;
const pending = new Map();

async function handleClientMessage(message) {
  const method = String(message.method || '');
  record({ type: 'app-server-client-message', method });
  if (method === 'initialize') {
    write({ id: message.id, result: {
      userAgent: 'codex-app-server/0.99.0-e2e',
      codexHome: '/safe/codex-home',
      platformFamily: 'unix',
      platformOs: 'macos',
    } });
    return;
  }
  if (method === 'initialized') return;
  if (method === 'thread/resume') {
    const threadId = message.params && message.params.threadId;
    if (typeof threadId !== 'string' || !threadId.startsWith('codex-session-')) {
      write({ id: message.id, error: { code: -32602, message: 'unknown fake Codex session' } });
      return;
    }
    THREAD_ID = threadId;
    THREAD_RESUMED = true;
    record({ type: 'app-server-thread-resume', agentId: 'codex', sessionId: THREAD_ID });
    write({ id: message.id, result: { thread: { id: THREAD_ID } } });
    return;
  }
  if (method === 'thread/start') {
    const namespaces = Array.isArray(message.params && message.params.dynamicTools)
      ? message.params.dynamicTools
      : [];
    const tools = namespaces.flatMap((namespace) => Array.isArray(namespace && namespace.tools)
      ? namespace.tools.map((tool) => tool && tool.name).filter(Boolean)
      : []);
    const contractMatches = tools.length === MAP_TOOL_NAMES.length
      && tools.every((tool, index) => tool === MAP_TOOL_NAMES[index]);
    if (!contractMatches) {
      record({ type: 'app-server-thread-rejected', tools });
      write({ id: message.id, error: { code: -32602, message: 'dynamic Map tool contract mismatch' } });
      return;
    }
    THREAD_ID = nextSessionId('codex');
    THREAD_RESUMED = false;
    record({ type: 'app-server-thread', agentId: 'codex', sessionId: THREAD_ID, tools });
    write({ id: message.id, result: { thread: { id: THREAD_ID } } });
    return;
  }
  if (method === 'turn/start') {
    write({ id: message.id, result: { turn: turn('inProgress') } });
    const prompt = Array.isArray(message.params && message.params.input)
      ? message.params.input.filter((item) => item && item.type === 'text').map((item) => item.text).join('\\n')
      : '';
    recordSession('codex', THREAD_ID, THREAD_RESUMED, prompt);
    setImmediate(() => runTurn(prompt).catch((error) => {
      record({ type: 'fixture-failure', phase: String(error && error.message || error) });
      completeTurn('failed', { message: RAW_PROVIDER_ERROR });
    }));
    return;
  }
  if (method === 'turn/interrupt') {
    write({ id: message.id, result: {} });
    return;
  }
  if (message.id !== undefined) write({ id: message.id, error: { code: -32601, message: 'method unavailable' } });
}

async function runTurn(prompt) {
  const skillObserved = /map-design|map_get_context|map_apply_transaction/iu.test(prompt);
  const activePrompt = activeUserPrompt(prompt);
  if (activePrompt.includes('Improve road hierarchy')) {
    await waitForRelease('activity-success-start');
    await emitPrivateAndPublic('activity-success', 'Road hierarchy needs more contrast.');
    const context = await callTool('activity-success', 'context-call', 'map_get_context', {});
    const semantics = await callTool('activity-success', 'semantics-call', 'map_update_semantics', semanticsInput(Number(context.draftRevision), 'activity'));
    await callTool('activity-success', 'apply-call', 'map_apply_transaction', applyInput(Number(semantics.draftRevision), 'activity'));
    record({ type: 'fixture-ready', branch: 'activity-success', skillObserved });
    await waitForRelease('activity-success');
    record({ type: 'fixture-event', branch: 'activity-success', phase: 'final-answer' });
    agentText('Road hierarchy updated.');
    completeTurn('completed');
    record({ type: 'fixture-complete', branch: 'activity-success', skillObserved });
    return;
  }
  if (activePrompt.includes('Start a long validation')) {
    await waitForRelease('long-validation-start');
    await emitPrivateAndPublic('long-validation', 'Checking long-running validation constraints.');
    const context = await callTool('long-validation', 'long-context-call', 'map_get_context', {});
    await callTool('long-validation', 'long-validate-call', 'map_validate', {
      expectedRevision: Number(context.draftRevision),
    });
    record({ type: 'fixture-ready', branch: 'long-validation', skillObserved });
    await new Promise(() => {});
  }
  if (activePrompt.includes('Trigger a sanitized failure')) {
    await emitPrivateAndPublic('sanitized-failure', 'Checking the public validation boundary.');
    await callTool('sanitized-failure', 'failure-validate-call', 'map_validate', { expectedRevision: -1 });
    completeTurn('failed', { message: RAW_PROVIDER_ERROR + ' ' + LITERAL_JWT + ' ' + PRIVATE_PATH });
    record({ type: 'fixture-complete', branch: 'sanitized-failure', skillObserved });
    return;
  }
  if (activePrompt.includes('cross-Agent committed map revision')) {
    await commitDeterministicRevision('cross-agent', {
      background: '#F4F1EA',
      fill: '#D7E0DA',
      line: '#49665A',
      symbol: '#16231E',
    }, skillObserved);
    return;
  }
  if (activePrompt.includes('deterministic revision one')) {
    await commitDeterministicRevision('revision-one', {
      background: '#F8F4F0',
      fill: '#DFDBD7',
      line: '#FFCC88',
      symbol: '#171717',
    }, skillObserved);
    return;
  }
  if (activePrompt.includes('deterministic revision two')) {
    await commitDeterministicRevision('revision-two', {
      background: '#0D1117',
      fill: '#171D24',
      line: '#59616A',
      symbol: '#E1DFDB',
    }, skillObserved);
    return;
  }
  if (activePrompt.includes('deterministic dark theme background')) {
    await emitPrivateAndPublic('dark-theme', 'Applying a deterministic dark theme background.');
    await callTool('dark-theme', 'dark-theme-semantics', 'map_update_semantics', semanticsInput(0, 'dark-theme'));
    await callTool('dark-theme', 'dark-theme-apply', 'map_apply_transaction', {
      expectedRevision: 1,
      idempotencyKey: 'dark-theme-001',
      transaction: {
        operations: [{
          op: 'setLayerProperties',
          layerId: 'background',
          paint: { 'background-color': '#111318' },
        }],
      },
      intentSummary: 'Apply dark theme background',
    });
    await callTool('dark-theme', 'dark-theme-validate', 'map_validate', { expectedRevision: 2 });
    agentText('Dark theme background applied.');
    completeTurn('completed');
    record({ type: 'fixture-complete', branch: 'dark-theme', skillObserved });
    return;
  }
  if (activePrompt.includes('invalid legacy map operation')) {
    await emitPrivateAndPublic('legacy-loop', 'Checking a repeated invalid legacy map operation.');
    const invalidLegacyInput = {
      expectedRevision: 0,
      idempotencyKey: 'legacy-loop-001',
      transaction: {
        operations: [{
          op: 'setPaintProperty',
          layerId: 'background',
          property: 'background-color',
          value: '#111318',
        }],
      },
      intentSummary: 'Apply a legacy dark theme operation',
    };
    for (let count = 1; count <= 9; count += 1) {
      await callTool('legacy-loop', 'legacy-repeat-' + count, 'map_apply_transaction', invalidLegacyInput);
    }
    agentText('Legacy operation loop completed unexpectedly.');
    completeTurn('completed');
    record({ type: 'fixture-complete', branch: 'legacy-loop', skillObserved });
    return;
  }
  if (activePrompt.includes('deterministic acceptance metadata')) {
    await emitPrivateAndPublic('native-transaction', 'Applying a validated map transaction.');
    const context = await callTool('native-transaction', 'transaction-context-call', 'map_get_context', {});
    const semantics = await callTool('native-transaction', 'transaction-semantics-call', 'map_update_semantics', semanticsInput(Number(context.draftRevision), 'transaction'));
    const apply = await callTool('native-transaction', 'transaction-apply-call', 'map_apply_transaction', applyInput(Number(semantics.draftRevision), 'transaction'));
    await callTool('native-transaction', 'transaction-validate-call', 'map_validate', {
      expectedRevision: Number(apply.draftRevision),
    });
    await callTool('native-transaction', 'transaction-preview-call', 'map_render_preview', {
      expectedRevision: Number(apply.draftRevision),
      idempotencyKey: 'e2e-native-preview',
    });
    agentText('MapDesign acceptance workflow completed.');
    completeTurn('completed');
    record({ type: 'fixture-complete', branch: 'native-transaction', skillObserved });
    return;
  }
  await emitPrivateAndPublic('generic', 'Reviewing the map request.');
  agentText('Map request reviewed.');
  completeTurn('completed');
  record({ type: 'fixture-complete', branch: 'generic', skillObserved });
}

function agentIdentity(executable) {
  if (executable === 'omp' || executable === 'omp.cjs') return 'oh-my-pi';
  if (executable === 'pi' || executable === 'pi.cjs') return 'pi';
  if (executable === 'opencode-cli' || executable === 'opencode-cli.cjs' || executable === 'opencode') return 'opencode';
  if (executable === 'dsh' || executable === 'dsh.cjs') return 'deepseek-harness';
  if (executable === 'claude' || executable === 'claude.cjs') return 'claude';
  return 'codex';
}

function versionFor(agentId) {
  if (agentId === 'codex') return 'codex-cli 0.99.0';
  if (agentId === 'pi') return '0.84.4';
  return '1.0.0';
}

function recordedEvents() {
  try {
    return readFileSync(CAPTURE_PATH, 'utf8').split('\\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function sessionPrefix(agentId) {
  if (agentId === 'oh-my-pi') return 'omp';
  if (agentId === 'deepseek-harness') return 'deepseek';
  return agentId;
}

function nextSessionId(agentId) {
  const count = recordedEvents().filter((event) => (
    event.type === 'fake-session' && event.agentId === agentId && event.resumed === false
  )).length;
  return sessionPrefix(agentId) + '-session-' + (count + 1);
}

function recordSession(agentId, sessionId, resumed, prompt) {
  const visibleTranscript = extractVisibleTranscript(prompt);
  record({
    type: 'fake-session',
    agentId,
    conversationId: CONVERSATION_ID,
    sessionId,
    resumed,
    prompt,
    ...(visibleTranscript === null ? {} : { visibleTranscript }),
  });
}

function extractVisibleTranscript(prompt) {
  const marker = 'Conversation:\\n';
  const index = prompt.lastIndexOf(marker);
  return index < 0 ? null : prompt.slice(index + marker.length).replace(/^\\n/u, '');
}

function recordTool(agentId, tool, adapterPath) {
  record({ type: 'fake-tool-call', agentId, tool, adapterPath });
}

function recordForbiddenDelivery(agentId, argv, config) {
  if (argv.some((argument) => /(?:^|[-_])mcp(?:$|[-_])/iu.test(String(argument)))) {
    record({ type: 'map-mcp-server', agentId, argv });
  }
  if (basename(process.argv[1] || '') === 'md') {
    record({ type: 'map-cli-invocation', agentId, argv });
  }
  const mcp = config && config.mcp;
  if (mcp && typeof mcp === 'object' && Object.keys(mcp).some((key) => /map[-_ ]?design/iu.test(key))) {
    record({ type: 'map-mcp-server', agentId, argv });
  }
}

function readJsonLines(onFrame) {
  process.stdin.setEncoding('utf8');
  let input = '';
  process.stdin.on('data', (chunk) => {
    input += chunk;
    const lines = input.split('\\n');
    input = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      Promise.resolve(onFrame(frame)).catch((error) => {
        record({ type: 'fixture-failure', agentId: AGENT_ID, phase: String(error && error.message || error) });
      });
    }
  });
}

function responseFrame(request, data) {
  return {
    id: request.id,
    type: 'response',
    command: request.type,
    success: true,
    data: data || {},
  };
}

function configuredOpenCodePluginPath(config) {
  const plugins = Array.isArray(config && config.plugin) ? config.plugin : [];
  const configured = plugins[plugins.length - 1];
  if (typeof configured !== 'string') throw new Error('OpenCode probe plugin missing');
  const url = new URL(configured);
  if (url.protocol !== 'file:') throw new Error('OpenCode probe plugin must use a file URL');
  return fileURLToPath(url);
}

function installOpenCodePluginStub(pluginPath) {
  const packageRoot = join(dirname(pluginPath), 'node_modules', '@opencode-ai', 'plugin');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@opencode-ai/plugin',
    type: 'module',
    exports: './index.js',
  }), 'utf8');
  writeFileSync(join(packageRoot, 'index.js'), [
    'export function tool(definition) { return definition; }',
    'tool.schema = { fromJSONSchema(schema) {',
    '  return { shape: schema && typeof schema === "object" && schema.properties ? schema.properties : {} };',
    '} };',
  ].join(String.fromCharCode(10)), 'utf8');
}

async function loadOpenCodePlugin(config) {
  const pluginPath = configuredOpenCodePluginPath(config);
  installOpenCodePluginStub(pluginPath);
  const plugin = await import(pathToFileURL(pluginPath).href + '?map-design-fake=' + process.pid + '-' + Date.now());
  if (!plugin || typeof plugin.MapDesignOpenCodePlugin !== 'function') {
    throw new Error('OpenCode MapDesign plugin export missing');
  }
  const loaded = await plugin.MapDesignOpenCodePlugin();
  const tools = loaded && loaded.tool;
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
    throw new Error('OpenCode MapDesign tool surface missing');
  }
  const names = Object.keys(tools);
  if (names.length !== MAP_TOOL_NAMES.length || !names.every((name, index) => name === MAP_TOOL_NAMES[index])) {
    throw new Error('OpenCode MapDesign tool surface mismatch');
  }
  if (names.some((name) => !tools[name] || typeof tools[name].execute !== 'function')) {
    throw new Error('OpenCode MapDesign tool execution surface missing');
  }
  record({
    type: 'opencode-plugin-loaded',
    agentId: 'opencode',
    adapterPath: 'opencode-plugin-export',
    tools: names,
  });
  return { names, tools };
}

async function runOpenCodeProbe() {
  try {
    const probePath = process.env.MAP_DESIGN_PLUGIN_PROBE_PATH;
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
    if (!probePath) throw new Error('OpenCode probe path missing');
    recordForbiddenDelivery('opencode', process.argv.slice(2), config);
    const loaded = await loadOpenCodePlugin(config);
    if (!existsSync(probePath)) {
      writeFileSync(probePath, JSON.stringify(loaded.names), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
    record({ type: 'fake-probe', agentId: 'opencode', adapterPath: 'opencode-plugin', tools: loaded.names });
    process.exit(0);
  } catch (error) {
    record({ type: 'fixture-failure', agentId: 'opencode', phase: String(error && error.message || error) });
    process.exit(1);
  }
}

function extensionPathFromArgs() {
  const index = process.argv.indexOf('--extension');
  return index >= 0 ? process.argv[index + 1] : null;
}

function piManifest() {
  const path = extensionPathFromArgs();
  if (!path) throw new Error('Pi extension path missing');
  const source = readFileSync(path, 'utf8');
  const prefix = 'const MANIFEST = ';
  const start = source.indexOf(prefix);
  const end = source.indexOf(';\\nconst seenToolCalls', start);
  if (start < 0 || end < 0) throw new Error('Pi extension manifest missing');
  return JSON.parse(source.slice(start + prefix.length, end));
}

function runPiProbe() {
  try {
    const source = readFileSync(extensionPathFromArgs(), 'utf8');
    if (!source.includes('map-design-native-tools-probe')) throw new Error('Pi probe flag missing');
    record({ type: 'fake-probe', agentId: 'pi', adapterPath: 'pi-sdk' });
    process.stdout.write('--map-design-native-tools-probe\\n');
    process.exit(0);
  } catch (error) {
    record({ type: 'fixture-failure', agentId: 'pi', phase: String(error && error.message || error) });
    process.exit(1);
  }
}

function runDeepSeekProbe() {
  try {
    const definitions = JSON.parse(process.env.MAP_DESIGN_PROFILE_PROBE_TOOLS || '[]');
    const tools = definitions.map((tool) => tool.name);
    write({
      v: 1,
      type: 'probe',
      runtime: 'map-design',
      protocol_version: 1,
      plugin_version: '1.0.0-e2e',
      capabilities: deepSeekCapabilities(),
      host_tools: tools,
    });
    record({ type: 'fake-probe', agentId: 'deepseek-harness', adapterPath: 'deepseek-profile', tools });
    process.exit(0);
  } catch (error) {
    record({ type: 'fixture-failure', agentId: 'deepseek-harness', phase: String(error && error.message || error) });
    process.exit(1);
  }
}

function runOmpRuntime() {
  record({ type: 'runtime-process', agentId: 'oh-my-pi', adapterPath: 'omp-rpc', argv: process.argv.slice(2) });
  recordForbiddenDelivery('oh-my-pi', process.argv.slice(2));
  const hostResults = new Map();
  let sessionPath = null;
  let resumed = false;
  write({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1], maxFrameBytes: 1048576, maxReassembledFrameBytes: 1048576 });
  readJsonLines(async (frame) => {
    if (frame.type === 'host_tool_result') {
      const waiter = hostResults.get(frame.id);
      if (waiter) {
        hostResults.delete(frame.id);
        waiter(frame);
      }
      return;
    }
    if (frame.type === 'set_host_tools') {
      const tools = Array.isArray(frame.tools) ? frame.tools.map((tool) => tool.name) : [];
      write(responseFrame(frame, { toolNames: tools }));
      return;
    }
    if (frame.type === 'switch_session') {
      sessionPath = frame.sessionPath;
      resumed = true;
      write(responseFrame(frame, { cancelled: false }));
      return;
    }
    if (frame.type === 'get_state') {
      sessionPath = sessionPath || '/safe/fake/' + nextSessionId('oh-my-pi') + '.jsonl';
      write(responseFrame(frame, { sessionFile: sessionPath }));
      return;
    }
    if (frame.type === 'abort') {
      write(responseFrame(frame, {}));
      return;
    }
    if (frame.type !== 'prompt') return;
    write(responseFrame(frame, {}));
    const sessionId = basename(sessionPath || '').replace(/\\.jsonl$/u, '') || nextSessionId('oh-my-pi');
    recordSession('oh-my-pi', sessionId, resumed, String(frame.message || ''));
    setImmediate(async () => {
      try {
        const reply = await runSdkWorkflow('oh-my-pi', String(frame.message || ''), async (tool, args, callId) => {
          const hostId = 'host-' + callId;
          const result = await new Promise((resolve) => {
            hostResults.set(hostId, resolve);
            write({ type: 'host_tool_call', id: hostId, toolCallId: callId, toolName: tool, arguments: args });
          });
          if (result.isError) throw new Error('Oh My Pi tool failed');
          const text = result.result && result.result.content && result.result.content[0] && result.result.content[0].text;
          return typeof text === 'string' ? JSON.parse(text) : {};
        });
        write({ type: 'session_info_update', sessionFile: sessionPath });
        write({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Applying a deterministic native map workflow.' } });
        write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: reply } });
        write({ type: 'agent_end', isTerminal: true, willContinue: false, messages: [] });
      } catch (error) {
        record({ type: 'fixture-failure', agentId: 'oh-my-pi', phase: String(error && error.message || error) });
        write({ type: 'extension_error' });
      }
    });
  });
}

function runPiRuntime() {
  let manifest;
  try { manifest = piManifest(); } catch (error) {
    record({ type: 'fixture-failure', agentId: 'pi', phase: String(error && error.message || error) });
    process.exit(1);
  }
  record({ type: 'runtime-process', agentId: 'pi', adapterPath: 'pi-sdk', argv: process.argv.slice(2) });
  recordForbiddenDelivery('pi', process.argv.slice(2));
  let sessionPath = null;
  let resumed = false;
  readJsonLines(async (frame) => {
    if (frame.type === 'switch_session') {
      sessionPath = frame.sessionPath;
      resumed = true;
      write(responseFrame(frame, { cancelled: false }));
      return;
    }
    if (frame.type === 'get_state') {
      sessionPath = sessionPath || '/safe/fake/' + nextSessionId('pi') + '.jsonl';
      write(responseFrame(frame, { sessionFile: sessionPath }));
      return;
    }
    if (frame.type === 'abort') {
      write(responseFrame(frame, {}));
      return;
    }
    if (frame.type !== 'prompt') return;
    write(responseFrame(frame, {}));
    const sessionId = basename(sessionPath || '').replace(/\\.jsonl$/u, '') || nextSessionId('pi');
    recordSession('pi', sessionId, resumed, String(frame.message || ''));
    setImmediate(async () => {
      try {
        const reply = await runSdkWorkflow('pi', String(frame.message || ''), async (tool, args, callId) => {
          write({ type: 'tool_execution_start', toolCallId: callId, toolName: tool, args });
          const result = await callbackTool(manifest.context, 'pi', tool, callId, args);
          write({
            type: 'tool_execution_end',
            toolCallId: callId,
            toolName: tool,
            isError: false,
            result: {
              content: [{ type: 'text', text: result.modelContent }],
              details: { summary: result.summary },
            },
          });
          return result.value;
        });
        write({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'PRIVATE_PI_REASONING_MUST_NOT_RENDER' } });
        write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: reply } });
        write({ type: 'agent_end', messages: [], willRetry: false });
        write({ type: 'agent_settled' });
      } catch (error) {
        record({ type: 'fixture-failure', agentId: 'pi', phase: String(error && error.message || error) });
        write({ type: 'extension_error' });
      }
    });
  });
}

function runOpenCodeRuntime() {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { prompt += chunk; });
  process.stdin.on('end', () => {
    void (async () => {
      try {
        const resumeIndex = process.argv.indexOf('-s');
        const resumed = resumeIndex >= 0 && typeof process.argv[resumeIndex + 1] === 'string';
        const sessionId = resumed ? process.argv[resumeIndex + 1] : nextSessionId('opencode');
        const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
        recordForbiddenDelivery('opencode', process.argv.slice(2), config);
        const loaded = await loadOpenCodePlugin(config);
        record({ type: 'runtime-process', agentId: 'opencode', adapterPath: 'opencode-plugin', argv: process.argv.slice(2) });
        recordSession('opencode', sessionId, resumed, prompt);
        write({ type: 'step_start', sessionID: sessionId, part: {} });
        const callbackUrl = process.env.MAP_DESIGN_TOOL_CALLBACK_URL;
        let reply = 'Map request reviewed.';
        if (callbackUrl) {
          reply = await runSdkWorkflow('opencode', prompt, async (tool, args, callId) => {
            const output = await loaded.tools[tool].execute(args, { abort: new AbortController().signal });
            if (typeof output !== 'string') throw new Error('OpenCode MapDesign tool output invalid');
            let value;
            try { value = JSON.parse(output); } catch { throw new Error('OpenCode MapDesign tool output is not JSON'); }
            recordTool('opencode', tool, 'opencode-plugin-export');
            record({ type: 'fake-tool-result', agentId: 'opencode', tool, summary: value });
            write({
              type: 'tool_use',
              sessionID: sessionId,
              part: { tool, callID: callId, state: { status: 'completed', input: args, output: value } },
            });
            return value;
          });
        }
        write({ type: 'text', sessionID: sessionId, part: { text: reply } });
        process.stdout.end();
      } catch (error) {
        record({ type: 'fixture-failure', agentId: 'opencode', phase: String(error && error.message || error) });
        process.exitCode = 1;
        process.stdout.end();
      }
    })();
  });
}

function deepSeekCapabilities() {
  return {
    session_resume: true,
    session_cancel: true,
    structured_events: true,
    native_host_tools: true,
    authenticated_callback: true,
  };
}

function runDeepSeekRuntime() {
  record({ type: 'runtime-process', agentId: 'deepseek-harness', adapterPath: 'deepseek-profile', argv: process.argv.slice(2) });
  recordForbiddenDelivery('deepseek-harness', process.argv.slice(2));
  write({
    v: 1,
    type: 'ready',
    runtime: 'map-design',
    protocol_version: 1,
    plugin_version: '1.0.0-e2e',
    capabilities: deepSeekCapabilities(),
  });
  readJsonLines(async (command) => {
    if (command.type === 'cancel') return;
    if (command.type !== 'execute') return;
    const resumed = typeof command.resume_session_id === 'string';
    const sessionId = resumed ? command.resume_session_id : nextSessionId('deepseek-harness');
    recordSession('deepseek-harness', sessionId, resumed, String(command.prompt || ''));
    write({ v: 1, type: 'session', request_id: command.request_id, session_id: sessionId, resumed });
    try {
      const context = {
        ...callbackContextFromEnvironment(command.callback.url, process.env.MAP_DESIGN_TOOL_TOKEN),
        runId: command.request_id,
      };
      const reply = await runSdkWorkflow('deepseek-harness', String(command.prompt || ''), async (tool, args, callId) => {
        write({ v: 1, type: 'tool_call', request_id: command.request_id, call_id: callId, name: tool, arguments: JSON.stringify(args) });
        const result = await callbackTool(context, 'deepseek-harness', tool, callId, args);
        write({ v: 1, type: 'tool_result', request_id: command.request_id, call_id: callId, name: tool, status: 'succeeded', summary: result.summary });
        return result.value;
      });
      write({ v: 1, type: 'text', request_id: command.request_id, content: reply });
      write({ v: 1, type: 'result', request_id: command.request_id, status: 'completed', session_id: sessionId, resume_rejected: false });
    } catch (error) {
      record({ type: 'fixture-failure', agentId: 'deepseek-harness', phase: String(error && error.message || error) });
      write({ v: 1, type: 'result', request_id: command.request_id, status: 'failed', session_id: sessionId, resume_rejected: false, error: { code: 'FIXTURE_FAILED', message: 'Fixture failed.' } });
    }
  });
}

function callbackContextFromEnvironment(url, token) {
  return {
    callbackUrl: url,
    callbackToken: token,
    runId: process.env.MAP_DESIGN_RUN_ID,
    projectId: process.env.MAP_DESIGN_PROJECT_ID,
    conversationId: process.env.MAP_DESIGN_CONVERSATION_ID,
    agentId: process.env.MAP_DESIGN_AGENT_ID,
  };
}

async function callbackTool(context, agentId, tool, callId, args) {
  recordTool(agentId, tool, agentId === 'pi' ? 'pi-sdk-callback' : agentId === 'opencode' ? 'opencode-plugin-callback' : 'deepseek-profile-callback');
  const response = await fetch(String(context.callbackUrl) + '/' + encodeURIComponent(tool), {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + context.callbackToken,
      'content-type': 'application/json',
      'x-map-design-run-id': context.runId,
      'x-map-design-project-id': context.projectId,
      'x-map-design-conversation-id': context.conversationId,
      'x-map-design-agent-id': context.agentId || agentId,
      'x-map-design-tool-use-id': callId,
    },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error('MapDesign callback failed');
  const result = await response.json();
  if (!result || result.ok !== true || result.toolUseId !== callId) {
    record({ type: 'fixture-callback-invalid', agentId, tool, callId, result });
    throw new Error('MapDesign callback result invalid');
  }
  const summary = result.summary && typeof result.summary === 'object' ? result.summary : {};
  const modelContent = typeof result.modelContent === 'string' ? result.modelContent : JSON.stringify(summary);
  record({ type: 'fake-tool-result', agentId, tool, summary });
  let value = summary;
  try { value = JSON.parse(modelContent); } catch { /* safe summary fallback */ }
  return { modelContent, summary, value };
}

async function runSdkWorkflow(agentId, prompt, invoke) {
  if (activeUserPrompt(prompt) === 'Keep the map deterministic and legible.') return 'Map request reviewed.';
  let callIndex = 0;
  const call = async (tool, args) => {
    callIndex += 1;
    const callId = sessionPrefix(agentId) + '-call-' + callIndex;
    if (agentId === 'oh-my-pi') recordTool(agentId, tool, 'omp-host-tool');
    return await invoke(tool, args, callId);
  };
  const context = await call('map_get_context', {});
  const draftRevision = Number(context.draftRevision);
  const semantics = await call('map_update_semantics', semanticsInput(draftRevision, sessionPrefix(agentId)));
  const semanticRevision = Number(semantics.draftRevision);
  const changedRevision = semanticRevision + 1;
  const colors = {
    'oh-my-pi': { background: '#EEF4F8', fill: '#C9DCE8', line: '#315B72', symbol: '#173445' },
    pi: { background: '#F8F0EB', fill: '#E8D0C4', line: '#7A4635', symbol: '#3B2119' },
    opencode: { background: '#0D1117', fill: '#171D24', line: '#59616A', symbol: '#E1DFDB' },
    'deepseek-harness': { background: '#F3EFF8', fill: '#D8CCE8', line: '#654D7D', symbol: '#31243D' },
  }[agentId];
  const apply = await call('map_apply_transaction', revisionPaintInput(
    semanticRevision,
    changedRevision,
    colors,
    agentId === 'opencode',
  ));
  const appliedRevision = Number(apply.draftRevision);
  await call('map_validate', { expectedRevision: appliedRevision });
  const preview = await call('map_render_preview', {
    expectedRevision: appliedRevision,
    idempotencyKey: sessionPrefix(agentId) + '-' + appliedRevision + '-preview',
  });
  await call('map_commit_revision', {
    expectedRevision: appliedRevision,
    idempotencyKey: sessionPrefix(agentId) + '-' + appliedRevision + '-commit',
    previewId: preview.previewId,
    intentSummary: 'Commit deterministic ' + agentId + ' revision.',
  });
  return 'Deterministic revision committed.';
}

function activeUserPrompt(prompt) {
  const marker = '\\nuser: ';
  const markerIndex = prompt.lastIndexOf(marker);
  return markerIndex >= 0 ? prompt.slice(markerIndex + marker.length) : prompt;
}

async function commitDeterministicRevision(branch, colors, skillObserved) {
  await emitPrivateAndPublic(branch, 'Applying and committing deterministic revision paint.');
  const context = await callTool(branch, branch + '-context', 'map_get_context', {});
  const expectedRevision = Number(context.draftRevision);
  const semantics = await callTool(branch, branch + '-semantics', 'map_update_semantics', semanticsInput(
    expectedRevision,
    branch,
  ));
  const semanticRevision = Number(semantics.draftRevision);
  if (semanticRevision !== expectedRevision && semanticRevision !== expectedRevision + 1) {
    throw new Error('deterministic revision semantics failed');
  }
  const changedRevision = semanticRevision + 1;
  const apply = await callTool(branch, branch + '-apply', 'map_apply_transaction', revisionPaintInput(
    semanticRevision,
    changedRevision,
    colors,
    branch === 'revision-two',
  ));
  if (Number(apply.draftRevision) !== changedRevision) throw new Error('deterministic revision transaction failed');
  const validation = await callTool(branch, branch + '-validate', 'map_validate', {
    expectedRevision: changedRevision,
  });
  if (validation.summary?.status !== 'valid') throw new Error('deterministic revision validation failed');
  const preview = await callTool(branch, branch + '-preview', 'map_render_preview', {
    expectedRevision: changedRevision,
    idempotencyKey: 'revision-' + changedRevision + '-preview',
  });
  if (preview.status !== 'succeeded' || typeof preview.previewId !== 'string') {
    throw new Error('deterministic revision preview failed');
  }
  const commit = await callTool(branch, branch + '-commit', 'map_commit_revision', {
    expectedRevision: changedRevision,
    idempotencyKey: 'revision-' + changedRevision + '-commit',
    previewId: preview.previewId,
    intentSummary: 'Commit deterministic revision ' + changedRevision + '.',
  });
  if (!Number.isSafeInteger(Number(commit.revision))) throw new Error('deterministic revision commit failed');
  agentText('Deterministic revision committed.');
  completeTurn('completed');
  record({ type: 'fixture-complete', branch, skillObserved });
}

function revisionPaintInput(expectedRevision, changedRevision, colors, includeMarker) {
  return {
    expectedRevision,
    idempotencyKey: 'revision-' + changedRevision + '-apply',
    transaction: {
      operations: [
        { op: 'setLayerProperties', layerId: 'background', paint: { 'background-color': colors.background } },
        { op: 'setLayerProperties', layerId: 'countries-fill', paint: { 'fill-color': colors.fill } },
        { op: 'setLayerProperties', layerId: 'countries-boundary', paint: { 'line-color': colors.line } },
        { op: 'setLayerProperties', layerId: 'countries-label', paint: { 'text-color': colors.symbol } },
        ...(includeMarker ? [{
          op: 'addLayerDefinition',
          layer: {
            id: 'revision-two-marker',
            type: 'circle',
            source: 'maplibre',
            'source-layer': 'countries',
            paint: { 'circle-color': colors.symbol, 'circle-radius': 2 },
          },
          beforeId: 'countries-label',
        }] : []),
      ],
      validate: true,
    },
    intentSummary: 'Apply deterministic revision ' + changedRevision + ' paint.',
  };
}

function applyInput(expectedRevision, suffix) {
  return {
    expectedRevision,
    idempotencyKey: 'e2e-native-apply-' + suffix,
    transaction: {
      operations: [{
        op: 'setStyleRootProperties',
        properties: { metadata: { mapdesignAcceptance: true } },
      }],
    },
    intentSummary: 'Apply deterministic acceptance metadata.',
  };
}

function semanticsInput(expectedRevision, suffix) {
  return {
    expectedRevision,
    idempotencyKey: 'e2e-native-semantics-' + suffix,
    semantics: {
      version: 1,
      groups: [{
        id: 'acceptance-map',
        label: 'Acceptance map',
        role: 'acceptance',
        layerIds: [
          'background',
          'coastline',
          'countries-fill',
          'countries-boundary',
          'geolines',
          'geolines-label',
          'countries-label',
          'crimea-fill',
        ],
        sourceIds: ['maplibre', 'crimea'],
      }],
    },
    intentSummary: 'Repair the deterministic acceptance semantic mapping.',
  };
}

async function emitPrivateAndPublic(branch, summary) {
  write({ method: 'item/reasoning/textDelta', params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: 'private-reasoning',
    delta: [PRIVATE_REASONING, PRIVATE_PATH, PRIVATE_SOURCE_URL, COMPLETE_STYLE_SENTINEL, RAW_PROVIDER_ERROR, LITERAL_JWT].join(' '),
  } });
  record({ type: 'fixture-event', branch, phase: 'public-summary' });
  write({ method: 'item/reasoning/summaryTextDelta', params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: 'public-reasoning',
    summaryIndex: 0,
    delta: summary,
  } });
}

async function callTool(branch, callId, tool, args) {
  recordTool('codex', tool, 'codex-dynamic-tool');
  record({ type: 'fixture-event', branch, phase: 'tool-start', tool });
  const result = await requestClient('item/tool/call', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    callId,
    namespace: 'map-design',
    tool,
    arguments: args,
  });
  const content = result && Array.isArray(result.contentItems) ? result.contentItems[0] : null;
  const summary = content && typeof content.text === 'string' ? JSON.parse(content.text) : {};
  record({ type: 'fixture-event', branch, phase: 'tool-result', tool, success: result && result.success === true, summary });
  if (!result || result.success !== true) return summary;
  return summary;
}

function requestClient(method, params) {
  const id = nextServerId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('client response timed out'));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    write({ id, method, params });
  });
}

function agentText(text) {
  write({ method: 'item/agentMessage/delta', params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: 'assistant-message',
    delta: text,
  } });
}

function completeTurn(status, error) {
  write({ method: 'turn/completed', params: {
    threadId: THREAD_ID,
    turn: turn(status, error || null),
  } });
}

function turn(status, error) {
  return {
    id: TURN_ID,
    items: [],
    itemsView: { type: 'full' },
    status,
    error: error || null,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: status === 'inProgress' ? null : 1,
  };
}

function waitForRelease(branch) {
  const releasePath = CAPTURE_PATH + '.' + branch + '.release';
  if (consumeRelease(releasePath)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(releasePath), (_eventType, filename) => {
      if (String(filename || '') !== basename(releasePath) || !consumeRelease(releasePath)) return;
      watcher.close();
      resolve();
    });
    watcher.once('error', reject);
    if (consumeRelease(releasePath)) {
      watcher.close();
      resolve();
    }
  });
}

function consumeRelease(path) {
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
`;
}
