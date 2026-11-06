import type { ApiConversationHistory, ApiHistoryMessage, ApiHistorySummary } from '../agents/api-context.js';
import type { MapDesignLocalStore } from './local-store.js';

export function apiConversationHistory(store: MapDesignLocalStore, conversationId: string, messages: readonly ApiHistoryMessage[]): ApiConversationHistory {
  const summary = store.inTransaction(db => db.prepare(`SELECT through_message_id AS throughMessageId, digest, summary AS text
    FROM api_context_summaries WHERE conversation_id = ?`).get(conversationId)) as ApiHistorySummary | undefined;
  return { messages: messages.map(({ id, role, content }) => ({ id, role, content })), summary,
    save(value) {
      store.inTransaction(db => {
        const covered = db.prepare('SELECT id FROM messages WHERE id = ? AND conversation_id = ?').get(value.throughMessageId, conversationId);
        if (!covered) throw new Error('The summarized conversation changed.');
        db.prepare(`INSERT INTO api_context_summaries (conversation_id, through_message_id, digest, summary) VALUES (?, ?, ?, ?)
          ON CONFLICT(conversation_id) DO UPDATE SET through_message_id = excluded.through_message_id, digest = excluded.digest, summary = excluded.summary`)
          .run(conversationId, value.throughMessageId, value.digest, value.text);
      });
    },
  };
}
