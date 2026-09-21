import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { MapDesignMessageSchema } from '@mapseekai/contracts';
import { openMapDesignDatabase, closeMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';
import { createMapRunHistory } from '../../../src/map-design/storage/run-history.js';

it('recovers interrupted runs after database reopen, keeps saved progress and cascades project deletion', () => {
  const root = mkdtempSync(join(tmpdir(), 'durable-run-recovery-'));
  let db = openMapDesignDatabase(root);
  try {
    const store = createMapDesignLocalStore(db);
    store.createProject({ project: { projectId: 'p', title: 'Recovery test', source: { url: 'https://example.com/style.json' }, runtime: { agentId: 'api' }, designRequirement: 'Inspect', idempotencyKey: 'project-create' }, primaryConversationId: 'c', verifiedWorkingDirectory: null });
    const message = MapDesignMessageSchema.parse({ id: 'a', conversationId: 'c', role: 'assistant', content: '', events: [], runStatus: 'running', startedAt: 1000, endedAt: 0 });
    store.appendMessage({ message, runId: 'r' });
    const history = createMapRunHistory(db);
    history.start({ response: { runId: 'r', projectId: 'p', conversationId: 'c', status: 'running', startedAt: new Date(1000).toISOString() },
      trusted: { runId: 'r', projectId: 'p', runtime: { id: 'api', version: 'test', adapter: 'ai-sdk' }, model: { id: 'mock', provider: 'api' } },
      message, clientRequestId: 'request-1', requestDigest: 'a'.repeat(64),
    });
    store.updateRunMessage('a', { content: 'The draft already contains the first change.', events: [{ kind: 'text', text: 'First change saved.' }], runStatus: 'running', endedAt: 0 });
    closeMapDesignDatabase(db); db = openMapDesignDatabase(root);
    const recovered = createMapRunHistory(db);
    expect(recovered.recoverInterrupted(2000)).toBe(1);
    expect(recovered.get('r')).toMatchObject({ response: { status: 'failed', error: { code: 'RUN_INTERRUPTED' } },
      message: { content: 'The draft already contains the first change.', runStatus: 'failed', endedAt: 2000 } });
    expect(recovered.findRequest('request-1')?.trusted.model.id).toBe('mock');
    expect(recovered.recoverInterrupted(3000)).toBe(0);
    expect(createMapDesignLocalStore(db).getConversation('c')?.messages[0]?.runStatus).toBe('failed');
    db.prepare('DELETE FROM projects WHERE id = ?').run('p');
    expect(recovered.get('r')).toBeNull();
  } finally { closeMapDesignDatabase(db); rmSync(root, { recursive: true, force: true }); }
});
