import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { MapIdentifierSchema, MapStudioEventRecordSchema, MapStudioEventReplaySchema } from '@mapseekai/map-design-contracts';

import { isMapDraftError } from '../application/errors.js';
import type { MapDesignEventOutbox } from '../application/event-outbox.js';
import type { MapStudioEventPublisher } from '../application/event-bus.js';

const EVENT_ROUTE = '/api/map-design/projects/:projectId/events';
const HEARTBEAT_MS = 25_000;
const MAX_PENDING_EVENTS = 1_000;

export interface CreateMapDesignEventStreamRouterDependencies {
  outbox: Pick<MapDesignEventOutbox, 'listAfter'>;
  publisher: MapStudioEventPublisher;
  requireLocalDaemonRequest: RequestHandler;
  projectReader: { getProject(projectId: string): Promise<unknown> };
  scheduleHeartbeat?: (callback: () => void, milliseconds: number) => () => void;
}

export function createMapDesignEventStreamRouter(deps: CreateMapDesignEventStreamRouterDependencies): Router {
  const router = Router();
  router.use(EVENT_ROUTE, deps.requireLocalDaemonRequest);
  router.use(EVENT_ROUTE, (request, response, next) => {
    const projectId = MapIdentifierSchema.safeParse(request.params.projectId);
    if (!projectId.success) {
      response.status(400).json({ code: 'INVALID_INPUT', message: 'Invalid map project.', retryable: false });
      return;
    }
    void deps.projectReader.getProject(projectId.data).then(() => next()).catch(next);
  });
  router.get(EVENT_ROUTE, (request, response) => {
    const projectId = MapIdentifierSchema.parse(request.params.projectId);
    const cursor = readCursor(request.headers['last-event-id'], request.query.after);
    if (!cursor) {
      response.status(400).json({ code: 'INVALID_INPUT', message: 'Invalid event cursor.', retryable: false });
      return;
    }
    response.status(200);
    response.set({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.flushHeaders();
    let closed = false;
    let replaying = true;
    let lastSequence = cursor.sequence;
    const pending: Array<{ sequence: number; event: unknown }> = [];
    let unsubscribe = () => {};
    let stopHeartbeat = () => {};
    const cleanup = () => {
      if (closed) return;
      closed = true;
      stopHeartbeat();
      unsubscribe();
    };
    const terminate = () => {
      cleanup();
      try { response.destroy(); } catch { /* Transport is already terminal. */ }
    };
    const write = (value: string): boolean => {
      if (closed) return false;
      try {
        if (response.write(value)) return true;
      } catch {
        // A broken transport follows the same terminal path as explicit backpressure.
      }
      terminate();
      return false;
    };
    const subscribedUnsubscribe = deps.publisher.subscribe?.(projectId, (record) => {
      if (closed || record.sequence <= lastSequence) return;
      if (replaying) {
        if (pending.length >= MAX_PENDING_EVENTS) terminate();
        else pending.push(record);
        return;
      }
      if (writeRecord(write, record)) lastSequence = record.sequence;
    }) ?? (() => {});
    unsubscribe = subscribedUnsubscribe;
    if (closed) subscribedUnsubscribe();
    const scheduledStop = (deps.scheduleHeartbeat ?? defaultHeartbeat)(() => {
      write(': heartbeat\n\n');
    }, HEARTBEAT_MS);
    stopHeartbeat = scheduledStop;
    if (closed) scheduledStop();
    request.once('close', cleanup);
    response.once('close', cleanup);

    if (cursor.initial) {
      const snapshot = deps.outbox.listAfter(projectId, 0, 1);
      if (snapshot.latestSequence !== null) {
        const gap = replayGap(snapshot.oldestAvailableSequence, snapshot.latestSequence);
        if (writeEvent(write, 'map-design-gap', gap, snapshot.latestSequence)) {
          lastSequence = snapshot.latestSequence;
        }
      }
    } else for (;;) {
      const replay = deps.outbox.listAfter(projectId, lastSequence, 1_000);
      if (replay.gap || (replay.latestSequence !== null && lastSequence > replay.latestSequence)
        || (replay.latestSequence === null && lastSequence > 0)) {
        const gap = replayGap(replay.oldestAvailableSequence, replay.latestSequence);
        const recoverySequence = replay.latestSequence ?? 0;
        if (writeEvent(write, 'map-design-gap', gap, recoverySequence)) lastSequence = recoverySequence;
        break;
      }
      for (const record of replay.events) {
        if (record.sequence <= lastSequence) continue;
        if (!writeRecord(write, record)) break;
        lastSequence = record.sequence;
      }
      if (closed) break;
      if (replay.events.length < 1_000 || replay.latestSequence === null || lastSequence >= replay.latestSequence) break;
    }
    if (closed) return;
    replaying = false;
    pending.sort((left, right) => left.sequence - right.sequence);
    for (const record of pending) {
      if (record.sequence <= lastSequence) continue;
      if (!writeRecord(write, record)) break;
      lastSequence = record.sequence;
    }
  });
  router.use(EVENT_ROUTE, (error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) { next(error); return; }
    if (isMapDraftError(error) && error.code === 'NOT_FOUND') {
      response.status(404).json({ code: error.code, message: error.message, retryable: error.retryable });
      return;
    }
    response.status(500).json({ code: 'INTERNAL', message: 'The map event stream could not be opened.', retryable: false });
  });
  return router;
}

function writeRecord(write: (value: string) => boolean, record: { sequence: number; event: unknown }): boolean {
  const parsed = MapStudioEventRecordSchema.parse(record);
  return write(`id: ${parsed.sequence}\nevent: map-design-event\ndata: ${JSON.stringify(parsed)}\n\n`);
}

function writeEvent(write: (value: string) => boolean, name: string, data: unknown, sequence?: number): boolean {
  return write(`${sequence === undefined ? '' : `id: ${sequence}\n`}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function readCursor(
  header: string | string[] | undefined,
  query: unknown,
): { sequence: number; initial: boolean } | null {
  const headerValue = Array.isArray(header) ? header[0] : header;
  const initial = headerValue === undefined && query === undefined;
  const raw = headerValue ?? (initial ? '0' : typeof query === 'string' ? query : null);
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? { sequence: value, initial } : null;
}

function replayGap(oldestAvailableSequence: number | null, latestSequence: number | null) {
  return MapStudioEventReplaySchema.parse({
    events: [], oldestAvailableSequence, latestSequence, gap: true,
  });
}

function defaultHeartbeat(callback: () => void, milliseconds: number): () => void {
  const timer = setInterval(callback, milliseconds);
  timer.unref?.();
  return () => clearInterval(timer);
}
