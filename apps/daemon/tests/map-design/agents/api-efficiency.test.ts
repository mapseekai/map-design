import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { ApiToolMetrics } from '../../../src/map-design/agents/api-tool-metrics.js';
import { ApiToolHistory } from '../../../src/map-design/agents/api-tool-history.js';

describe('API tool efficiency', () => {
  it('counts repeated reads only before a mutation and keeps payloads out of diagnostics', () => {
    const metrics = new ApiToolMetrics();
    const args = { query: 'secret-local-data' };
    metrics.record({ name: 'map_search_layers', input: args, output: '地图', durationMs: 4, ok: true });
    metrics.record({ name: 'map_search_layers', input: args, output: '地图', durationMs: 7, ok: true });
    metrics.record({ name: 'map_apply_transaction', input: {}, output: '{}', durationMs: 3, ok: true });
    metrics.record({ name: 'map_search_layers', input: args, output: '地图', durationMs: 2, ok: true });
    const snapshot = metrics.snapshot();
    expect(snapshot).toMatchObject({ readCalls: 3, duplicateReads: 1, duplicateReadRate: 1 / 3 });
    expect(snapshot.tools.map_search_layers).toMatchObject({ calls: 3, outputBytes: 18, durationMs: 13 });
    expect(JSON.stringify(snapshot)).not.toContain('secret-local-data');
  });

  it('compacts historical successful reads while preserving call pairs, revisions, errors and preview', () => {
    const history = new ApiToolHistory();
    const large = JSON.stringify({ layers: 'x'.repeat(10_000) });
    history.remember('old', { revision: 2 });
    history.remember('new', { revision: 3 });
    const messages: ModelMessage[] = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'old', toolName: 'map_inspect', input: { layerId: 'roads' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'old', toolName: 'map_inspect', output: { type: 'text', value: large } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'failed', toolName: 'map_inspect', output: { type: 'text', value: JSON.stringify({ code: 'REVISION_CONFLICT', detail: large }) } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'preview', toolName: 'map_render_preview', output: { type: 'text', value: JSON.stringify({ previewId: 'preview-3', revision: 3 }) } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'new', toolName: 'map_inspect', output: { type: 'text', value: large } }] },
    ];
    const compacted = history.compact(messages);
    expect(compacted.messages[0]).toEqual(messages[0]);
    expect(compacted.messages.slice(2)).toEqual(messages.slice(2));
    expect(compacted.compactedResults).toBe(1);
    expect(compacted.savedBytes).toBeGreaterThan(9000);
    const old = compacted.messages[1];
    if (old?.role !== 'tool' || old.content[0]?.type !== 'tool-result' || old.content[0].output.type !== 'text') throw new TypeError('Expected tool result');
    expect(JSON.parse(old.content[0].output.value)).toMatchObject({ compacted: true, toolCallId: 'old', summary: { revision: 2 }, requiresReread: true });
    expect(history.compact(compacted.messages).compactedResults).toBe(0);
  });
});
