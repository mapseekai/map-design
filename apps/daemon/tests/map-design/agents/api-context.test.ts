import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { createApiContextCompactor, estimateContextTokens, type ApiConversationHistory } from '../../../src/map-design/agents/api-context.js';
import { createApiMapAgentAdapter } from '../../../src/map-design/agents/ai-sdk.js';
import type { MapRunInput } from '../../../src/map-design/agents/types.js';
import { apiConversationHistory } from '../../../src/map-design/storage/api-context.js';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';

const repo = resolve(import.meta.dirname, '../../../../..');
const usage = { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const summaryResult = (text = 'Keep waterways blue. Layers roads and water were inspected. Continue the requested edit.') => ({
  content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [],
});
const end = () => ({ stream: simulateReadableStream({ chunks: [
  { type: 'stream-start' as const, warnings: [] },
  { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage },
] }) });
const toolStep = (id: string) => ({ stream: simulateReadableStream({ chunks: [
  { type: 'stream-start' as const, warnings: [] },
  { type: 'tool-call' as const, toolCallId: id, toolName: 'map_get_context', input: '{}' },
  { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage },
] }) });
const input = (): MapRunInput => ({ runId: 'r', projectId: 'p', conversationId: 'c', prompt: 'Current state: revision 9. Edit roads.',
  resumePrompt: '', cwd: repo, model: 'test', reasoning: null, serviceTier: null, signal: new AbortController().signal,
  toolRuntime: { execute: async call => ({ ok: true, toolUseId: call.toolUseId, summary: { revision: 9 }, modelContent: 'x'.repeat(55_000) }), closeRun() {} },
  toolCallback: { url: 'http://127.0.0.1', token: 'test', close() {} },
});
const messages = Array.from({ length: 8 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? 'assistant' : 'user',
  content: index < 4 ? 'Keep waterways blue. 地图约束。'.repeat(1000) : `Recent message ${index}` }));

describe('API context compaction', () => {
  it('persists a bounded summary across restart, preserves originals and invalidates changed history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-context-'));
    let db = openMapDesignDatabase(root);
    try {
      let store = createMapDesignLocalStore(db);
      store.createProject({ project: { projectId: 'p', title: 'Map', runtime: { agentId: 'api' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Clear', idempotencyKey: 'key' }, primaryConversationId: 'c', verifiedWorkingDirectory: null });
      for (const [index, message] of messages.entries()) store.appendMessage({ message: { ...message, role: index % 2 ? 'assistant' : 'user',
        conversationId: 'c', events: [], runStatus: 'succeeded', startedAt: index, endedAt: index } });
      const model = new MockLanguageModelV4({ doGenerate: summaryResult(), doStream: end() });
      const compact = createApiContextCompactor({ model, contextWindowTokens: 32_768, signal: new AbortController().signal });
      const rendered = await compact.conversation(apiConversationHistory(store, 'c', messages), 8000);
      expect(estimateContextTokens(rendered)).toBeLessThan(8000);
      expect(JSON.stringify(rendered)).toContain('Keep waterways blue');
      expect(JSON.stringify(rendered)).toContain('Recent message 4');
      expect(model.doGenerateCalls.length).toBeGreaterThan(1);
      expect(model.doGenerateCalls.every(call => !call.tools?.length && estimateContextTokens(call.prompt) < 28_000)).toBe(true);
      const original = store.getConversation('c')!.messages;
      db.close(); db = openMapDesignDatabase(root); store = createMapDesignLocalStore(db);
      expect(store.getConversation('c')!.messages).toEqual(original);
      const history = apiConversationHistory(store, 'c', messages);
      expect(history.summary?.throughMessageId).toBe('m3');
      const calls = model.doGenerateCalls.length;
      expect(await compact.conversation(history, 8000)).toEqual(rendered);
      expect(model.doGenerateCalls).toHaveLength(calls);
      await compact.conversation({ ...history, messages: messages.map(m => m.id === 'm0' ? { ...m, content: 'Changed constraint. '.repeat(2000) } : m) }, 8000);
      expect(model.doGenerateCalls.length).toBeGreaterThan(calls);
      expect(JSON.stringify(model.doGenerateCalls[calls]?.prompt)).toContain('Changed constraint');
      store.deleteProject('p');
      expect(db.prepare('SELECT * FROM api_context_summaries').all()).toEqual([]);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it('sends summary and recent turns to the actual SDK loop without duplicating old history', async () => {
    const model = new MockLanguageModelV4({ doGenerate: summaryResult(), doStream: end() });
    const save = vi.fn();
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model,
      execution: () => ({ contextWindowTokens: 65_536 }), report: vi.fn() });
    const handle = await adapter.startMapRun({ ...input(), apiHistory: { messages, save } }, [], () => {});
    expect(await handle.done).toEqual({ status: 'succeeded' });
    expect(save).toHaveBeenCalledOnce();
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    expect(prompt).toContain('Keep waterways blue');
    expect(prompt).toContain('Current state: revision 9');
    expect(prompt).toContain('Recent message 7');
    expect(prompt).not.toContain('地图约束');
  });

  it('compacts complete older tool steps in the real SDK loop without replaying tools', async () => {
    const model = new MockLanguageModelV4({ doGenerate: summaryResult(), doStream: [toolStep('a'), toolStep('b'), toolStep('c'), toolStep('d'), toolStep('e'), toolStep('f'), end()] });
    const request = input();
    const execute = vi.fn(request.toolRuntime.execute);
    const report = vi.fn();
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, report });
    const handle = await adapter.startMapRun({ ...request, toolRuntime: { ...request.toolRuntime, execute } }, [
      { name: 'map_get_context', description: 'Read map state', inputSchema: { type: 'object', properties: {} } },
    ], () => {});
    expect(await handle.done).toEqual({ status: 'succeeded' });
    expect(execute).toHaveBeenCalledTimes(6);
    expect(model.doGenerateCalls.length).toBeGreaterThan(0);
    const last = JSON.stringify(model.doStreamCalls.at(-1)?.prompt);
    expect(last).toContain('Historical context summary');
    expect(last).toContain('Current state: revision 9');
    expect(last).not.toContain('"toolCallId":"a"');
    expect(last).toContain('"toolCallId":"f"');
    for (const call of model.doStreamCalls) {
      const calls = call.prompt.flatMap(m => m.role === 'assistant' ? m.content.filter(p => p.type === 'tool-call').map(p => p.toolCallId) : []);
      const results = call.prompt.flatMap(m => m.role === 'tool' ? m.content.filter(p => p.type === 'tool-result').map(p => p.toolCallId) : []);
      expect(calls).toEqual(results);
    }
    expect(report.mock.calls[0]?.[0].summaryCalls).toBe(model.doGenerateCalls.length);
  });

  it('keeps unresolved calls with their arguments and results', async () => {
    const model = new MockLanguageModelV4({ doGenerate: summaryResult() });
    const compact = createApiContextCompactor({ model, contextWindowTokens: 32_768, signal: new AbortController().signal });
    const steps: ModelMessage[] = [{ role: 'user', content: 'Current request' }];
    for (const id of ['failed', 'b', 'c']) steps.push(
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'map_apply_transaction', input: { revision: 4 } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'map_apply_transaction', output: { type: 'text', value: 'REVISION_CONFLICT'.repeat(1000) } }] },
    );
    expect(await compact.step(steps, 1000, ['failed'])).toEqual(steps);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it('summarizes a single oversized historical message in bounded Unicode fragments', async () => {
    const model = new MockLanguageModelV4({ doGenerate: summaryResult() });
    const save = vi.fn();
    const compact = createApiContextCompactor({ model, contextWindowTokens: 16_384, signal: new AbortController().signal });
    const original = { id: 'huge', role: 'user', content: '保留水体蓝色🌊\\"'.repeat(5000) };
    const result = await compact.conversation({ messages: [original], save }, 5000);
    expect(estimateContextTokens(result)).toBeLessThan(5000);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ throughMessageId: 'huge' }));
    expect(model.doGenerateCalls.length).toBeGreaterThan(1);
    for (const call of model.doGenerateCalls) {
      expect(estimateContextTokens(call.prompt) + 4096).toBeLessThan(16_384);
      expect(JSON.stringify(call.prompt)).not.toContain('�');
    }
  });

  it.each(['error', 'empty', 'truncated', 'canceled'])('preserves the prior summary on %s', async reason => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      if (reason === 'error') throw new Error('provider details');
      if (reason === 'canceled') { controller.abort(); throw new Error('aborted'); }
      return { ...summaryResult(reason === 'empty' ? '' : 'Partial summary'),
        finishReason: { unified: reason === 'truncated' ? 'length' as const : 'stop' as const, raw: 'stop' } };
    } });
    const save = vi.fn();
    const history: ApiConversationHistory = { messages, save };
    const compact = createApiContextCompactor({ model, contextWindowTokens: 32_768, signal: controller.signal });
    await expect(compact.conversation(history, 8000)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    expect(history.messages).toEqual(messages);
  });

  it('rejects an oversized current request before a provider call', async () => {
    const model = new MockLanguageModelV4({ doStream: end() });
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model });
    const handle = await adapter.startMapRun({ ...input(), prompt: 'x'.repeat(500_000) }, [], () => {});
    expect(await handle.done).toMatchObject({ status: 'failed', error: { code: 'API_CONTEXT_LIMIT' } });
    expect(model.doStreamCalls).toHaveLength(0);
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
