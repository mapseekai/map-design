import { Router, json, type RequestHandler, type Request, type Response, type NextFunction } from 'express';
import type { MapThumbnailService } from '../application/thumbnail-service.js';
import { isMapDraftError } from '../application/errors.js';
import { bodyErrorStatus, requireJson, route, sendError } from './route-helpers.js';

export function createMapThumbnailRouter(deps: {
  service: MapThumbnailService; requireLocalDaemonRequest: RequestHandler;
}): Router {
  const router = Router();
  const path = '/api/map-design/projects/:projectId/thumbnail';
  router.use(path, deps.requireLocalDaemonRequest);
  router.put(path, json({ limit: '2mb', strict: true }), requireJson, route(async (req, res) => {
    deps.service.save(String(req.params.projectId), req.body);
    res.status(204).end();
  }));
  router.get(path, route(async (req, res) => {
    const png = deps.service.read(String(req.params.projectId));
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    if (!png) { res.status(204).end(); return; }
    res.type('png').send(png);
  }));
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(error); return; }
    if (isMapDraftError(error)) {
      sendError(res, error.code === 'NOT_FOUND' ? 404 : 400, error.code, error.message); return;
    }
    const status = bodyErrorStatus(error);
    sendError(res, status ?? 500, status ? 'INVALID_INPUT' : 'INTERNAL', 'The map thumbnail request failed.');
  });
  return router;
}
