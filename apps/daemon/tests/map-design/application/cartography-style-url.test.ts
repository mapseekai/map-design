import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { CARTOGRAPHY_STYLE_MAX_BYTES } from '@mapseekai/map-design-contracts';
import { initializeCartographyUrlDraft } from '../../../src/map-design/application/cartography-authoring.js';
import { createPinnedTransport } from '../../../src/map-design/ingestion/pinned-transport.js';
const download = vi.hoisted(() => vi.fn());
vi.mock('../../../src/map-design/ingestion/pinned-transport.js', () => ({ createPinnedTransport: vi.fn(() => ({ fetch: download })) }));
beforeEach(() => vi.clearAllMocks());
it('converts a large JSON style from an extensionless URL without truncating the specification', async () => {
  const style = { version: 8, sources: { sample: { type: 'vector', url: 'https://example.com/tiles.json' } },
    layers: Array.from({ length: 180 }, (_, index) => ({ id: `area-${index}`, type: 'fill', source: 'sample', 'source-layer': 'area', paint: { 'fill-color': `#${index.toString(16).padStart(6, '0')}` } })),
  };
  download.mockResolvedValueOnce({ status: 200, body: Buffer.from(JSON.stringify(style)) });
  const draft = await initializeCartographyUrlDraft({ name: 'Large Atlas', url: 'https://tiles.openfreemap.org/styles/liberty' });
  expect(Buffer.byteLength(draft.source)).toBeGreaterThan(32 * 1024);
  expect(draft.source).toContain('area-179');
});
it.each(['style-min.json', 'qgis-min.qgs', 'arcgis-min.lyrx', 'sld-min.xml'])('downloads and converts %s using the bounded transport', async (fileName) => {
  const body = readFileSync(new URL(`../../../../../skills/cartography-init/fixtures/${fileName}`, import.meta.url));
  download.mockResolvedValueOnce({ status: 200, body });
  const result = await initializeCartographyUrlDraft({ name: 'URL Atlas', url: `https://example.com/${fileName}?download=1` });
  expect(result.source).toContain('URL Atlas');
  expect(result.reportMarkdown).toBeTruthy();
  expect(createPinnedTransport).toHaveBeenCalledWith(expect.objectContaining({ limits: { document: expect.objectContaining({ maxBodyBytes: CARTOGRAPHY_STYLE_MAX_BYTES }) } }));
});
it('supports filenames for download endpoints and rejects failed upstream responses', async () => {
  download.mockResolvedValueOnce({ status: 200, body: readFileSync(new URL('../../../../../skills/cartography-init/fixtures/qgis-min.qgs', import.meta.url)) });
  expect((await initializeCartographyUrlDraft({ name: 'QGIS', url: 'https://example.com/download', fileName: 'map.qgs' })).source).toContain('QGIS');
  download.mockResolvedValueOnce({ status: 404, body: new Uint8Array() });
  await expect(initializeCartographyUrlDraft({ name: 'Missing', url: 'https://example.com/style.json' })).rejects.toThrow('Unable to download');
  await expect(initializeCartographyUrlDraft({ name: 'Invalid', url: 'https://example.com/download', fileName: '../map.qgs' })).rejects.toThrow();
});
it('reports the actual limit when a converted document is still too large', async () => {
  const style = { version: 8, sources: { sample: { type: 'vector', url: 'https://example.com/tiles.json' } },
    layers: Array.from({ length: 350 }, (_, index) => ({ id: `area-${index}`, type: 'fill', source: 'sample', 'source-layer': 'area', paint: { 'fill-color': `#${index.toString(16).padStart(6, '0')}` } })),
  };
  download.mockResolvedValueOnce({ status: 200, body: Buffer.from(JSON.stringify(style)) });
  await expect(initializeCartographyUrlDraft({ name: 'Oversized', url: 'https://example.com/style' })).rejects.toMatchObject({ details: { reason: 'CARTOGRAPHY_TOO_LARGE', maxBytes: 65536 } });
});
