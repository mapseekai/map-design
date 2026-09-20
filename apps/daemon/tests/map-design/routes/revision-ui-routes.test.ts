import express, { type Express } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type {
  MapRestoreRevisionInput,
  MapRestoreRevisionOutput,
  MapRevisionSnapshotOutput,
} from '@mapseekai/map-design-contracts';

import { MapDraftError } from '../../../src/map-design/application/errors.js';
import { createMapDesignRevisionUiRouter } from '../../../src/map-design/routes/revision-ui-routes.js';

const NOW = '2026-09-01T00:00:00.000Z';
const DIGEST = 'a'.repeat(64);
const SNAPSHOT: MapRevisionSnapshotOutput = {
  revision: {
    revision: 1,
    draftRevision: 1,
    styleHash: DIGEST,
    sourceDigest: DIGEST,
    semanticDigest: DIGEST,
    designSystemDigest: DIGEST,
    previewId: 'preview-project-a-1',
    attestationDigest: DIGEST,
    committedAt: NOW,
  },
  style: { version: 8, sources: {}, layers: [] },
  semantics: { version: 1, groups: [] },
  validation: {
    draftRevision: 1,
    styleHash: DIGEST,
    validationDigest: DIGEST,
    summary: {
      status: 'valid',
      errors: 0,
      warnings: 0,
      infos: 0,
      totalFindings: 0,
      returnedFindings: 0,
      omittedFindings: 0,
    },
    findings: [],
  },
  inspect: {
    target: { kind: 'root' },
    view: {
      kind: 'root',
      style: { layerCount: 0, sourceCount: 0, layerTypes: [] },
      layers: [],
      sources: [],
    },
    truncated: false,
  },
};

const RESTORE_OUTPUT: MapRestoreRevisionOutput = {
  draftRevision: 8,
  restoredRevision: 1,
  styleHash: DIGEST,
  semanticDigest: DIGEST,
  validationSummary: {
    status: 'valid',
    errors: 0,
    warnings: 0,
    infos: 0,
    totalFindings: 0,
    returnedFindings: 0,
    omittedFindings: 0,
  },
};

function setup(options: { projectRunning?: boolean } = {}) {
  const revisionService = {
    commit: vi.fn(),
    restore: vi.fn(async (_context: unknown, revision: number) => {
      if (revision !== 1) throw new MapDraftError('NOT_FOUND', 'The map revision was not found.');
      return RESTORE_OUTPUT;
    }),
    getSnapshot: vi.fn(async (projectId: string, revision: number) => {
      if (projectId === 'project-a' && revision === 1) return SNAPSHOT;
      if (projectId === 'project-a' && revision === 3) {
        throw new MapDraftError('SOURCE_UNAVAILABLE', 'The historical map revision evidence is unavailable.');
      }
      throw new MapDraftError('NOT_FOUND', 'The map revision was not found.');
    }),
  };
  let projectRunning = options.projectRunning ?? false;
  const isProjectRunning = vi.fn(() => projectRunning);
  const app: Express = express();
  app.use((_request, response, next) => {
    response.locals.requestId = 'request-server-generated';
    next();
  });
  app.use(createMapDesignRevisionUiRouter({
    revisionService,
    isProjectRunning,
    loadPreviewRun: () => null,
    requireLocalDaemonRequest: (_request, _response, next) => next(),
    projectReader: { getProject: async () => ({}) },
  }));
  return {
    app,
    isProjectRunning,
    revisionService,
    setProjectRunning: (running: boolean) => { projectRunning = running; },
  };
}

async function request(app: Express, path: string, init: RequestInit = {}): Promise<Response> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not listen');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, init);
    const body = await response.arrayBuffer();
    return new Response(body, { status: response.status, headers: response.headers });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function restoreInput(overrides: Partial<MapRestoreRevisionInput> = {}): MapRestoreRevisionInput {
  return {
    expectedDraftRevision: 7,
    idempotencyKey: 'restore-route-v1',
    confirmReplaceDraft: true,
    intentSummary: 'Restore revision 1 as a new draft',
    ...overrides,
  };
}

function postRestore(app: Express, input: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return request(app, '/api/map-design/projects/project-a/revisions/1/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(input),
  });
}

describe('MapDesign revision UI routes', () => {
  it('serves the project-scoped immutable revision snapshot', async () => {
    const { app, revisionService } = setup();

    const response = await request(app, '/api/map-design/projects/project-a/revisions/1/snapshot');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SNAPSHOT);
    expect(revisionService.getSnapshot).toHaveBeenCalledWith('project-a', 1);
  });

  it('returns 404 for missing and cross-project revisions', async () => {
    const { app } = setup();

    const statuses = await Promise.all([
      request(app, '/api/map-design/projects/project-a/revisions/999/snapshot'),
      request(app, '/api/map-design/projects/project-a/revisions/2/snapshot'),
    ]);

    expect(statuses.map((response) => response.status)).toEqual([404, 404]);
    await expect(statuses[1]!.json()).resolves.toEqual({
      error: { code: 'NOT_FOUND', message: 'The map revision was not found.', retryable: false },
    });
  });

  it('returns 400 for malformed revision and project identifiers', async () => {
    const { app } = setup();

    const statuses = await Promise.all([
      request(app, '/api/map-design/projects/project-a/revisions/not-a-number/snapshot'),
      request(app, '/api/map-design/projects/project-a/revisions/-1/snapshot'),
      request(app, `/api/map-design/projects/${'a'.repeat(257)}/revisions/1/snapshot`),
    ]);

    expect(statuses.map((response) => response.status)).toEqual([400, 400, 400]);
  });

  it('keeps historical evidence failures inside the safe domain envelope', async () => {
    const { app } = setup();

    const response = await request(app, '/api/map-design/projects/project-a/revisions/3/snapshot');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: 'SOURCE_UNAVAILABLE',
        message: 'The historical map revision evidence is unavailable.',
        retryable: false,
      },
    });
  });

  it('requires literal restore confirmation before invoking the mutation', async () => {
    const { app, revisionService } = setup();

    const response = await postRestore(app, { ...restoreInput(), confirmReplaceDraft: false });

    expect(response.status).toBe(400);
    expect(revisionService.restore).not.toHaveBeenCalled();
  });

  it('restores with the server-generated request identity rather than a client header', async () => {
    const { app, isProjectRunning, revisionService, setProjectRunning } = setup();
    const input = restoreInput();

    const response = await postRestore(app, input, { 'x-request-id': 'client-controlled' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(RESTORE_OUTPUT);
    expect(isProjectRunning).not.toHaveBeenCalled();
    expect(revisionService.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ui',
        projectId: 'project-a',
        requestId: 'request-server-generated',
        isProjectRunning: expect.any(Function),
      }),
      1,
      input,
    );
    const context = revisionService.restore.mock.calls[0]?.[0] as {
      isProjectRunning(): boolean;
    };
    expect(context.isProjectRunning()).toBe(false);
    setProjectRunning(true);
    expect(context.isProjectRunning()).toBe(true);
  });

  it('returns 409 for a stale draft revision', async () => {
    const { app, revisionService } = setup();
    revisionService.restore.mockRejectedValueOnce(new MapDraftError(
      'REVISION_CONFLICT',
      'The map draft revision has changed.',
      { retryable: true, details: { currentRevision: 8 } },
    ));

    const response = await postRestore(app, restoreInput({ expectedDraftRevision: 6 }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'REVISION_CONFLICT',
        message: 'The map draft revision has changed.',
        retryable: true,
        details: { currentRevision: 8 },
      },
    });
  });

  it('delegates a valid new restore during an active Run and preserves its stable conflict detail', async () => {
    const { app, revisionService } = setup({ projectRunning: true });
    revisionService.restore.mockImplementationOnce(async (context: unknown) => {
      const running = (context as { isProjectRunning(): boolean }).isProjectRunning();
      if (running) {
        throw new MapDraftError(
          'REVISION_CONFLICT',
          'A map run is active for this project.',
          { retryable: true, details: { reason: 'ACTIVE_RUN' } },
        );
      }
      return RESTORE_OUTPUT;
    });

    const response = await postRestore(app, restoreInput());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'REVISION_CONFLICT',
        message: 'A map run is active for this project.',
        retryable: true,
        details: { reason: 'ACTIVE_RUN' },
      },
    });
    expect(revisionService.restore).toHaveBeenCalledOnce();
  });

  it('returns project-scoped 404 for a missing revision even while a project Run is active', async () => {
    const { app, revisionService } = setup({ projectRunning: true });

    const response = await request(app, '/api/map-design/projects/project-a/revisions/2/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(restoreInput({ idempotencyKey: 'restore-active-missing' })),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'The map revision was not found.', retryable: false },
    });
    expect(revisionService.restore).toHaveBeenCalledOnce();
  });

  it('allows an exact restore receipt replay even while a project Run is active', async () => {
    const { app, revisionService } = setup({ projectRunning: true });

    const response = await postRestore(app, restoreInput({ idempotencyKey: 'restore-active-replay' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(RESTORE_OUTPUT);
    expect(revisionService.restore).toHaveBeenCalledOnce();
  });

  it('requires JSON and bounds malformed and oversized restore bodies', async () => {
    const { app, revisionService } = setup();
    const path = '/api/map-design/projects/project-a/revisions/1/restore';

    const missingContentType = await request(app, path, {
      method: 'POST',
      body: JSON.stringify(restoreInput()),
    });
    const malformed = await request(app, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    const oversized = await request(app, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...restoreInput(), intentSummary: 'x'.repeat(65 * 1024) }),
    });

    expect([missingContentType.status, malformed.status, oversized.status]).toEqual([415, 400, 413]);
    expect(revisionService.restore).not.toHaveBeenCalled();
  });

  it('returns 404 when the revision number belongs only to another project', async () => {
    const { app, revisionService } = setup();

    const response = await request(app, '/api/map-design/projects/project-a/revisions/2/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(restoreInput({ idempotencyKey: 'restore-cross-project' })),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'The map revision was not found.', retryable: false },
    });
    expect(revisionService.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ui',
        projectId: 'project-a',
        requestId: 'request-server-generated',
        isProjectRunning: expect.any(Function),
      }),
      2,
      expect.any(Object),
    );
  });
});
