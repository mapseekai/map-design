import { Router, json as expressJson, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import {
  MapIdentifierSchema,
  MapProjectRetryInputSchema,
  MapSourcePreflightInputSchema,
  type MapDesignProjectListOutput,
  type MapToolErrorCode,
} from '@mapseekai/map-design-contracts';

import type { MapDesignQueryService } from '../application/query-service.js';
import { invalidInput, isMapDraftError } from '../application/errors.js';
import type { MapImportJobRunner } from '../ingestion/import-job-runner.js';
import type { MapSourceImportService } from '../ingestion/source-import-service.js';
import { route, requireJson, sendError } from './route-helpers.js';

export interface CreateMapDesignImportRouterDependencies {
  sourceImportService: MapSourceImportService;
  importJobRunner: Pick<MapImportJobRunner, 'enqueue'>;
  requireLocalDaemonRequest: RequestHandler;
  projectReader: Pick<MapDesignQueryService, 'getProject'>;
}

const PREFLIGHT_ROUTE = '/api/map-design/source-preflight';
const RETRY_ROUTE = '/api/map-design/projects/:projectId/retry-import';
const parseJson = expressJson({ limit: 64 * 1024, strict: true });

export function createMapDesignImportRouter(deps: CreateMapDesignImportRouterDependencies): Router {
  const router = Router();
  router.use(PREFLIGHT_ROUTE, deps.requireLocalDaemonRequest);
  router.use(PREFLIGHT_ROUTE, parseJson);
  router.post(PREFLIGHT_ROUTE, requireJson, route(async (request, response) => {
    const input = parseInput(MapSourcePreflightInputSchema, request.body);
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('request closed'));
    const abortUnfinishedResponse = () => { if (!response.writableEnded) abort(); };
    request.once('aborted', abort);
    response.once('close', abortUnfinishedResponse);
    try {
      response.json(await deps.sourceImportService.preflight(input, controller.signal));
    } finally {
      request.off('aborted', abort);
      response.off('close', abortUnfinishedResponse);
    }
  }));

  router.use(RETRY_ROUTE, deps.requireLocalDaemonRequest);
  router.use(RETRY_ROUTE, (request, response, next) => {
    const projectId = MapIdentifierSchema.safeParse(request.params.projectId);
    if (!projectId.success) {
      sendError(response, 400, 'INVALID_INPUT', 'The map import request is invalid.');
      return;
    }
    void deps.projectReader.getProject(projectId.data).then(() => next()).catch(next);
  });
  router.use(RETRY_ROUTE, parseJson);
  router.post(RETRY_ROUTE, requireJson, route(async (request, response) => {
    const projectId = MapIdentifierSchema.parse(request.params.projectId);
    const input = parseInput(MapProjectRetryInputSchema, request.body);
    let output = await deps.sourceImportService.retryImport(projectId, input);
    if (output.lifecycle === 'importing') {
      let accepted = false;
      try { accepted = deps.importJobRunner.enqueue(projectId); } catch { accepted = false; }
      if (!accepted) output = await deps.sourceImportService.failRetryEnqueue(projectId, input);
    }
    response.json(output);
  }));

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) { next(error); return; }
    if (isMapDraftError(error)) {
      sendError(response, statusFor(error.code), error.code, error.message, error.retryable, error.details);
      return;
    }
    const bodyStatus = jsonBodyErrorStatus(error);
    if (bodyStatus !== null) {
      sendError(response, bodyStatus, 'INVALID_INPUT', 'The map import request is invalid.');
      return;
    }
    sendError(response, 500, 'INTERNAL', 'The map import request failed.');
  });
  return router;
}

function parseInput<T>(schema: { parse(input: unknown): T }, value: unknown): T {
  try { return schema.parse(value); } catch { throw invalidInput(); }
}

function statusFor(code: MapToolErrorCode): number {
  if (code === 'INVALID_INPUT') return 400;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'RUN_NOT_AUTHORIZED') return 403;
  if (code === 'SOURCE_UNAVAILABLE' || code === 'IDEMPOTENCY_CONFLICT' || code === 'REVISION_CONFLICT') return 409;
  return 500;
}

function jsonBodyErrorStatus(error: unknown): 400 | 413 | null {
  if (!error || typeof error !== 'object') return null;
  const type = (error as { type?: unknown }).type;
  if (type === 'entity.parse.failed') return 400;
  if (type === 'entity.too.large') return 413;
  return null;
}

export type { MapDesignProjectListOutput };
