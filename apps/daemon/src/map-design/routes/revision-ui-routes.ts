import { Router, json as expressJson, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import {
  MapCommitRevisionInputSchema,
  MapIdentifierSchema,
  MapRestoreRevisionInputSchema,
  MapSafeRevisionSchema,
  type MapToolErrorCode,
} from '@mapseekai/map-design-contracts';

import type { MapRevisionService } from '../application/revision-service.js';
import { MapDraftError, invalidInput, isMapDraftError } from '../application/errors.js';
import { route, requireJson, sendError, bodyErrorStatus } from './route-helpers.js';

export interface CreateMapDesignRevisionUiRouterDependencies {
  revisionService: Pick<MapRevisionService, 'commit' | 'getSnapshot' | 'restore'>;
  isProjectRunning(projectId: string): boolean;
  loadPreviewRun(projectId: string, previewId: string): { runId: string } | null;
  requireLocalDaemonRequest: RequestHandler;
  projectReader: { getProject(projectId: string): Promise<unknown> };
}

const COMMIT_ROUTE = '/api/map-design/projects/:projectId/revisions/commit-from-preview';
const SNAPSHOT_ROUTE = '/api/map-design/projects/:projectId/revisions/:revision/snapshot';
const RESTORE_ROUTE = '/api/map-design/projects/:projectId/revisions/:revision/restore';
const parseJson = expressJson({ limit: 64 * 1024, strict: true });

export function createMapDesignRevisionUiRouter(deps: CreateMapDesignRevisionUiRouterDependencies): Router {
  const router = Router();
  router.use([COMMIT_ROUTE, SNAPSHOT_ROUTE, RESTORE_ROUTE], deps.requireLocalDaemonRequest);
  router.get(SNAPSHOT_ROUTE, route(async (request, response) => {
    const { projectId, revision } = parseRevisionRequest(request);
    response.json(await deps.revisionService.getSnapshot(projectId, revision));
  }));
  router.use(COMMIT_ROUTE, (request, response, next) => {
    let projectId: string;
    try {
      projectId = parseProjectId(request);
    } catch {
      sendError(response, 400, 'INVALID_INPUT', 'The revision request is invalid.');
      return;
    }
    void deps.projectReader.getProject(projectId).then(() => next()).catch(next);
  });
  router.use([COMMIT_ROUTE, RESTORE_ROUTE], parseJson);
  router.post(COMMIT_ROUTE, requireJson, route(async (request, response) => {
    const projectId = parseProjectId(request);
    const input = parseInput(request.body);
    const preview = deps.loadPreviewRun(projectId, input.previewId);
    if (!preview) throw new MapDraftError('NOT_FOUND', 'The map preview was not found.');
    response.json(await deps.revisionService.commit({ projectId, runId: preview.runId }, input));
  }));
  router.post(RESTORE_ROUTE, requireJson, route(async (request, response) => {
    const { projectId, revision } = parseRevisionRequest(request);
    const input = parseRestoreInput(request.body);
    const requestId = parseUiRequestId(response.locals.requestId);
    response.json(await deps.revisionService.restore(
      {
        kind: 'ui',
        projectId,
        requestId,
        isProjectRunning: () => deps.isProjectRunning(projectId),
      },
      revision,
      input,
    ));
  }));
  router.use([COMMIT_ROUTE, SNAPSHOT_ROUTE, RESTORE_ROUTE], (error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) { next(error); return; }
    if (isMapDraftError(error)) { sendError(response, statusFor(error.code), error.code, error.message, error.retryable, error.details); return; }
    const status = bodyErrorStatus(error); if (status) { sendError(response, status, 'INVALID_INPUT', 'The revision request is invalid.'); return; }
    sendError(response, 500, 'INTERNAL', 'The revision request failed.');
  });
  return router;
}

function parseProjectId(request: Request): string {
  const projectId = MapIdentifierSchema.safeParse(request.params.projectId);
  if (!projectId.success) throw invalidInput();
  return projectId.data;
}

function parseRevisionRequest(request: Request): { projectId: string; revision: number } {
  const projectId = parseProjectId(request);
  const rawRevision = request.params.revision;
  if (typeof rawRevision !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(rawRevision)) {
    throw invalidInput();
  }
  const revision = MapSafeRevisionSchema.safeParse(Number(rawRevision));
  if (!revision.success) throw invalidInput();
  return { projectId, revision: revision.data };
}

function parseInput(value: unknown) { try { return MapCommitRevisionInputSchema.parse(value); } catch { throw invalidInput(); } }
function parseRestoreInput(value: unknown) { try { return MapRestoreRevisionInputSchema.parse(value); } catch { throw invalidInput(); } }
function parseUiRequestId(value: unknown): string {
  const requestId = MapIdentifierSchema.safeParse(value);
  if (!requestId.success || requestId.data !== value) throw invalidInput();
  return requestId.data;
}
function statusFor(code: MapToolErrorCode) { if (code === 'INVALID_INPUT') return 400; if (code === 'NOT_FOUND') return 404;
  if (code === 'RUN_NOT_AUTHORIZED') return 403; if (code === 'IDEMPOTENCY_CONFLICT' || code === 'PREVIEW_STALE' || code === 'REVISION_CONFLICT') return 409; return 500; }
