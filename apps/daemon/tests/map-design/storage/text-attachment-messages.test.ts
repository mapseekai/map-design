import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openMapDesignDatabase } from '../../../src/map-design/storage/database.js';
import { createMapDesignLocalStore } from '../../../src/map-design/storage/local-store.js';

it('retains text attachment metadata with user messages after reopening the database', () => {
  const root = mkdtempSync(join(tmpdir(), 'map-shot-message-'));
  let db = openMapDesignDatabase(root);
  try {
    db.exec('ALTER TABLE messages DROP COLUMN attachments_json');
    db.close(); db = openMapDesignDatabase(root);
    const store = createMapDesignLocalStore(db);
    store.createProject({ project: { projectId: 'p', title: 'Map', runtime: { agentId: 'codex' }, source: { url: 'https://example.com/style.json' }, designRequirement: 'Clear', idempotencyKey: 'k' }, primaryConversationId: 'c', verifiedWorkingDirectory: null });
    const attachments = [{ id: 'a'.repeat(64), projectId: 'p', fileName: 'notes.md', mediaType: 'text/plain' as const, byteLength: 10, createdAt: '2026-09-08T00:00:00.000Z' }];
    store.appendMessage({ message: { id: 'u', conversationId: 'c', role: 'user', content: 'Fix the colors', attachments,
      events: [], runStatus: 'succeeded', startedAt: 1, endedAt: 1 } });
    db.close(); db = openMapDesignDatabase(root);
    expect(createMapDesignLocalStore(db).getConversation('c')!.messages[0]).toMatchObject({ content: 'Fix the colors', attachments });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
