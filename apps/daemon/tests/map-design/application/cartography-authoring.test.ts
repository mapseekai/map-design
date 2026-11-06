import { readFileSync } from 'node:fs';
import { lintCartography } from '@mapseekai/cartography.md';
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
    expect(draft.sourceFile).toEqual({ fileName, content: fixture(fileName).toString('base64') });
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
    expect(body).toContain('Bare numbers are invalid');
    expect(body).toContain('Authoritative front-matter JSON Schema');
    expect(body).toContain('The optional omitted field');
    expect(body).not.toContain('not-for-client');
  } finally { vi.unstubAllGlobals(); }
});

it('edits the supplied document through the shared Agent runner and validates its reply', async () => {
  vi.mocked(runCartographyAgent).mockClear();
  const source = '---\nversion: "0.4.0"\nname: Atlas\ncolors:\n  ink: "#123456"\n---\n\n## Overview\nOriginal.';
  const reply = { message: 'Clarified hierarchy.', source: source + '\n\n## Typography & Labels\nKeep labels readable.' };
  vi.mocked(runCartographyAgent).mockResolvedValue(JSON.stringify(reply));
  const result = await generateCartographyEdit({ source, prompt: 'Improve labels', history: Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: 'constraint-' + i })), reportMarkdown: 'Keep extracted colors.', runtime: 'api' }, {
    dataRoot: '/unused', projectRoot: fileURLToPath(new URL('../../../../../', import.meta.url)),
    agents: {} as Parameters<typeof runCartographyAgent>[0]['agents'],
  }, new AbortController().signal);
  expect(result).toEqual(reply);
  expect(vi.mocked(runCartographyAgent).mock.calls[0]?.[0].apiHistory?.messages).toHaveLength(12);
  expect(vi.mocked(runCartographyAgent).mock.calls[0]?.[0].prompt).not.toContain('constraint-');
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

it('repairs an invalid geometry-only element once using validator feedback', async () => {
  const source = '---\nversion: "0.4.0"\nname: Atlas\ncolors:\n  paper: "#faf9f5"\nelements:\n  paper:\n    geometry: background\n    color: "{colors.paper}"\n---\n\n## Overview\nPaper map.';
  const invalidSource = source.replace('elements:\n', 'elements:\n  building-public:\n    geometry: polygon\n');
  const runner = vi.mocked(runCartographyAgent).mockReset();
  runner.mockResolvedValueOnce(JSON.stringify({ message: 'Draft', source: invalidSource }))
    .mockResolvedValueOnce(JSON.stringify({ message: 'Corrected', source }));
  const result = await generateCartographyEdit({ source, prompt: 'Improve', history: [], reportMarkdown: '', runtime: 'codex' }, {
    dataRoot: '/unused', projectRoot: fileURLToPath(new URL('../../../../../', import.meta.url)),
    agents: { runtimeCatalog: { refresh: async () => undefined, list: () => [], validate: value => value,
      normalizeSaved: value => ({ runtime: value }), resolveChoice: () => { throw new Error('Runner is replaced'); } } },
  }, new AbortController().signal);
  expect(result.source).toBe(source);
  expect(runner).toHaveBeenCalledTimes(2);
});

it('stops after one repair attempt and reports the actual specification finding', async () => {
  const source = '---\nversion: "0.4.0"\nname: Atlas\nelements:\n  building-public:\n    geometry: polygon\n---\n\n## Overview\nDraft.';
  const runner = vi.mocked(runCartographyAgent).mockReset().mockResolvedValue(JSON.stringify({ message: 'Draft', source }));
  await expect(generateCartographyEdit({ source, prompt: 'Improve', history: [], reportMarkdown: '', runtime: 'codex' }, {
    dataRoot: '/unused', projectRoot: fileURLToPath(new URL('../../../../../', import.meta.url)),
    agents: { runtimeCatalog: { refresh: async () => undefined, list: () => [], validate: value => value,
      normalizeSaved: value => ({ runtime: value }), resolveChoice: () => { throw new Error('Runner is replaced'); } } },
  }, new AbortController().signal)).rejects.toThrow('MapElement must contain at least one core style property');
  expect(runner).toHaveBeenCalledTimes(2);
});

it('supplies dimension rules before generation and returns all repeated field errors for repair', async () => {
  const frontMatter = (valid: boolean) => ({ version: '0.4.0', name: 'Watercolor',
    widths: { thin: valid ? '0.75px' : 0.75 }, sizes: { poi: valid ? '8px' : 8 },
    typography: { label: { fontFamily: ['serif'], fontSize: valid ? '14px' : 14 } },
    elements: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`building-${index}`, {
      geometry: 'polygon', fillColor: '#D9C3A5', outlineWidth: valid ? '0.75px' : 0.75,
    }])),
  });
  const source = (valid: boolean) => `---\n${JSON.stringify(frontMatter(valid), null, 2)}\n---\n\n## Overview\nSoft colors.\n`;
  const rejected = source(false); const corrected = source(true);
  expect(lintCartography(rejected).findings.filter(finding => finding.severity === 'error').length).toBeGreaterThan(8);
  expect(lintCartography(corrected).valid).toBe(true);
  const runner = vi.mocked(runCartographyAgent).mockReset()
    .mockResolvedValueOnce(JSON.stringify({ message: 'Proposal', source: rejected }))
    .mockResolvedValueOnce(JSON.stringify({ message: 'Corrected units', source: corrected }));
  const result = await generateCartographyEdit({ source: '---\nversion: "0.4.0"\nname: Watercolor\n---\n\n## Overview\n',
    prompt: 'Create a watercolor design', history: [], reportMarkdown: '', runtime: 'codex',
  }, { dataRoot: '/unused', projectRoot: fileURLToPath(new URL('../../../../../', import.meta.url)),
    agents: {} as Parameters<typeof runCartographyAgent>[0]['agents'],
  }, new AbortController().signal);
  expect(result.source).toBe(corrected);
  const initial = runner.mock.calls[0]![0].prompt;
  expect(initial).toContain('Bare numbers are invalid');
  expect(initial).toContain('"outlineWidth"');
  expect(initial).toContain('"fontSize":"14px"');
  const repair = runner.mock.calls[1]![0].prompt;
  expect(repair).toContain('widths.thin: Invalid input');
  expect(repair).toContain('sizes.poi: Invalid input');
  expect(repair).toContain('typography.label: Invalid input');
  expect(repair).toContain('including analogous fields not listed');
});

it('repairs unknown omitted sections without dropping the evidence explanation', async () => {
  const prose = '\n## Overview\n莫奈风格。原始样式证据未提供；运行时数据绑定不属于规范。\n';
  const source = (omitted: string[]) => `---\n${JSON.stringify({ version: '0.4.0', name: '莫奈风格', omitted })}\n---\n${prose}`;
  const rejected = source(['原始样式证据', '运行时数据绑定']);
  const corrected = source([]);
  expect(lintCartography(rejected).findings.filter(f => f.severity === 'error').map(f => f.ruleId)).toEqual(['omitted-sections', 'omitted-sections']);
  expect(lintCartography(corrected).valid).toBe(true);
  const runner = vi.mocked(runCartographyAgent).mockReset()
    .mockResolvedValueOnce(JSON.stringify({ message: 'Draft', source: rejected }))
    .mockResolvedValueOnce(JSON.stringify({ message: 'Corrected', source: corrected }));
  const result = await generateCartographyEdit({ source: corrected, prompt: '体现莫奈的特点', history: [], reportMarkdown: '', runtime: 'codex' }, {
    dataRoot: '/unused', projectRoot: fileURLToPath(new URL('../../../../../', import.meta.url)),
    agents: {} as Parameters<typeof runCartographyAgent>[0]['agents'],
  }, new AbortController().signal);
  expect(result.source).toBe(corrected);
  const initial = runner.mock.calls[0]![0].prompt;
  expect(initial).toContain('The optional omitted field lists only intentionally absent standard sections');
  expect(initial).toContain('"Scale & Generalization"');
  expect(initial).toContain('"id":"omitted-sections"');
  expect(runner.mock.calls[1]![0].prompt).toContain('not a recognized standard section');
});
