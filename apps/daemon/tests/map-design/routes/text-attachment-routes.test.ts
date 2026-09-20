import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createMapTextAttachmentRouter } from '../../../src/map-design/routes/text-attachment-routes.js';
import { MapTextAttachmentService } from '../../../src/map-design/application/text-attachment-service.js';
import { createMapDesignBlobStore } from '../../../src/map-design/storage/blob-store.js';
import { requireLocalDaemonRequest } from '../../../src/http/local-daemon-request.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

it('accepts local JSON uploads and returns safe UTF8 previews, rejects invalid/oversized uploads and cross-project reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'text-route-'));
  const app = express();
  app.use(createMapTextAttachmentRouter({ service: new MapTextAttachmentService({ blobStore: createMapDesignBlobStore(root),
    projectReader: { getProject: async () => ({}) } }), requireLocalDaemonRequest }));
  const server = app.listen(0, '127.0.0.1');
  cleanups.push(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); rmSync(root, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const url = `http://127.0.0.1:${address.port}/api/map-design/projects/p/attachments`;
  const upload = (body: string, headers = { 'content-type': 'application/json' }) => fetch(url, { method: 'POST', body, headers });
  expect((await upload('{}', { 'content-type': 'text/plain' })).status).toBe(415);
  expect((await upload('{')).status).toBe(400);
  expect((await upload('"' + 'a'.repeat(100_000) + '"')).status).toBe(413);
  expect((await fetch(url, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  const response = await upload(JSON.stringify({ fileName: 'notes.md', contentBase64: Buffer.from('<script>alert(1)</script> 海').toString('base64') }));
  expect(response.status).toBe(201);
  const attachment = await response.json() as { id: string };
  const preview = await fetch(`${url}/${attachment.id}/content`);
  expect(preview.status).toBe(200);
  expect(preview.headers.get('content-type')).toContain('text/plain');
  expect(preview.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await preview.text()).toBe('<script>alert(1)</script> 海');
  expect((await fetch(`${url.replace('/p/', '/other/')}/${attachment.id}/content`)).status).toBe(404);
  expect((await fetch(`${url}/${attachment.id}/content`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
});
