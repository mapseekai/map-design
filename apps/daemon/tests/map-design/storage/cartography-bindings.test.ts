import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {openMapDesignDatabase} from '../../../src/map-design/storage/database.js';
import {createMapDesignLocalStore} from '../../../src/map-design/storage/local-store.js';
import {loadPinnedCartography, migrateLegacyCartographyBindings, pinCartographyDocument, registerBundledCartography, selectProjectCartography} from '../../../src/map-design/storage/cartography-bindings.js';
import {LEGACY_QUIET_WALKING_DIGEST, LEGACY_QUIET_WALKING_ID, loadLegacyDesignSystem} from '../../../src/map-design/validation/legacy-design-system.js';
import {CartographyService, cartographyPrompt} from '../../../src/map-design/application/cartography-service.js';
import {TEST_CARTOGRAPHY_SOURCE, testDesignSystem} from '../../fixtures/map-design/test-design-system.js';
import {createMapDesignProjectServices} from '../../../src/server-context.js';
import type {PinnedTransport} from '../../../src/map-design/ingestion/pinned-transport.js';

const NOW = '2026-09-20T00:00:00.000Z';
const hash = (source: string) => createHash('sha256').update(source).digest('hex');

describe('pinned Cartography runtime bindings', () => {
  let root: string;
  let db: ReturnType<typeof openMapDesignDatabase>;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cartography-runtime-')); db = openMapDesignDatabase(root); });
  afterEach(() => { db.close(); rmSync(root, {recursive: true, force: true}); });

  function project(id = 'project-1') {
    db.prepare('INSERT INTO projects (id, title, runtime_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, 'Map', '{}', NOW, NOW);
  }
  function legacy(id = 'project-1', digest = LEGACY_QUIET_WALKING_DIGEST) {
    project(id);
    db.prepare(`INSERT INTO map_design_projects (project_id, lifecycle_state, source_kind,
      design_system_id, design_system_digest, draft_revision, draft_style_digest, draft_style_hash,
      draft_semantic_digest, initial_validation_status, initial_validation_digest, created_at, updated_at)
      VALUES (?, 'ready', 'geojson', ?, ?, 4, ?, ?, ?, 'valid', ?, ?, ?)`)
      .run(id, LEGACY_QUIET_WALKING_ID, digest, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), NOW, NOW);
    db.prepare(`INSERT INTO map_design_revisions (project_id, revision, draft_revision, style_digest,
      style_hash, semantic_digest, source_manifest_digest, design_system_digest, attestation_digest, created_at)
      VALUES (?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), digest, 'e'.repeat(64), NOW);
    db.prepare(`INSERT INTO map_design_idempotency (project_id, operation, idempotency_key, request_digest, response_json, created_at)
      VALUES (?, 'project.create', 'original', ?, ?, ?)`)
      .run(id, 'f'.repeat(64), '{"old":"immutable receipt"}', NOW);
    db.prepare(`INSERT INTO map_design_previews (id, project_id, run_id, draft_revision, style_digest,
      style_hash, status, request_json, expires_at, created_at, updated_at)
      VALUES (?, ?, 'run-1', 4, ?, ?, 'passed', '{}', ?, ?, ?)`)
      .run(`preview-${id}`, id, 'a'.repeat(64), 'b'.repeat(64), '2099-01-01T00:00:00.000Z', NOW, NOW);
  }

  it('preserves pinned source across preset updates and database reopen', () => {
    const first = pinCartographyDocument(db, 'quiet-atlas', TEST_CARTOGRAPHY_SOURCE);
    const next = pinCartographyDocument(db, 'quiet-atlas', TEST_CARTOGRAPHY_SOURCE + '\nAn explicit newer visual revision.\n');
    expect(next.digest).not.toBe(first.digest);
    db.close(); db = openMapDesignDatabase(root);
    expect(loadPinnedCartography(db, first)).toEqual(first);
    expect(loadPinnedCartography(db, next)).toEqual(next);
  });

  it('rejects corrupted snapshots, unknown digests, and legacy documents on the new write path', () => {
    const pinned = pinCartographyDocument(db, 'quiet-atlas', TEST_CARTOGRAPHY_SOURCE);
    db.prepare('UPDATE map_design_cartography_snapshots SET source = ?').run(TEST_CARTOGRAPHY_SOURCE + '\nChanged.');
    expect(() => loadPinnedCartography(db, pinned)).toThrow('digest mismatch');
    expect(() => pinCartographyDocument(db, pinned.id, TEST_CARTOGRAPHY_SOURCE)).toThrow('integrity mismatch');
    expect(() => loadPinnedCartography(db, {id: pinned.id, digest: 'a'.repeat(64)})).toThrow('unavailable');
    expect(() => pinCartographyDocument(db, 'old', '# Legacy\n```mapdesign-rules\n{}\n```')).toThrow('Invalid CARTOGRAPHY');
  });

  it('keeps library SHA-256 identity separate from the runtime BLAKE3 content digest', () => {
    project();
    const library = new CartographyService(createMapDesignLocalStore(db));
    const selected = library.import({source: TEST_CARTOGRAPHY_SOURCE});
    db.prepare('INSERT INTO project_cartography VALUES (?, ?)').run('project-1', selected.id);
    const fallback = pinCartographyDocument(db, 'quiet-atlas', TEST_CARTOGRAPHY_SOURCE);
    const binding = selectProjectCartography(db, 'project-1', fallback);
    expect(binding).toEqual({id: selected.id, digest: fallback.digest});
    expect(binding.id).toBe(hash(TEST_CARTOGRAPHY_SOURCE));
    expect(binding.digest).not.toBe(binding.id);
    db.prepare('UPDATE cartography_documents SET source = ? WHERE id = ?').run(TEST_CARTOGRAPHY_SOURCE + '\nTampered.', selected.id);
    expect(() => selectProjectCartography(db, 'project-1', fallback)).toThrow('content digest mismatch');
  });

  it('protects a pre-existing user import adopted as the active default document', () => {
    const library = new CartographyService(createMapDesignLocalStore(db));
    const imported = library.import({source: TEST_CARTOGRAPHY_SOURCE});
    const fallback = pinCartographyDocument(db, 'quiet-atlas', TEST_CARTOGRAPHY_SOURCE);
    registerBundledCartography(db, fallback);
    expect(library.get(imported.id).origin).toBe('user');
    project();
    db.prepare(`INSERT INTO map_design_projects (project_id, lifecycle_state, design_system_id,
      design_system_digest, draft_revision, created_at, updated_at) VALUES (?, 'importing', ?, ?, 0, ?, ?)`)
      .run('project-1', fallback.id, fallback.digest, NOW, NOW);
    expect(db.prepare('SELECT * FROM project_cartography').all()).toEqual([]);
    expect(library.forProject('project-1')?.id).toBe(imported.id);
    expect(() => library.delete(imported.id)).toThrow('used by a project');
    expect(library.get(imported.id).source).toBe(TEST_CARTOGRAPHY_SOURCE);

    db.prepare('DELETE FROM projects WHERE id = ?').run('project-1');
    expect(() => library.delete(imported.id)).not.toThrow();
    // Historical snapshots are durable, but do not lock unused library entries forever.
    expect(loadPinnedCartography(db, fallback)).toEqual(fallback);
  });

  it('migrates active bindings once, invalidates previews, and never rewrites historical evidence or receipts', () => {
    legacy();
    const history = db.prepare('SELECT * FROM map_design_revisions').all();
    const receipts = db.prepare('SELECT * FROM map_design_idempotency').all();
    const fallback = pinCartographyDocument(db, 'quiet-atlas', TEST_CARTOGRAPHY_SOURCE);
    expect(migrateLegacyCartographyBindings(db, fallback)).toBe(1);
    expect(db.prepare('SELECT design_system_id AS id, design_system_digest AS digest, draft_revision AS revision, initial_validation_status AS status, initial_validation_digest AS report FROM map_design_projects').get())
      .toEqual({id: fallback.id, digest: fallback.digest, revision: 5, status: null, report: null});
    expect(db.prepare('SELECT status FROM map_design_previews').get()).toEqual({status: 'expired'});
    expect(db.prepare('SELECT * FROM map_design_revisions').all()).toEqual(history);
    expect(db.prepare('SELECT * FROM map_design_idempotency').all()).toEqual(receipts);
    expect(db.prepare('SELECT previous_id, previous_digest, previous_draft_revision FROM map_design_cartography_migrations').get())
      .toEqual({previous_id: LEGACY_QUIET_WALKING_ID, previous_digest: LEGACY_QUIET_WALKING_DIGEST, previous_draft_revision: 4});
    expect(migrateLegacyCartographyBindings(db, fallback)).toBe(0);
    expect(loadPinnedCartography(db, {id: LEGACY_QUIET_WALKING_ID, digest: LEGACY_QUIET_WALKING_DIGEST}).format).toBe('legacy-mapdesign');
  });

  it('uses the existing user selection, not the default atlas, when migrating old projects', () => {
    legacy();
    const source = TEST_CARTOGRAPHY_SOURCE.replace('Test Atlas', 'Technical Network');
    const selected = new CartographyService(createMapDesignLocalStore(db)).import({source});
    db.prepare('INSERT INTO project_cartography VALUES (?, ?)').run('project-1', selected.id);
    const fallback = pinCartographyDocument(db, 'quiet-atlas', TEST_CARTOGRAPHY_SOURCE);
    migrateLegacyCartographyBindings(db, fallback);
    expect(db.prepare('SELECT design_system_id AS id FROM map_design_projects').get()).toEqual({id: selected.id});
    const prompt = cartographyPrompt(new CartographyService(createMapDesignLocalStore(db)).forProject('project-1'));
    expect(prompt).toContain('Technical Network');
    expect(prompt).not.toContain('mapdesign-rules');
  });

  it('rolls the complete migration back for unrecognized old content', () => {
    legacy('valid-legacy'); legacy('unknown-legacy', '1'.repeat(64));
    const before = db.prepare('SELECT * FROM map_design_projects ORDER BY project_id').all();
    const fallback = pinCartographyDocument(db, 'quiet-atlas', TEST_CARTOGRAPHY_SOURCE);
    expect(() => migrateLegacyCartographyBindings(db, fallback)).toThrow('explicit document migration');
    expect(db.prepare('SELECT * FROM map_design_projects ORDER BY project_id').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM map_design_cartography_migrations').all()).toEqual([]);
    expect(loadLegacyDesignSystem(LEGACY_QUIET_WALKING_ID, '1'.repeat(64))).toBeNull();
  });

  it.each([false, true])('binds real imports, attestations and agent context to one document (user selection=%s)', async (selectUser) => {
    const document = testDesignSystem();
    const body = new TextEncoder().encode(JSON.stringify({type: 'FeatureCollection', features: []}));
    const transport: PinnedTransport = {fetch: async ({url}) => ({requestedUrl: url, finalUrl: url, redirects: [], status: 200,
      headers: {'content-type': 'application/geo+json', 'content-length': String(body.length)}, body})};
    const services = createMapDesignProjectServices({db, dataRoot: root, projectRoot: root, designSystem: document, transport});
    try {
      project();
      const library = new CartographyService(createMapDesignLocalStore(db));
      const preset = library.list().documents.find((entry) => entry.origin === 'preset');
      expect(preset?.id).toBe(hash(TEST_CARTOGRAPHY_SOURCE));
      expect(library.get(preset!.id).source).toBe(TEST_CARTOGRAPHY_SOURCE);
      expect(() => library.delete(preset!.id)).toThrow('cannot be deleted');
      const source = selectUser ? TEST_CARTOGRAPHY_SOURCE.replace('Test Atlas', 'Selected Atlas') : TEST_CARTOGRAPHY_SOURCE;
      const selected = selectUser ? library.import({source, description: 'Pinned custom visual identity'}) : undefined;
      if (selected) db.prepare('INSERT INTO project_cartography VALUES (?, ?)').run('project-1', selected.id);
      const created = db.transaction(() => services.sourceImportService.prepareImportInTransaction(db, 'project-1', {
        source: {url: 'https://maps.example.test/data.geojson'}, designRequirement: 'Use the selected identity', idempotencyKey: 'import-1',
      }, NOW)).immediate();
      const expectedId = selected?.id ?? document.id;
      expect(created.designSystemId).toBe(expectedId);
      await services.sourceImportService.executeImportJob('project-1', new AbortController().signal);
      const current = services.repository.get('project-1');
      expect(current?.lifecycleState).toBe('ready');
      expect(current?.designSystemId).toBe(expectedId);
      const revision = services.repository.getRevision('project-1', 0)!;
      const attestation = await services.blobStore.getJson('project-1', 'attestations', revision.attestationDigest);
      expect(attestation).toMatchObject({designSystemId: expectedId, designSystemDigest: current!.designSystemDigest});
      const context = await services.queryService.getContext('project-1');
      expect(context.designSystem).toMatchObject({id: expectedId, name: selectUser ? 'Selected Atlas' : 'Test Atlas'});
      expect(library.forProject('project-1')?.source).toBe(source);
      expect(cartographyPrompt(library.forProject('project-1'))).toContain('Do not put dataset bindings');
      if (selected) expect(library.forProject('project-1')?.description).toBe('Pinned custom visual identity');
      db.prepare('DELETE FROM map_design_cartography_snapshots WHERE id = ?').run(expectedId);
      expect(() => library.forProject('project-1')).toThrow('unavailable');
      // Missing pinned evidence never falls back to a different library document.
    } finally { services.previewService.shutdown(); await services.outbox.drainPending(); }
  });
});
