import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sha256CanonicalJson } from 'maplibre-style-tools/bridge';
import { MapDesignQueryService } from '../../../src/map-design/application/query-service.js';
import { MapDesignValidationService } from '../../../src/map-design/application/validation-service.js';
import { createMapDesignBlobStore } from '../../../src/map-design/storage/blob-store.js';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { blobPath } from '../../../src/map-design/storage/paths.js';
import { MapDesignSqliteProjectRepository } from '../../../src/map-design/storage/project-repository.js';
import { testDesignSystem } from '../../fixtures/map-design/test-design-system.js';

const cleanups: (() => void)[] = [];
const projectId = 'validation-reuse';
const now = '2026-09-22T00:00:00.000Z';
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'map-validation-reuse-'));
  const db = openMapDesignDatabase(root);
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const blobStore = createMapDesignBlobStore(root);
  const style = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#ffffff' } }] };
  const semantics = { version: 1, groups: [] };
  const manifest = { kind: 'style', digest: 'a'.repeat(64), mediaType: 'application/json', byteLength: 1, resourceCount: 1, capturedAt: now };
  const [styleBlob, semanticBlob, sourceBlob] = await Promise.all([
    blobStore.putJson(projectId, 'styles', style), blobStore.putJson(projectId, 'semantics', semantics),
    blobStore.putJson(projectId, 'sources', manifest),
  ]);
  const designSystem = testDesignSystem();
  db.prepare("INSERT INTO projects (id,title,runtime_json,created_at,updated_at) VALUES (?,?,'{}',?,?)")
    .run(projectId, projectId, now, now);
  const repository = new MapDesignSqliteProjectRepository(db);
  repository.createImporting({ projectId, designSystemId: designSystem.id, designSystemDigest: designSystem.digest, draftRevision: 4, createdAt: now });
  repository.markReady({ projectId, sourceKind: 'style', sourceManifestDigest: sourceBlob.digest,
    draftStyleDigest: styleBlob.digest, draftStyleHash: await sha256CanonicalJson(style), draftSemanticDigest: semanticBlob.digest, updatedAt: now });
  const loadDesignSystem = vi.fn(async () => designSystem);
  const reads = vi.spyOn(blobStore, 'getJson');
  const dependencies = { repository, blobStore, loadDesignSystem };
  const validation = new MapDesignValidationService(dependencies);
  const query = new MapDesignQueryService({ ...dependencies, db, validationService: validation });
  return { root, db, blobStore, styleBlob, query, validation, reads, loadDesignSystem };
}

it('loads each blob once when context includes validation', async () => {
  const { query, reads, loadDesignSystem } = await fixture();
  const context = await query.getContext(projectId);
  expect(context.draftRevision).toBe(4);
  expect(reads).toHaveBeenCalledTimes(3);
  expect(loadDesignSystem).toHaveBeenCalledTimes(1);
});

it('shares in-flight snapshot reads while isolating mutable results', async () => {
  const { query, reads } = await fixture();
  const [first, second] = await Promise.all([query.getStyle(projectId), query.getStyle(projectId)]);
  first.layers.length = 0;
  expect(second.layers).toHaveLength(1);
  expect(reads).toHaveBeenCalledTimes(3);
});

it('rejects a missing blob after a successful validation', async () => {
  const { root, validation, styleBlob } = await fixture();
  await validation.validate(projectId, { expectedRevision: 4 });
  unlinkSync(blobPath(root, projectId, 'styles', styleBlob.digest));
  await expect(validation.validate(projectId, { expectedRevision: 4 })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
});

it('invalidates validation when semantics change without a revision change', async () => {
  const { db, blobStore, validation } = await fixture();
  const first = await validation.validate(projectId, { expectedRevision: 4 });
  const changed = await blobStore.putJson(projectId, 'semantics', { version: 1,
    groups: [{ id: 'bad', label: 'Bad', role: 'roads', layerIds: ['missing'], sourceIds: [] }] });
  db.prepare('UPDATE map_design_projects SET draft_semantic_digest=? WHERE project_id=?').run(changed.digest, projectId);
  const second = await validation.validate(projectId, { expectedRevision: 4 });
  expect(second.validationDigest).not.toBe(first.validationDigest);
  expect(second.findings.some(finding => finding.code === 'SEMANTIC_INVALID')).toBe(true);
});

it('rejects a revision changed while its snapshot loads', async () => {
  const { db, query, loadDesignSystem } = await fixture();
  loadDesignSystem.mockImplementationOnce(async () => {
    db.prepare('UPDATE map_design_projects SET draft_revision=5 WHERE project_id=?').run(projectId);
    return testDesignSystem();
  });
  await expect(query.getContext(projectId)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});

it('retries a failed load and preserves lifecycle checks after validation', async () => {
  const { validation, loadDesignSystem, db } = await fixture();
  loadDesignSystem.mockRejectedValueOnce(new Error('unavailable'));
  await expect(validation.validate(projectId, { expectedRevision: 4 })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  await expect(validation.validate(projectId, { expectedRevision: 4 })).resolves.toMatchObject({ draftRevision: 4 });
  db.prepare("UPDATE map_design_projects SET lifecycle_state='importing' WHERE project_id=?").run(projectId);
  await expect(validation.validate(projectId, { expectedRevision: 4 })).rejects.toMatchObject({ code: 'PROJECT_NOT_READY' });
});

it('runs read preflight on the loaded snapshot without fetching blobs again', async () => {
  const { query, reads } = await fixture();
  const preflight = vi.fn();
  await query.searchLayers(projectId, { query: 'background', limit: 10 }, preflight);
  expect(preflight).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ layers: [expect.objectContaining({ id: 'background' })] }));
  expect(reads).toHaveBeenCalledTimes(3);
});

it('preserves preflight errors before returning a query result', async () => {
  const { query } = await fixture();
  await expect(query.inspect(projectId, { target: { kind: 'root' } }, () => { throw new TypeError('invalid stored style'); }))
    .rejects.toThrow('invalid stored style');
});

it('checks design-system identity before reusing a validation result', async () => {
  const { validation, loadDesignSystem } = await fixture();
  await validation.validate(projectId, { expectedRevision: 4 });
  loadDesignSystem.mockResolvedValueOnce(testDesignSystem({ digest: 'd'.repeat(64) }));
  await expect(validation.validate(projectId, { expectedRevision: 4 })).rejects.toMatchObject({ code: 'DESIGN_SYSTEM_VIOLATION' });
});
