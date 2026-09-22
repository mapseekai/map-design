import type { SafeToolSummary } from '@mapseekai/contracts';
import type { ModelMessage } from 'ai';

const COMPACTABLE_TOOLS = new Set(['map_inspect', 'map_search_layers']);
const MIN_RESULT_BYTES = 4096;

export class ApiToolHistory {
  private readonly summaries = new Map<string, SafeToolSummary>();

  remember(toolCallId: string, summary: SafeToolSummary): void {
    if (this.summaries.size >= 512) this.summaries.delete(this.summaries.keys().next().value ?? '');
    this.summaries.set(toolCallId, Object.fromEntries(Object.entries(summary)
      .filter(([, value]) => value === null || typeof value === 'number' || typeof value === 'boolean'
        || (typeof value === 'string' && value.length <= 256))));
  }

  compact(messages: ModelMessage[]) {
    const toolIndexes = messages.flatMap((message, index) => message.role === 'tool' ? [index] : []);
    const recentStart = toolIndexes.at(-2) ?? 0;
    let compactedResults = 0;
    let savedBytes = 0;
    const compacted: ModelMessage[] = messages.map((message, index) => {
      if (message.role !== 'tool' || index >= recentStart) return message;
      return { ...message, content: message.content.map((part) => {
        if (part.type !== 'tool-result' || !COMPACTABLE_TOOLS.has(part.toolName)) return part;
        const summary = this.summaries.get(part.toolCallId);
        if (!summary || part.output.type !== 'text') return part;
        const bytes = Buffer.byteLength(part.output.value);
        if (bytes < MIN_RESULT_BYTES) return part;
        const value = JSON.stringify({ compacted: true, toolCallId: part.toolCallId, summary, requiresReread: true,
          message: 'Historical read content omitted. Use the original call arguments to read current data again if its details are needed. Retained revision metadata describes the historical result only.' });
        compactedResults++;
        savedBytes += bytes - Buffer.byteLength(value);
        return { ...part, output: { type: 'text' as const, value } };
      }) };
    });
    return { messages: compacted, compactedResults, savedBytes };
  }
}
