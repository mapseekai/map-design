import {pinCartographyDocument, selectProjectCartography} from '../../../src/map-design/storage/cartography-bindings.js';
import {testDesignSystem} from '../../fixtures/map-design/test-design-system.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { MapDesignProjectRead } from '@mapseekai/map-design-contracts';
import { sha256CanonicalJson } from 'maplibre-style-tools/bridge';

import { MapDesignConversationService } from '../../../src/map-design/application/conversation-service.js';
import { MapDesignQueryService } from '../../../src/map-design/application/query-service.js';
import { MapDesignProjectService } from '../../../src/map-design/application/project-service.js';
import { createMapDesignRuntimeCatalog, type MapDesignRuntimeCatalog } from '../../../src/map-design/application/runtime-catalog.js';
import { apiAgentDef } from '../../../src/runtimes/defs/api.js';
import { apiProfileModelId, type MapDesignAppConfig } from '@mapseekai/contracts';
import { resolveApiProfile } from '../../../src/map-design/application/api-profile-service.js';
import express from 'express';
import { createMapDesignProjectRouter } from '../../../src/map-design/routes/project-routes.js';
import { requireLocalDaemonRequest } from '../../../src/http/local-daemon-request.js';
import { runMapDesignProjectCli } from '../../../src/tools-map-design-project-cli.js';
import { MapDraftError } from '../../../src/map-design/application/errors.js';
import { createMapDesignBlobStore } from '../../../src/map-design/storage/blob-store.js';
import { openMapDesignDatabase, closeMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { resetMapDesignDevelopmentConversations } from '../../../src/map-design/storage/dev-conversation-reset.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';
import { MapDesignSqliteProjectRepository } from '../../../src/map-design/storage/project-repository.js';

const NOW = '2026-08-24T00:00:00.000Z';
const roots: string[] = [];

function project(projectId = 'project-1') {
  return { projectId, title: 'Map', source: { url: 'https://example.com/style.json' }, designRequirement: 'Make it clear', runtime: { agentId: 'claude' }, idempotencyKey: 'create-key' };
}

function importing(projectId: string): MapDesignProjectRead {
  return { projectId, lifecycle: 'importing', sourceKind: null, designSystemId: 'quiet-atlas', designSystemDigest: 'a'.repeat(64), draftRevision: 0, committedRevision: null, failure: null, createdAt: NOW, updatedAt: NOW };
}

function openFixture(options: { runtimeCatalog?: Pick<MapDesignRuntimeCatalog, 'validate'>; enqueue?: () => boolean; verifyWorkingDirectoryGrant?: () => Promise<string>; prepare?: (db: Database.Database, projectId: string) => MapDesignProjectRead } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'map-project-service-'));
  roots.push(root);
  const db = openMapDesignDatabase(root);
  const store = createMapDesignLocalStore(db);
  const prepare = vi.fn((database: Database.Database, projectId: string) => {
    if (options.prepare) return options.prepare(database, projectId);
    const source = testDesignSystem();
    pinCartographyDocument(database, source.id, source.source);
    const binding = selectProjectCartography(database, projectId);
    database.prepare(`INSERT INTO map_design_projects (project_id, lifecycle_state, design_system_id, design_system_digest, draft_revision, created_at, updated_at) VALUES (?, 'importing', ?, ?, 0, ?, ?)`)
      .run(projectId, binding.id, binding.digest, NOW, NOW);
    database.prepare(`INSERT INTO map_design_import_jobs (project_id, status, import_request_json, import_request_digest, attempt, queued_at) VALUES (?, 'queued', '{}', 'a', 1, ?)`)
      .run(projectId, NOW);
    return { ...importing(projectId), designSystemId: binding.id, designSystemDigest: binding.digest };
  });
  const queryService = { getProject: vi.fn() };
  const service = new MapDesignProjectService({
    store,
    ...(options.runtimeCatalog ? { runtimeCatalog: options.runtimeCatalog } : {}),
    sourceImportService: { prepareImportInTransaction: prepare } as never,
    importJobRunner: { enqueue: options.enqueue ?? vi.fn(() => true) },
    queryService,
    verifyWorkingDirectoryGrant: options.verifyWorkingDirectoryGrant ?? vi.fn(async (grant) => `/canonical${grant.path}`),
    randomId: () => 'conversation-1',
  });
  return { db, service, prepare, queryService };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function apiCatalogFixture() {
  const config: MapDesignAppConfig = { activeApiProfileId: 'a', byokProviders: {
    a: { protocol: 'openai', model: 'model-a', baseUrl: 'https://a.example/v1', apiKey: 'key-a' },
    b: { protocol: 'openai', model: 'model-b', baseUrl: 'https://b.example/v1', apiKey: 'key-b' },
  } };
  const catalog = createMapDesignRuntimeCatalog({ definitions: [apiAgentDef], apiConfig: () => config,
    inspect: definition => ({ definition, available: true, environment: {},
      mapDesign: { nativeMapTools: true, publicReasoningSummary: true } }),
  });
  return { config, catalog };
}

it.each([undefined, 'default'])('pins the API profile when creating with model %s and replays after the default changes', async (model) => {
  // Given: A is the default API account.
  const { config, catalog } = apiCatalogFixture();
  const { db, service } = openFixture({ runtimeCatalog: catalog });
  const input = { ...project(), runtime: { agentId: 'api', ...(model === undefined ? {} : { model }) } };
  try {
    // When: the project is created, then the global default changes to B.
    const created = await service.create(input);
    config.activeApiProfileId = 'b';
    // Then: the saved conversation still resolves to A, and replay returns its receipt.
    const saved = createMapDesignLocalStore(db).getConversationRuntime('conversation-1');
    expect(created.runtime).toEqual({ agentId: 'api', model: apiProfileModelId('a') });
    expect(saved?.model).toBe(apiProfileModelId('a'));
    expect(resolveApiProfile(config, saved?.model)).toMatchObject({ baseUrl: 'https://a.example/v1', apiKey: 'key-a' });
    config.byokProviders = {};
    expect(await service.create(input)).toEqual(created);
    await expect(service.create({ ...input, runtime: { agentId: 'api', model: apiProfileModelId('b') } }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  } finally { closeMapDesignDatabase(db); }
});

it.each(['api-profile:missing', 'unknown-model'])('rejects invalid API model %s before project persistence', async (model) => {
  // Given: the requested profile or remote model does not exist.
  const { catalog } = apiCatalogFixture();
  const { db, service, prepare } = openFixture({ runtimeCatalog: catalog });
  try {
    // When: creating a project with an invalid explicit selection.
    await expect(service.create({ ...project(), runtime: { agentId: 'api', model } }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // Then: no project or import is created.
    expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 0 });
    expect(prepare).not.toHaveBeenCalled();
  } finally { closeMapDesignDatabase(db); }
});

it.each([true, false])('preserves local agent creation when catalog availability is %s', async (available) => {
  const definition = { ...apiAgentDef, id: 'local', fallbackModels: [{ id: 'local-model', label: 'Local' }] };
  const catalog = createMapDesignRuntimeCatalog({ definitions: [definition],
    inspect: agent => ({ definition: agent, available, environment: {},
      mapDesign: { nativeMapTools: true, publicReasoningSummary: true } }),
  });
  const { db, service } = openFixture({ runtimeCatalog: catalog });
  const runtime = { agentId: 'local', model: 'local-model' };
  try {
    const created = await service.create({ ...project(), runtime });
    expect(created.runtime).toEqual(runtime);
    expect(createMapDesignLocalStore(db).getConversationRuntime('conversation-1')).toMatchObject(runtime);
  } finally { closeMapDesignDatabase(db); }
});

it('pins CLI API project creation through the HTTP router and rejects an invalid explicit profile', async () => {
  const { config, catalog } = apiCatalogFixture();
  const { db, service } = openFixture({ runtimeCatalog: catalog });
  const unused = async (): Promise<never> => { throw new Error('Unexpected map read'); };
  const app = express();
  app.use(createMapDesignProjectRouter({ projectService: service, requireLocalDaemonRequest,
    queryService: { getContext: unused, inspect: unused, searchLayers: unused, getStyle: unused,
      getSemantics: unused, listRevisions: unused }, validationService: { validate: unused },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not listen');
  const output: string[] = [];
  const errors: string[] = [];
  let sequence = 0;
  const args = ['create', '--name', 'CLI map', '--source-url', 'https://example.com/style.json',
    '--runtime', 'api', '--prompt-file', '-'];
  const io = { env: { MAP_DESIGN_DAEMON_URL: `http://127.0.0.1:${address.port}` },
    stdout: { write: (value: string) => output.push(value) },
    stderr: { write: (value: string) => errors.push(value) },
    stdin: { async *[Symbol.asyncIterator]() { yield 'Make it clear'; } },
    randomId: () => `cli-${++sequence}`,
  };
  try {
    expect(await runMapDesignProjectCli(args, io)).toBe(0);
    config.activeApiProfileId = 'b';
    const conversation = service.getConversation('cli-1');
    expect(createMapDesignLocalStore(db).getConversationRuntime(conversation.id)?.model).toBe(apiProfileModelId('a'));
    expect(JSON.parse(output.join('')).runtime).toEqual({ agentId: 'api', model: apiProfileModelId('a') });
    expect(await runMapDesignProjectCli([...args, '--model', apiProfileModelId('missing'), '--json'], io)).toBe(1);
    expect(JSON.parse(errors.join('')).code).toBe('INVALID_INPUT');
    expect(service.list().projects).toHaveLength(1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    closeMapDesignDatabase(db);
  }
});

it('binds an imported CARTOGRAPHY.md atomically and preserves it on replay and reopen', async () => {
  const { db, service, queryService } = openFixture();
  try {
    const source = '---\nversion: "0.4.0"\nname: Atlas\n---\n\n## Overview\n\nQuiet maps.\n';
    const document = service.importCartography({ source });
    const input = { ...project(), cartographyId: document.id };
    const created = await service.create(input);
    expect(created.cartography).toEqual(document);
    expect(await service.create(input)).toEqual(created);
    queryService.getProject.mockResolvedValue(importing('project-1'));
    expect((await service.get('project-1')).cartography).toEqual(document);
    const updated = service.importCartography({ source: source.replace('Quiet maps.', 'Bright maps.') });
    expect(updated.id).not.toBe(document.id);
    expect((await service.get('project-1')).cartography?.id).toBe(document.id);
    await expect(service.create({ ...input, cartographyId: updated.id })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(service.delete('project-1')).toBe(true);
    expect(db.prepare('SELECT * FROM project_cartography').all()).toEqual([]);
    expect(service.listCartographies().documents).toHaveLength(2);
  } finally { closeMapDesignDatabase(db); }
});

it('rejects an unknown cartography before creating a project', async () => {
  const { db, service } = openFixture();
  try {
    await expect(service.create({ ...project(), cartographyId: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.prepare('SELECT * FROM projects').all()).toEqual([]);
  } finally { closeMapDesignDatabase(db); }
});

it('persists a trimmed project rename and rejects invalid names without changing the project', async () => {
  const { db, service } = openFixture();
  try {
    await service.create(project());
    const updated = service.rename('project-1', { title: '  Renamed atlas  ' });
    expect(updated.title).toBe('Renamed atlas');
    expect(service.list().projects.find(item => item.projectId === 'project-1')?.title).toBe('Renamed atlas');
    expect(db.prepare('SELECT title FROM projects WHERE id = ?').get('project-1')).toEqual({ title: 'Renamed atlas' });
    for (const title of ['', '   ', 'a'.repeat(257)]) {
      expect(() => service.rename('project-1', { title })).toThrow();
    }
    expect(() => service.rename('missing', { title: 'New name' })).toThrow('not found');
    expect(db.prepare('SELECT title FROM projects WHERE id = ?').get('project-1')).toEqual({ title: 'Renamed atlas' });
  } finally { closeMapDesignDatabase(db); }
});

it('keeps an unspecified cartography absent on create, replay and reopen', async () => {
  const { db, service, queryService } = openFixture();
  try {
    const input = project();
    const created = await service.create(input);
    expect(created.cartography).toBeUndefined();
    expect(await service.create(input)).toEqual(created);
    queryService.getProject.mockResolvedValue(created.project);
    expect((await service.get(input.projectId)).cartography).toBeUndefined();
    expect(db.prepare('SELECT * FROM project_cartography').all()).toEqual([]);
  } finally { closeMapDesignDatabase(db); }
});

describe('MapDesignProjectService', () => {
  it('creates the local project, conversation, import state, and sanitized replay witness atomically', async () => {
    const { db, service, prepare } = openFixture();
    try {
      const created = await service.create({ ...project(), runtime: { agentId: 'claude', model: 'sonnet', reasoning: 'high', serviceTier: 'priority' }, workingDirectory: { path: '/picked', token: 't'.repeat(16) } });
      expect(created).toMatchObject({ project: { projectId: 'project-1', lifecycle: 'importing' }, conversationId: 'conversation-1', title: 'Map', runtime: { agentId: 'claude', model: 'sonnet', reasoning: 'high', serviceTier: 'priority' } });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(db.prepare('SELECT conversation_id, prompt, status FROM map_design_initial_runs').get()).toEqual({ conversation_id: 'conversation-1', prompt: 'Make it clear', status: 'pending' });
      expect(db.prepare('SELECT working_directory AS workingDirectory FROM projects WHERE id = ?').get('project-1')).toEqual({ workingDirectory: '/canonical/picked' });
      const witness = db.prepare(`SELECT canonical_request_json AS requestJson, response_json AS responseJson FROM map_design_idempotency WHERE operation = 'project.create'`).get() as { requestJson: string; responseJson: string };
      expect(witness.requestJson).not.toContain('tttt');
      expect(JSON.parse(witness.responseJson)).toEqual(created);
    } finally { closeMapDesignDatabase(db); }
  });

  it('replays an equal request before consuming its desktop grant and rejects a changed request with the same key', async () => {
    const { db, service, prepare } = openFixture();
    try {
      const first = await service.create(project());
      expect(first).toMatchObject({ title: 'Map' });
      expect(prepare).toHaveBeenCalledTimes(1);
      await expect(service.create({ ...project(), title: 'Other map' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 1 });
    } finally { closeMapDesignDatabase(db); }
  });

  it('returns the stored project title in the reload aggregate', async () => {
    const { db, service, queryService } = openFixture();
    try {
      await service.create(project());
      queryService.getProject.mockResolvedValue(importing('project-1'));
      await expect(service.get('project-1')).resolves.toMatchObject({
        project: { projectId: 'project-1' },
        conversationId: 'conversation-1',
        title: 'Map',
        runtime: { agentId: 'claude' },
      });
    } finally { closeMapDesignDatabase(db); }
  });

  it('reloads a reset project without a phantom primary conversation and creates a replacement conversation', async () => {
    const { db, service, queryService } = openFixture();
    try {
      await service.create(project());
      queryService.getProject.mockResolvedValue(importing('project-1'));

      resetMapDesignDevelopmentConversations(db);

      const store = createMapDesignLocalStore(db);
      expect(store.getProject('project-1')).toMatchObject({ primaryConversationId: null });
      await expect(service.get('project-1')).resolves.toMatchObject({
        project: { projectId: 'project-1' },
        conversationId: null,
      });
      const conversations = new MapDesignConversationService({
    getActiveConversationRun: () => null,
        store,
        isConversationRunning: () => false,
        randomId: () => 'conversation-reset-replacement',
        now: () => NOW,
      });
      expect(conversations.list('project-1')).toEqual({ conversations: [] });
      expect(conversations.create('project-1', { idempotencyKey: 'reset-replacement-key' })).toMatchObject({
        conversation: {
          conversationId: 'conversation-reset-replacement',
          projectId: 'project-1',
          runState: 'idle',
        },
      });
      expect(conversations.list('project-1').conversations).toHaveLength(1);
    } finally { closeMapDesignDatabase(db); }
  });

  it('rolls back the local project when import preparation fails', async () => {
    const { db, service } = openFixture({ prepare: () => { throw new Error('prepare failed'); } });
    try {
      await expect(service.create(project())).rejects.toThrow('prepare failed');
      expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM map_design_idempotency').get()).toEqual({ count: 0 });
    } finally { closeMapDesignDatabase(db); }
  });

  it('records a canonical failed lifecycle when enqueue throws after commit', async () => {
    const { db, service } = openFixture({ enqueue: () => { throw new Error('queue unavailable'); } });
    try {
      const output = await service.create(project());
      expect(output.project).toMatchObject({ lifecycle: 'failed', failure: { code: 'IMPORT_ENQUEUE_FAILED' } });
      expect(db.prepare('SELECT lifecycle_state AS lifecycle FROM map_design_projects WHERE project_id = ?').get('project-1')).toEqual({ lifecycle: 'failed' });
      expect(db.prepare('SELECT status, failure_code AS failureCode FROM map_design_import_jobs WHERE project_id = ?').get('project-1')).toEqual({ status: 'failed', failureCode: 'IMPORT_ENQUEUE_FAILED' });
      expect(JSON.parse((db.prepare(`SELECT response_json AS responseJson FROM map_design_idempotency WHERE operation = 'project.create'`).get() as { responseJson: string }).responseJson)).toEqual(output);
    } finally { closeMapDesignDatabase(db); }
  });

  it('records the failed lifecycle and replay witness when enqueue declines the project', async () => {
    const { db, service } = openFixture({ enqueue: () => false });
    try {
      const failed = await service.create(project());
      expect(failed.project).toMatchObject({ lifecycle: 'failed', failure: { code: 'IMPORT_ENQUEUE_FAILED' } });
      await expect(service.create(project())).resolves.toEqual(failed);
      expect(db.prepare('SELECT status FROM map_design_import_jobs WHERE project_id = ?').get('project-1')).toEqual({ status: 'failed' });
    } finally { closeMapDesignDatabase(db); }
  });

  it.each(['missing', 'expired', 'path', 'process', 'replayed'] as const)(
    'translates a %s working-directory grant verifier failure to RUN_NOT_AUTHORIZED without persistence',
    async (reason) => {
      const { db, service } = openFixture({ verifyWorkingDirectoryGrant: async () => { throw new Error(`${reason} picker token`); } });
      try {
        await expect(service.create({ ...project(`${reason}-project`), workingDirectory: { path: '/picker', token: 't'.repeat(16) } }))
          .rejects.toMatchObject({ code: 'RUN_NOT_AUTHORIZED', message: 'The desktop working-directory grant is not authorized.' });
        expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 0 });
        expect(db.prepare('SELECT COUNT(*) AS count FROM map_design_idempotency').get()).toEqual({ count: 0 });
      } finally { closeMapDesignDatabase(db); }
    },
  );
});

describe('MapDesignQueryService current snapshot compatibility', () => {
  it('keeps the root map summary unchanged when it reads the current draft', async () => {
    const root = mkdtempSync(join(tmpdir(), 'map-query-summary-'));
    roots.push(root);
    const db = openMapDesignDatabase(root);
    const blobStore = createMapDesignBlobStore(root);
    const projectId = 'summary-project';
    const style = {
      version: 8 as const,
      sources: {
        base: {
          type: 'vector' as const,
          promoteId: 'feature_id',
          tiles: [`/api/map-design/projects/${projectId}/resources/base/tiles/{z}/{x}/{y}.pbf`],
        },
      },
      layers: [{
        id: 'roads',
        type: 'line' as const,
        source: 'base',
        'source-layer': 'roads',
        metadata: { title: '  Main roads  ' },
        filter: ['==', ['get', 'class'], 'primary'],
        paint: { 'line-color': ['case', ['==', ['id'], 0], '#ff0000', '#333333'] },
        layout: { 'line-cap': 'round' },
      }],
    };
    const semantics = {
      version: 1 as const,
      groups: [{ id: 'roads', label: 'Roads', role: 'roads', layerIds: ['roads'], sourceIds: ['base'] }],
    };
    try {
      const [styleBlob, semanticBlob, sourceBlob] = await Promise.all([
        blobStore.putJson(projectId, 'styles', style),
        blobStore.putJson(projectId, 'semantics', semantics),
        blobStore.putJson(projectId, 'sources', {
          kind: 'style', digest: 'a'.repeat(64), mediaType: 'application/json',
          byteLength: 1, resourceCount: 1, capturedAt: NOW,
        }),
      ]);
      db.prepare(`INSERT INTO projects (id, title, runtime_json, created_at, updated_at)
        VALUES (?, ?, '{}', ?, ?)`).run(projectId, projectId, NOW, NOW);
      db.prepare(`INSERT INTO map_design_projects (
        project_id, lifecycle_state, source_kind, source_manifest_digest,
        design_system_id, design_system_digest, draft_revision, draft_style_digest,
        draft_style_hash, draft_semantic_digest, created_at, updated_at
      ) VALUES (?, 'ready', 'style', ?, 'quiet-atlas', ?, 4, ?, ?, ?, ?, ?)`).run(
        projectId,
        sourceBlob.digest,
        'd'.repeat(64),
        styleBlob.digest,
        await sha256CanonicalJson(style),
        semanticBlob.digest,
        NOW,
        NOW,
      );
      const service = new MapDesignQueryService({
        db,
        repository: new MapDesignSqliteProjectRepository(db),
        blobStore,
        loadDesignSystem: async () => (testDesignSystem({ id: 'quiet-atlas', digest: 'd'.repeat(64) })),
        validationService: { validate: vi.fn() } as never,
      });

      await expect(service.inspect(projectId, { target: { kind: 'root' } })).resolves.toEqual({
        target: { kind: 'root' },
        view: {
          kind: 'root',
          style: { layerCount: 1, sourceCount: 1, layerTypes: ['line'] },
          layers: [{ id: 'roads', type: 'line', title: 'Main roads', sourceId: 'base', sourceLayer: 'roads' }],
          sources: [{ id: 'base', kind: 'vector', sourceLayerCount: 1, layerCount: 1 }],
        },
        truncated: false,
      });
      await expect(service.inspect(projectId, { target: { kind: 'layer', layerId: 'roads' } })).resolves.toMatchObject({
        view: { layer: { filter: ['==', ['get', 'class'], 'primary'],
          paint: { 'line-color': ['case', ['==', ['id'], 0], '#ff0000', '#333333'] }, layout: { 'line-cap': 'round' } } },
        truncated: false,
      });
      await expect(service.inspect(projectId, { target: { kind: 'source', sourceId: 'base' } })).resolves.toEqual({
        target: { kind: 'source', sourceId: 'base' },
        view: { kind: 'source', source: { id: 'base', kind: 'vector', sourceLayerCount: 1, layerCount: 1, generateId: false, promoteId: 'feature_id' } },
        truncated: false,
      });
      const oversizedStyle = { ...style, layers: [{ ...style.layers[0]!, paint: {
        'line-color': ['match', ['get', 'class'], ...Array.from({ length: 5000 }, (_, index) => [`${index}-${'x'.repeat(64)}`, '#333333']).flat(), '#111111'],
      } }] };
      const oversizedBlob = await blobStore.putJson(projectId, 'styles', oversizedStyle);
      db.prepare('UPDATE map_design_projects SET draft_style_digest=?, draft_style_hash=? WHERE project_id=?')
        .run(oversizedBlob.digest, await sha256CanonicalJson(oversizedStyle), projectId);
      const bounded = await service.inspect(projectId, { target: { kind: 'layer', layerId: 'roads' } });
      expect(bounded.truncated).toBe(true);
      expect(bounded.view).not.toHaveProperty('layer.paint');
      expect(JSON.stringify(bounded).length).toBeLessThan(1024);
    } finally {
      closeMapDesignDatabase(db);
    }
  });
});
