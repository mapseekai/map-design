import {
  assertMapDesignStyleResourceUrls,
  assertMapDesignTransactionResourceUrls,
  type MapStudioEventRecord,
} from '@mapseekai/map-design-contracts';
import {
  applyStyleDocumentOrUrlToMap,
  applyTransactionToMap,
  hashStyle,
  type MapStyleApplyResult,
} from 'maplibre-style-tools/maplibre';
import { prepareMapStyleForRuntime } from './runtime-style';
import { hashMapDesignStyle } from './map-design-style-hash';

export interface LiveDraftContext {
  draftRevision: number;
  styleHash: string;
}

export interface CanonicalDraft {
  context: LiveDraftContext;
  style: unknown;
}

export interface LiveDraftSnapshot extends LiveDraftContext {
  sequence?: number;
}

export interface LiveDraftControllerOptions {
  map: unknown;
  projectId: string;
  initialContext: LiveDraftContext & { sequence?: number };
  loadCanonical: (reason: string, signal: AbortSignal) => Promise<CanonicalDraft>;
  applyTransaction?: (map: unknown, transaction: unknown, options: {
    timeoutMs: number;
    hashStyle: typeof hashStyle;
    deadline: { expiresAt: number; signal: AbortSignal };
  }) => Promise<MapStyleApplyResult>;
  hashStyle?: (style: any) => Promise<string>;
  applyCanonicalStyle?: (map: unknown, style: any, options: {
    timeoutMs: number;
    hashStyle: typeof hashStyle;
    deadline: { expiresAt: number; signal: AbortSignal };
  }) => Promise<unknown>;
  transactionTimeoutMs?: number;
}

export class LiveDraftController {
  readonly #map: unknown;
  readonly #projectId: string;
  readonly #loadCanonical: LiveDraftControllerOptions['loadCanonical'];
  readonly #applyTransaction: NonNullable<LiveDraftControllerOptions['applyTransaction']>;
  readonly #hashStyle: NonNullable<LiveDraftControllerOptions['hashStyle']>;
  readonly #mapHashStyle: NonNullable<LiveDraftControllerOptions['hashStyle']>;
  readonly #applyCanonicalStyle: NonNullable<LiveDraftControllerOptions['applyCanonicalStyle']>;
  readonly #timeoutMs: number;
  #state: LiveDraftSnapshot;
  #tail = Promise.resolve();
  #closed = false;
  #generation = 0;
  readonly #abortControllers = new Set<AbortController>();

  constructor(options: LiveDraftControllerOptions) {
    this.#map = options.map;
    this.#projectId = options.projectId;
    this.#loadCanonical = options.loadCanonical;
    this.#applyTransaction = options.applyTransaction ?? ((map, transaction, applyOptions) =>
      applyTransactionToMap(map as Parameters<typeof applyTransactionToMap>[0], transaction, applyOptions));
    this.#hashStyle = options.hashStyle ?? hashStyle;
    this.#mapHashStyle = options.hashStyle ?? ((style) => hashMapDesignStyle(style, this.#projectId, resourceOptions()));
    this.#applyCanonicalStyle = options.applyCanonicalStyle ?? ((map, style, applyOptions) =>
      applyStyleDocumentOrUrlToMap(map as Parameters<typeof applyStyleDocumentOrUrlToMap>[0], style, applyOptions));
    this.#timeoutMs = options.transactionTimeoutMs ?? 5_000;
    this.#state = { ...options.initialContext };
  }

  snapshot(): LiveDraftSnapshot {
    return { ...this.#state };
  }

  handleRecord(record: MapStudioEventRecord): Promise<void> {
    return this.#enqueue((generation) => this.#handleRecord(record, generation));
  }

  handleGap(gap: { oldestAvailableSequence?: number | null; latestSequence?: number | null }): Promise<void> {
    return this.#enqueue((generation) => this.#reload('event-gap', gap.latestSequence ?? undefined, generation));
  }

  reload(reason = 'manual'): Promise<void> {
    return this.#enqueue((generation) => this.#reload(reason, undefined, generation));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    for (const controller of this.#abortControllers) controller.abort();
    this.#abortControllers.clear();
  }

  #enqueue(work: (generation: number) => Promise<void>): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const generation = this.#generation;
    const task = this.#tail.then(() => this.#active(generation) ? work(generation) : undefined);
    this.#tail = task.catch(() => {});
    return task;
  }

  async #handleRecord(record: MapStudioEventRecord, generation: number): Promise<void> {
    if (this.#state.sequence !== undefined && record.sequence <= this.#state.sequence) {
      await this.#reload(record.sequence === this.#state.sequence ? 'duplicate-event' : 'out-of-order-event', undefined, generation);
      return;
    }
    const event = record.event;
    if (event.type === 'draft.updated') {
      if (event.payload.draftRevision === this.#state.draftRevision
        && event.payload.styleHash === this.#state.styleHash) {
        this.#state = { ...this.#state, sequence: record.sequence };
        return;
      }
      if (event.payload.draftRevision !== this.#state.draftRevision + 1) {
        await this.#reload('event-gap', record.sequence, generation);
        return;
      }
      try {
        assertMapDesignTransactionResourceUrls(event.payload.transaction, this.#projectId, resourceOptions());
      } catch {
        await this.#reload('unsafe-style-resource', record.sequence, generation);
        return;
      }
      let result: MapStyleApplyResult;
      const operation = this.#operation(generation);
      try {
        result = await this.#applyTransaction(this.#map, event.payload.transaction, {
          timeoutMs: this.#timeoutMs,
          hashStyle: this.#mapHashStyle,
          deadline: operation.deadline,
        });
      } catch {
        if (this.#active(generation)) await this.#reload('adapter-timeout', record.sequence, generation);
        return;
      } finally {
        operation.release();
      }
      if (!this.#active(generation)) return;
      if (!result.ok || result.styleAuthority !== 'current' || !result.applied) {
        await this.#reload(result.ok ? 'adapter-conflict' : result.error.code === 'TIMEOUT' ? 'adapter-timeout' : 'adapter-conflict', record.sequence, generation);
        return;
      }
      try {
        assertMapDesignStyleResourceUrls(result.style, this.#projectId, resourceOptions());
      } catch {
        await this.#reload('unsafe-style-resource', record.sequence, generation);
        return;
      }
      let actualHash: string;
      try { actualHash = await this.#mapHashStyle(result.style); } catch {
        await this.#reload('hash-mismatch', record.sequence, generation);
        return;
      }
      if (!this.#active(generation)) return;
      if (actualHash !== event.payload.styleHash) {
        await this.#reload('hash-mismatch', record.sequence, generation);
        return;
      }
      this.#state = {
        draftRevision: event.payload.draftRevision,
        styleHash: event.payload.styleHash,
        sequence: record.sequence,
      };
      return;
    }
    if (event.type === 'draft.reloaded' || event.type === 'draft.discarded' || event.type === 'revision.committed') {
      await this.#reload(event.type, record.sequence, generation);
      return;
    }
    if (this.#active(generation)) this.#state = { ...this.#state, sequence: record.sequence };
  }

  async #reload(reason: string, sequence: number | undefined, generation: number): Promise<void> {
    if (!this.#active(generation)) return;
    const operation = this.#operation(generation);
    try {
      const canonical = await this.#loadCanonical(reason, operation.deadline.signal);
      if (!this.#active(generation)) return;
      assertMapDesignStyleResourceUrls(canonical.style, this.#projectId, resourceOptions());
      const actualHash = await this.#hashStyle(canonical.style);
      if (!this.#active(generation)) return;
      if (actualHash !== canonical.context.styleHash) throw new TypeError('Canonical MapDesign Style hash mismatch.');
      const applied = await this.#applyCanonicalStyle(this.#map, prepareMapStyleForRuntime(canonical.style, this.#projectId, resourceOptions()), {
        timeoutMs: this.#timeoutMs,
        hashStyle: this.#mapHashStyle,
        deadline: operation.deadline,
      });
      if (!this.#active(generation)) return;
      if (applied && typeof applied === 'object' && 'ok' in applied && applied.ok === false) {
        throw new TypeError('Canonical MapDesign Style reload failed.');
      }
      this.#state = {
        draftRevision: canonical.context.draftRevision,
        styleHash: canonical.context.styleHash,
        sequence: sequence ?? this.#state.sequence,
      };
    } finally {
      operation.release();
    }
  }

  #operation(generation: number): {
    deadline: { expiresAt: number; signal: AbortSignal };
    release: () => void;
  } {
    const controller = new AbortController();
    if (!this.#active(generation)) controller.abort();
    this.#abortControllers.add(controller);
    const timeout = globalThis.setTimeout(() => {
      controller.abort(new DOMException('MapDesign operation timed out.', 'TimeoutError'));
    }, this.#timeoutMs);
    let released = false;
    return {
      deadline: { expiresAt: Date.now() + this.#timeoutMs, signal: controller.signal },
      release: () => {
        if (released) return;
        released = true;
        globalThis.clearTimeout(timeout);
        this.#abortControllers.delete(controller);
      },
    };
  }

  #active(generation: number): boolean {
    return !this.#closed && this.#generation === generation;
  }
}

function resourceOptions(): { origin?: string } {
  return typeof globalThis.location?.origin === 'string'
    ? { origin: globalThis.location.origin }
    : {};
}
