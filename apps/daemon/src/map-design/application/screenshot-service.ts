import {
  MAP_SCREENSHOT_MAX_BYTES, MapScreenshotIdSchema, MapScreenshotIdsSchema, MapScreenshotInputSchema, MapScreenshotSchema,
  type MapScreenshot,
} from '@mapseekai/contracts';
import { MapIdentifierSchema } from '@mapseekai/map-design-contracts';
import { crc32, inflateSync } from 'node:zlib';
import type { MapDesignBlobStore } from '../storage/types.js';
import { invalidInput, MapDraftError } from './errors.js';

type StoredScreenshot = { kind: 'map-screenshot'; screenshot: Omit<MapScreenshot, 'id'>; pngDigest: string };

export class MapScreenshotService {
  constructor(private readonly deps: { blobStore: MapDesignBlobStore; projectReader: {
    getProject(projectId: string): Promise<unknown>;
    getContext(projectId: string): Promise<{ draftRevision: number; styleHash: string }>;
  } }) {}

  async save(projectId: string, value: unknown): Promise<MapScreenshot> {
    await this.requireProject(projectId);
    const parsed = MapScreenshotInputSchema.safeParse(value);
    if (!parsed.success) throw invalidInput();
    const { pngBase64, ...metadata } = parsed.data;
    const canonical = await this.deps.projectReader.getContext(projectId);
    if (canonical.draftRevision !== metadata.draftRevision || canonical.styleHash !== metadata.styleHash) {
      throw new MapDraftError('REVISION_CONFLICT', 'The map changed while the screenshot was captured. Try again.');
    }
    const bytes = Buffer.from(pngBase64, 'base64');
    if (!isValidCanvasPng(bytes, metadata.width, metadata.height)) throw invalidInput();
    const png = await this.deps.blobStore.putBytes(projectId, 'previews', bytes, 'image/png');
    const screenshot = { ...metadata, projectId, capturedAt: new Date().toISOString() };
    const stored: StoredScreenshot = { kind: 'map-screenshot', screenshot, pngDigest: png.digest };
    const report = await this.deps.blobStore.putJson(projectId, 'reports', stored);
    return MapScreenshotSchema.parse({ ...screenshot, id: report.digest });
  }

  async read(projectId: string, id: string): Promise<{ screenshot: MapScreenshot; bytes: Uint8Array }> {
    await this.requireProject(projectId);
    if (!MapScreenshotIdSchema.safeParse(id).success) throw invalidInput();
    try {
      const stored = await this.deps.blobStore.getJson<StoredScreenshot>(projectId, 'reports', id);
      if (stored.kind !== 'map-screenshot' || stored.screenshot.projectId !== projectId) throw new Error();
      const screenshot = MapScreenshotSchema.parse({ ...stored.screenshot, id });
      const bytes = await this.deps.blobStore.getBytes(projectId, 'previews', MapScreenshotIdSchema.parse(stored.pngDigest));
      if (bytes.length > MAP_SCREENSHOT_MAX_BYTES) throw new Error();
      return { screenshot, bytes };
    } catch {
      throw new MapDraftError('NOT_FOUND', 'The project screenshot was not found.');
    }
  }

  async resolve(projectId: string, ids: string[]) {
    const parsed = MapScreenshotIdsSchema.safeParse(ids);
    if (!parsed.success) throw invalidInput();
    const entries = await Promise.all(parsed.data.map((id) => this.read(projectId, id)));
    return {
      screenshots: entries.map(({ screenshot }) => screenshot),
      images: entries.map(({ bytes }) => ({ data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' as const })),
    };
  }

  private async requireProject(projectId: string) {
    if (!MapIdentifierSchema.safeParse(projectId).success) throw invalidInput();
    await this.deps.projectReader.getProject(projectId);
  }
}

export function isValidCanvasPng(bytes: Buffer, width: number, height: number): boolean {
  if (bytes.length < 57 || bytes.length > MAP_SCREENSHOT_MAX_BYTES
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  const idat: Buffer[] = [];
  let offset = 8;
  let sawIhdr = false;
  let sawIdat = false;
  let endedIdat = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const dataEnd = dataOffset + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataOffset || chunkEnd > bytes.length) return false;
    const type = bytes.toString('ascii', typeOffset, dataOffset);
    if (!/^[A-Za-z]{4}$/u.test(type)
      || (crc32(bytes.subarray(typeOffset, dataEnd)) >>> 0) !== bytes.readUInt32BE(dataEnd)) return false;
    if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90
      && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) return false;
    if (!sawIhdr) {
      if (type !== 'IHDR' || length !== 13
        || bytes.readUInt32BE(dataOffset) !== width || bytes.readUInt32BE(dataOffset + 4) !== height
        || bytes[dataOffset + 8] !== 8 || bytes[dataOffset + 9] !== 6
        || bytes[dataOffset + 10] !== 0 || bytes[dataOffset + 11] !== 0 || bytes[dataOffset + 12] !== 0) return false;
      sawIhdr = true;
    } else if (type === 'IHDR') return false;
    if (type === 'IDAT') {
      if (endedIdat) return false;
      sawIdat = true;
      idat.push(bytes.subarray(dataOffset, dataEnd));
    } else {
      if (type === 'PLTE' && sawIdat) return false;
      if (sawIdat && type !== 'IEND') endedIdat = true;
    }
    if (type === 'IEND') {
      if (length !== 0 || !sawIdat || chunkEnd !== bytes.length) return false;
      try {
        const expectedBytes = height * (1 + width * 4);
        const pixels = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedBytes });
        if (pixels.length !== expectedBytes) return false;
        const rowBytes = 1 + width * 4;
        for (let row = 0; row < height; row += 1) {
          if (pixels[row * rowBytes]! > 4) return false;
        }
        return true;
      } catch {
        return false;
      }
    }
    offset = chunkEnd;
  }
  return false;
}
