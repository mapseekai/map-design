import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCartographyAgent } from '../../../src/map-design/agents/cartography-runner.js';
vi.mock('../../../src/map-design/agents/cartography-runner.js', () => ({ runCartographyAgent: vi.fn() }));
import { describe, expect, it, vi } from 'vitest';
import { initializeCartographyDraft, initializeCartographyUrlDraft, fetchCartographySource, generateCartographyDraft, generateCartographyEdit } from '../../../src/map-design/application/cartography-authoring.js';

const fixture = (name: string) => readFileSync(new URL(`../../../../../skills/cartography-init/fixtures/${name}`, import.meta.url));
describe('cartography authoring', () => {
  it.each(['style-min.json', 'qgis-min.qgs', 'arcgis-min.lyrx', 'sld-min.xml'])('creates a reviewable draft from %s', (fileName) => {
    const draft = initializeCartographyDraft({ name: 'Library test', fileName, content: fixture(fileName).toString('base64') });
    expect(draft.source).toContain('Library test');
    expect(draft.reportMarkdown).toBeTruthy();
    expect(JSON.parse(draft.reportJson)).toHaveProperty('bindings');
  });
  it('rejects private network sources before connecting', async () => {
    await expect(fetchCartographySource('http://127.0.0.1/private')).rejects.toThrow();
    await expect(initializeCartographyUrlDraft({ name: 'Test', url: 'http://127.0.0.1/style.json' })).rejects.toThrow();
  });
  it('rejects paths and oversized style uploads', () => {
    expect(() => initializeCartographyDraft({ name: 'Test', fileName: '../style.json', content: 'e30=' })).toThrow();
    expect(() => initializeCartographyDraft({ name: 'Test', fileName: 'style.json', content: 'a'.repeat(6_000_000) })).toThrow();
  });
});


it('creates a lint-valid CARTOGRAPHY.md through the configured API without a CLI', async () => {
  const source = '---\nversion: "0.4.0"\nname: API Atlas\ncolors:\n  ink: "#24303A"\n---\n\n## Overview\nWarm paper and restrained ink.\n';
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'chat-1', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: source }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', request);
  try {
    const output = await generateCartographyDraft({ jobId: '12345678-1234-4234-8234-123456789abc', runtime: 'api', name: 'API Atlas', requirements: 'Warm paper' }, {
      dataRoot: '/unused-api-draft', projectRoot: fileURLToPath(new URL('../../../../../', import.meta.url)),
      config: { read: () => ({ byokProviders: { default: { protocol: 'openai', apiKey: 'not-for-client', model: 'test' } } }) },
    }, new AbortController().signal);
    expect(output.source).toBe(source);
    const body = String(request.mock.calls[0]?.[1]?.body);
    expect(body).toContain('cartography.md agent skill');
    expect(body).not.toContain('not-for-client');
  } finally { vi.unstubAllGlobals(); }
});

it('edits the supplied document through the shared Agent runner and validates its reply', async () => {
  vi.mocked(runCartographyAgent).mockClear();
  const source = '---\nversion: "0.4.0"\nname: Atlas\ncolors:\n  ink: "#123456"\n---\n\n## Overview\nOriginal.';
  const reply = { message: 'Clarified hierarchy.', source: source + '\n\n## Typography & Labels\nKeep labels readable.' };
  vi.mocked(runCartographyAgent).mockResolvedValue(JSON.stringify(reply));
  const result = await generateCartographyEdit({ source, prompt: 'Improve labels', history: [], reportMarkdown: 'Keep extracted colors.', runtime: 'api' }, {
    dataRoot: '/unused', projectRoot: fileURLToPath(new URL('../../../../../', import.meta.url)),
    agents: {} as Parameters<typeof runCartographyAgent>[0]['agents'],
  }, new AbortController().signal);
  expect(result).toEqual(reply);
  expect(runCartographyAgent).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('#123456') }));
  expect(vi.mocked(runCartographyAgent).mock.calls[0]?.[0].prompt).toContain('sampleBindings');
});

it.each(['api', 'codex', 'omp'])('generates with the selected %s agent and model', async (agentId) => {
  const source = '---\nversion: "0.4.0"\nname: Atlas\ncolors:\n  ink: "#123456"\n---\n\n## Overview\nOriginal.';
  vi.mocked(runCartographyAgent).mockResolvedValue(source);
  const runtime = { agentId, model: 'chosen-model' };
  const result = await generateCartographyDraft({
    jobId: '12345678-1234-4234-8234-123456789abc', name: 'Atlas', requirements: 'Warm paper', runtime,
  }, {
    dataRoot: '/unused', projectRoot: fileURLToPath(new URL('../../../../../', import.meta.url)),
    agents: {} as Parameters<typeof runCartographyAgent>[0]['agents'],
  }, new AbortController().signal);
  expect(result.source).toBe(source);
  expect(runCartographyAgent).toHaveBeenLastCalledWith(expect.objectContaining({ runtime }));
});
