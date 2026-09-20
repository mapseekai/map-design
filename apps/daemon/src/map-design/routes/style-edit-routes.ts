import { Router, json, type NextFunction, type RequestHandler, type Response } from 'express';
import { MapIdentifierSchema, type MapToolErrorCode } from '@mapseekai/map-design-contracts';

import type { MapDesignStyleEditService } from '../application/style-edit-service.js';
import { invalidInput, isMapDraftError } from '../application/errors.js';
import { bodyErrorStatus, requireJson, route, sendError } from './route-helpers.js';

const PATH = '/api/map-design/projects/:projectId/style-edits';
const DOCUMENT_PATH = '/api/map-design/projects/:projectId/style-document';

export function createMapDesignStyleEditRouter(deps: {
  service: Pick<MapDesignStyleEditService, 'apply'> & Partial<Pick<MapDesignStyleEditService, 'applyDocument'>>;
  requireLocalDaemonRequest: RequestHandler;
}): Router {
  const router = Router();
  router.use(PATH, deps.requireLocalDaemonRequest, json({ limit: 64 * 1024, strict: true }));
  router.use(DOCUMENT_PATH, deps.requireLocalDaemonRequest, json({ limit: 2 * 1024 * 1024 + 4096, strict: true }));
  router.put(DOCUMENT_PATH, requireJson, route(async (request, response) => {
    if (!deps.service.applyDocument) throw invalidInput();
    response.json(await deps.service.applyDocument(identifier(request.params.projectId), identifier(response.locals.requestId), request.body));
  }));
  router.post(PATH, requireJson, route(async (request, response) => {
    response.json(await deps.service.apply(
      identifier(request.params.projectId),
      identifier(response.locals.requestId),
      request.body,
    ));
  }));
  router.use([PATH, DOCUMENT_PATH], (error: unknown, _request: unknown, response: Response, next: NextFunction) => {
    if (response.headersSent) { next(error); return; }
    if (isMapDraftError(error)) {
      sendError(response, statusFor(error.code), error.code, error.message, error.retryable, error.details);
      return;
    }
    const status = bodyErrorStatus(error);
    sendError(response, status ?? 500, status ? 'INVALID_INPUT' : 'INTERNAL', 'The map style edit request failed.');
  });
  return router;
}

function identifier(value: unknown): string {
  const parsed = MapIdentifierSchema.safeParse(value);
  if (!parsed.success || parsed.data !== value) throw invalidInput();
  return parsed.data;
}

function statusFor(code: MapToolErrorCode): number {
  if (code === 'INVALID_INPUT' || code === 'STYLE_INVALID' || code === 'SEMANTIC_INVALID' || code === 'DESIGN_SYSTEM_VIOLATION') return 400;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'REVISION_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT' || code === 'RUN_NOT_AUTHORIZED' || code === 'PROJECT_NOT_READY') return 409;
  return 500;
}
