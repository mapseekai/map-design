import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { CartographyEditService } from '../../../src/map-design/application/cartography-edit-service.js';
import type { generateCartographyEdit } from '../../../src/map-design/application/cartography-authoring.js';

const source = '---\nversion: "0.4.0"\nname: Atlas\ncolors:\n  ink: "#123456"\n---\n\n## Overview\nOriginal guidance.\n';
const updated = `${source}\n## Scale & Generalization\nPreserve label hierarchy.\n`;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cartography-editor-')); roots.push(root);
  const generate = vi.fn<typeof generateCartographyEdit>();
  const saveDocument = vi.fn(() => ({ id: 'a'.repeat(64), name: 'Atlas', description: 'Note', version: '0.4.0' }));
  const deps = { dataRoot: root, projectRoot: '/unused', generate, saveDocument };
  const service = new CartographyEditService(deps);
  const session = await service.create({ source, description: 'Note', runtime: 'api', initialPrompt: 'Improve the document' });
  return { root, deps, service, session, generate, saveDocument };
}
it('runs the initial analysis once, persists a valid edit and saves a new library record explicitly', async () => {
  const { deps, service, session, generate, saveDocument } = await setup();
  let finish!: (reply: { source: string; message: string }) => void;
  generate.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const request = { requestId: session.id, expectedRevision: 0, prompt: session.initialPrompt, runtime: 'api' };
  expect((await service.turn(session.id, request)).status).toBe('running');
  expect((await service.turn(session.id, request)).status).toBe('running');
  expect(generate).toHaveBeenCalledTimes(1);
  await expect(service.save(session.id, { expectedRevision: 0 })).rejects.toThrow('running');
  finish({ source: updated, message: 'Added scale guidance.' });
  await vi.waitFor(async () => expect((await service.get(session.id)).status).toBe('idle'));
  const edited = await service.get(session.id);
  expect(edited.source).toBe(updated);
  expect(edited.revision).toBe(1);
  expect(edited.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  expect(edited.preview?.palette).toContainEqual({ name: 'ink', color: '#123456' });
  expect(saveDocument).not.toHaveBeenCalled();
  expect((await new CartographyEditService(deps).get(session.id)).source).toBe(updated);
  await service.turn(session.id, request);
  expect(generate).toHaveBeenCalledTimes(1);
  const saved = await service.save(session.id, { expectedRevision: 1 });
  expect(saveDocument).toHaveBeenCalledWith({ source: updated, description: 'Note' });
  expect(saved.session.savedRevision).toBe(1);
  await expect(service.turn(session.id, { ...request, prompt: 'Different input' })).rejects.toThrow('identity');
  await expect(service.turn(session.id, { ...request, requestId: randomUUID() })).rejects.toThrow('changed');
});
it('keeps the original document when the agent returns invalid Markdown', async () => {
  const { service, session, generate } = await setup();
  generate.mockResolvedValue({ source: 'Invalid Markdown', message: 'Updated' });
  await service.turn(session.id, { requestId: session.id, expectedRevision: 0, prompt: 'Improve', runtime: 'api' });
  await vi.waitFor(async () => expect((await service.get(session.id)).status).toBe('failed'));
  expect((await service.get(session.id)).source).toBe(source);
  expect((await service.get(session.id)).revision).toBe(0);
});
it('cancels an edit without replacing the last valid document', async () => {
  const { service, session, generate } = await setup();
  generate.mockImplementation(async (_input, _roots, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Canceled')), { once: true })));
  await service.turn(session.id, { requestId: session.id, expectedRevision: 0, prompt: 'Improve', runtime: 'codex' });
  const stopped = await service.cancel(session.id);
  expect(stopped.status).toBe('canceled');
  expect(stopped.source).toBe(source);
  expect(generate.mock.calls[0]?.[0].runtime).toBe('codex');
});
it('recovers interrupted edits without restarting the agent and rejects path traversal', async () => {
  const { root, service, session, generate } = await setup();
  const path = join(root, 'cartography-edits', `${session.id}.json`);
  const stored = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...stored, status: 'running' }));
  expect(await service.get(session.id)).toMatchObject({ status: 'failed', error: 'interrupted', source });
  expect(generate).not.toHaveBeenCalled();
  await expect(service.get('../secrets')).rejects.toThrow();
});
