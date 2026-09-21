import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { createApiMapAgentAdapter } from '../../../src/map-design/agents/ai-sdk.js';
import type { MapRunInput } from '../../../src/map-design/agents/types.js';
import type { NativeMapToolDefinition } from '../../../src/map-design/tools/tool-context.js';

const repo = resolve(import.meta.dirname, '../../../../..');
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const definition: NativeMapToolDefinition = { name: 'map_apply_transaction', description: 'test edit', inputSchema: {
  type: 'object', properties: { target: { type: 'string' }, expectedRevision: { type: 'integer' }, idempotencyKey: { type: 'string' } }, required: ['target'], additionalProperties: false,
} };
const toolStep = (id: string, args: Record<string, unknown>) => ({ stream: simulateReadableStream({ chunks: [
  { type: 'stream-start' as const, warnings: [] }, { type: 'tool-call' as const, toolCallId: id, toolName: definition.name, input: JSON.stringify(args) },
  { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage },
] }) });
const end = (reason: 'stop' | 'length' = 'stop') => ({ stream: simulateReadableStream({ chunks: [
  { type: 'stream-start' as const, warnings: [] }, { type: 'finish' as const, finishReason: { unified: reason, raw: reason }, usage },
] }) });
function input(execute: MapRunInput['toolRuntime']['execute']): MapRunInput {
  return { runId: 'r', projectId: 'p', conversationId: 'c', prompt: 'Edit', resumePrompt: '', cwd: repo,
    model: 'test', reasoning: null, serviceTier: null, signal: new AbortController().signal,
    toolRuntime: { execute, closeRun() {} }, toolCallback: {} as MapRunInput['toolCallback'] };
}
const succeeded: MapRunInput['toolRuntime']['execute'] = async (call) => ({ ok: true, toolUseId: call.toolUseId, summary: {} });
const failed: MapRunInput['toolRuntime']['execute'] = async (call) => ({ ok: false, toolUseId: call.toolUseId, error: { code: 'REVISION_CONFLICT', message: 'Refresh revision', retryable: true } });

describe('API execution outcomes and budgets', () => {
  it('never treats a different successful operation as repair of a failed call', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep('a', { target: 'A' }), toolStep('b', { target: 'B' }), end()] });
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, report: vi.fn() });
    const handle = await adapter.startMapRun(input((call) => call.toolUseId === 'a' ? failed(call) : succeeded(call)), [definition], () => {});
    expect(await handle.done).toMatchObject({ status: 'failed', error: { code: 'API_TOOL_FAILED' } });
  });
  it('resolves an explicitly linked retry with refreshed metadata, stripping retry metadata from domain input', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep('a', { target: 'A', expectedRevision: 1 }), toolStep('b', { target: 'A', expectedRevision: 2, retryOfToolCallId: 'a' }), end()] });
    const execute = vi.fn<MapRunInput['toolRuntime']['execute']>((call) => call.toolUseId === 'a' ? failed(call) : succeeded(call));
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, report: vi.fn() });
    const handle = await adapter.startMapRun(input(execute), [definition], () => {});
    expect(await handle.done).toEqual({ status: 'succeeded' });
    expect(execute.mock.calls[1]![0].input).toEqual({ target: 'A', expectedRevision: 2 });
  });
  it('rejects a retry reference that changes the operation', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep('a', { target: 'A' }), toolStep('b', { target: 'B', retryOfToolCallId: 'a' }), end()] });
    const execute = vi.fn(failed); const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, report: vi.fn() });
    const handle = await adapter.startMapRun(input(execute), [definition], () => {});
    expect(await handle.done).toMatchObject({ status: 'failed', error: { code: 'API_TOOL_FAILED' } }); expect(execute).toHaveBeenCalledOnce();
  });
  it('distinguishes output truncation and records actual usage without prompts', async () => {
    const model = new MockLanguageModelV4({ doStream: end('length') }); const report = vi.fn();
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, execution: () => ({ maxOutputTokens: 512 }), report });
    const handle = await adapter.startMapRun(input(succeeded), [], () => {});
    expect(await handle.done).toMatchObject({ status: 'failed', error: { code: 'API_OUTPUT_LIMIT' } });
    expect(model.doStreamCalls[0]!.maxOutputTokens).toBe(512);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ steps: 1, inputTokens: 10, outputTokens: 5, finishReason: 'length' }));
    expect(JSON.stringify(report.mock.calls)).not.toContain('prompt');
  });
  it('enforces the configured model step budget', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep('a', { target: 'A' }), end()] });
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, execution: () => ({ maxSteps: 1 }), report: vi.fn() });
    const handle = await adapter.startMapRun(input(succeeded), [definition], () => {});
    expect(await handle.done).toMatchObject({ error: { code: 'API_STEP_LIMIT' } }); expect(model.doStreamCalls).toHaveLength(1);
  });
  it('enforces the tool budget without executing extra tools', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep('a', { target: 'A' }), toolStep('b', { target: 'B' }), end()] });
    const execute = vi.fn(succeeded); const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, execution: () => ({ maxToolCalls: 1 }), report: vi.fn() });
    const handle = await adapter.startMapRun(input(execute), [definition], () => {});
    expect(await handle.done).toMatchObject({ error: { code: 'API_TOOL_LIMIT' } }); expect(execute).toHaveBeenCalledOnce();
  });
  it('stops repeated failing operations before exhausting the full budget', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep('a', { target: 'A' }), toolStep('b', { target: 'A' }), toolStep('c', { target: 'A' }), end()] });
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, report: vi.fn() });
    const handle = await adapter.startMapRun(input(failed), [definition], () => {});
    expect(await handle.done).toMatchObject({ error: { code: 'API_TOOL_LOOP' } }); expect(model.doStreamCalls).toHaveLength(3);
  });
  it('rejects invalid configuration before requesting a model', async () => {
    const model = new MockLanguageModelV4({ doStream: end() });
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, execution: () => ({ maxSteps: 0 }), report: vi.fn() });
    const handle = await adapter.startMapRun(input(succeeded), [], () => {});
    expect(await handle.done).toMatchObject({ error: { code: 'API_CONFIGURATION_REQUIRED' } }); expect(model.doStreamCalls).toHaveLength(0);
  });
});
