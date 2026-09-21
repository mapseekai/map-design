import { Router, json as expressJson, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import {
  MapDesignProjectCreateInputSchema,
  CARTOGRAPHY_MAX_BYTES,
  MapDigestSchema,
  MapIdentifierSchema,
  MapInspectInputSchema,
  MapSearchLayersInputSchema,
  MapToolErrorSchema,
  MapValidateInputSchema,
  type MapToolErrorCode,
} from '@mapseekai/map-design-contracts';

import type { MapDesignProjectService } from '../application/project-service.js';
import type { MapDesignQueryService } from '../application/query-service.js';
import { invalidInput, isMapDraftError, MapDraftError } from '../application/errors.js';
import type { MapDesignValidationService } from '../application/validation-service.js';
import { route, requireJson } from './route-helpers.js';

export interface CreateMapDesignProjectRouterDependencies {
  projectService: Pick<MapDesignProjectService,
    'create' | 'list' | 'get' | 'rename' | 'getConversation' | 'delete' | 'listCartographies' | 'importCartography' | 'getCartography' | 'updateCartography' | 'deleteCartography'>;
  queryService: Pick<MapDesignQueryService,
    'getContext' | 'inspect' | 'searchLayers' | 'getStyle' | 'getSemantics' | 'listRevisions'>;
  validationService: Pick<MapDesignValidationService, 'validate'>;
  requireLocalDaemonRequest: RequestHandler;
}

const PROJECT_ROUTE = '/api/map-design/projects/:projectId';
const MAP_DESIGN_READ_BODY_MAX_BYTES = 64 * 1024;
const parseMapDesignJson = expressJson({ limit: MAP_DESIGN_READ_BODY_MAX_BYTES, strict: true });
// A JSON-escaped document can occupy six wire bytes per source byte, plus metadata.
const parseCartographyJson = expressJson({ limit: CARTOGRAPHY_MAX_BYTES * 6 + 16 * 1024, strict: true });

export function createMapDesignProjectRouter(deps: CreateMapDesignProjectRouterDependencies): Router {
  const router = Router();
  const cartographies = deps.projectService;
  router.use('/api/map-design/cartographies', deps.requireLocalDaemonRequest, parseCartographyJson);
  router.get('/api/map-design/cartographies', rejectReadBody, route(async (_request, response) => {
    response.json(cartographies.listCartographies());
  }));
  router.post('/api/map-design/cartographies', requireJson, route(async (request, response) => {
    response.status(201).json(cartographies.importCartography(request.body));
  }));
  router.patch('/api/map-design/cartographies/:id', requireJson, route(async (request, response) => {
    response.json(cartographies.updateCartography(parseInput(MapDigestSchema, request.params.id), request.body));
  }));
  router.get('/api/map-design/cartographies/:id', rejectReadBody, route(async (request, response) => {
    response.json(cartographies.getCartography(parseInput(MapDigestSchema, request.params.id)));
  }));
  router.delete('/api/map-design/cartographies/:id', rejectReadBody, route(async (request, response) => {
    cartographies.deleteCartography(parseInput(MapDigestSchema, request.params.id));
    response.status(204).end();
  }));
  router.use('/api/map-design/projects', deps.requireLocalDaemonRequest);
  router.use('/api/map-design/projects', (request, response, next) => {
    if (request.method !== 'POST' && request.method !== 'PATCH') { next(); return; }
    parseMapDesignJson(request, response, next);
  });
  router.get('/api/map-design/projects', rejectReadBody, route(async (_request, response) => {
    response.json(deps.projectService.list());
  }));
  router.post('/api/map-design/projects', requireJson, route(async (request, response) => {
    response.status(201).json(await deps.projectService.create(parseProjectCreateInput(request.body)));
  }));
  router.use(PROJECT_ROUTE, (request, response, next) => {
    const parsed = MapIdentifierSchema.safeParse(request.params.projectId);
    if (!parsed.success) {
      sendMapError(response, 400, 'INVALID_INPUT', 'The map project request is invalid.');
      return;
    }
    next();
  });

  router.get(PROJECT_ROUTE, rejectReadBody, route(async (request, response) => {
    response.json(await deps.projectService.get(projectId(request)));
  }));
  router.patch(PROJECT_ROUTE, requireJson, route(async (request, response) => {
    response.json(deps.projectService.rename(projectId(request), request.body));
  }));
  // Keep this primary-conversation endpoint as a compatibility alias for existing clients.
  router.get(`${PROJECT_ROUTE}/conversation`, rejectReadBody, route(async (request, response) => {
    response.json(deps.projectService.getConversation(projectId(request)));
  }));
  router.delete(PROJECT_ROUTE, rejectReadBody, route(async (request, response) => {
    if (!deps.projectService.delete(projectId(request))) {
      throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
    }
    response.status(204).end();
  }));
  router.get(`${PROJECT_ROUTE}/context`, rejectReadBody, route(async (request, response) => {
    response.json(await deps.queryService.getContext(projectId(request)));
  }));
  router.post(`${PROJECT_ROUTE}/inspect`, requireJson, route(async (request, response) => {
    response.json(await deps.queryService.inspect(projectId(request), parseInput(MapInspectInputSchema, request.body)));
  }));
  router.post(`${PROJECT_ROUTE}/search-layers`, requireJson, route(async (request, response) => {
    response.json(await deps.queryService.searchLayers(projectId(request), parseInput(MapSearchLayersInputSchema, request.body)));
  }));
  router.post(`${PROJECT_ROUTE}/validate`, requireJson, route(async (request, response) => {
    response.json(await deps.validationService.validate(projectId(request), parseInput(MapValidateInputSchema, request.body)));
  }));
  router.get(`${PROJECT_ROUTE}/style`, rejectReadBody, route(async (request, response) => {
    response.json(await deps.queryService.getStyle(projectId(request)));
  }));
  router.get(`${PROJECT_ROUTE}/semantics`, rejectReadBody, route(async (request, response) => {
    response.json(await deps.queryService.getSemantics(projectId(request)));
  }));
  router.get(`${PROJECT_ROUTE}/revisions`, rejectReadBody, route(async (request, response) => {
    response.json(await deps.queryService.listRevisions(projectId(request)));
  }));

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) { next(error); return; }
    if (isMapDraftError(error)) {
      sendMapError(response, statusFor(error.code), error.code, error.message, error.retryable, error.details);
      return;
    }
    const bodyErrorStatus = jsonBodyErrorStatus(error);
    if (bodyErrorStatus !== null) {
      sendMapError(response, bodyErrorStatus, 'INVALID_INPUT', 'The map project request is invalid.');
      return;
    }
    sendMapError(response, 500, 'INTERNAL', 'The map project request failed.');
  });
  return router;
}

function projectId(request: Request): string {
  return MapIdentifierSchema.parse(request.params.projectId);
}

function parseInput<T>(schema: { parse(input: unknown): T }, input: unknown): T {
  try {
    return schema.parse(input);
  } catch {
    throw invalidInput();
  }
}

function parseProjectCreateInput(input: unknown) {
  if (isRecord(input) && isRecord(input.workingDirectory)
    && (typeof input.workingDirectory.token !== 'string' || input.workingDirectory.token.length < 16)) {
    throw new MapDraftError('RUN_NOT_AUTHORIZED', 'The desktop working-directory grant is not authorized.');
  }
  return parseInput(MapDesignProjectCreateInputSchema, input);
}

function rejectReadBody(request: Request, response: Response, next: NextFunction): void {
  const contentLength = request.get('content-length');
  const hasTransportBody = (contentLength !== undefined && contentLength.trim() !== '' && contentLength !== '0')
    || request.get('transfer-encoding') !== undefined;
  if (hasTransportBody || (isRecord(request.body) && Object.keys(request.body).length > 0)) {
    sendMapError(response, 400, 'INVALID_INPUT', 'Read endpoints do not accept a request body.');
    return;
  }
  next();
}

function sendMapError(
  response: Response,
  status: number,
  code: MapToolErrorCode,
  message: string,
  retryable = false,
  details?: unknown,
): void {
  const error = MapToolErrorSchema.parse({ code, message, retryable, ...(details === undefined ? {} : { details }) });
  response.status(status).json({ error });
}

function statusFor(code: MapToolErrorCode): number {
  if (code === 'INVALID_INPUT') return 400;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'PROJECT_NOT_READY' || code === 'REVISION_CONFLICT' || code === 'IDEMPOTENCY_CONFLICT'
    || code === 'STYLE_INVALID' || code === 'SEMANTIC_INVALID' || code === 'DESIGN_SYSTEM_VIOLATION'
    || code === 'SOURCE_UNAVAILABLE' || code === 'PREVIEW_FAILED' || code === 'PREVIEW_STALE') return 409;
  if (code === 'RUN_NOT_AUTHORIZED') return 403;
  return 500;
}

function jsonBodyErrorStatus(error: unknown): 400 | 413 | null {
  if (!isRecord(error)) return null;
  if (error.type === 'entity.parse.failed') return 400;
  if (error.type === 'entity.too.large') return 413;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
