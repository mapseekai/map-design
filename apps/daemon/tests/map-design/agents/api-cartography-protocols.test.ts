import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createApiModel } from '../../../src/map-design/agents/api-model.js';
import { createApiMapAgentAdapter } from '../../../src/map-design/agents/ai-sdk.js';
import type { MapAgentEvent, MapRunInput } from '../../../src/map-design/agents/types.js';

const repo = resolve(import.meta.dirname, '../../../../..');
const source = '{"vendorEvidence":"original-value"}';
const reply = JSON.stringify({ message: 'Done', source: '# Specification', sampleBindings: {} });
const read = { fileName: 'style.json' };
type Protocol = 'chat' | 'responses' | 'anthropic';

function stream(protocol: Protocol, first: boolean, text: string): Response {
  const events: Record<string, unknown>[] = [];
  if (protocol === 'chat') {
    const chunk = (delta: unknown, finish: string | null = null) => ({ id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason: finish }] });
    events.push(chunk({ role: 'assistant', content: first ? 'Reading source.' : text }));
    if (first) events.push(chunk({ tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read_cartography_source', arguments: JSON.stringify(read) } }] }));
    events.push(chunk({}, first ? 'tool_calls' : 'stop'));
  } else if (protocol === 'anthropic') {
    events.push({ type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', model: 'test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: first ? 'Reading source.' : text } },
      { type: 'content_block_stop', index: 0 });
    if (first) events.push({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'read-1', name: 'read_cartography_source', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(read) } },
      { type: 'content_block_stop', index: 1 });
    events.push({ type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' });
  } else {
    const message = { id: 'msg-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: first ? 'Reading source.' : text, annotations: [] }] };
    const call = { id: 'fc-1', type: 'function_call', call_id: 'read-1', name: 'read_cartography_source', arguments: JSON.stringify(read), status: 'completed' };
    events.push({ type: 'response.created', response: { id: 'resp-1', created_at: 1, model: 'test' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: 'msg-1', output_index: 0, content_index: 0, delta: first ? 'Reading source.' : text },
      { type: 'response.output_item.done', output_index: 0, item: message });
    if (first) events.push({ type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '', status: 'in_progress' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc-1', output_index: 1, delta: JSON.stringify(read) },
      { type: 'response.output_item.done', output_index: 1, item: call });
    events.push({ type: 'response.completed', response: { id: 'resp-1', object: 'response', created_at: 1, model: 'test', status: 'completed', output: first ? [message, call] : [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, incomplete_details: null } });
  }
  return new Response(events.map(event => `${typeof event.type === 'string' ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') + (protocol === 'chat' ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } });
}

it.each([
  ['chat', reply], ['responses', reply], ['anthropic', reply],
  ['chat', ''], ['responses', ''], ['anthropic', ''],
] as const)('returns only the final cartography reply after a %s source tool step (%j)', async (protocol, finalText) => {
  // Given real provider parsing with commentary, a source read, and a final JSON response.
  let requests = 0;
  const request = vi.fn<typeof fetch>(async () => stream(protocol, ++requests === 1, finalText));
  const provider = { protocol: protocol === 'anthropic' ? 'anthropic' as const : 'openai' as const,
    apiFormat: protocol === 'responses' ? 'responses' as const : 'chat-completions' as const,
    apiKey: 'fixture-key', model: 'test', baseUrl: 'https://models.example/v1' };
  const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => provider, model: createApiModel(provider, null, request), report: vi.fn() });
  const events: MapAgentEvent[] = [];
  const input: MapRunInput = { runId: 'r', projectId: 'p', conversationId: 'c', prompt: 'Optimize', resumePrompt: '', cwd: repo,
    model: 'test', reasoning: null, serviceTier: null, signal: new AbortController().signal, taskKind: 'cartography',
    cartographySources: [{ fileName: 'style.json', content: source }],
    toolRuntime: { execute: async () => { throw new Error('Unexpected mutation'); }, closeRun() {} },
    toolCallback: { url: 'http://127.0.0.1', token: 'test', close() {} } };
  // When the real SDK completes both HTTP stream steps.
  const handle = await adapter.startMapRun(input, [], event => events.push(event));
  // Then final output excludes commentary and the second request includes original source evidence.
  expect(await handle.done).toEqual({ status: 'succeeded', finalResponse: finalText });
  expect(request).toHaveBeenCalledTimes(2);
  expect(String(request.mock.calls[1]?.[1]?.body)).toContain('original-value');
  expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_result', status: 'succeeded' }));
});
