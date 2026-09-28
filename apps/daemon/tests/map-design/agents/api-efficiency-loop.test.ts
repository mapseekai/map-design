import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { createApiMapAgentAdapter, type ApiRunDiagnostic } from '../../../src/map-design/agents/ai-sdk.js';
import type { MapRunInput } from '../../../src/map-design/agents/types.js';
import type { NativeMapToolDefinition } from '../../../src/map-design/tools/tool-context.js';

const repo = resolve(import.meta.dirname, '../../../../..');
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const definition: NativeMapToolDefinition = { name: 'map_inspect', description: 'Read layers', inputSchema: {
  type: 'object', properties: { layerId: { type: 'string' } }, required: ['layerId'], additionalProperties: false,
} };
const toolStep = (name: string, id: string, args: Record<string, unknown>) => ({ stream: simulateReadableStream({ chunks: [
  { type: 'stream-start' as const, warnings: [] }, { type: 'tool-call' as const, toolCallId: id, toolName: name, input: JSON.stringify(args) },
  { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage },
] }) });
const end = () => ({ stream: simulateReadableStream({ chunks: [
  { type: 'stream-start' as const, warnings: [] }, { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage },
] }) });
function input(execute: MapRunInput['toolRuntime']['execute']): MapRunInput {
  return { runId: 'r', projectId: 'p', conversationId: 'c', prompt: 'Inspect roads', resumePrompt: '', cwd: repo,
    model: 'test', reasoning: null, serviceTier: null, signal: new AbortController().signal,
    toolRuntime: { execute, closeRun() {} }, toolCallback: { url: 'http://127.0.0.1', token: 'test', close() {} } };
}

describe('API efficiency in the actual SDK loop', () => {
  it('compacts old successful reads in provider requests and reports bounded counters', async () => {
    const model = new MockLanguageModelV4({ doStream: [
      toolStep('map_inspect', 'a', { layerId: 'private-layer-name' }),
      toolStep('map_inspect', 'b', { layerId: 'private-layer-name' }),
      toolStep('map_inspect', 'c', { layerId: 'private-layer-name' }), end(),
    ] });
    const report = vi.fn<(value: ApiRunDiagnostic) => void>();
    const execute = vi.fn<MapRunInput['toolRuntime']['execute']>(async (call) => ({ ok: true, toolUseId: call.toolUseId,
      summary: { revision: 7 }, modelContent: JSON.stringify({ revision: 7, payload: 'y'.repeat(9000) }) }));
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, report });
    const handle = await adapter.startMapRun(input(execute), [definition], () => {});
    expect(await handle.done).toEqual({ status: 'succeeded' });
    const finalMessages = model.doStreamCalls.at(-1)?.prompt;
    const outputs = finalMessages?.flatMap((message) => message.role === 'tool' ? message.content : []);
    const old = outputs?.find((part) => part.type === 'tool-result' && part.toolCallId === 'a');
    if (old?.type !== 'tool-result' || old.output.type !== 'text') throw new TypeError('Expected historical tool output');
    expect(JSON.parse(old.output.value)).toMatchObject({ compacted: true, summary: { revision: 7 }, requiresReread: true });
    const diagnostic = report.mock.calls[0]?.[0];
    expect(diagnostic).toMatchObject({ compactedResults: 1, toolMetrics: { readCalls: 3, duplicateReads: 2,
      tools: { map_inspect: { calls: 3, failures: 0 } } } });
    expect(diagnostic?.compactedBytes).toBeGreaterThan(8000);
    expect(JSON.stringify(diagnostic)).not.toContain('private-layer-name');
    expect(model.doStreamCalls.every((call) => call.tools?.some((entry) => entry.name === 'map_inspect'))).toBe(true);
  });

  it('reuses the injected skill without sending a second copy to the model', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep('read_design_reference', 'ref', { name: 'map-design' }), end()] });
    const execute = vi.fn<MapRunInput['toolRuntime']['execute']>();
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, report: vi.fn() });
    const handle = await adapter.startMapRun(input(execute), [], () => {});
    expect(await handle.done).toEqual({ status: 'succeeded' });
    const response = model.doStreamCalls[1]?.prompt.flatMap((message) => message.role === 'tool' ? message.content : [])[0];
    if (response?.type !== 'tool-result' || response.output.type !== 'text') throw new TypeError('Expected reference result');
    expect(JSON.parse(response.output.value)).toEqual({ reference: 'map-design', alreadyInInstructions: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it('only exposes document references for an explicitly typed cartography edit', async () => {
    const model = new MockLanguageModelV4({ doStream: end() });
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, report: vi.fn() });
    const handle = await adapter.startMapRun({ ...input(vi.fn()), taskKind: 'cartography' }, [definition], () => {});
    expect(await handle.done).toEqual({ status: 'succeeded', finalResponse: '' });
    expect(model.doStreamCalls[0]?.tools?.map((entry) => entry.name)).toEqual(['read_design_reference']);
  });
});
