import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';
import { createMapImportJobRunner } from '../../../src/map-design/ingestion/import-job-runner.js';
import { MapInitialRunService } from '../../../src/map-design/application/initial-run-service.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(fn => fn()));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'map-initial-run-'));
  const db = openMapDesignDatabase(root);
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const store = createMapDesignLocalStore(db);
  store.createProject({ project: { projectId: 'p1', title: 'Map', source: { url: 'https://example.com/style.json' }, designRequirement: 'Make roads blue', runtime: { agentId: 'codex' }, idempotencyKey: 'create-p1' }, primaryConversationId: 'c1', verifiedWorkingDirectory: null });
  db.prepare("INSERT INTO map_design_projects (project_id,lifecycle_state,design_system_id,design_system_digest,draft_revision,created_at,updated_at) VALUES ('p1','importing','default','digest',0,'now','now')").run();
  db.prepare("INSERT INTO map_design_initial_runs VALUES ('p1','c1','Make roads blue','pending')").run();
  const runs = { start: vi.fn().mockResolvedValue({ runId: 'r1' }) };
  const ready = () => db.exec("UPDATE map_design_projects SET lifecycle_state='ready', source_kind='style', draft_style_digest='digest', draft_style_hash='hash', draft_semantic_digest='digest' WHERE project_id='p1'");
  return { db, store, runs, ready, service: new MapInitialRunService({ db, store, runs }) };
}
it('waits for import, submits the original requirement with the saved runtime, and does not restart on reload', async () => {
  const f = fixture();
  await f.service.start('p1');
  expect(f.runs.start).not.toHaveBeenCalled();
  f.ready();
  await Promise.all([f.service.start('p1'), f.service.start('p1')]);
  expect(f.runs.start).toHaveBeenCalledTimes(1);
  expect(f.runs.start).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Make roads blue', projectId: 'p1', conversationId: 'c1', runtimeRevision: 0, clientRequestId: 'initial-run:p1' }));
  await new MapInitialRunService(f).recover();
  expect(f.runs.start).toHaveBeenCalledTimes(1);
});
it('keeps the requirement visible in the conversation when the selected runtime cannot start', async () => {
  const f = fixture(); f.ready();
  f.runs.start.mockRejectedValue(new Error('unavailable'));
  await f.service.start('p1');
  expect(f.store.getConversation('c1')?.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'user', content: 'Make roads blue' }),
    expect.objectContaining({ role: 'assistant', runStatus: 'failed' }),
  ]));
  await f.service.recover();
  expect(f.runs.start).toHaveBeenCalledTimes(1);
});
it('recognizes persisted acceptance after a daemon interruption and never replays it', async () => {
  const f = fixture(); f.ready();
  f.store.appendMessage({ message: { id: 'initial-user:p1', conversationId: 'c1', role: 'user', content: 'Make roads blue', events: [], runStatus: 'succeeded', startedAt: 1, endedAt: 1 } });
  await f.service.recover();
  expect(f.runs.start).not.toHaveBeenCalled();
});

it('starts the queued first task directly after the import worker completes', async () => {
  const f = fixture();
  const runner = createMapImportJobRunner({
    db: f.db,
    executor: { executeImportJob: async () => { f.ready(); }, preparePendingRetry: async () => false },
    onImported: id => f.service.start(id),
  });
  runner.enqueue('p1');
  await vi.waitFor(() => expect(f.runs.start).toHaveBeenCalledTimes(1));
  await runner.shutdown();
});
