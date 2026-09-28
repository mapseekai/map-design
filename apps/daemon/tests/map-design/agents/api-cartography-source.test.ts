import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { createApiMapAgentAdapter } from '../../../src/map-design/agents/ai-sdk.js';
import type { MapAgentEvent, MapRunInput } from '../../../src/map-design/agents/types.js';

const repo = resolve(import.meta.dirname, '../../../../..');
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const step = (args?: Record<string, unknown>, id = 'read') => ({ stream: simulateReadableStream({ chunks: [
  { type: 'stream-start' as const, warnings: [] },
  ...(args ? [{ type: 'tool-call' as const, toolCallId: id, toolName: 'read_cartography_source', input: JSON.stringify(args) }] : []),
  { type: 'finish' as const, finishReason: { unified: args ? 'tool-calls' as const : 'stop' as const, raw: 'stop' }, usage },
] }) });
function input(overrides: Partial<MapRunInput> = {}): MapRunInput {
  return { runId: 'r', projectId: 'p', conversationId: 'c', prompt: 'Optimize the imported design.', resumePrompt: '', cwd: repo,
    model: 'test', reasoning: null, serviceTier: null, signal: new AbortController().signal, taskKind: 'cartography',
    toolRuntime: { execute: async () => { throw new Error('Unexpected map mutation'); }, closeRun() {} },
    toolCallback: { url: 'http://127.0.0.1', token: 'test', close() {} }, ...overrides };
}
const { taskKind: _taskKind, ...mapInput } = input({ cartographySources: [{ fileName: 'style.json', content: '{}' }] });

describe('API cartography source reads', () => {
  it('returns original fields with bounded pagination through the SDK loop', async () => {
    // Given an uploaded document with a field absent from its normalized design.
    const content = '{"vendorUnknown":"preserve-this"}';
    const model = new MockLanguageModelV4({ doStream: [step({ fileName: 'style.json', length: 10 }), step({ fileName: 'style.json', offset: 10 }, 'rest'), step()] });
    const report = vi.fn(); const events: MapAgentEvent[] = [];
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, report });
    // When the model reads both pages.
    const handle = await adapter.startMapRun(input({ cartographySources: [{ fileName: 'style.json', content }] }), [], (event) => events.push(event));
    // Then both exact slices reach the model and successful events are emitted.
    expect(await handle.done).toEqual({ status: 'succeeded', finalResponse: '' });
    const results = model.doStreamCalls.at(-1)?.prompt.flatMap((message) => message.role === 'tool' ? message.content : []);
    expect(results).toMatchObject([
      { output: { type: 'text', value: JSON.stringify({ fileName: 'style.json', offset: 0, totalLength: content.length, nextOffset: 10, content: content.slice(0, 10) }) } },
      { output: { type: 'text', value: JSON.stringify({ fileName: 'style.json', offset: 10, totalLength: content.length, nextOffset: null, content: content.slice(10) }) } },
    ]);
    expect(events.filter((event) => event.kind === 'tool_result')).toHaveLength(2);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ toolCalls: 2, unresolvedCalls: 0 }));
    expect(model.doStreamCalls[0]?.tools?.find(tool => tool.name === 'read_cartography_source')).toMatchObject({
      inputSchema: { properties: { fileName: { type: 'string', enum: ['style.json'] } } },
    });
  });
  it('rejects file names outside the supplied uploads', async () => {
    // Given a source-scoped cartography run.
    const model = new MockLanguageModelV4({ doStream: [step({ fileName: '../.env' }), step()] });
    const events: MapAgentEvent[] = [];
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, report: vi.fn() });
    // When the model requests an unprovided path.
    const handle = await adapter.startMapRun(input({ cartographySources: [{ fileName: 'style.json', content: '{}' }] }), [], (event) => events.push(event));
    // Then the read fails and remains unresolved.
    expect(await handle.done).toMatchObject({ status: 'failed', error: { code: 'API_TOOL_FAILED' } });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', status: 'failed' }));
  });
  it.each([input(), mapInput])('omits source access without a source-scoped cartography task', async (runInput) => {
    // Given a run without permission to read uploaded sources.
    const model = new MockLanguageModelV4({ doStream: step() });
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, report: vi.fn() });
    // When its tools are sent to the model.
    const handle = await adapter.startMapRun(runInput, [], () => undefined);
    // Then the source tool is absent.
    expect(await handle.done).toEqual({ status: 'succeeded', ...('taskKind' in runInput ? { finalResponse: '' } : {}) });
    expect(model.doStreamCalls[0]?.tools?.map((entry) => entry.name)).not.toContain('read_cartography_source');
  });
  it.each([{ length: 16001 }, { length: 0 }, { offset: -1 }, { offset: 0.5 }])('rejects invalid source ranges %j', async (range) => {
    // Given a source read with an invalid character range.
    const model = new MockLanguageModelV4({ doStream: [step({ fileName: 'style.json', ...range }), step()] });
    const events: MapAgentEvent[] = [];
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, report: vi.fn() });
    // When the SDK validates the requested range.
    const handle = await adapter.startMapRun(input({ cartographySources: [{ fileName: 'style.json', content: '{}' }] }), [], (event) => events.push(event));
    // Then no source read executes.
    expect(await handle.done).toMatchObject({ status: 'failed', error: { code: 'API_TOOL_FAILED' } });
    expect(events.filter((event) => event.kind === 'tool_use')).toHaveLength(0);
  });
  it('counts source reads against the shared tool budget', async () => {
    // Given a one-call budget and two source reads.
    const model = new MockLanguageModelV4({ doStream: [step({ fileName: 'style.json' }), step({ fileName: 'style.json' }, 'second'), step()] });
    const events: MapAgentEvent[] = [];
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, execution: () => ({ maxToolCalls: 1 }), report: vi.fn() });
    // When the model requests the second read.
    const handle = await adapter.startMapRun(input({ cartographySources: [{ fileName: 'style.json', content: '{}' }] }), [], (event) => events.push(event));
    // Then only the first read executes.
    expect(await handle.done).toMatchObject({ status: 'failed', error: { code: 'API_TOOL_LIMIT' } });
    expect(events.filter((event) => event.kind === 'tool_use')).toHaveLength(1);
  });
  it('recovers a schema-invalid source call when the model explicitly retries it', async () => {
    // Given invalid arguments followed by a corrected retry of that call.
    const model = new MockLanguageModelV4({ doStream: [step({ fileName: 'style.json', length: 0 }),
      step({ fileName: 'style.json', length: 10, retryOfToolCallId: 'read' }, 'corrected'), step()] });
    const report = vi.fn();
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, report });
    // When the SDK rejects the first call and executes the corrected one.
    const handle = await adapter.startMapRun(input({ cartographySources: [{ fileName: 'style.json', content: '{}' }] }), [], () => undefined);
    // Then the old failure is resolved without discarding tool validation.
    expect(await handle.done).toEqual({ status: 'succeeded', finalResponse: '' });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ toolCalls: 1, unresolvedCalls: 0 }));
  });
});
