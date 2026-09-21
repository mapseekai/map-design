import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { MapIdentifierSchema } from '@mapseekai/map-design-contracts';

import { isMapDraftError } from '../application/errors.js';
import {
  MapDesignResourceError,
  type MapDesignPmtilesRangeRepresentation,
  type MapDesignResourceRepresentation,
  type MapDesignResourceService,
} from '../resources/resource-service.js';

export interface CreateMapDesignResourceGatewayDependencies {
  resourceService: MapDesignResourceService;
  requireLocalDaemonRequest: RequestHandler;
  projectReader: { getProject(projectId: string): Promise<unknown> };
}

export interface CreateMapDesignSourcePreviewResourceGatewayDependencies {
  resourceService: MapDesignResourceService;
  requireLocalDaemonRequest: RequestHandler;
}

const PROJECT_RESOURCE_ROUTE = '/api/map-design/projects/:projectId/resources/:resourceId';
const SOURCE_PREVIEW_RESOURCE_ROUTE = '/api/map-design/source-previews/:previewId/resources/:resourceId';

export function createMapDesignResourceGateway(
  deps: CreateMapDesignResourceGatewayDependencies,
): Router {
  return createResourceGateway({
    resourceRoute: PROJECT_RESOURCE_ROUTE,
    ownerParam: 'projectId',
    resourceService: deps.resourceService,
    requireLocalDaemonRequest: deps.requireLocalDaemonRequest,
    authorizeOwner: (projectId) => deps.projectReader.getProject(projectId),
  });
}

export function createMapDesignSourcePreviewResourceGateway(
  deps: CreateMapDesignSourcePreviewResourceGatewayDependencies,
): Router {
  return createResourceGateway({
    resourceRoute: SOURCE_PREVIEW_RESOURCE_ROUTE,
    ownerParam: 'previewId',
    resourceService: deps.resourceService,
    requireLocalDaemonRequest: deps.requireLocalDaemonRequest,
  });
}

function createResourceGateway(deps: {
  resourceRoute: string;
  ownerParam: 'projectId' | 'previewId';
  resourceService: MapDesignResourceService;
  requireLocalDaemonRequest: RequestHandler;
  authorizeOwner?: (ownerId: string) => Promise<unknown>;
}): Router {
  const router = Router();
  router.use(deps.resourceRoute, deps.requireLocalDaemonRequest);
  router.use(deps.resourceRoute, (request, response, next) => {
    const ownerId = MapIdentifierSchema.safeParse(request.params[deps.ownerParam]);
    const resourceId = MapIdentifierSchema.safeParse(request.params.resourceId);
    if (!ownerId.success || !resourceId.success) {
      sendError(response, 400, 'Map resource request is invalid');
      return;
    }
    if (!deps.authorizeOwner) {
      next();
      return;
    }
    void deps.authorizeOwner(ownerId.data).then(() => next()).catch(next);
  });
  const handler = route(async (request, response) => {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    if (request.aborted || response.destroyed) abort();
    try {
      const representation = await deps.resourceService.getResource(
        MapIdentifierSchema.parse(request.params[deps.ownerParam]),
        MapIdentifierSchema.parse(request.params.resourceId),
        suffixParts(request),
        abortController.signal,
      );
      sendRepresentation(request, response, representation);
    } finally {
      request.off('aborted', abort);
      response.off('close', abort);
    }
  });
  const archiveHandler = route(async (request, response) => {
    const range = parseArchiveRange(request.get('range'));
    if (!range) throw new MapDesignResourceError(400, 'PMTiles archive requires one bounded byte range');
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    if (request.aborted || response.destroyed) abort();
    try {
      const representation = await deps.resourceService.getPmtilesArchiveRange(
        MapIdentifierSchema.parse(request.params[deps.ownerParam]),
        MapIdentifierSchema.parse(request.params.resourceId),
        range,
        request.get('if-match'),
        abortController.signal,
      );
      sendArchiveRepresentation(request, response, representation);
    } finally {
      request.off('aborted', abort);
      response.off('close', abort);
    }
  });
  router.head(`${deps.resourceRoute}/archive.pmtiles`, archiveHandler);
  router.get(`${deps.resourceRoute}/archive.pmtiles`, archiveHandler);
  router.head(`${deps.resourceRoute}/*suffix`, handler);
  router.get(`${deps.resourceRoute}/*suffix`, handler);
  router.head(deps.resourceRoute, (_request, response) => sendError(response, 400, 'Map resource suffix is required'));
  router.get(deps.resourceRoute, (_request, response) => sendError(response, 400, 'Map resource suffix is required'));
  router.use(deps.resourceRoute, (
    error: unknown,
    _request: Request,
    response: Response,
    _next: NextFunction,
  ) => {
    if (response.headersSent) return;
    if (isMapDraftError(error) && error.code === 'NOT_FOUND') {
      sendError(response, 404, error.message);
      return;
    }
    if (error instanceof MapDesignResourceError) {
      if (error.retryAfter) response.set('Retry-After', error.retryAfter);
      sendError(response, error.status, error.message);
      return;
    }
    sendError(response, 500, 'Map resource request failed');
  });
  return router;
}

function sendArchiveRepresentation(
  request: Request,
  response: Response,
  representation: MapDesignPmtilesRangeRepresentation,
): void {
  response.status(206).set({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=0, must-revalidate',
    'Content-Length': String(representation.bytes.byteLength),
    'Content-Range': `bytes ${representation.start}-${representation.end}/${representation.total}`,
    'Content-Type': representation.mediaType,
    'Cross-Origin-Resource-Policy': 'same-origin',
    ETag: representation.etag,
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') response.end();
  else response.send(Buffer.from(representation.bytes));
}

function parseArchiveRange(value: string | undefined): { start: number; endInclusive: number } | null {
  const match = value?.match(/^bytes=(\d+)-(\d+)$/u);
  if (!match) return null;
  const start = Number(match[1]);
  const endInclusive = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(endInclusive) && start >= 0
    && endInclusive >= start && endInclusive - start + 1 <= 1024 * 1024
    ? { start, endInclusive }
    : null;
}

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next) => { void handler(request, response).catch(next); };
}

function suffixParts(request: Request): string[] {
  const suffix = request.params.suffix;
  if (Array.isArray(suffix)) return suffix.map(String);
  if (typeof suffix === 'string') return suffix.split('/');
  return [];
}

function sendRepresentation(
  request: Request,
  response: Response,
  representation: MapDesignResourceRepresentation,
): void {
  const size = representation.bytes.byteLength;
  const range = parseRange(request.get('range'), size);
  response.set({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=0, must-revalidate',
    'Content-Type': representation.mediaType,
    'Cross-Origin-Resource-Policy': 'same-origin',
    ETag: representation.etag,
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.get('if-none-match') === representation.etag && request.get('range') === undefined) {
    response.status(304).end();
    return;
  }
  if (range === 'invalid') {
    response.status(416).set('Content-Range', `bytes */${size}`).end();
    return;
  }
  if (range) {
    const body = representation.bytes.subarray(range.start, range.end + 1);
    response.status(206).set({
      'Content-Length': String(body.byteLength),
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    });
    if (request.method === 'HEAD') response.end();
    else response.send(Buffer.from(body));
    return;
  }
  response.status(200).set('Content-Length', String(size));
  if (request.method === 'HEAD') response.end();
  else response.send(Buffer.from(representation.bytes));
}

function parseRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (value === undefined) return null;
  if (value.includes(',')) return 'invalid';
  const match = value.match(/^bytes=(\d*)-(\d*)$/u);
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (match[1] === '') {
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length <= 0) return 'invalid';
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }
  if (![start, end].every(Number.isSafeInteger) || start < 0 || start >= size || end < start) {
    return 'invalid';
  }
  return { start, end: Math.min(end, size - 1) };
}

function sendError(response: Response, status: number, message: string): void {
  response.status(status).set({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  }).json({ error: { code: status === 404 ? 'NOT_FOUND' : status === 429 ? 'RESOURCE_RATE_LIMITED' : 'RESOURCE_ERROR', message } });
}
