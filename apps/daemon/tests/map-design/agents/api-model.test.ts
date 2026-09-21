import { generateText, streamText, tool, jsonSchema } from 'ai';
import { apiProviderOptions } from '../../../src/map-design/agents/api-provider-options.js';
import { describe, expect, it, vi } from 'vitest';
import { createApiModel, apiModelFailure } from '../../../src/map-design/agents/api-model.js';

const text = 'Map analysis is ready.';
const responses = {
  chat: { id: 'chat-1', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  anthropic: { id: 'msg-1', type: 'message', role: 'assistant', model: 'test', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  responses: { id: 'resp-1', object: 'response', created_at: 1, status: 'completed', model: 'test', output: [{ id: 'msg-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, incomplete_details: null },
};
describe('direct model API protocols', () => {
  it.each([
    ['openai', 'chat-completions', 'chat', '/chat/completions'],
    ['openai', 'responses', 'responses', '/responses'],
    ['anthropic', 'chat-completions', 'anthropic', '/messages'],
  ] as const)('handles %s / %s with the real AI SDK provider', async (protocol, apiFormat, fixture, endpoint) => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(responses[fixture]), { headers: { 'content-type': 'application/json' } }));
    const model = createApiModel({ protocol, apiKey: 'test-secret', baseUrl: 'https://models.example/v1', model: 'test', apiFormat }, null, request);
    const result = await generateText({ model, prompt: 'Analyze the map', maxOutputTokens: 128, maxRetries: 0 });
    expect(result.text).toBe(text);
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe(`https://models.example/v1${endpoint}`);
    expect(init?.redirect).toBe('error');
    expect(String(init?.body)).not.toContain('test-secret');
    const headers = new Headers(init?.headers);
    expect(headers.get(protocol === 'anthropic' ? 'x-api-key' : 'authorization')).toBe(protocol === 'anthropic' ? 'test-secret' : 'Bearer test-secret');
  });
  it('rejects missing configuration and never echoes upstream errors containing a key', async () => {
    expect(() => createApiModel(undefined)).toThrow(/Configure/);
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: 'test-secret rejected' } }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const model = createApiModel({ protocol: 'openai', apiKey: 'test-secret', model: 'test' }, null, request);
    try { await generateText({ model, prompt: 'Analyze', maxRetries: 0 }); throw new Error('Expected rejection'); }
    catch (error) { expect(apiModelFailure(error).code).toBe('API_AUTH_FAILED'); expect(JSON.stringify(apiModelFailure(error))).not.toContain('test-secret'); }
  });
});


it.each(['openai', 'anthropic'] as const)('streams %s responses with the real provider parser', async (protocol) => {
  const events = protocol === 'openai' ? [
    { id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ] : [
    { type: 'message_start', message: { ...responses.anthropic, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  const sse = events.map((event) => `${'type' in event ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') + (protocol === 'openai' ? 'data: [DONE]\n\n' : '');
  const mockFetch = vi.fn<typeof fetch>(async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }));
  const result = streamText({ model: createApiModel({ protocol, apiKey: 'test-secret', model: 'test' }, null, mockFetch), prompt: 'Analyze', maxOutputTokens: 128, maxRetries: 0 });
  expect(await result.text).toBe(text);
  expect(JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body)).stream).toBe(true);
});


it.each([
  ['openai', 'chat-completions', 'chat'], ['openai', 'responses', 'responses'], ['anthropic', 'chat-completions', 'anthropic'],
] as const)('sends effective provider-specific parameters for %s / %s', async (protocol, apiFormat, fixture) => {
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(responses[fixture]), { headers: { 'content-type': 'application/json' } }));
  const provider = { protocol, apiFormat, apiKey: 'test-secret', baseUrl: 'https://models.example/v1', model: apiFormat === 'responses' ? 'gpt-5' : 'test' };
  const model = createApiModel(provider, null, request);
  const tier = protocol === 'anthropic' ? 'standard_only' : 'priority';
  await generateText({ model, prompt: 'Analyze the map', maxOutputTokens: 512, maxRetries: 0,
    tools: { read_map: tool({ inputSchema: jsonSchema({ type: 'object', properties: {}, additionalProperties: false }), execute: async () => ({ ok: true }) }) },
    providerOptions: apiProviderOptions(provider, 'high', tier),
  });
  const body = JSON.parse(String(request.mock.calls[0]![1]!.body));
  if (protocol === 'anthropic') {
    expect(body.tool_choice.disable_parallel_tool_use).toBe(true);
    expect(body.output_config.effort).toBe('high'); expect(body.service_tier).toBe('standard_only');
  } else {
    expect(body.parallel_tool_calls).toBe(false); expect(body.service_tier).toBe('priority');
    expect(apiFormat === 'responses' ? body.reasoning.effort : body.reasoning_effort).toBe('high');
  }
  expect(JSON.stringify(body)).not.toContain('test-secret');
});
