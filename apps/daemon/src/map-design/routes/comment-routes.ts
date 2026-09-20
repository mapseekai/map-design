import { Router, json, type RequestHandler, type Request, type Response, type NextFunction } from 'express';
import { MapIdentifierSchema, MapSafeRevisionSchema } from '@mapseekai/map-design-contracts';
import type { MapDesignCommentService } from '../application/comment-service.js';
import { invalidInput, isMapDraftError } from '../application/errors.js';
import { bodyErrorStatus, requireJson, route, sendError } from './route-helpers.js';

export function createMapDesignCommentRouter(deps: {
  service: Pick<MapDesignCommentService, 'list' | 'save' | 'delete'>;
  requireLocalDaemonRequest: RequestHandler;
}): Router {
  const router = Router();
  const path = '/api/map-design/projects/:projectId/comments';
  router.use(path, deps.requireLocalDaemonRequest, json({ limit: 64 * 1024, strict: true }));
  router.get(path, route(async (request, response) => {
    response.json(deps.service.list(identifier(request.params.projectId)));
  }));
  router.post(path, requireJson, route(async (request, response) => {
    response.json(await deps.service.save(identifier(request.params.projectId), request.body));
  }));
  router.delete(`${path}/:commentId`, route(async (request, response) => {
    const value = request.query.version;
    if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw invalidInput();
    const version = MapSafeRevisionSchema.safeParse(Number(value));
    if (!version.success) throw invalidInput();
    deps.service.delete(identifier(request.params.projectId), identifier(request.params.commentId), version.data);
    response.status(204).end();
  }));
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) { next(error); return; }
    if (isMapDraftError(error)) {
      const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_INPUT' ? 400
        : error.code === 'REVISION_CONFLICT' || error.code === 'PROJECT_NOT_READY' ? 409 : 500;
      sendError(response, status, error.code, error.message, error.retryable);
      return;
    }
    const status = bodyErrorStatus(error);
    sendError(response, status ?? 500, status ? 'INVALID_INPUT' : 'INTERNAL', 'The map comment request failed.');
  });
  return router;
}

function identifier(value: unknown): string {
  const parsed = MapIdentifierSchema.safeParse(value);
  if (!parsed.success) throw invalidInput();
  return parsed.data;
}
