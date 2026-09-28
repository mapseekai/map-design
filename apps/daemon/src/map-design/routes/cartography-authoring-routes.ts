import type { MapDesignAppConfig } from '@mapseekai/contracts';
import type { CartographyModelRoots } from '../application/cartography-authoring.js';
import { Router, json, type RequestHandler, type Request, type Response, type NextFunction } from 'express';
import { CARTOGRAPHY_MAX_BYTES, CARTOGRAPHY_STYLE_MAX_BYTES, CartographyGenerateInputSchema, type CartographyGeneration, CartographyUrlInputSchema } from '@mapseekai/map-design-contracts';
import { fetchCartographySource, generateCartographyDraft, initializeCartographyDraft, initializeCartographyUrlDraft } from '../application/cartography-authoring.js';
import { invalidInput, isMapDraftError } from '../application/errors.js';
import type { MapDesignProjectService } from '../application/project-service.js';
import { CartographyEditService } from '../application/cartography-edit-service.js';
import { bodyErrorStatus, requireJson, route, sendError } from './route-helpers.js';

export function createCartographyAuthoringRouter(deps: {
  dataRoot: string; projectRoot: string;
  config?: { read(): MapDesignAppConfig };
  agents?: NonNullable<CartographyModelRoots['agents']>;
  projectService: Pick<MapDesignProjectService, 'importCartography'> & Partial<Pick<MapDesignProjectService, 'getCartography' | 'canOverwriteCartography' | 'saveCartographyEdit' | 'cartographyHistoryIds'>>;
  requireLocal: RequestHandler;
  editService?: CartographyEditService | undefined;
}): Router {
  const router = Router();
  const edits = deps.editService ?? new CartographyEditService({ ...deps,
    saveDocument: (input) => deps.projectService.importCartography(input),
    ...(deps.projectService.getCartography ? { readSourceFile: (id: string) => deps.projectService.getCartography?.(id).sourceFile } : {}),
    ...(deps.projectService.canOverwriteCartography ? { canOverwriteDocument: deps.projectService.canOverwriteCartography.bind(deps.projectService) } : {}),
    ...(deps.projectService.cartographyHistoryIds ? { documentHistoryIds: deps.projectService.cartographyHistoryIds.bind(deps.projectService) } : {}),
    ...(deps.projectService.saveCartographyEdit ? { saveEditedDocument: deps.projectService.saveCartographyEdit.bind(deps.projectService) } : {}),
  });
  const jobs = new Map<string, { controller: AbortController; result: CartographyGeneration }>();
  const parseAuthoringJson = json({ limit: '6mb', strict: true });
  const parseEditJson = json({ limit: Math.ceil(CARTOGRAPHY_STYLE_MAX_BYTES / 3) * 4 + (CARTOGRAPHY_MAX_BYTES + 2 * 1024 * 1024) * 6 + 16 * 1024, strict: true });
  router.use('/api/map-design/cartography-tools', deps.requireLocal, (request, response, next) => {
    const parse = request.method === 'POST' && request.path === '/edit-sessions' ? parseEditJson : parseAuthoringJson;
    parse(request, response, next);
  });
  const editPath = '/api/map-design/cartography-tools/edit-sessions';
  router.get(editPath, route(async (_request, response) => {
    response.json(await edits.activeEdits());
  }));
  router.get(`${editPath}/history/:documentId`, route(async (request, response) => {
    response.json(await edits.history(String(request.params.documentId)));
  }));
  router.post(editPath, requireJson, route(async (request, response) => {
    response.status(201).json(await edits.create(request.body));
  }));
  router.get(`${editPath}/:id`, route(async (request, response) => {
    response.json(await edits.get(String(request.params.id)));
  }));
  router.post(`${editPath}/:id/turns`, requireJson, route(async (request, response) => {
    response.status(202).json(await edits.turn(String(request.params.id), request.body));
  }));
  router.delete(`${editPath}/:id/turns`, route(async (request, response) => {
    response.json(await edits.cancel(String(request.params.id)));
  }));
  router.post(`${editPath}/:id/save`, requireJson, route(async (request, response) => {
    response.json(await edits.save(String(request.params.id), request.body));
  }));
  router.post('/api/map-design/cartography-tools/import-url', requireJson, route(async (request, response) => {
    const parsed = CartographyUrlInputSchema.safeParse(request.body);
    if (!parsed.success) throw invalidInput();
    const source = await fetchCartographySource(parsed.data.url);
    response.status(201).json(deps.projectService.importCartography({ source, ...(parsed.data.description === undefined ? {} : { description: parsed.data.description }) }));
  }));
  router.post('/api/map-design/cartography-tools/initialize', requireJson, route(async (request, response) => {
    response.json(initializeCartographyDraft(request.body));
  }));
  router.post('/api/map-design/cartography-tools/initialize-url', requireJson, route(async (request, response) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    response.once('close', abort);
    try { response.json(await initializeCartographyUrlDraft(request.body, controller.signal)); }
    finally { response.off('close', abort); }
  }));
  router.post('/api/map-design/cartography-tools/generate', requireJson, route(async (request, response) => {
    const parsed = CartographyGenerateInputSchema.safeParse(request.body);
    if (!parsed.success) throw invalidInput();
    if ([...jobs.values()].some((job) => job.result.status === 'running') || jobs.has(parsed.data.jobId)) {
      sendError(response, 409, 'PROJECT_NOT_READY', 'A CARTOGRAPHY.md generation is already running.'); return;
    }
    const jobId = parsed.data.jobId;
    const controller = new AbortController();
    const job = { controller, result: { jobId, status: 'running' } as CartographyGeneration };
    jobs.set(jobId, job);
    setTimeout(() => { controller.abort(); jobs.delete(jobId); }, 15 * 60_000).unref();
    void generateCartographyDraft(parsed.data, deps, controller.signal).then((draft) => {
      job.result = { jobId, status: 'succeeded', draft };
    }).catch(() => { job.result = { jobId, status: 'failed', message: 'Unable to generate a valid document. Check the API settings or Codex CLI sign-in and try again.' }; });
    response.status(202).json(job.result);
  }));
  router.get('/api/map-design/cartography-tools/generate/:jobId', route(async (request, response) => {
    const job = jobs.get(String(request.params.jobId));
    if (!job) { sendError(response, 404, 'NOT_FOUND', 'Generation not found.'); return; }
    response.json(job.result);
  }));
  router.delete('/api/map-design/cartography-tools/generate/:jobId', route(async (request, response) => {
    const job = jobs.get(String(request.params.jobId));
    job?.controller.abort(); jobs.delete(String(request.params.jobId));
    response.status(204).end();
  }));
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) { next(error); return; }
    if (isMapDraftError(error)) {
      const status = ['SOURCE_UNAVAILABLE', 'PROJECT_NOT_READY', 'REVISION_CONFLICT', 'RUNTIME_CONFLICT', 'IDEMPOTENCY_CONFLICT'].includes(error.code) ? 409 : error.code === 'NOT_FOUND' ? 404 : error.code === 'INTERNAL' ? 500 : 400;
      sendError(response, status, error.code, error.message, error.retryable, error.details); return;
    }
    const status = bodyErrorStatus(error);
    sendError(response, status ?? 500, status ? 'INVALID_INPUT' : 'INTERNAL', status ? 'Invalid request body or file size.' : 'Cartography authoring failed.');
  });
  return router;
}
