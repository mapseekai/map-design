import { resolve } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { MapDesignAppConfig } from '@mapseekai/contracts';
import { createApiMapAgentAdapter } from '../../../src/map-design/agents/ai-sdk.js';
import { resolveApiProfile } from '../../../src/map-design/application/api-profile-service.js';
import type { MapRunInput } from '../../../src/map-design/agents/types.js';
const repo = resolve(import.meta.dirname, '../../../../..');
const input = (model: string): MapRunInput => ({ runId: 'run', projectId: 'project', conversationId: 'conversation',
  prompt: 'Inspect the map.', resumePrompt: '', model, cwd: repo, reasoning: null, serviceTier: null,
  signal: new AbortController().signal, toolCallback: {} as MapRunInput['toolCallback'],
  toolRuntime: { execute: async () => { throw new Error('No tools expected'); }, closeRun() {} } });
function sse() {
  const base = { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'same-model' };
  const events = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Ready.' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => vi.unstubAllGlobals());
describe('API profile selection with mocked network responses', () => {
  const config: MapDesignAppConfig = { activeApiProfileId: 'b', byokProviders: {
    a: { protocol: 'openai', baseUrl: 'https://one.example/v1', apiKey: 'fixture-a', model: 'same-model' },
    b: { protocol: 'openai', baseUrl: 'https://two.example/v1', apiKey: 'fixture-b', model: 'same-model' },
  } };
  it('selects distinct endpoint and key pairs for identical model names', async () => {
    const request = vi.fn<typeof fetch>(async () => sse()); vi.stubGlobal('fetch', request);
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: (model) => resolveApiProfile(config, model), report: vi.fn() });
    for (const profile of ['a', 'b']) {
      const handle = await adapter.startMapRun(input(`api-profile:${profile}`), [], () => {});
      expect(await handle.done).toEqual({ status: 'succeeded' });
    }
    expect(request.mock.calls).toHaveLength(2);
    for (const [index, profile] of ['a', 'b'].entries()) {
      const saved = config.byokProviders![profile]!;
      const [url, init] = request.mock.calls[index]!;
      expect(String(url)).toBe(`${saved.baseUrl}/chat/completions`);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${saved.apiKey}`);
      expect(JSON.parse(String(init?.body)).model).toBe('same-model');
      expect(init?.redirect).toBe('error'); expect(String(init?.body)).not.toContain(saved.apiKey);
    }
  });
  it('preserves the immutable run snapshot when the default differs', async () => {
    const request = vi.fn<typeof fetch>(async () => sse()); vi.stubGlobal('fetch', request);
    const adapter = createApiMapAgentAdapter({ projectRoot: repo, provider: () => config.byokProviders!.b, report: vi.fn() });
    const handle = await adapter.startMapRun({ ...input('same-model'), apiProviderSnapshot: { ...config.byokProviders!.a! } }, [], () => {});
    expect(await handle.done).toEqual({ status: 'succeeded' });
    expect(String(request.mock.calls[0]![0])).toBe('https://one.example/v1/chat/completions');
  });
});
