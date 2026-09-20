import express, { type Express } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { createCartographyAuthoringRouter } from '../../../src/map-design/routes/cartography-authoring-routes.js';
import { generateCartographyDraft, initializeCartographyUrlDraft } from '../../../src/map-design/application/cartography-authoring.js';
vi.mock('../../../src/map-design/application/cartography-authoring.js', () => ({ generateCartographyDraft: vi.fn(), generateCartographyEdit: vi.fn(), fetchCartographySource: vi.fn(), initializeCartographyDraft: vi.fn(), initializeCartographyUrlDraft: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const jobId = '12345678-1234-4234-8234-123456789abc';
const base = '/api/map-design/cartography-tools/generate';
function setup() {
  const app = express();
  app.use(createCartographyAuthoringRouter({ dataRoot: '/tmp', projectRoot: '/tmp', projectService: { importCartography: vi.fn() }, requireLocal: (_req, _res, next) => next() }));
  return app;
}
it('keeps generation alive after the start response and returns its completed draft on polling', async () => {
  let finish!: (value: { source: string; reportMarkdown: string; reportJson: string }) => void;
  vi.mocked(generateCartographyDraft).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const app = setup();
  const started = await request(app, base, 'POST', { jobId, name: 'Atlas', requirements: 'Calm' });
  expect(started.status).toBe(202);
  expect(await started.json()).toEqual({ jobId, status: 'running' });
  expect(vi.mocked(generateCartographyDraft).mock.calls[0]?.[2].aborted).toBe(false);
  const draft = { source: 'Specification', reportMarkdown: '', reportJson: '' };
  finish(draft);
  const polled = await request(app, `${base}/${jobId}`);
  expect(await polled.json()).toEqual({ jobId, status: 'succeeded', draft });
  expect((await request(app, `${base}/${jobId}`, 'DELETE')).status).toBe(204);
});
it('cancels the exact job and leaves no pollable result', async () => {
  vi.mocked(generateCartographyDraft).mockReturnValue(new Promise(() => {}));
  const app = setup();
  expect((await request(app, base, 'POST', { jobId, name: 'Atlas', requirements: 'Calm' })).status).toBe(202);
  expect((await request(app, `${base}/${jobId}`, 'DELETE')).status).toBe(204);
  expect(vi.mocked(generateCartographyDraft).mock.calls[0]?.[2].aborted).toBe(true);
  expect((await request(app, `${base}/${jobId}`)).status).toBe(404);
});

async function request(app: Express, path: string, method = 'GET', body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  try {
    return await fetch(`http://127.0.0.1:${address.port}${path}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it('converts a URL request to a draft without saving a specification', async () => {
  const draft = { source: 'Specification', reportMarkdown: 'Report', reportJson: '{}' };
  vi.mocked(initializeCartographyUrlDraft).mockResolvedValue(draft);
  const response = await request(setup(), '/api/map-design/cartography-tools/initialize-url', 'POST', { name: 'Atlas', url: 'https://example.com/style.json' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(draft);
  expect(initializeCartographyUrlDraft).toHaveBeenCalledWith({ name: 'Atlas', url: 'https://example.com/style.json' }, expect.any(AbortSignal));
});
