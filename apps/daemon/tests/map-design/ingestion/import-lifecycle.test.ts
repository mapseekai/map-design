import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignProjectServices } from '../../../src/server-context.js';
import { testDesignSystem } from '../../fixtures/map-design/test-design-system.js';
import type { PinnedFetchRequest, PinnedFetchResponse } from '../../../src/map-design/ingestion/pinned-transport.js';

const SOURCE_URL = 'https://maps.example.test/style.json';
const NOW = '2026-09-20T00:00:00.000Z';
const style = { version: 8, sources: {
  TerrainSource: { type: 'raster-dem', url: './terrain.json' },
  HillshadeSource: { type: 'raster-dem', url: './terrain.json' },
}, layers: [{ id: 'hillshade', type: 'hillshade', source: 'HillshadeSource' }] };
const metadata = { tilejson: '3.0.0', tiles: ['https://maps.example.test/{z}/{x}/{y}.png'] };
function documentResponse(request: PinnedFetchRequest, status = 200): PinnedFetchResponse {
  return { requestedUrl: request.url, finalUrl: request.url, redirects: [], status,
    headers: { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '60' } : {}) },
    body: new TextEncoder().encode(JSON.stringify(request.url.href === SOURCE_URL ? style : metadata)) };
}

describe('map source import persistence and retry', () => {
  let root: string;
  let db: ReturnType<typeof openMapDesignDatabase>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'map-import-lifecycle-'));
    db = openMapDesignDatabase(root);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('downloads Style JSON once and preserves shared terrain URLs without eagerly fetching metadata', async () => {
    const fetch = vi.fn(async (request: PinnedFetchRequest) => documentResponse(request));
    const services = createMapDesignProjectServices({ db, dataRoot: root, projectRoot: root, designSystem: testDesignSystem(), transport: { fetch } });
    try {
      db.prepare('INSERT INTO projects (id,title,runtime_json,created_at,updated_at) VALUES (?,?,?,?,?)').run('map', 'Map', '{}', NOW, NOW);
      db.transaction(() => services.sourceImportService.prepareImportInTransaction(db, 'map', {
        source: { url: SOURCE_URL }, designRequirement: 'Preserve terrain', idempotencyKey: 'create',
      }, NOW)).immediate();
      await services.sourceImportService.executeImportJob('map', new AbortController().signal);
      expect((await services.queryService.getProject('map')).lifecycle).toBe('ready');
      expect(fetch.mock.calls.map(([request]) => [request.url.href, request.purpose, request.range])).toEqual([
        [SOURCE_URL, 'document', undefined],
      ]);
      const stored = await services.queryService.getStyle('map');
      expect(stored.sources.TerrainSource).toEqual(stored.sources.HillshadeSource);
      expect(stored.sources.TerrainSource).toMatchObject({ url: 'https://maps.example.test/terrain.json' });
      expect(services.repository.getRevision('map', 0)).not.toBeNull();
    } finally { services.previewService.shutdown(); await services.outbox.drainPending(); }
  });

  it('persists a safe rate-limit reason and retries the same project successfully', async () => {
    let limited = true;
    const fetch = vi.fn(async (request: PinnedFetchRequest) => documentResponse(request, limited ? 429 : 200));
    const services = createMapDesignProjectServices({ db, dataRoot: root, projectRoot: root, designSystem: testDesignSystem(), transport: { fetch } });
    try {
      db.prepare('INSERT INTO projects (id,title,runtime_json,created_at,updated_at) VALUES (?,?,?,?,?)').run('map', 'Map', '{}', NOW, NOW);
      db.transaction(() => services.sourceImportService.prepareImportInTransaction(db, 'map', {
        source: { url: SOURCE_URL }, designRequirement: 'Preserve terrain', idempotencyKey: 'create',
      }, NOW)).immediate();
      await services.sourceImportService.executeImportJob('map', new AbortController().signal);
      expect(await services.queryService.getProject('map')).toMatchObject({ lifecycle: 'failed', failure: { code: 'IMPORT_RATE_LIMITED' } });
      expect(fetch).toHaveBeenCalledOnce();
      limited = false;
      await services.sourceImportService.retryImport('map', { idempotencyKey: 'retry' });
      await services.sourceImportService.executeImportJob('map', new AbortController().signal);
      expect(await services.queryService.getProject('map')).toMatchObject({ lifecycle: 'ready', failure: null });
      expect(db.prepare('SELECT attempt FROM map_design_import_jobs WHERE project_id = ?').get('map')).toEqual({ attempt: 2 });
    } finally { services.previewService.shutdown(); await services.outbox.drainPending(); }
  });
});
