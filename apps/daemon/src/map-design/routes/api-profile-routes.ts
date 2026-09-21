import { Router, json, type Request, type Response, type NextFunction } from 'express';
import { ApiProfileError, ApiProfileService } from '../application/api-profile-service.js';
import type { MapDesignConfigStore } from '../storage/config-store.js';
const PATH = '/api/map-design/api-profiles';
export function createApiProfileRouter(config: MapDesignConfigStore, service = new ApiProfileService(config)): Router {
  const router = Router();
  router.use(PATH, json({ limit: '32kb', strict: true }));
  const id = (request: Request) => typeof request.params.id === 'string' ? request.params.id : '';
  router.get(PATH, (_req, res) => res.json(service.list()));
  router.put(`${PATH}/:id`, (req, res) => res.json(service.save(id(req), req.body)));
  router.post(`${PATH}/:id/activate`, (req, res) => res.json(service.activate(id(req))));
  router.delete(`${PATH}/:id`, (req, res) => res.json(service.delete(id(req))));
  router.post(`${PATH}/:id/test`, async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort); res.once('close', abort);
    if (req.aborted || res.destroyed) abort();
    try { res.json(await service.test(id(req), controller.signal)); }
    finally { req.off('aborted', abort); res.off('close', abort); }
  });
  router.use(PATH, (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent || res.destroyed) return;
    const status = error instanceof ApiProfileError ? error.status : 400;
    res.status(status).json({ error: { code: error instanceof ApiProfileError ? error.code : 'API_PROFILE_SAVE_FAILED' } });
  });
  return router;
}
