import { once } from 'node:events';
import express, { type Express } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { MapDesignRunEvent } from '@mapseekai/contracts';

import { requireLocalDaemonRequest } from '../../../src/http/local-daemon-request.js';
import { MapDraftError } from '../../../src/map-design/application/errors.js';
import { MapDesignProjectRunConflictError, MapDesignRunConflictError, MapDesignRunRequestError } from '../../../src/map-design/application/run-service.js';
import { createMapDesignRunRouter } from '../../../src/map-design/routes/run-routes.js';
type CancelResult = { runId: string; status: 'canceled' } | { runId: string; projectId: string; conversationId: string; status: 'succeeded' };

const validStartRequest = {
  projectId: 'map-1',
  conversationId: 'conversation-1',
  prompt: 'Improve labels.',
  runtimeRevision: 3,
  clientRequestId: 'request-1',
  userMessageId: 'user-1',
  assistantMessageId: 'assistant-1',
};


function setup() {
  const runs = {
    start: vi.fn(async () => ({ runId: 'run-1', projectId: 'map-1', conversationId: 'conversation-1', status: 'running' as const, startedAt: '2026-08-25T00:00:00.000Z' })),
    get: vi.fn((runId: string) => runId === 'run-1' ? ({ runId, projectId: 'map-1', conversationId: 'conversation-1', status: 'succeeded' as const }) : null),
    cancel: vi.fn<(runId: string) => Promise<CancelResult | null>>(async (runId: string) => runId === 'run-1' ? ({ runId, status: 'canceled' }) : null),
    subscribe: vi.fn((_runId: string, listener: (event: MapDesignRunEvent) => void) => { listener({ type: 'run_finished', run: { runId: 'run-1', projectId: 'map-1', conversationId: 'conversation-1', status: 'succeeded' } }); return vi.fn(); }),
  };
  const app: Express = express();
  app.use(createMapDesignRunRouter({ runService: runs, requireLocalDaemonRequest }));
  return { app, runs };
}

async function request(app: Express, route: string, init: RequestInit = {}) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not listen');
  try { return await fetch(`http://127.0.0.1:${address.port}${route}`, init); }
  finally { const closed = once(server, 'close'); server.close(); await closed; }
}

describe('MapDesign run routes', () => {
  it('starts, reads, cancels, and streams scoped run events', async () => {
    const { app, runs } = setup();
    const requestBody = validStartRequest;
    const start = await request(app, '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody) });
    expect(start.status).toBe(202);
    expect(await start.json()).toMatchObject({ runId: 'run-1' });
    expect(runs.start).toHaveBeenCalledWith(requestBody);
    expect((await request(app, '/api/runs/run-1')).status).toBe(200);
    expect((await request(app, '/api/runs/run-1/cancel', { method: 'POST' })).status).toBe(200);
    const events = await request(app, '/api/runs/run-1/events');
    expect(events.status).toBe(200);
    expect(await events.text()).toContain('event: run_finished');
    expect(runs.subscribe).toHaveBeenCalledWith('run-1', expect.any(Function));
  });

  it('passes the schema-normalized request once and maps oversized JSON to 413', async () => {
    const { app, runs } = setup();
    const normalized = await request(app, '/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...validStartRequest,
        projectId: '  map-1  ',
        conversationId: '  conversation-1  ',
        prompt: '  Improve labels.  ',
        locale: '  zh-CN  ',
        clientRequestId: '  request-1  ',
        userMessageId: '  user-1  ',
        assistantMessageId: '  assistant-1  ',
      }),
    });

    expect(normalized.status).toBe(202);
    expect(runs.start).toHaveBeenCalledWith({
      ...validStartRequest,
      locale: 'zh-CN',
    });

    runs.start.mockClear();
    const oversized = await request(app, '/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validStartRequest, prompt: 'x'.repeat(70_000) }),
    });

    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'The map run request is too large.',
      },
    });
    expect(runs.start).not.toHaveBeenCalled();
  });

  it.each([
    { agentId: 'opencode' },
    { model: 'client-model' },
    { reasoning: 'high' },
    { serviceTier: 'priority' },
    { byokProvider: { protocol: 'openai', apiKey: 'key', model: 'nested-client-model' } },
  ])('rejects legacy client runtime authority before starting (%j)', async (legacy) => {
    const { app, runs } = setup();
    const response = await request(app, '/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'map-1',
        conversationId: 'conversation-1',
        prompt: 'Improve labels.',
        runtimeRevision: 3,
        clientRequestId: 'request-1',
        userMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        ...legacy,
      }),
    });

    expect(response.status).toBe(400);
    expect(runs.start).not.toHaveBeenCalled();
  });

  it('rejects malformed identifiers and preserves not found semantics', async () => {
    const { app } = setup();
    expect((await request(app, `/api/runs/${'x'.repeat(257)}`)).status).toBe(400);
    expect((await request(app, '/api/runs/missing')).status).toBe(404);
    expect((await request(app, '/api/runs/missing/cancel', { method: 'POST' })).status).toBe(404);
  });
  it('reports terminal conflicts and only classifies known request errors as 400', async () => {
    const { app, runs } = setup();
    runs.cancel.mockResolvedValueOnce({ runId: 'run-1', projectId: 'map-1', conversationId: 'conversation-1', status: 'succeeded' as const });
    expect((await request(app, '/api/runs/run-1/cancel', { method: 'POST' })).status).toBe(409);

    runs.start.mockRejectedValueOnce(new MapDesignRunRequestError('bad request'));
    expect((await request(app, '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validStartRequest) })).status).toBe(400);

    runs.start.mockRejectedValueOnce(new SyntaxError('persisted JSON unavailable'));
    const syntaxFailure = await request(app, '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validStartRequest) });
    expect(syntaxFailure.status).toBe(500);

    runs.start.mockRejectedValueOnce(new MapDesignRunConflictError('client request conflict'));
    const clientConflict = await request(app, '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validStartRequest) });
    expect(clientConflict.status).toBe(409);
    expect(await clientConflict.json()).toEqual({ error: { code: 'CONFLICT', message: 'The client request identifier conflicts with an existing run.' } });

    runs.start.mockRejectedValueOnce(new MapDesignProjectRunConflictError('project run conflict'));
    const projectConflict = await request(app, '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...validStartRequest, clientRequestId: 'request-2', userMessageId: 'user-2', assistantMessageId: 'assistant-2' }) });
    expect(projectConflict.status).toBe(409);
    expect(await projectConflict.json()).toEqual({ error: { code: 'CONFLICT', message: 'Another run is already active for this project.' } });

    runs.start.mockRejectedValueOnce(new MapDraftError('RUNTIME_CONFLICT', 'The conversation runtime changed in another client.', {
      retryable: true,
      details: { currentRuntime: { agentId: 'codex', model: 'gpt-5.4', revision: 4, updatedAt: '2026-09-02T00:00:00.000Z' } },
    }));
    const runtimeConflict = await request(app, '/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validStartRequest),
    });
    expect(runtimeConflict.status).toBe(409);
    expect(await runtimeConflict.json()).toMatchObject({
      error: {
        code: 'RUNTIME_CONFLICT',
        retryable: true,
        details: { currentRuntime: { agentId: 'codex', revision: 4 } },
      },
    });

    const malformed = await request(app, '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(malformed.status).toBe(400);
  });

  it.each([null, false, '', 0, [], {}, { protocol: 'openai', apiKey: 1 }, { protocol: 'invalid', apiKey: 'key' }])('rejects an explicitly malformed BYOK provider before starting (%j)', async (byokProvider) => {
    const { app, runs } = setup();
    const response = await request(app, '/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validStartRequest, byokProvider }),
    });

    expect(response.status).toBe(400);
    expect(runs.start).not.toHaveBeenCalled();
  });
  it('rejects unknown and malformed optional run fields before starting', async () => {
    const { app, runs } = setup();
    const base = validStartRequest;
    for (const value of [{ ...base, unexpected: true }, { ...base, model: { name: 'bad' } }, { ...base, locale: 'x'.repeat(257) }]) {
      expect((await request(app, '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })).status).toBe(400);
    }
    expect(runs.start).not.toHaveBeenCalled();
  });

  it('validates viewedRevision as a non-negative safe integer and rejects historical-mode starts', async () => {
    const { app, runs } = setup();
    const base = validStartRequest;
    for (const viewedRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      const response = await request(app, '/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...base, viewedRevision }),
      });
      expect(response.status).toBe(400);
    }
    expect(runs.start).not.toHaveBeenCalled();

    runs.start.mockRejectedValueOnce(new MapDesignRunRequestError('Historical map revisions are read-only.'));
    const historical = await request(app, '/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, viewedRevision: 1 }),
    });

    expect(historical.status).toBe(400);
    expect(runs.start).toHaveBeenCalledWith({ ...base, viewedRevision: 1 });
  });

  it('unsubscribes a synchronous terminal replay after subscription returns', async () => {
    const { app, runs } = setup();
    const unsubscribe = vi.fn();
    runs.subscribe.mockImplementationOnce((_runId: string, listener: (event: MapDesignRunEvent) => void) => {
      listener({ type: 'run_finished', run: { runId: 'run-1', projectId: 'map-1', conversationId: 'conversation-1', status: 'succeeded' } });
      return unsubscribe;
    });
    expect((await request(app, '/api/runs/run-1/events')).status).toBe(200);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('replays the terminal event snapshot before message completion and run completion', async () => {
    const { app, runs } = setup();
    runs.subscribe.mockImplementationOnce((_runId: string, listener: (event: MapDesignRunEvent) => void) => {
      listener({
        type: 'event_snapshot',
        runId: 'run-1',
        messageId: 'assistant-1',
        events: [{ kind: 'run_finished', status: 'succeeded' }],
      });
      listener({
        type: 'message_completed',
        runId: 'run-1',
        message: {
          id: 'assistant-1', conversationId: 'conversation-1', role: 'assistant', content: '',
          events: [{ kind: 'run_finished', status: 'succeeded' }], runStatus: 'succeeded',
          startedAt: 1_788_100_000_000, endedAt: 1_788_100_002_000,
        },
      });
      listener({ type: 'run_finished', run: { runId: 'run-1', projectId: 'map-1', conversationId: 'conversation-1', status: 'succeeded' } });
      return vi.fn();
    });

    const response = await request(app, '/api/runs/run-1/events');
    const body = await response.text();

    expect(body.indexOf('event: event_snapshot')).toBeLessThan(body.indexOf('event: message_completed'));
    expect(body.indexOf('event: message_completed')).toBeLessThan(body.indexOf('event: run_finished'));
    expect(body).toContain('"events":[{"kind":"run_finished","status":"succeeded"}]');
  });
});
