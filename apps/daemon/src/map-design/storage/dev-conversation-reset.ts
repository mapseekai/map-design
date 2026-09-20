import type Database from 'better-sqlite3';

type SqliteDb = Database.Database;

export function resetMapDesignDevelopmentConversations(db: SqliteDb): void {
  const reset = db.transaction(() => {
    const conversations = db.prepare(`
      SELECT c.id
      FROM conversations c
      JOIN map_design_projects p ON p.project_id = c.project_id
      ORDER BY c.id
    `).all() as Array<{ id: string }>;
    if (conversations.length === 0) return;

    const deleteSessions = db.prepare('DELETE FROM agent_sessions WHERE conversation_id = ?');
    const deleteMessages = db.prepare('DELETE FROM messages WHERE conversation_id = ?');
    const deleteConversation = db.prepare('DELETE FROM conversations WHERE id = ?');
    for (const conversation of conversations) {
      deleteSessions.run(conversation.id);
      deleteMessages.run(conversation.id);
      deleteConversation.run(conversation.id);
    }
  });
  reset.immediate();
}
