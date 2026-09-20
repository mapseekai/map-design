import type { MapStudioEvent, MapToolName } from '@mapseekai/map-design-contracts';
import type Database from 'better-sqlite3';

import type { MapDesignEventOutbox } from './event-outbox.js';

export type MapDesignMutationActor =
  | { kind: 'run'; runId: string }
  | { kind: 'ui'; requestId: string };

interface MapDraftUpdatedEnvelopeBase {
  projectId: string;
  idempotencyKey: string;
  requestDigest: string;
  operation: Extract<MapToolName, 'map_apply_transaction' | 'map_update_semantics'>;
  event: Extract<MapStudioEvent, { type: 'draft.updated' }>;
}

export type MapDraftUpdatedEnvelope = MapDraftUpdatedEnvelopeBase & (
  | { actor: Extract<MapDesignMutationActor, { kind: 'run' }>; runId: string }
  | { actor: Extract<MapDesignMutationActor, { kind: 'ui' }>; requestId: string }
);

export interface MapDraftEventBus {
  appendInTransaction?(db: Database.Database, projectId: string, event: MapStudioEvent): number;
  publish(envelope: MapDraftUpdatedEnvelope): Promise<void> | void;
}

export interface MapStudioEventPublisher {
  publish(projectId: string, sequence: number, event: MapStudioEvent): Promise<void> | void;
  subscribe?(projectId: string, listener: MapStudioEventListener): () => void;
}

export type MapStudioEventListener = (record: { sequence: number; event: MapStudioEvent }) => void;

export class InMemoryMapStudioEventPublisher implements MapStudioEventPublisher {
  readonly events: Array<{ projectId: string; sequence: number; event: MapStudioEvent }> = [];
  readonly #listeners = new Map<string, Set<MapStudioEventListener>>();

  publish(projectId: string, sequence: number, event: MapStudioEvent): void {
    this.events.push({ projectId, sequence, event });
    if (this.events.length > 10_000) this.events.splice(0, this.events.length - 10_000);
    for (const listener of this.#listeners.get(projectId) ?? []) {
      try { listener({ sequence, event }); } catch { /* Durable outbox delivery must not depend on live clients. */ }
    }
  }

  subscribe(projectId: string, listener: MapStudioEventListener): () => void {
    const listeners = this.#listeners.get(projectId) ?? new Set<MapStudioEventListener>();
    listeners.add(listener);
    this.#listeners.set(projectId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(projectId);
    };
  }
}

export class MapDesignOutboxEventBus {
  constructor(private readonly outbox: Pick<MapDesignEventOutbox, 'appendInTransaction' | 'drainPending'>) {}

  appendInTransaction(db: Database.Database, projectId: string, event: MapStudioEvent): number {
    return this.outbox.appendInTransaction(db, projectId, event);
  }

  publish(): Promise<void> {
    return this.outbox.drainPending();
  }
}

/** Useful at composition boundaries that do not yet have an SSE/outbox publisher. */
export class InMemoryMapDraftEventBus implements MapDraftEventBus {
  readonly events: MapDraftUpdatedEnvelope[] = [];

  publish(envelope: MapDraftUpdatedEnvelope): void {
    this.events.push(envelope);
  }
}
