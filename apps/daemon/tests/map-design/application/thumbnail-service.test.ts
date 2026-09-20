import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { MapThumbnailService } from '../../../src/map-design/application/thumbnail-service.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(fn => fn()));
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const input = { pngBase64, width: 1, height: 1, capturedAt: 100 };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'map-thumbnail-'));
  const db = openMapDesignDatabase(dir);
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO projects (id,title,runtime_json,created_at,updated_at) VALUES ('p1','Map','{}','now','now')").run();
  db.prepare("INSERT INTO map_design_projects (project_id,lifecycle_state,design_system_id,design_system_digest,draft_revision,created_at,updated_at) VALUES ('p1','importing','default','digest',0,'now','now')").run();
  return { db, service: new MapThumbnailService(db) };
}
it('keeps one durable thumbnail per project, ignores older requests, and cascades deletion', () => {
  const { db, service } = fixture();
  expect(service.read('p1')).toBeNull();
  service.save('p1', input);
  service.save('p1', { ...input, capturedAt: 200 });
  service.save('p1', { ...input, capturedAt: 150 });
  expect(new MapThumbnailService(db).read('p1')).toEqual(Buffer.from(pngBase64, 'base64'));
  expect(db.prepare('SELECT captured_at FROM map_design_thumbnails').get()).toEqual({ captured_at: 200 });
  expect(db.prepare('SELECT count(*) AS n FROM map_design_thumbnails').get()).toEqual({ n: 1 });
  db.prepare("DELETE FROM projects WHERE id='p1'").run();
  expect(db.prepare('SELECT count(*) AS n FROM map_design_thumbnails').get()).toEqual({ n: 0 });
});
it('rejects invalid pixels, dimensions, oversized payloads, unknown projects and future timestamps', () => {
  const { service } = fixture();
  for (const value of [{ ...input, width: 2 }, { ...input, pngBase64: 'AAAA' }, { ...input, pngBase64: 'A'.repeat(1_400_004) }, { ...input, capturedAt: Date.now() + 120_000 }]) {
    expect(() => service.save('p1', value)).toThrow();
  }
  expect(() => service.save('missing', input)).toThrow();
  expect(() => service.read('../secret')).toThrow();
  expect(service.read('p1')).toBeNull();
});
