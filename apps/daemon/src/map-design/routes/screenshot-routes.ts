import { Router, json, type RequestHandler, type Request, type Response, type NextFunction } from 'express';
import { MAP_SCREENSHOT_MAX_BYTES } from '@mapseekai/contracts';
import type { MapScreenshotService } from '../application/screenshot-service.js';
import { isMapDraftError } from '../application/errors.js';
import { bodyErrorStatus, requireJson, route, sendError } from './route-helpers.js';

export function createMapScreenshotRouter(deps: {
  service: Pick<MapScreenshotService, 'save' | 'read'>; requireLocalDaemonRequest: RequestHandler;
}): Router {
  const router = Router();
  const path = '/api/map-design/projects/:projectId/screenshots';
  router.use(path, deps.requireLocalDaemonRequest, json({ limit: Math.ceil(MAP_SCREENSHOT_MAX_BYTES * 4 / 3) + 8192, strict: true }));
  router.post(path, requireJson, route(async (request, response) => {
    response.status(201).json(await deps.service.save(String(request.params.projectId), request.body));
  }));
  router.get(`${path}/:screenshotId/image`, route(async (request, response) => {
    const { bytes } = await deps.service.read(String(request.params.projectId), String(request.params.screenshotId));
    response.set({ 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(Buffer.from(bytes));
  }));
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) { next(error); return; }
    if (isMapDraftError(error)) {
      const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_INPUT' ? 400 : error.code === 'PROJECT_NOT_READY' || error.code === 'REVISION_CONFLICT' ? 409 : 500;
      sendError(response, status, error.code, error.message, error.retryable); return;
    }
    const status = bodyErrorStatus(error);
    sendError(response, status ?? 500, status ? 'INVALID_INPUT' : 'INTERNAL', 'The map screenshot request failed.');
  });
  return router;
}
