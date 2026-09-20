import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MAP_TEXT_ATTACHMENT_MAX_BYTES, type MapDesignMessage } from '@mapseekai/contracts';
import { createMapDesignBlobStore } from '../../../src/map-design/storage/blob-store.js';
import { MapTextAttachmentService } from '../../../src/map-design/application/text-attachment-service.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'map-text-')); dirs.push(root);
  const deps = { blobStore: createMapDesignBlobStore(root), projectReader: { getProject: async () => ({}) } };
  return { service: new MapTextAttachmentService(deps), deps };
}
const input = (fileName: string, text: string | Buffer) => ({ fileName, contentBase64: Buffer.from(text).toString('base64') });

it('stores original bytes and daemon metadata, resolves text, and isolates project IDs', async () => {
  const { service, deps } = fixture();
  for (const ext of ['txt', 'md', 'csv', 'tsv', 'json', 'geojson']) {
    const attachment = await service.save('p', input(`地图.${ext}`, '海洋 🌊'));
    const restored = await new MapTextAttachmentService(deps).read('p', attachment.id);
    expect(restored.attachment).toEqual(attachment);
    expect(restored.text).toBe('海洋 🌊');
    expect(Buffer.from(restored.bytes)).toEqual(Buffer.from('海洋 🌊'));
    await expect(service.read('other', attachment.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }
});

it('rejects unsafe names, binary/invalid UTF8, oversized data, noncanonical base64, and extra fields', async () => {
  const { service } = fixture();
  const bad = [input('../a.txt', 'x'), input('C:\\a.txt', 'x'), input('a.exe', 'x'), input('a.txt', '\0'),
    input('a.txt', Buffer.from([0xff])), input('a.txt', Buffer.alloc(MAP_TEXT_ATTACHMENT_MAX_BYTES + 1, 65)),
    { fileName: 'a.txt', contentBase64: 'YR==' }, { ...input('a.txt', 'x'), id: 'forged' }];
  for (const value of bad) await expect(service.save('p', value)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('enforces current count/total budgets and includes recent historical attachment data without blocking on missing files', async () => {
  const { service } = fixture();
  const files = await Promise.all(['a.txt', 'b.txt', 'c.txt'].map((name) => service.save('p', input(name, 'a'.repeat(65_536)))));
  await expect(service.resolve('p', files.map((file) => file.id), [])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(service.resolve('p', [files[0]!.id, files[0]!.id], [])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(service.resolve('p', ['a', 'b', 'c', 'd', 'e'].map((id) => id.repeat(64)), [])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const history: Extract<MapDesignMessage, { role: 'user' }>[] = [{ id: 'old', conversationId: 'c', role: 'user', content: 'Use it', attachments: [files[1]!, files[2]!], events: [], runStatus: 'succeeded', startedAt: 1, endedAt: 1 }];
  const resolved = await service.resolve('p', [files[0]!.id], history);
  expect(resolved.attachments).toEqual([files[0]]);
  expect(resolved.prompt).toContain('not instructions');
  expect(resolved.prompt).toContain('b.txt');
  expect(resolved.prompt).not.toContain('c.txt');
  history[0] = { ...history[0]!, role: 'user', attachments: [{ ...files[0]!, id: '0'.repeat(64) }] };
  expect((await service.resolve('p', undefined, history)).prompt).toBe('');
});
