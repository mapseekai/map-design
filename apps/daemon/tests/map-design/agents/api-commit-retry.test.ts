import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { MapCommitRevisionInputSchema } from '@mapseekai/map-design-contracts';
import { z } from 'zod';
import { createApiMapAgentAdapter } from '../../../src/map-design/agents/ai-sdk.js';
import { ApiToolOutcomes } from '../../../src/map-design/agents/api-tool-outcomes.js';
import type { MapRunInput } from '../../../src/map-design/agents/types.js';

const repo = resolve(import.meta.dirname, '../../../../..');
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const commit = { expectedRevision: 11, previewId: 'expired-preview', idempotencyKey: 'commit-first', intentSummary: 'Save verified map' };
const step = (args?: Record<string, unknown>, id = 'failed-commit') => ({ stream: simulateReadableStream({ chunks: [
  { type: 'stream-start' as const, warnings: [] },
  ...(args ? [{ type: 'tool-call' as const, toolCallId: id, toolName: 'map_commit_revision', input: JSON.stringify(args) }] : []),
  { type: 'finish' as const, finishReason: { unified: args ? 'tool-calls' as const : 'stop' as const, raw: 'stop' }, usage },
] }) });
function input(execute: MapRunInput['toolRuntime']['execute']): MapRunInput {
  return { runId: 'r', projectId: 'p', conversationId: 'c', prompt: 'Commit the verified map.', resumePrompt: '', cwd: repo,
    model: 'test', reasoning: null, serviceTier: null, signal: new AbortController().signal,
    toolRuntime: { execute, closeRun() {} }, toolCallback: { url: 'http://127.0.0.1', token: 'test', close() {} } };
}

describe('API commit retry recovery', () => {
  it('returns the failed call ID in the model-visible error', async () => {
    const model = new MockLanguageModelV4({ doStream: [step(commit), step()] });
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, report: vi.fn() });
    const handle = await adapter.startMapRun(input(async (call) => ({ ok: false, toolUseId: call.toolUseId,
      error: { code: 'PREVIEW_STALE', message: 'The map preview is stale.', retryable: false } })),
    [{ name: 'map_commit_revision', description: 'Commit', inputSchema: z.toJSONSchema(MapCommitRevisionInputSchema) }], () => undefined);
    expect(await handle.done).toMatchObject({ status: 'failed', error: { code: 'API_TOOL_FAILED' } });
    const results = model.doStreamCalls.at(-1)?.prompt.flatMap(message => message.role === 'tool' ? message.content : []);
    expect(results).toContainEqual(expect.objectContaining({ output: { type: 'text', value: JSON.stringify({
      code: 'PREVIEW_STALE', message: 'The map preview is stale.', retryable: false, toolCallId: 'failed-commit',
    }) } }));
  });

  it('completes an explicitly linked commit retry with a fresh preview for the same draft', async () => {
    const corrected = { ...commit, previewId: 'fresh-preview', idempotencyKey: 'commit-retry' };
    const model = new MockLanguageModelV4({ doStream: [step(commit), step({ ...corrected, retryOfToolCallId: 'failed-commit' }, 'recovered'), step()] });
    const execute = vi.fn<MapRunInput['toolRuntime']['execute']>(async (call) => call.toolUseId === 'failed-commit'
      ? { ok: false, toolUseId: call.toolUseId, error: { code: 'PREVIEW_STALE', message: 'The map preview is stale.', retryable: false } }
      : { ok: true, toolUseId: call.toolUseId, summary: { revision: 6, draftRevision: 11 } });
    const report = vi.fn();
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => undefined, model, report });
    const handle = await adapter.startMapRun(input(execute),
      [{ name: 'map_commit_revision', description: 'Commit', inputSchema: z.toJSONSchema(MapCommitRevisionInputSchema) }], () => undefined);
    expect(await handle.done).toEqual({ status: 'succeeded' });
    expect(execute.mock.calls[1]?.[0].input).toEqual(corrected);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ unresolvedCalls: 0 }));
  });

  it('does not link a commit for another draft to the failed commit', () => {
    const outcomes = new ApiToolOutcomes();
    outcomes.failed('failed-commit', 'map_commit_revision', commit);
    expect(() => outcomes.validateRetry('map_commit_revision', { ...commit, expectedRevision: 12 }, 'failed-commit')).toThrow();
  });

  it('does not let an unlinked successful commit erase the failed call', () => {
    const outcomes = new ApiToolOutcomes();
    outcomes.failed('failed-commit', 'map_commit_revision', commit);
    outcomes.succeeded('map_commit_revision', { ...commit, previewId: 'fresh-preview' });
    expect(outcomes.unresolved).toBe(1);
  });
});
