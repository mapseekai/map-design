import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMapDesignRunService } from '../../../src/map-design/application/run-service.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';
import { apiAgentDef } from '../../../src/runtimes/defs/api.js';
import { ToolTokenRegistry } from '../../../src/tool-tokens.js';
import type { MapRunInput } from '../../../src/map-design/agents/types.js';
import type { MapCommentInput } from '@mapseekai/map-design-contracts';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { MapDesignCommentService, mapCommentPrompt } from '../../../src/map-design/application/comment-service.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'map-comments-'));
  const db = openMapDesignDatabase(dir);
  cleanups.push(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const id of ['project-a', 'project-b']) {
    db.prepare("INSERT INTO projects (id,title,runtime_json,created_at,updated_at) VALUES (?, 'Test','{}','now','now')").run(id);
    db.prepare(`INSERT INTO map_design_projects
      (project_id,lifecycle_state,source_kind,design_system_id,design_system_digest,draft_revision,draft_style_digest,draft_style_hash,draft_semantic_digest,created_at,updated_at)
      VALUES (?, 'ready','geojson','quiet-walking',?,3,?,?,?,'now','now')`).run(id, 'a'.repeat(64), 'a'.repeat(64), 'a'.repeat(64), 'a'.repeat(64));
  }
  const style = { version: 8 as const, sources: { streets: { type: 'geojson' as const, data: {
    type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, id: 0,
      properties: { class: 'primary', lanes: 2 }, geometry: { type: 'Point' as const, coordinates: [120, 30] } }],
  } } }, layers: [{ id: 'roads', type: 'circle' as const, source: 'streets' }] };
  const service = new MapDesignCommentService({ db, getStyle: async () => style });
  const input: MapCommentInput = { id: 'comment-1', version: 0, text: 'Make it red', scope: 'feature', draftRevision: 3, styleHash: 'a'.repeat(64),
    target: { layerId: 'roads', sourceId: 'streets', featureId: 0, properties: { class: 'primary', lanes: 2 }, anchor: [120, 30], geometryType: 'Point' } };
  return { db, dir, service, input, style };
}

describe('project map comments', () => {
  it('saves, updates with version checks, reopens, and deletes only the selected project comment', async () => {
    const { db, dir, service, input, style } = fixture();
    const saved = await service.save('project-a', input);
    expect(saved).toMatchObject({ status: 'draft', version: 1, text: 'Make it red' });
    const updated = await service.save('project-a', { ...input, version: 1, text: 'Make it blue' });
    expect(updated.version).toBe(2);
    await expect(service.save('project-a', { ...input, version: 1 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(service.list('project-b')).toEqual([]);
    expect(() => service.delete('project-a', saved.id, 1)).toThrow();
    db.close();
    const reopened = openMapDesignDatabase(dir);
    try {
      const again = new MapDesignCommentService({ db: reopened, getStyle: async () => style });
      expect(again.list('project-a')[0]).toMatchObject({ text: 'Make it blue', version: 2 });
      again.delete('project-a', saved.id, 2);
      expect(again.list('project-a')).toEqual([]);
    } finally { reopened.close(); }
  });

  it('keeps successful audit rows out of the active list and active comment limit', async () => {
    const { db, service, input } = fixture();
    const insert = db.prepare("INSERT INTO map_design_comments (project_id,id,version,body_json,status,run_id,created_at,updated_at) VALUES (?,?,1,?,'succeeded',NULL,'2026-09-08T00:00:00Z','2026-09-08T00:00:00Z')");
    db.transaction(() => { for (let index = 0; index < 500; index += 1) {
      const id = `finished-${index}`; insert.run('project-a', id, JSON.stringify({ ...input, id }));
    } })();
    expect(service.list('project-a')).toEqual([]);
    const saved = await service.save('project-a', input);
    expect(service.list('project-a')).toEqual([saved]);
    expect(db.prepare("SELECT count(*) AS count FROM map_design_comments WHERE project_id=? AND status='succeeded'").get('project-a')).toEqual({ count: 500 });
  });

  it('validates the entire batch and rejects cross-project and stale map references', async () => {
    const { db, service, input } = fixture();
    const a = await service.save('project-a', input);
    await service.save('project-b', { ...input, id: 'other' });
    await expect(service.prepare('project-a', [{ id: a.id, version: a.version }, { id: 'other', version: 1 }])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(service.list('project-a')[0]?.status).toBe('draft');
    db.prepare('UPDATE map_design_projects SET draft_revision = 4 WHERE project_id = ?').run('project-a');
    await expect(service.prepare('project-a', [{ id: a.id, version: a.version }])).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('atomically claims versions, prevents duplicate execution, retains failures for retry and recovers abandoned runs', async () => {
    const { service, input } = fixture();
    const a = await service.save('project-a', input);
    const b = await service.save('project-a', { ...input, id: 'comment-2', scope: 'similar', match: { property: 'class', value: 'primary' } });
    const batch = await service.prepare('project-a', [a, b].map(({ id, version }) => ({ id, version })));
    service.claim('project-a', batch, 'run-a');
    expect(service.list('project-a').map((c) => c.status)).toEqual(['submitted', 'submitted']);
    expect(() => service.claim('project-a', batch, 'run-b')).toThrow();
    service.finish('project-a', 'run-a', 'failed');
    const failed = service.list('project-a');
    expect(failed.every((c) => c.status === 'failed' && c.version === 3)).toBe(true);
    const retry = await service.prepare('project-a', failed.map(({ id, version }) => ({ id, version })));
    service.claim('project-a', retry, 'run-retry');
    service.recoverAbandoned();
    expect(service.list('project-a').every((c) => c.status === 'failed')).toBe(true);
  });

  it('checks source/layer, stable feature identity and real inline category values', async () => {
    const { service, input, style } = fixture();
    for (const target of [{ ...input.target, layerId: 'deleted' }, { ...input.target, sourceId: 'wrong' }, { ...input.target, featureId: 7 }]) {
      await expect(service.save('project-a', { ...input, target })).rejects.toThrow();
    }
    await expect(service.save('project-a', { ...input, scope: 'similar', match: { property: 'class', value: 'primary' } })).resolves.toMatchObject({ scope: 'similar' });
    style.sources.streets.data.features.push({ ...style.sources.streets.data.features[0]! });
    await expect(service.save('project-a', { ...input, id: 'ambiguous' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('builds explicit scoped AI instructions including typed predicates and version evidence', async () => {
    const { service, input } = fixture();
    const comment = await service.save('project-a', { ...input, scope: 'similar', match: { property: 'lanes', value: 2 } });
    const prompt = mapCommentPrompt([comment]);
    expect(prompt).toContain('"layerId":"roads"');
    expect(prompt).toContain('"value":2');
    expect(prompt).toContain('"draftRevision":3');
    expect(prompt).toContain('Preserve all nonmatching features');
    expect(prompt).toContain('Make it red');
  });

  it('sends saved targets in fresh and resumed AI prompts and persists execution status', async () => {
    const { db, dir, service: comments, input } = fixture();
    db.prepare("INSERT INTO conversations (id, project_id, created_at, updated_at) VALUES ('conversation','project-a','now','now')").run();
    let launch: MapRunInput | undefined;
    let done!: (result: { status: 'failed' | 'succeeded' }) => void;
    const run = createMapDesignRunService({
      store: createMapDesignLocalStore(db), comments, dataDir: dir, projectRoot: dir, mcpCliPath: '/tmp/md.mjs',
      agents: { get: () => apiAgentDef, getMapAgent: () => ({ id: 'api', capabilities: { nativeMapTools: true, publicReasoningSummary: true },
        startMapRun: async (value) => { launch = value; return { done: new Promise((resolve) => { done = resolve; }), cancel: async () => undefined }; } }) },
      nativeToolRegistry: { definitions: () => [], call: async () => ({ ok: true, toolUseId: 'test', summary: {} }) },
      mapContext: { getContext: async () => ({ draftRevision: 3 }) }, toolTokens: new ToolTokenRegistry(), daemonUrl: () => 'http://localhost:7456',
      runtimeChoices: { requireCurrent: () => ({ agentId: 'api', revision: 0, updatedAt: '2026-09-08T00:00:00Z' }) },
      runtimeCatalog: { resolveChoice: () => ({ agentId: 'api', model: 'test', modelOrigin: 'catalog', adapter: 'ai-sdk' }) },
    });
    const saved = await comments.save('project-a', input);
    const request = { projectId: 'project-a', conversationId: 'conversation', prompt: 'Apply this comment', runtimeRevision: 0,
      commentRefs: [{ id: saved.id, version: saved.version }], clientRequestId: 'request-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1' };
    try {
      const attempts = await Promise.allSettled([
        run.start(request),
        run.start({ ...request, clientRequestId: 'concurrent', userMessageId: 'user-concurrent', assistantMessageId: 'assistant-concurrent' }),
      ]);
      expect(attempts.map((attempt) => attempt.status)).toEqual(['fulfilled', 'rejected']);
      const first = attempts[0]!;
      if (first.status !== 'fulfilled') throw first.reason;
      const started = first.value;
      expect(launch?.prompt).toContain('"featureId":0');
      expect(launch?.resumePrompt).toContain('"layerId":"roads"');
      expect(comments.list('project-a')[0]).toMatchObject({ status: 'submitted', runId: started.runId });
      await expect(run.start(request)).resolves.toEqual(started);
      done({ status: 'failed' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(comments.list('project-a')[0]?.status).toBe('failed');
      const failed = comments.list('project-a')[0]!;
      await expect(run.start({ ...request, commentRefs: [{ id: failed.id, version: failed.version }], clientRequestId: 'rollback', assistantMessageId: 'assistant-rollback' })).rejects.toThrow();
      expect(comments.list('project-a')[0]).toMatchObject({ status: 'failed', version: failed.version });
      expect(db.prepare("SELECT id FROM messages WHERE id='assistant-rollback'").get()).toBeUndefined();
      await run.start({ ...request, commentRefs: [{ id: failed.id, version: failed.version }], clientRequestId: 'request-2', userMessageId: 'user-2', assistantMessageId: 'assistant-2' });
      done({ status: 'succeeded' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(comments.list('project-a')).toEqual([]);
      expect(db.prepare('SELECT status FROM map_design_comments WHERE project_id=? AND id=?').get('project-a', input.id)).toEqual({ status: 'succeeded' });
    } finally { done?.({ status: 'failed' }); await run.shutdown(); }
  });
});

it('keeps immediate submissions out of the list and removes their temporary record when claimed', async () => {
  const { db, service, input } = fixture();
  const saved = await service.save('project-a', { ...input, transient: true });
  expect(service.list('project-a')).toEqual([]);
  const prepared = await service.prepare('project-a', [{ id: saved.id, version: saved.version }]);
  expect(mapCommentPrompt(prepared)).toContain('Make it red');
  service.claim('project-a', prepared, 'run-now');
  expect(db.prepare('SELECT count(*) AS count FROM map_design_comments').get()).toEqual({ count: 0 });
  service.finish('project-a', 'run-now', 'failed');
  expect(service.list('project-a')).toEqual([]);
  db.close();
});
