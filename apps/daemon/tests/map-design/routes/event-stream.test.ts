import express from 'express';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MapStudioEvent } from '@mapseekai/map-design-contracts';

import { InMemoryMapStudioEventPublisher } from '../../../src/map-design/application/event-bus.js';
import { createMapDesignEventStreamRouter } from '../../../src/map-design/routes/event-stream.js';
import { MapDraftError } from '../../../src/map-design/application/errors.js';


const PROJECT_ID = 'project-events';
const EVENT: MapStudioEvent = {
  type: 'project.lifecycle.updated',
  occurredAt: '2026-08-15T00:00:00.000Z',
  payload: { lifecycle: 'ready', failure: null },
};
let server: Server | undefined;

describe('MapDesign event stream', () => {
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('keeps publishing after request completion and releases the subscription on response disconnect', async () => {
    let live: ((record: { sequence: number; event: MapStudioEvent }) => void) | undefined;
    let responseOnServer: express.Response | undefined;
    const unsubscribe = vi.fn();
    const stopHeartbeat = vi.fn();
    const { url } = await listen(createMapDesignEventStreamRouter({
      outbox: { listAfter: () => ({ events: [], oldestAvailableSequence: null, latestSequence: null, gap: false }) },
      publisher: {
        publish: vi.fn(),
        subscribe: (_projectId, listener) => { live = listener; return unsubscribe; },
      },
      projectReader: { getProject: async () => ({}) },
      requireLocalDaemonRequest: (_request, _response, next) => next(),
      scheduleHeartbeat: (callback) => { queueMicrotask(callback); return stopHeartbeat; },
    }), (response) => { responseOnServer = response; });
    const abort = new AbortController();
    try {
      const response = await fetch(`${url}/api/map-design/projects/${PROJECT_ID}/events`, { signal: abort.signal });
      // Consume the incoming GET independently of the still-open SSE response.
      responseOnServer!.req.resume();
      await vi.waitFor(() => expect(responseOnServer!.req.destroyed).toBe(true));
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(stopHeartbeat).not.toHaveBeenCalled();
      live?.({ sequence: 1, event: EVENT });
      expect(await readUntil(response, (text) => text.includes('id: 1'))).toContain('project.lifecycle.updated');
      abort.abort();
      await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
      expect(stopHeartbeat).toHaveBeenCalledOnce();
    } finally {
      abort.abort();
    }
  });

  it('authorizes navigation query identity and replays the durable outbox from Last-Event-ID', async () => {
    const publisher = new InMemoryMapStudioEventPublisher();
    const listAfter = vi.fn(() => ({
      events: [{ sequence: 8, event: EVENT }],
      oldestAvailableSequence: 8,
      latestSequence: 8,
      gap: false,
    }));
    const projectReader = { getProject: vi.fn(async () => ({})) };
    const { url } = await listen(createMapDesignEventStreamRouter({
      outbox: { listAfter },
      publisher,
      requireLocalDaemonRequest: (_request, _response, next) => next(),
      projectReader,
      scheduleHeartbeat: () => () => {},
    }));

    const abort = new AbortController();
    const response = await fetch(`${url}/api/map-design/projects/${PROJECT_ID}/events?workspaceId=workspace-a&workspaceMemberId=member-a`, {
      headers: { 'Last-Event-ID': '7' },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const text = await readUntil(response, (value) => value.includes('id: 8'));
    abort.abort();

    expect(listAfter).toHaveBeenCalledWith(PROJECT_ID, 7, 1_000);
    expect(projectReader.getProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(text).toContain('event: map-design-event');
    expect(text).toContain('"sequence":8');
  });
  it('keeps workspace headers inert and returns a safe local not-found response', async () => {
    const missing = await listen(createMapDesignEventStreamRouter({
      outbox: { listAfter: vi.fn() },
      publisher: new InMemoryMapStudioEventPublisher(),
      projectReader: { getProject: async () => { throw new MapDraftError('NOT_FOUND', 'The map project was not found.'); } },
      requireLocalDaemonRequest: (_request, _response, next) => next(),
      scheduleHeartbeat: () => () => {},
    }));
    const missingResponse = await fetch(`${missing.url}/api/map-design/projects/${PROJECT_ID}/events?workspaceId=ignored`);
    expect(missingResponse.status).toBe(404);
  });


  it('uses durable replay after a publisher restart, reports retention gaps, and emits heartbeats', async () => {
    let heartbeat: (() => void) | undefined;
    const { url } = await listen(createMapDesignEventStreamRouter({
      outbox: {
        listAfter: vi.fn(() => ({
          events: [{ sequence: 21, event: EVENT }],
          oldestAvailableSequence: 21,
          latestSequence: 21,
          gap: true,
        })),
      },
      publisher: new InMemoryMapStudioEventPublisher(),
      requireLocalDaemonRequest: (_request, _response, next) => next(),
      projectReader: { getProject: async () => ({}) },
      scheduleHeartbeat: (callback) => {
        heartbeat = callback;
        queueMicrotask(callback);
        return () => { heartbeat = undefined; };
      },
    }));

    const abort = new AbortController();
    const response = await fetch(`${url}/api/map-design/projects/${PROJECT_ID}/events?after=4`, { signal: abort.signal });
    const text = await readUntil(response, (value) => value.includes(': heartbeat'));
    abort.abort();
    expect(text).toContain('event: map-design-gap');
    expect(text).toContain('"oldestAvailableSequence":21');
    expect(text).toContain('id: 21');
    expect(heartbeat).toBeTypeOf('function');
  });

  it('delivers live fanout without making it the replay source', async () => {
    const publisher = new InMemoryMapStudioEventPublisher();
    const listAfter = vi.fn(() => ({ events: [], oldestAvailableSequence: null, latestSequence: null, gap: false }));
    const { url } = await listen(createMapDesignEventStreamRouter({
      outbox: { listAfter },
      publisher,
      requireLocalDaemonRequest: (_request, _response, next) => next(),
      projectReader: { getProject: async () => ({}) },
      scheduleHeartbeat: () => () => {},
    }));
    const abort = new AbortController();
    const response = await fetch(`${url}/api/map-design/projects/${PROJECT_ID}/events`, { signal: abort.signal });
    await publisher.publish(PROJECT_ID, 34, EVENT);
    const text = await readUntil(response, (value) => value.includes('id: 34'));
    abort.abort();
    expect(text).toContain('"sequence":34');
    expect(listAfter).toHaveBeenCalledTimes(1);
  });

  it('uses one initial gap snapshot instead of replaying retained history event by event', async () => {
    const listAfter = vi.fn(() => ({
      events: [{ sequence: 1, event: EVENT }],
      oldestAvailableSequence: 1,
      latestSequence: 10_000,
      gap: false,
    }));
    const { url } = await listen(createMapDesignEventStreamRouter({
      outbox: { listAfter },
      publisher: new InMemoryMapStudioEventPublisher(),
      requireLocalDaemonRequest: (_request, _response, next) => next(),
      projectReader: { getProject: async () => ({}) },
      scheduleHeartbeat: () => () => {},
    }));
    const abort = new AbortController();
    const response = await fetch(`${url}/api/map-design/projects/${PROJECT_ID}/events`, { signal: abort.signal });
    const text = await readUntil(response, (value) => value.includes('event: map-design-gap') || value.includes('event: map-design-event'));
    abort.abort();

    expect(text).toContain('event: map-design-gap');
    expect(text).toContain('id: 10000');
    expect(text).not.toContain('event: map-design-event');
    expect(listAfter).toHaveBeenCalledTimes(1);
  });

  it('turns a forged future cursor into a resumable gap at the durable latest sequence', async () => {
    const listAfter = vi.fn(() => ({
      events: [], oldestAvailableSequence: 3, latestSequence: 8, gap: false,
    }));
    const { url } = await listen(createMapDesignEventStreamRouter({
      outbox: { listAfter },
      publisher: new InMemoryMapStudioEventPublisher(),
      requireLocalDaemonRequest: (_request, _response, next) => next(),
      projectReader: { getProject: async () => ({}) },
      scheduleHeartbeat: (callback) => { queueMicrotask(callback); return () => {}; },
    }));
    const abort = new AbortController();
    const response = await fetch(`${url}/api/map-design/projects/${PROJECT_ID}/events?after=999`, { signal: abort.signal });
    const text = await readUntil(response, (value) => value.includes('event: map-design-gap') || value.includes(': heartbeat'));
    abort.abort();

    expect(text).toContain('event: map-design-gap');
    expect(text).toContain('id: 8');
  });

  it.each(['replay', 'live', 'heartbeat'] as const)(
    'immediately tears down the stream when %s hits response backpressure',
    async (path) => {
      let live: ((record: { sequence: number; event: MapStudioEvent }) => void) | undefined;
      let heartbeat: (() => void) | undefined;
      const unsubscribe = vi.fn();
      const stopHeartbeat = vi.fn();
      const publisher = {
        publish: vi.fn(),
        subscribe: vi.fn((_projectId: string, listener: typeof live) => {
          live = listener;
          return unsubscribe;
        }),
      };
      const router = createMapDesignEventStreamRouter({
        outbox: {
          listAfter: vi.fn(() => ({
            events: path === 'replay' ? [{ sequence: 1, event: EVENT }] : [],
            oldestAvailableSequence: path === 'replay' ? 1 : null,
            latestSequence: path === 'replay' ? 1 : null,
            gap: false,
          })),
        },
        publisher,
        requireLocalDaemonRequest: (_request, _response, next) => next(),
        projectReader: { getProject: async () => ({}) },
        scheduleHeartbeat: (callback) => {
          heartbeat = callback;
          return stopHeartbeat;
        },
      });
      let observedResponse: express.Response | undefined;
      let markSeen!: () => void;
      const seen = new Promise<void>((resolve) => { markSeen = resolve; });
      const { url } = await listen(router, (response) => {
        observedResponse = response;
        response.write = vi.fn(() => false) as unknown as typeof response.write;
        markSeen();
      });
      const client = httpRequest(`${url}/api/map-design/projects/${PROJECT_ID}/events`);
      client.on('error', () => {});
      client.end();
      await seen;
      await vi.waitFor(() => expect(publisher.subscribe).toHaveBeenCalledTimes(1));
      if (path === 'live') live?.({ sequence: 2, event: EVENT });
      if (path === 'heartbeat') heartbeat?.();
      try {
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1), { timeout: 100 });
        expect(stopHeartbeat).toHaveBeenCalledTimes(1);
        expect(observedResponse?.destroyed).toBe(true);
      } finally {
        client.destroy();
        observedResponse?.destroy();
      }
    },
  );
});

async function listen(
  router: express.Router,
  observeResponse?: (response: express.Response) => void,
): Promise<{ url: string }> {
  const app = express();
  if (observeResponse) app.use((_request, response, next) => { observeResponse(response); next(); });
  app.use(router);
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new TypeError('missing test port');
  return { url: `http://127.0.0.1:${address.port}` };
}

async function readUntil(response: Response, done: (value: string) => boolean): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError('missing response stream');
  const decoder = new TextDecoder();
  let value = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return value;
    value += decoder.decode(chunk.value, { stream: true });
    if (done(value)) return value;
  }
}
