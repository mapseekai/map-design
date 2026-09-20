import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createFakeMapAcpRuntime } from '../lib/playwright/fake-map-acp-runtime.js';
import { STANDARD_AGENTS } from '../lib/playwright/mock-factory.js';

const EXPECTED_MAP_TOOLS = [
  'map_get_context',
  'map_inspect',
  'map_search_layers',
  'map_apply_transaction',
  'map_update_semantics',
  'map_validate',
  'map_render_preview',
  'map_commit_revision',
  'map_discard_draft',
] as const;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })));
});

describe('deterministic multi-Agent acceptance fixture', () => {
  it('exposes distinct native runtimes and keeps Codex and OpenCode sessions isolated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'map-design-fake-agents-'));
    roots.push(root);
    const fake = await createFakeMapAcpRuntime({ root });

    expect(Object.keys(fake.executables)).toEqual([
      'codex',
      'oh-my-pi',
      'pi',
      'opencode',
      'deepseek-harness',
    ]);
    expect(new Set(Object.values(fake.executables)).size).toBe(5);

    await createFakeCodexSession(fake.executables.codex, 'conversation-1');
    await createFakeOpenCodeSession(fake.executables.opencode, 'conversation-1');

    expect(fake.sessionsFor('conversation-1')).toEqual({
      codex: ['codex-session-1'],
      opencode: ['opencode-session-1'],
    });
    expect(fake.crossAgentSessionReuse).toBe(false);
  });

  it('publishes all supported fake Agents and keeps Claude policy-disabled without executable paths', () => {
    expect(STANDARD_AGENTS.map((agent) => agent.id)).toEqual([
      'codex',
      'oh-my-pi',
      'pi',
      'opencode',
      'deepseek-harness',
      'claude',
    ]);
    expect(STANDARD_AGENTS.filter((agent) => agent.mapDesign.nativeMapTools).map((agent) => agent.id))
      .toEqual(['codex', 'oh-my-pi', 'pi', 'opencode', 'deepseek-harness']);
    expect(STANDARD_AGENTS.find((agent) => agent.id === 'claude')).toMatchObject({
      available: true,
      mapDesign: {
        nativeMapTools: false,
        reason: 'map-tools-policy-unsupported',
      },
    });
    expect(STANDARD_AGENTS.some((agent) => Object.hasOwn(agent, 'executable'))).toBe(false);
  });

  it.each([
    ['malformed', 'export const broken = ;\n'],
    ['incomplete', `export async function MapDesignOpenCodePlugin() {
  return { tool: { map_get_context: { execute: async () => '{}' } } };
}\n`],
  ])('fails the OpenCode probe for a %s configured plugin', async (_case, source) => {
    const root = await mkdtemp(join(tmpdir(), 'map-design-fake-opencode-plugin-'));
    roots.push(root);
    const fake = await createFakeMapAcpRuntime({ root });
    const pluginPath = join(root, 'configured-plugin.mjs');
    const probePath = join(root, 'configured-plugin-tools.json');
    await writeFile(pluginPath, source, 'utf8');

    const code = await spawnAndWait(fake.executables.opencode, ['debug', 'agent', 'build'], {
      ...process.env,
      MAP_DESIGN_PLUGIN_PROBE_PATH: probePath,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [pathToFileURL(pluginPath).href] }),
    });

    expect(code).not.toBe(0);
  });

  it('records observable violations when the map CLI or MapDesign MCP tripwire is launched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'map-design-fake-tripwires-'));
    roots.push(root);
    const fake = await createFakeMapAcpRuntime({ root });

    expect(fake.env.MAP_DESIGN_MCP_CLI_PATH).toBe(fake.interceptors.mapMcpServer);
    expect(fake.env.PATH.split(delimiter)).toContain(root);
    await spawnAndWait('md', ['tool', 'map_get_context'], { ...process.env, PATH: fake.env.PATH });
    await spawnAndWait(process.execPath, [fake.env.MAP_DESIGN_MCP_CLI_PATH], process.env);

    const events = (await readFile(fake.capturePath, 'utf8')).split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { argv?: string[]; type: string });
    expect(events.filter((event) => event.type === 'map-cli-invocation')).toEqual([
      expect.objectContaining({ argv: ['tool', 'map_get_context'] }),
    ]);
    expect(events.filter((event) => event.type === 'map-mcp-server')).toEqual([
      expect.objectContaining({ argv: [] }),
    ]);
  });
});

describe('fake Codex app-server dynamic tool contract', () => {
  it('accepts the exact ordered nine Map tools', async () => {
    await expect(startThread([...EXPECTED_MAP_TOOLS])).resolves.toMatchObject({
      id: 2,
      result: { thread: { id: 'codex-session-1' } },
    });
  });

  it.each([
    ['a missing tool', EXPECTED_MAP_TOOLS.slice(0, -1)],
    ['an extra tool', [...EXPECTED_MAP_TOOLS, 'map_private_tool']],
    ['reordered tools', [EXPECTED_MAP_TOOLS[1], EXPECTED_MAP_TOOLS[0], ...EXPECTED_MAP_TOOLS.slice(2)]],
  ])('fails closed for %s', async (_case, tools) => {
    await expect(startThread(tools)).resolves.toMatchObject({
      id: 2,
      error: { code: -32602 },
    });
  });

  it.each([
    [
      'revision one',
      composedPrompt([], 'Create and commit deterministic revision one.'),
      0,
      1,
      2,
      false,
      {
        background: '#F8F4F0',
        fill: '#DFDBD7',
        line: '#FFCC88',
        symbol: '#171717',
      },
    ],
    [
      'revision two',
      composedPrompt([
        'user: Create and commit deterministic revision one.',
        'assistant: Deterministic revision committed.',
      ], 'Create and commit deterministic revision two.'),
      7,
      7,
      8,
      true,
      {
        background: '#0D1117',
        fill: '#171D24',
        line: '#59616A',
        symbol: '#E1DFDB',
      },
    ],
  ])('drives the validated preview and commit sequence for %s', async (
    _case,
    prompt,
    initialDraftRevision,
    semanticDraftRevision,
    paintDraftRevision,
    includeMarker,
    colors,
  ) => {
    const calls = await runTurn(prompt, (tool) => {
      if (tool === 'map_get_context') return { draftRevision: initialDraftRevision };
      if (tool === 'map_update_semantics') return { revision: semanticDraftRevision, validationStatus: 'valid' };
      if (tool === 'map_apply_transaction') return { revision: paintDraftRevision };
      if (tool === 'map_validate') return { revision: paintDraftRevision, validationStatus: 'valid' };
      if (tool === 'map_render_preview') {
        return { draftRevision: paintDraftRevision, previewId: `preview-${paintDraftRevision}`, status: 'succeeded' };
      }
      if (tool === 'map_commit_revision') return { draftRevision: paintDraftRevision, revision: paintDraftRevision };
      throw new Error(`Unexpected fake Map tool: ${tool}`);
    });

    expect(calls.map((call) => call.tool)).toEqual([
      'map_get_context',
      'map_update_semantics',
      'map_apply_transaction',
      'map_validate',
      'map_render_preview',
      'map_commit_revision',
    ]);
    expect(calls[1]?.arguments).toMatchObject({
      expectedRevision: initialDraftRevision,
      idempotencyKey: expect.stringMatching(/^e2e-native-semantics-revision-(?:one|two)$/u),
      semantics: { version: 1 },
    });
    const operations = [
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
          paint: { 'circle-color': '#E1DFDB', 'circle-radius': 2 },
        },
        beforeId: 'countries-label',
      }] : []),
    ];
    expect(calls[2]?.arguments).toEqual({
      expectedRevision: semanticDraftRevision,
      idempotencyKey: `revision-${paintDraftRevision}-apply`,
      transaction: {
        operations,
        validate: true,
      },
      intentSummary: `Apply deterministic revision ${paintDraftRevision} paint.`,
    });
    expect(calls[3]?.arguments).toEqual({ expectedRevision: paintDraftRevision });
    expect(calls[4]?.arguments).toEqual({
      expectedRevision: paintDraftRevision,
      idempotencyKey: `revision-${paintDraftRevision}-preview`,
    });
    expect(calls[5]?.arguments).toEqual({
      expectedRevision: paintDraftRevision,
      idempotencyKey: `revision-${paintDraftRevision}-commit`,
      previewId: `preview-${paintDraftRevision}`,
      intentSummary: `Commit deterministic revision ${paintDraftRevision}.`,
    });
  });

  it('follows the latest draft instruction after accumulated revision history', async () => {
    const calls = await runTurn(composedPrompt([
      'Create and commit deterministic revision one.',
      'Create and commit deterministic revision two.',
    ], 'Add the deterministic acceptance metadata.'), (tool) => {
      if (tool === 'map_get_context') return { draftRevision: 4 };
      if (tool === 'map_update_semantics') return { revision: 5, validationStatus: 'valid' };
      if (tool === 'map_apply_transaction') return { revision: 6 };
      if (tool === 'map_validate') return { revision: 6, validationStatus: 'valid' };
      if (tool === 'map_render_preview') return { previewId: 'preview-6', status: 'succeeded' };
      throw new Error(`Unexpected fake Map tool: ${tool}`);
    });

    expect(calls.map((call) => call.tool)).toEqual([
      'map_get_context',
      'map_update_semantics',
      'map_apply_transaction',
      'map_validate',
      'map_render_preview',
    ]);
    expect(calls[2]?.arguments).toMatchObject({
      expectedRevision: 5,
      transaction: {
        operations: [{
          op: 'setStyleRootProperties',
          properties: { metadata: { mapdesignAcceptance: true } },
        }],
      },
    });
  });

  it.each([
    ['generic', 'Review the recovered map.', []],
    ['dark', 'Apply the deterministic dark theme background.', [
      'map_update_semantics', 'map_apply_transaction', 'map_validate',
    ]],
    ['legacy', 'Repeat the invalid legacy map operation until the run is stopped.', Array.from(
      { length: 9 },
      () => 'map_apply_transaction',
    )],
    ['unrelated', 'Summarize the current request without changing the map.', []],
  ])('isolates a %s follow-up from historical revision prompts', async (_case, currentPrompt, expectedTools) => {
    const calls = await runTurn(composedPrompt([
      'user: Create and commit deterministic revision one.',
      'assistant: Deterministic revision committed.',
      'user: Create and commit deterministic revision two.',
      'assistant: Deterministic revision committed.',
    ], currentPrompt), (tool) => {
      if (tool === 'map_get_context') return { draftRevision: 0 };
      if (tool === 'map_update_semantics') return { revision: 1, validationStatus: 'valid' };
      if (tool === 'map_apply_transaction') return { revision: 2 };
      if (tool === 'map_validate') return { revision: 2, validationStatus: 'valid' };
      if (tool === 'map_render_preview') return { previewId: 'preview-2', status: 'succeeded' };
      if (tool === 'map_commit_revision') return { draftRevision: 2, revision: 1 };
      throw new Error(`Unexpected fake Map tool: ${tool}`);
    });

    expect(calls.map((call) => call.tool)).toEqual(expectedTools);
    expect(calls.some((call) => call.tool === 'map_commit_revision')).toBe(false);
  });
});

type FakeToolCall = {
  arguments: Record<string, unknown>;
  callId: string;
  tool: string;
};

function composedPrompt(history: readonly string[], currentPrompt: string): string {
  return [
    'You are the MapDesign agent.',
    'Conversation:',
    ...history,
    `user: ${currentPrompt}`,
  ].join('\n');
}

async function runTurn(
  prompt: string,
  resultForTool: (tool: string) => Record<string, unknown>,
): Promise<FakeToolCall[]> {
  const root = await mkdtemp(join(tmpdir(), 'map-design-fake-turn-'));
  roots.push(root);
  const runtime = await createFakeMapAcpRuntime({ root });
  const child = spawn(runtime.bin, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const calls: FakeToolCall[] = [];
  let buffer = '';
  let settled = false;
  const completion = new Promise<FakeToolCall[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fake ACP turn timed out.')), 5_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: { arguments?: Record<string, unknown>; callId?: string; tool?: string };
        };
        if (frame.method === 'item/tool/call') {
          const tool = String(frame.params?.tool ?? '');
          calls.push({
            arguments: frame.params?.arguments ?? {},
            callId: String(frame.params?.callId ?? ''),
            tool,
          });
          child.stdin.write(`${JSON.stringify({
            id: frame.id,
            result: {
              contentItems: [{ text: JSON.stringify(resultForTool(tool)) }],
              success: true,
            },
          })}\n`);
        }
        if (frame.method === 'turn/completed' && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(calls);
        }
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!settled && code !== 0) reject(new Error(`Fake ACP process exited with ${code}.`));
    });
  });
  try {
    const send = (frame: unknown): void => { child.stdin.write(`${JSON.stringify(frame)}\n`); };
    send({ id: 1, method: 'initialize', params: {} });
    send({ method: 'initialized', params: {} });
    send({
      id: 2,
      method: 'thread/start',
      params: {
        dynamicTools: [{
          type: 'namespace',
          name: 'map-design',
          tools: EXPECTED_MAP_TOOLS.map((name) => ({ type: 'function', name })),
        }],
      },
    });
    send({ id: 3, method: 'turn/start', params: { input: [{ type: 'text', text: prompt }] } });
    return await completion;
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
  }
}

async function startThread(toolNames: readonly string[]): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), 'map-design-fake-app-server-'));
  roots.push(root);
  const runtime = await createFakeMapAcpRuntime({ root });
  const child = spawn(runtime.bin, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<(frame: Record<string, unknown>) => void> = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(frame); else frames.push(frame);
    }
  });
  const nextFrame = async (): Promise<Record<string, unknown>> => {
    const frame = frames.shift();
    if (frame) return frame;
    return await new Promise((resolve) => waiters.push(resolve));
  };
  const send = (frame: unknown): void => { child.stdin.write(`${JSON.stringify(frame)}\n`); };
  try {
    send({ id: 1, method: 'initialize', params: {} });
    await nextFrame();
    send({ method: 'initialized', params: {} });
    send({
      id: 2,
      method: 'thread/start',
      params: {
        dynamicTools: [{
          type: 'namespace',
          name: 'map-design',
          tools: toolNames.map((name) => ({ type: 'function', name })),
        }],
      },
    });
    return await nextFrame();
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
  }
}

async function createFakeCodexSession(bin: string, conversationId: string): Promise<void> {
  const child = spawn(bin, ['app-server', '--stdio'], {
    env: { ...process.env, MAP_DESIGN_FAKE_CONVERSATION_ID: conversationId },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fake Codex session timed out.')), 5_000);
    const send = (frame: unknown): void => { child.stdin.write(`${JSON.stringify(frame)}\n`); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as { id?: number; method?: string };
        if (frame.id === 1) {
          send({ method: 'initialized', params: {} });
          send({
            id: 2,
            method: 'thread/start',
            params: {
              dynamicTools: [{
                type: 'namespace',
                name: 'map-design',
                tools: EXPECTED_MAP_TOOLS.map((name) => ({ type: 'function', name })),
              }],
            },
          });
        } else if (frame.id === 2) {
          send({ id: 3, method: 'turn/start', params: { input: [{ type: 'text', text: 'Review the map.' }] } });
        } else if (frame.method === 'turn/completed') {
          clearTimeout(timer);
          resolve();
        }
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Fake Codex session exited with ${code}.`));
    });
    send({ id: 1, method: 'initialize', params: {} });
  }).finally(() => {
    child.stdin.end();
    child.kill('SIGTERM');
  });
}

async function createFakeOpenCodeSession(bin: string, conversationId: string): Promise<void> {
  const pluginPath = join(dirname(bin), 'session-plugin.mjs');
  await writeFile(pluginPath, `import { tool } from '@opencode-ai/plugin';
const names = ${JSON.stringify(EXPECTED_MAP_TOOLS)};
export async function MapDesignOpenCodePlugin() {
  return { tool: Object.fromEntries(names.map((name) => [name, tool({ execute: async () => '{}' })])) };
}
`, 'utf8');
  const child = spawn(bin, ['run', '--format', 'json'], {
    env: {
      ...process.env,
      MAP_DESIGN_AGENT_ID: 'opencode',
      MAP_DESIGN_CONVERSATION_ID: conversationId,
      MAP_DESIGN_FAKE_CONVERSATION_ID: conversationId,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [pathToFileURL(pluginPath).href] }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end('Review the map.');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fake OpenCode session timed out.')), 5_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Fake OpenCode session exited with ${code}.`));
    });
  });
}

async function spawnAndWait(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number | null> {
  const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'ignore'] });
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
}
