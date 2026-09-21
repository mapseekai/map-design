import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { lintCartography } from '@mapseekai/cartography.md';
import type { MapDesignMessage, MapDesignRuntimeSelectionInput } from '@mapseekai/contracts';
import {
  CartographyEditCreateSchema, CartographyEditTurnSchema, CartographyEditSessionSchema, CartographyEditSaveSchema, CartographyEditReplySchema,
  validCartographySampleBindings, type CartographySampleBindings, type CartographyEditSession, type CartographyEditTurn, type CartographySummary,
} from '@mapseekai/map-design-contracts';
import { cartographyPreview } from './cartography-preview.js';
import { generateCartographyEdit, type CartographyModelRoots } from './cartography-authoring.js';
import { invalidInput, MapDraftError } from './errors.js';
import type { MapDesignLocalStore, RunMessagePatch } from '../storage/local-store.js';
import { RunEventAccumulator } from './run-events.js';

const storedSchema = CartographyEditSessionSchema.omit({ preview: true }).extend({
  reportMarkdown: z.string().max(2 * 1024 * 1024), receipts: z.record(z.string().uuid(), z.string()), assistantId: z.string().uuid().optional(),
});
type StoredSession = z.infer<typeof storedSchema>;
type MessageChange = { append?: MapDesignMessage[]; patch?: { id: string; value: RunMessagePatch } };
type Job = { controller: AbortController; done: Promise<void>; conversationId: string; events: RunEventAccumulator; timer?: ReturnType<typeof setTimeout> | undefined };

/** Document drafts share project conversations, runtime choices and Agent session persistence. */
export class CartographyEditService {
  private readonly directory: string;
  private readonly locks = new Set<string>();
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly deps: CartographyModelRoots & {
    store?: MapDesignLocalStore;
    saveDocument(input: { source: string; description: string; sampleBindings?: CartographySampleBindings }): CartographySummary;
    generate?: typeof generateCartographyEdit;
  }) {
    this.directory = join(deps.dataRoot, 'cartography-edits');
    deps.store?.inTransaction((db) => db.exec('CREATE TABLE IF NOT EXISTS cartography_edit_sessions (id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, document_json TEXT NOT NULL)'));
  }
  isProjectRunning(id: string) { return this.jobs.has(id) || this.locks.has(id); }
  async history(documentId: string) {
    if (!z.string().regex(/^[a-f0-9]{64}$/).safeParse(documentId).success) throw invalidInput();
    const rows = this.deps.store?.inTransaction((db) => db.prepare('SELECT id FROM cartography_edit_sessions WHERE json_extract(document_json, \'$.sourceDocumentId\') = ?').all(documentId)) as { id: string }[] | undefined;
    const files = rows ? [] : await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const ids = rows?.map((row) => row.id) ?? files.filter((file) => /^[a-f0-9-]{36}\.json$/.test(file)).map((file) => file.slice(0, -5));
    const sessions = await Promise.all(ids.map((id) => this.get(id)));
    return { sessions: sessions.filter((session) => session.sourceDocumentId === documentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map(({ id, name, createdAt, updatedAt, status, revision }) => ({ id, name, createdAt, updatedAt, status, revision })) };
  }
  async activeEdits() {
    const sessions = await Promise.all([...this.jobs.keys()].map((id) => this.read(id)));
    return { sessions: sessions.filter((session) => session.status === 'running').map(({ id, sourceDocumentId }) => ({ id, sourceDocumentId })) };
  }
  isConversationRunning(id: string) { return [...this.jobs.values()].some((job) => job.conversationId === id); }
  async shutdown() {
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map((job) => job.done));
  }

  async create(input: unknown): Promise<CartographyEditSession> {
    const parsed = CartographyEditCreateSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    const report = lintCartography(parsed.data.source);
    if (!report.valid || !report.cartography) throw invalidInput();
    const now = new Date().toISOString();
    const session: StoredSession = {
      id: randomUUID(), name: report.cartography.name, source: parsed.data.source,
      ...(parsed.data.sourceDocumentId ? { sourceDocumentId: parsed.data.sourceDocumentId } : {}),
      description: parsed.data.description, reportMarkdown: parsed.data.reportMarkdown,
      initialPrompt: parsed.data.initialPrompt, runtime: parsed.data.runtime,
      revision: 0, status: 'idle', error: null, savedId: null, savedRevision: null,
      createdAt: now, updatedAt: now, messages: [], receipts: {}, initialAnalysisStarted: false,
    };
    await this.write(session);
    return this.publicSession(session);
  }

  async get(id: string): Promise<CartographyEditSession> {
    let session = await this.read(id);
    if (session.status === 'running' && !this.jobs.has(id) && !this.locks.has(id)) {
      this.locks.add(id);
      try {
        session = await this.read(id);
        if (session.status === 'running' && !this.jobs.has(id)) {
          session = { ...session, status: 'failed', error: 'interrupted', updatedAt: new Date().toISOString() };
          await this.write(session, session.assistantId ? { patch: { id: session.assistantId, value: { runStatus: 'failed', endedAt: Date.now() } } } : undefined);
        }
      } finally { this.locks.delete(id); }
    }
    return this.publicSession(session);
  }

  async turn(id: string, input: unknown): Promise<CartographyEditSession> {
    const parsed = CartographyEditTurnSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    return this.lock(id, async () => {
      const wasRunning = this.jobs.has(id);
      const session = await this.read(id);
      const request = parsed.data;
      const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      if (session.receipts[request.requestId]) {
        if (session.receipts[request.requestId] !== digest) throw new MapDraftError('IDEMPOTENCY_CONFLICT', 'The edit request identity was reused.');
        return this.publicSession(session);
      }
      if (wasRunning || this.jobs.has(id) || this.jobs.size >= 2) throw busy();
      if (session.revision !== request.expectedRevision) throw new MapDraftError('REVISION_CONFLICT', 'The specification draft has changed.');
      const conversationId = request.conversationId ?? id;
      let runtime: MapDesignRuntimeSelectionInput | 'api' | 'codex' = request.runtime ?? session.runtime;
      let history = session.messages;
      if (this.deps.store) {
        if (!request.conversationId || request.runtimeRevision === undefined) throw invalidInput();
        const conversation = this.deps.store.getConversation(conversationId);
        const choice = this.deps.store.getConversationRuntime(conversationId);
        if (conversation?.projectId !== id || !choice) throw new MapDraftError('NOT_FOUND', 'The editing conversation was not found.');
        if (choice.revision !== request.runtimeRevision) throw new MapDraftError('RUNTIME_CONFLICT', 'The Agent selection changed in another client.');
        const resolved = this.deps.agents?.runtimeCatalog.resolveChoice(choice.agentId, choice);
        if (!resolved) throw new MapDraftError('RUNTIME_CONFLICT', 'The selected Agent is no longer available.');
        runtime = { agentId: resolved.agentId, model: resolved.model, modelOrigin: resolved.modelOrigin, ...(resolved.reasoning ? { reasoning: resolved.reasoning } : {}), ...(resolved.serviceTier ? { serviceTier: resolved.serviceTier } : {}) };
        history = conversation.messages.filter((message): message is MapDesignMessage & { role: 'user' | 'assistant' } => message.role !== 'system')
          .map((message) => ({ id: message.id, role: message.role, content: message.content, createdAt: new Date(message.startedAt).toISOString() }));
      }
      if (history.length >= 198) throw new MapDraftError('INVALID_INPUT', 'Begin a new conversation to continue editing.');
      const now = new Date().toISOString();
      const assistantId = randomUUID();
      const user = { id: request.requestId, role: 'user' as const, content: request.prompt, createdAt: now };
      const next: StoredSession = { ...session, status: 'running', error: null, updatedAt: now, assistantId, activeConversationId: conversationId, initialAnalysisStarted: true,
        runtime: typeof runtime === 'string' ? runtime : session.runtime,
        receipts: { ...session.receipts, [request.requestId]: digest },
        messages: this.deps.store ? session.messages : [...session.messages, user],
      };
      const job: Job = { controller: new AbortController(), done: Promise.resolve(), conversationId, events: new RunEventAccumulator() };
      job.events.apply({ kind: 'status', label: 'analyzing' });
      this.jobs.set(id, job);
      try {
        await this.write(next, { append: [this.message(user, conversationId), {
          id: assistantId, conversationId, role: 'assistant', content: '', events: job.events.snapshot(), runStatus: 'running', startedAt: Date.now(), endedAt: 0,
        }] });
      } catch (error) { this.jobs.delete(id); throw error; }
      job.done = this.finish(next, request, runtime, history, job);
      return this.publicSession(next);
    });
  }

  async cancel(id: string): Promise<CartographyEditSession> {
    this.validId(id);
    const job = this.jobs.get(id);
    if (job) { job.controller.abort(); await job.done; }
    return this.get(id);
  }

  async save(id: string, input: unknown) {
    const parsed = CartographyEditSaveSchema.safeParse(input);
    if (!parsed.success) throw invalidInput();
    return this.lock(id, async () => {
      if (this.jobs.has(id)) throw busy();
      const session = await this.read(id);
      if (session.revision !== parsed.data.expectedRevision) throw new MapDraftError('REVISION_CONFLICT', 'The specification draft has changed.');
      const document = this.deps.saveDocument({ source: session.source, description: session.description,
        ...(session.sampleBindings ? { sampleBindings: session.sampleBindings } : {}),
      });
      const next = { ...session, savedId: document.id, savedRevision: session.revision, updatedAt: new Date().toISOString() };
      await this.write(next);
      return { session: this.publicSession(next), document };
    });
  }

  private async finish(session: StoredSession, request: CartographyEditTurn, runtime: MapDesignRuntimeSelectionInput | 'api' | 'codex', history: StoredSession['messages'], job: Job): Promise<void> {
    const timeout = setTimeout(() => job.controller.abort(), 600_000); timeout.unref();
    try {
      const reply = CartographyEditReplySchema.parse(await (this.deps.generate ?? generateCartographyEdit)({
        source: session.source, reportMarkdown: session.reportMarkdown, prompt: request.prompt, sampleBindings: session.sampleBindings,
        history: history.map(({ role, content }) => ({ role, content })), runtime,
        sessionId: session.id, conversationId: job.conversationId, runId: request.requestId,
        onEvent: (event) => {
          if (event.kind === 'text' || event.kind === 'run_finished' || !this.deps.store || !job.events.apply(event) || job.timer) return;
          job.timer = setTimeout(() => {
            job.timer = undefined;
            if (this.jobs.get(session.id) !== job) return;
            try { this.deps.store?.updateRunMessage(session.assistantId!, { events: job.events.snapshot() }); } catch { /* Final persistence reports errors. */ }
          }, 300); job.timer.unref();
        },
      }, this.deps, job.controller.signal));
      if (job.controller.signal.aborted) throw new Error('Canceled');
      const report = lintCartography(reply.source);
      if (!report.valid || !report.cartography) throw new Error('Invalid specification');
      const sampleBindings = reply.sampleBindings ?? {};
      if (!validCartographySampleBindings(cartographyPreview(reply.source).elements ?? [], sampleBindings)) throw new Error('Invalid sample binding');
      const now = new Date().toISOString();
      job.events.finish('succeeded', undefined, Date.now());
      await this.write({ ...session, source: reply.source, name: report.cartography.name, revision: session.revision + 1,
        sampleBindings: reply.sampleBindings, status: 'idle', error: null, updatedAt: now,
        messages: this.deps.store ? session.messages : [...session.messages, { id: session.assistantId!, role: 'assistant', content: reply.message, createdAt: now }],
      }, { patch: { id: session.assistantId!, value: { content: reply.message, runStatus: 'succeeded', endedAt: Date.now(), events: job.events.snapshot() } } });
    } catch {
      const canceled = job.controller.signal.aborted;
      job.events.finish(canceled ? 'canceled' : 'failed', undefined, Date.now());
      try { await this.write({ ...session, status: canceled ? 'canceled' : 'failed', error: canceled ? null : 'generation-failed', updatedAt: new Date().toISOString() },
        { patch: { id: session.assistantId!, value: { runStatus: canceled ? 'canceled' : 'failed', endedAt: Date.now(), events: job.events.snapshot() } } }); }
      catch { /* A durable running record is recovered on the next read. */ }
    } finally { clearTimeout(timeout); clearTimeout(job.timer); this.jobs.delete(session.id); }
  }

  private publicSession(session: StoredSession): CartographyEditSession {
    const { reportMarkdown: _report, receipts: _receipts, assistantId: _assistant, ...visible } = session;
    return CartographyEditSessionSchema.parse({ ...visible, initialAnalysisStarted: session.initialAnalysisStarted ?? session.messages.length > 0,
      preview: { ...cartographyPreview(session.source), ...(session.sampleBindings ? { sampleBindings: session.sampleBindings } : {}) },
    });
  }
  private validId(id: string) {
    if (!z.string().uuid().safeParse(id).success) throw invalidInput();
    return id;
  }
  private message(message: StoredSession['messages'][number], conversationId: string): MapDesignMessage {
    return { id: message.id, conversationId, role: message.role, content: message.content, events: [], runStatus: 'succeeded', startedAt: Date.parse(message.createdAt), endedAt: Date.parse(message.createdAt) };
  }
  private sqlRead(id: string): StoredSession | null {
    const row = this.deps.store?.inTransaction((db) => db.prepare('SELECT document_json AS json FROM cartography_edit_sessions WHERE id = ?').get(id)) as { json: string } | undefined;
    return row ? storedSchema.parse(JSON.parse(row.json)) : null;
  }
  private async read(id: string): Promise<StoredSession> {
    this.validId(id);
    try {
      const current = this.sqlRead(id);
      if (current) return current;
      const file = join(this.directory, `${id}.json`);
      const legacy = storedSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      if (!this.deps.store) return legacy;
      await this.write(legacy, undefined, true);
      await rename(file, `${file}.migrated`).catch(() => undefined);
      return this.sqlRead(id)!;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw new MapDraftError('NOT_FOUND', 'The specification editing session was not found.');
      throw new MapDraftError('INTERNAL', 'Unable to read the specification editing session.');
    }
  }
  private async write(session: StoredSession, change?: MessageChange, migrating = false): Promise<void> {
    const stored = storedSchema.parse(session);
    const store = this.deps.store;
    if (store) {
      store.inTransaction((db) => {
        if (migrating && db.prepare('SELECT 1 FROM cartography_edit_sessions WHERE id = ?').get(session.id)) return;
        if (db.prepare('SELECT 1 FROM map_design_projects WHERE project_id = ?').get(session.id)) throw invalidInput();
        if (!store.getProject(session.id)) {
          let runtime: MapDesignRuntimeSelectionInput = { agentId: session.runtime };
          try { runtime = this.deps.agents?.runtimeCatalog.normalizeSaved(runtime).runtime ?? runtime; } catch { /* Configure a runtime in the shared selector. */ }
          db.prepare('INSERT INTO projects (id, title, runtime_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(session.id, session.name, JSON.stringify(runtime), session.createdAt, session.updatedAt);
          store.createConversation(session.id, session.id, session.name);
          db.prepare('UPDATE conversations SET title_is_default = 0 WHERE id = ?').run(session.id);
          for (const message of session.messages) store.appendMessage({ message: this.message(message, session.id) });
        }
        db.prepare('INSERT INTO cartography_edit_sessions (id, document_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document_json = excluded.document_json').run(session.id, JSON.stringify(stored));
        for (const message of change?.append ?? []) store.appendMessage({ message });
        if (change?.patch) store.updateRunMessage(change.patch.id, change.patch.value);
        db.prepare('UPDATE projects SET title = ?, updated_at = ? WHERE id = ?').run(session.name, session.updatedAt, session.id);
      });
      return;
    }
    // Compatibility for legacy file-only installations; the app supplies the shared store.
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `${this.validId(session.id)}.${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 }); await rename(temporary, join(this.directory, `${session.id}.json`)); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
  private async lock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.validId(id); if (this.locks.has(id)) throw busy(); this.locks.add(id);
    try { return await operation(); } finally { this.locks.delete(id); }
  }
}
function busy() { return new MapDraftError('PROJECT_NOT_READY', 'An editing operation is already running.'); }
