import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runCartographyAgent } from '../../../src/map-design/agents/cartography-runner.js';
import type { MapAgentAdapter, MapRunTerminal } from '../../../src/map-design/agents/types.js';
import type { MapDesignRuntimeCatalog } from '../../../src/map-design/application/runtime-catalog.js';
import { RUN_TOOL_CALLBACK_AGENT_HEADER, RUN_TOOL_CALLBACK_CONVERSATION_HEADER, RUN_TOOL_CALLBACK_PROJECT_HEADER, RUN_TOOL_CALLBACK_RUN_HEADER, RUN_TOOL_CALLBACK_TOOL_USE_HEADER } from '../../../src/map-design/agents/tool-callback.js';

it.each(['api', 'codex', 'opencode', 'pi'])('executes %s with the shared model selection and no map mutation tools', async (agentId) => {
  const root = await mkdtemp(join(tmpdir(), 'cartography-runner-'));
  const startMapRun = vi.fn<MapAgentAdapter['startMapRun']>(async (_input, tools, onEvent) => {
    expect(tools).toEqual([]);
    if (agentId === 'codex') onEvent({ kind: 'text', text: 'Inspecting the uploaded source.' });
    onEvent({ kind: 'text', text: '{"message":"Done",' });
    onEvent({ kind: 'text', text: '"source":"spec"}' });
    const result = { status: 'succeeded', ...(agentId === 'codex' ? { finalResponse: '{"message":"Done","source":"spec"}' } : {}) } satisfies MapRunTerminal;
    return { done: Promise.resolve(result), cancel: async () => undefined };
  });
  const runtime = { agentId, model: 'provider/model', modelOrigin: 'custom' as const, reasoning: 'high', serviceTier: 'priority' };
  const runtimeCatalog: MapDesignRuntimeCatalog = { refresh: async () => undefined, list: () => [], validate: (input) => input, normalizeSaved: (input) => ({ runtime: input }), resolveChoice: () => ({ ...runtime, adapter: agentId }) };
  const getMapAgent = vi.fn(() => ({ id: agentId, capabilities: { nativeMapTools: true, publicReasoningSummary: true }, startMapRun }));
  const sessionId = randomUUID(); const conversationId = randomUUID();
  try {
    expect(await runCartographyAgent({ agents: { runtimeCatalog, getMapAgent }, dataRoot: root, prompt: 'Edit the specification', runtime, sessionId, conversationId, runId: randomUUID(), signal: new AbortController().signal })).toBe('{"message":"Done","source":"spec"}');
    expect(getMapAgent).toHaveBeenCalledWith(agentId);
    expect(startMapRun.mock.calls[0]?.[0]).toMatchObject({ projectId: sessionId, conversationId, model: runtime.model, reasoning: 'high', serviceTier: 'priority', taskKind: 'cartography', cwd: join(root, 'cartography-edits', 'agents', sessionId, conversationId) });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['api', 'codex'])('makes the original style readable on every %s turn', async (agentId) => {
  const root = await mkdtemp(join(tmpdir(), 'cartography-source-runner-'));
  const content = '{"layers":[],"vendorField":"original evidence"}';
  const sourceFile = { fileName: '样式.json', content: Buffer.from(content).toString('base64') };
  const runtime = { agentId, model: 'test', modelOrigin: 'catalog' as const };
  const runtimeCatalog: MapDesignRuntimeCatalog = { refresh: async () => undefined, list: () => [], validate: input => input,
    normalizeSaved: input => ({ runtime: input }), resolveChoice: () => ({ ...runtime, adapter: agentId }) };
  const startMapRun = vi.fn<MapAgentAdapter['startMapRun']>(async (input, tools, onEvent) => {
    expect(tools).toEqual([]);
    expect(input.cartographySources).toEqual([{ fileName: 'source/document-1.json', content }]);
    expect(await readFile(join(input.cwd, 'source/uploaded.json'), 'utf8')).toBe(content);
    expect(await readFile(join(input.cwd, 'source/document-1.json'), 'utf8')).toBe(content);
    expect(input.prompt).toContain('read_cartography_source');
    expect(input.resumePrompt).toBe(input.prompt);
    await writeFile(join(input.cwd, 'source/document-1.json'), 'modified local copy');
    onEvent({ kind: 'tool_use', id: 'read', name: 'read_cartography_source', summary: {} });
    onEvent({ kind: 'tool_result', toolUseId: 'read', status: 'succeeded', summary: {} });
    onEvent({ kind: 'text', text: 'complete' });
    return { done: Promise.resolve({ status: 'succeeded' }), cancel: async () => undefined };
  });
  const getMapAgent = () => ({ id: agentId, capabilities: { nativeMapTools: true, publicReasoningSummary: true }, startMapRun });
  const options = { agents: { runtimeCatalog, getMapAgent }, dataRoot: root, prompt: 'Improve', sourceFile, runtime,
    sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), signal: new AbortController().signal };
  try {
    expect(await runCartographyAgent(options)).toBe('complete');
    expect(await runCartographyAgent({ ...options, runId: randomUUID() })).toBe('complete');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['pi', 'omp', 'opencode', 'deepseek-harness'])('allows %s to read uploaded sources through a scoped callback', async (agentId) => {
  // Given an original style and a native adapter that only exposes registered tools.
  const root = await mkdtemp(join(tmpdir(), 'cartography-native-source-'));
  const content = '{"vendorEvidence":"original source"}';
  const runtime = { agentId, model: 'test', modelOrigin: 'catalog' as const };
  const runtimeCatalog: MapDesignRuntimeCatalog = { refresh: async () => undefined, list: () => [], validate: value => value,
    normalizeSaved: value => ({ runtime: value }), resolveChoice: () => ({ ...runtime, adapter: agentId }) };
  let callbackUrl = '';
  const startMapRun: MapAgentAdapter['startMapRun'] = async (input, tools, emit) => {
    expect(tools.map(tool => tool.name)).toEqual(['read_cartography_source']);
    callbackUrl = input.toolCallback.url;
    const headers = { authorization: `Bearer ${input.toolCallback.token}`, 'content-type': 'application/json',
      [RUN_TOOL_CALLBACK_AGENT_HEADER]: agentId, [RUN_TOOL_CALLBACK_RUN_HEADER]: input.runId,
      [RUN_TOOL_CALLBACK_PROJECT_HEADER]: input.projectId, [RUN_TOOL_CALLBACK_CONVERSATION_HEADER]: input.conversationId,
      [RUN_TOOL_CALLBACK_TOOL_USE_HEADER]: 'source-read' };
    // When the extension invokes its authenticated callback.
    const response = await fetch(`${callbackUrl}/read_cartography_source`, { method: 'POST', headers,
      body: JSON.stringify({ fileName: 'source/document-1.json', length: 12 }) });
    // Then it gets an exact source page, and cannot use another session or map mutation.
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ ok: true, toolUseId: 'source-read' });
    if (!result || typeof result !== 'object' || !('modelContent' in result) || typeof result.modelContent !== 'string') {
      throw new Error('Expected uploaded source content');
    }
    expect(JSON.parse(result.modelContent)).toMatchObject({ content: content.slice(0, 12), nextOffset: 12 });
    emit({ kind: 'tool_use', id: 'source-read', name: 'read_cartography_source', summary: {} });
    emit({ kind: 'tool_result', toolUseId: 'source-read', status: 'succeeded', summary: {} });
    const denied = await fetch(`${callbackUrl}/read_cartography_source`, { method: 'POST', headers: { ...headers,
      [RUN_TOOL_CALLBACK_CONVERSATION_HEADER]: 'another-session' }, body: '{}' });
    expect(denied.status).toBe(403);
    const mutation = await fetch(`${callbackUrl}/map_apply_transaction`, { method: 'POST', headers, body: '{}' });
    expect(mutation.status).toBe(404);
    const outside = await fetch(`${callbackUrl}/read_cartography_source`, { method: 'POST', headers,
      body: JSON.stringify({ fileName: '../private.env' }) });
    expect(await outside.json()).toMatchObject({ ok: false, error: { code: 'CARTOGRAPHY_SOURCE_UNAVAILABLE' } });
    return { done: Promise.resolve({ status: 'succeeded', finalResponse: 'complete' }), cancel: async () => undefined };
  };
  try {
    const result = await runCartographyAgent({ agents: { runtimeCatalog, getMapAgent: () => ({ id: agentId,
      capabilities: { nativeMapTools: true, publicReasoningSummary: false }, startMapRun }) }, dataRoot: root,
      prompt: 'Optimize', runtime, sourceFile: { fileName: 'style.json', content: Buffer.from(content).toString('base64') },
      sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), signal: new AbortController().signal });
    expect(result).toBe('complete');
    await expect(fetch(`${callbackUrl}/read_cartography_source`)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reports startup failure safely without mislabeling it as an invalid specification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cartography-startup-'));
  const runtime = { agentId: 'codex', model: 'test', modelOrigin: 'catalog' as const };
  const runtimeCatalog: MapDesignRuntimeCatalog = { refresh: async () => undefined, list: () => [], validate: value => value,
    normalizeSaved: value => ({ runtime: value }), resolveChoice: () => ({ ...runtime, adapter: 'codex' }) };
  const startMapRun: MapAgentAdapter['startMapRun'] = async () => { throw new Error('private upstream startup details'); };
  try {
    await expect(runCartographyAgent({ agents: { runtimeCatalog, getMapAgent: () => ({ id: 'codex',
      capabilities: { nativeMapTools: true, publicReasoningSummary: false }, startMapRun }) }, dataRoot: root,
      prompt: 'Optimize', runtime, sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(),
      signal: new AbortController().signal })).rejects.toThrow('The selected Agent could not start.');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['api', 'codex', 'omp', 'pi', 'opencode', 'deepseek-harness'])('rejects %s output when original source was never read successfully', async (agentId) => {
  const root = await mkdtemp(join(tmpdir(), 'cartography-unread-'));
  const runtime = { agentId, model: 'test', modelOrigin: 'catalog' as const };
  const runtimeCatalog: MapDesignRuntimeCatalog = { refresh: async () => undefined, list: () => [], validate: value => value,
    normalizeSaved: value => ({ runtime: value }), resolveChoice: () => ({ ...runtime, adapter: agentId }) };
  const startMapRun: MapAgentAdapter['startMapRun'] = async (_input, _tools, emit) => {
    emit({ kind: 'tool_use', id: 'read', name: 'read_cartography_source', summary: {} });
    emit({ kind: 'tool_result', toolUseId: 'read', status: 'failed', summary: { code: 'CARTOGRAPHY_SOURCE_UNAVAILABLE' } });
    emit({ kind: 'tool_use', id: 'other', name: 'read_design_reference', summary: {} });
    emit({ kind: 'tool_result', toolUseId: 'other', status: 'succeeded', summary: {} });
    return { done: Promise.resolve({ status: 'succeeded', finalResponse: 'complete' }), cancel: async () => undefined };
  };
  try {
    await expect(runCartographyAgent({ agents: { runtimeCatalog, getMapAgent: () => ({ id: agentId,
      capabilities: { nativeMapTools: true, publicReasoningSummary: false }, startMapRun }) }, dataRoot: root,
      prompt: 'Optimize', runtime, sourceFile: { fileName: 'style.json', content: Buffer.from('{}').toString('base64') },
      sessionId: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), signal: new AbortController().signal }))
      .rejects.toThrow('did not successfully read the uploaded source');
  } finally { await rm(root, { recursive: true, force: true }); }
});
