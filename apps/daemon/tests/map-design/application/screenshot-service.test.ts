import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import { createMapDesignBlobStore } from '../../../src/map-design/storage/blob-store.js';
import { MapScreenshotService } from '../../../src/map-design/application/screenshot-service.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const input = { pngBase64, width: 1, height: 1, draftRevision: 2, styleHash: 'a'.repeat(64),
  viewport: { center: [120, 30] as [number, number], zoom: 10, bearing: 0, pitch: 0 } };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'map-screenshot-')); dirs.push(dir);
  const blobStore = createMapDesignBlobStore(dir);
  const service = new MapScreenshotService({ blobStore, projectReader: { getProject: async () => ({}), getContext: async () => ({ draftRevision: 2, styleHash: 'a'.repeat(64) }) } });
  return { service, blobStore };
}

it('persists owned screenshot metadata and actual image bytes across service instances', async () => {
  const { service, blobStore } = fixture();
  const shot = await service.save('project-a', input);
  expect(shot).toMatchObject({ projectId: 'project-a', width: 1, height: 1, draftRevision: 2, viewport: input.viewport });
  const restored = new MapScreenshotService({ blobStore, projectReader: { getProject: async () => ({}), getContext: async () => ({ draftRevision: 2, styleHash: 'a'.repeat(64) }) } });
  const resolved = await restored.resolve('project-a', [shot.id]);
  expect(resolved.screenshots).toEqual([shot]);
  expect(resolved.images).toEqual([{ data: pngBase64, mimeType: 'image/png' }]);
  await expect(restored.resolve('project-b', [shot.id])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(restored.resolve('project-a', ['../secret'])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('rejects wrong image dimensions and non-PNG data before writing assets', async () => {
  const { service } = fixture();
  await expect(service.save('project-a', { ...input, width: 2 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(service.save('project-a', { ...input, pngBase64: Buffer.from('not a PNG').toString('base64') })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

it('rejects corrupt PNG chunk CRCs, invalid compressed pixels, and truncated chunks', async () => {
  const { service } = fixture();
  const original = Buffer.from(pngBase64, 'base64');
  const idat = original.indexOf(Buffer.from('IDAT'));

  const badCrc = Buffer.from(original);
  badCrc[idat + 4] = badCrc[idat + 4]! ^ 1;

  const badPixels = Buffer.from(original);
  badPixels.fill(0, idat + 4, idat + 17);
  badPixels.writeUInt32BE(crc32(badPixels.subarray(idat, idat + 17)) >>> 0, idat + 17);

  const truncated = Buffer.concat([original.subarray(0, -13), original.subarray(-12)]);
  for (const bytes of [badCrc, badPixels, truncated]) {
    await expect(service.save('project-a', {
      ...input,
      pngBase64: bytes.toString('base64'),
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
});

it('rejects a screenshot whose claimed map version is not the canonical capture version', async () => {
  const { service } = fixture();
  await expect(service.save('project-a', { ...input, draftRevision: 1 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(service.save('project-a', { ...input, styleHash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
