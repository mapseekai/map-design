import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { MapIdentifierSchema } from '@mapseekai/map-design-contracts';

import { isMapDraftError } from '../application/errors.js';
import type { MapSourcePreviewService } from '../ingestion/source-import-service.js';
import { route, sendError } from './route-helpers.js';

export interface CreateMapDesignSourcePreviewRouterDependencies {
  sourcePreviewService: Pick<MapSourcePreviewService, 'getPreviewStyle' | 'deletePreview'>;
  requireLocalDaemonRequest: RequestHandler;
}

const SOURCE_PREVIEW_ROUTE = '/api/map-design/source-previews/:previewId';
const SOURCE_PREVIEW_STYLE_ROUTE = `${SOURCE_PREVIEW_ROUTE}/style`;

export function createMapDesignSourcePreviewRouter(
  deps: CreateMapDesignSourcePreviewRouterDependencies,
): Router {
  const router = Router();
  router.use(SOURCE_PREVIEW_ROUTE, deps.requireLocalDaemonRequest);
  router.use(SOURCE_PREVIEW_ROUTE, (request, response, next) => {
    if (!MapIdentifierSchema.safeParse(request.params.previewId).success) {
      sendError(response, 400, 'INVALID_INPUT', 'The source preview request is invalid.');
      return;
    }
    next();
  });
  router.get(SOURCE_PREVIEW_STYLE_ROUTE, route(async (request, response) => {
    const previewId = MapIdentifierSchema.parse(request.params.previewId);
    response.status(200).set({
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    }).json(deps.sourcePreviewService.getPreviewStyle(previewId));
  }));
  router.delete(SOURCE_PREVIEW_ROUTE, route(async (request, response) => {
    deps.sourcePreviewService.deletePreview(MapIdentifierSchema.parse(request.params.previewId));
    response.status(204).end();
  }));
  router.use(SOURCE_PREVIEW_ROUTE, (
    error: unknown,
    _request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (isMapDraftError(error) && error.code === 'NOT_FOUND') {
      sendError(response, 404, 'NOT_FOUND', error.message);
      return;
    }
    sendError(response, 500, 'INTERNAL', 'The source preview request failed.');
  });
  return router;
}
