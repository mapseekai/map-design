import { Router, json as expressJson, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { MapCurrentPreviewOutputSchema, MapIdentifierSchema, MapPreviewFulfillRequestSchema } from '@mapseekai/map-design-contracts';

import type { MapPreviewFulfillmentService } from '../application/preview-fulfillment-service.js';
import { invalidInput, isMapDraftError } from '../application/errors.js';
import { route, requireJson, sendError, bodyErrorStatus, mapDraftErrorStatus } from './route-helpers.js';

export interface CreateMapDesignPreviewRouterDependencies {
  previewFulfillmentService: Pick<MapPreviewFulfillmentService, 'fulfill' | 'getCurrent'>;
  requireLocalDaemonRequest: RequestHandler;
  projectReader: { getProject(projectId: string): Promise<unknown> };
}

const ROUTE = '/api/map-design/projects/:projectId/previews/:previewId/fulfill';
const CURRENT_ROUTE = '/api/map-design/projects/:projectId/previews/current';
const parseJson = expressJson({ limit: 12 * 1024 * 1024, strict: true });

export function createMapDesignPreviewRouter(deps: CreateMapDesignPreviewRouterDependencies): Router {
  const router = Router();
  router.use(CURRENT_ROUTE, deps.requireLocalDaemonRequest);
  router.use(CURRENT_ROUTE, requireProject(deps.projectReader, false));
  router.get(CURRENT_ROUTE, route(async (request, response) => {
    const projectId = MapIdentifierSchema.parse(request.params.projectId);
    response.json(MapCurrentPreviewOutputSchema.parse(deps.previewFulfillmentService.getCurrent(projectId)));
  }));
  router.use(CURRENT_ROUTE, errorHandler('The current map preview could not be read.'));
  router.use(ROUTE, deps.requireLocalDaemonRequest);
  router.use(ROUTE, requireProject(deps.projectReader, true));
  router.use(ROUTE, parseJson);
  router.post(ROUTE, requireJson, route(async (request, response) => {
    const projectId = MapIdentifierSchema.parse(request.params.projectId);
    const previewId = MapIdentifierSchema.parse(request.params.previewId);
    const input = parseInput(request.body);
    if (input.previewId !== previewId) throw invalidInput();
    response.json(await deps.previewFulfillmentService.fulfill(projectId, previewId, input));
  }));
  router.use(ROUTE, errorHandler('The map preview request failed.'));
  return router;
}

function requireProject(
  projectReader: { getProject(projectId: string): Promise<unknown> },
  requiresPreviewId: boolean,
): RequestHandler {
  return (request, response, next) => {
    const projectId = MapIdentifierSchema.safeParse(request.params.projectId);
    const previewId = MapIdentifierSchema.safeParse(request.params.previewId);
    if (!projectId.success || (requiresPreviewId && !previewId.success)) {
      sendError(response, 400, 'INVALID_INPUT', 'The map preview request is invalid.');
      return;
    }
    void projectReader.getProject(projectId.data).then(() => next()).catch(next);
  };
}

function parseInput(value: unknown) { try { return MapPreviewFulfillRequestSchema.parse(value); } catch { throw invalidInput(); } }
function errorHandler(fallback: string) {
  return (error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) { next(error); return; }
    if (isMapDraftError(error)) { sendError(response, mapDraftErrorStatus(error.code), error.code, error.message, error.retryable, error.details); return; }
    const status = bodyErrorStatus(error);
    if (status) { sendError(response, status, 'INVALID_INPUT', 'The map preview request is invalid.'); return; }
    sendError(response, 500, 'INTERNAL', fallback);
  };
}
