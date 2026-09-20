import type Database from 'better-sqlite3';
import type { MapDesignLocalStore } from '../storage/local-store.js';
import type { MapDesignRunService } from './run-service.js';

type InitialRun = { projectId: string; conversationId: string; prompt: string };

/** A creation request is accepted before import; retain its first task until the map is ready. */
export class MapInitialRunService {
  private readonly active = new Map<string, Promise<void>>();
  constructor(private readonly deps: { db: Database.Database; store: MapDesignLocalStore; runs: Pick<MapDesignRunService, 'start'> }) {}

  start(projectId: string): Promise<void> {
    const current = this.active.get(projectId);
    if (current) return current;
    const task = this.startOnce(projectId).finally(() => this.active.delete(projectId));
    this.active.set(projectId, task);
    return task;
  }

  async recover(): Promise<void> {
    const rows = this.deps.db.prepare("SELECT project_id AS projectId FROM map_design_initial_runs WHERE status='pending'").all() as { projectId: string }[];
    for (const row of rows) await this.start(row.projectId);
  }

  private async startOnce(projectId: string): Promise<void> {
    const row = this.deps.db.prepare(`SELECT q.project_id AS projectId, q.conversation_id AS conversationId, q.prompt
      FROM map_design_initial_runs q JOIN map_design_projects p ON p.project_id=q.project_id
      WHERE q.project_id=? AND q.status='pending' AND p.lifecycle_state='ready'`).get(projectId) as InitialRun | undefined;
    if (!row) return;
    const conversation = this.deps.store.getConversation(row.conversationId);
    if (!conversation) return;
    const userMessageId = `initial-user:${projectId}`;
    const assistantMessageId = `initial-assistant:${projectId}`;
    const finish = (status: string) => this.deps.db.prepare('UPDATE map_design_initial_runs SET status=? WHERE project_id=?').run(status, projectId);
    // Stored messages are the durable acceptance receipt, including across daemon restarts.
    if (conversation.messages.some(message => message.id === userMessageId)) { finish('started'); return; }
    // Never insert an automatic task after the user has already begun this conversation.
    if (conversation.messages.length) { finish('started'); return; }
    try {
      const runtime = this.deps.store.getConversationRuntime(row.conversationId);
      if (!runtime) throw new Error('Conversation runtime is missing.');
      await this.deps.runs.start({
        projectId, conversationId: row.conversationId, prompt: row.prompt,
        runtimeRevision: runtime.revision,
        clientRequestId: `initial-run:${projectId}`, userMessageId, assistantMessageId,
      });
      finish('started');
    } catch {
      // Keep the original request visible and retryable using the normal chat workflow.
      const latest = this.deps.store.getConversation(row.conversationId);
      if (!latest) return;
      if (latest.messages.some(message => message.id === userMessageId)) { finish('started'); return; }
      const at = Date.now();
      this.deps.store.inTransaction(() => {
        this.deps.store.appendMessage({ message: { id: userMessageId, conversationId: row.conversationId,
          role: 'user', content: row.prompt, events: [], runStatus: 'succeeded', startedAt: at, endedAt: at } });
        this.deps.store.appendMessage({ message: { id: assistantMessageId, conversationId: row.conversationId,
          role: 'assistant', content: '', events: [], runStatus: 'failed', startedAt: at, endedAt: at } });
        finish('failed');
      });
    }
  }
}
