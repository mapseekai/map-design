import { Router, json as expressJson, type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import {
  StartMapDesignRunRequestSchema,
} from '@mapseekai/contracts';
import { isMapDraftError } from '../application/errors.js';
import { MapDesignProjectRunConflictError, MapDesignRunConflictError, MapDesignRunRequestError, type MapDesignRunService } from '../application/run-service.js';

export interface CreateMapDesignRunRouterDependencies {
  runService: Pick<MapDesignRunService, 'start' | 'get' | 'cancel' | 'subscribe'>;
  requireLocalDaemonRequest: RequestHandler;
}

const RUN_ROUTE = '/api/runs/:runId';
const parseRunJson = expressJson({ limit: 64 * 1024, strict: true });

export function createMapDesignRunRouter(deps: CreateMapDesignRunRouterDependencies): Router {
  const router = Router();
  router.use('/api/runs', deps.requireLocalDaemonRequest);
  router.post('/api/runs', parseRunJson, route(async (request, response) => {
    const parsed = StartMapDesignRunRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(response, 400, 'The map run request is invalid.');
    response.status(202).json(await deps.runService.start(parsed.data));
  }));
  router.use(RUN_ROUTE, (request, response, next) => validRunId(request.params.runId) ? next() : sendError(response, 400, 'The run identifier is invalid.'));
  router.get(RUN_ROUTE, route(async (request, response) => {
    const run = deps.runService.get(runId(request));
    if (!run) return sendError(response, 404, 'The map run was not found.');
    response.json(run);
  }));
  router.post(`${RUN_ROUTE}/cancel`, route(async (request, response) => {
    const canceled = await deps.runService.cancel(runId(request));
    if (!canceled) return sendError(response, 404, 'The map run was not found.');
    if (canceled.status !== 'canceled') { response.status(409).json(canceled); return; }
    response.json(canceled);
  }));
  router.get(`${RUN_ROUTE}/events`, (request, response) => {
    if (!deps.runService.get(runId(request))) return sendError(response, 404, 'The map run was not found.');
    response.status(200).set({ 'cache-control': 'no-cache', connection: 'keep-alive', 'content-type': 'text/event-stream' }).flushHeaders();
    response.write(': keepalive\n\n');
    let unsubscribe: () => void = () => {};
    let closed = false;
    let terminalReplayed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      unsubscribe();
    };
    const keepalive = setInterval(() => response.write(': keepalive\n\n'), 15_000);
    keepalive.unref?.();
    unsubscribe = deps.runService.subscribe(runId(request), (event) => {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'run_finished') { terminalReplayed = true; close(); response.end(); }
    });
    if (terminalReplayed) unsubscribe();
    else if (closed || response.writableEnded) close();
    // A completed request body does not mean the streaming response disconnected.
    response.once('close', close);
  });
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) return next(error);
    if (error instanceof MapDesignProjectRunConflictError) return sendError(response, 409, 'Another run is already active for this project.');
    if (error instanceof MapDesignRunConflictError) return sendError(response, 409, 'The client request identifier conflicts with an existing run.');
    if (isMapDraftError(error) && ['RUNTIME_CONFLICT', 'REVISION_CONFLICT', 'PROJECT_NOT_READY', 'NOT_FOUND'].includes(error.code)) {
      response.status(error.code === 'NOT_FOUND' ? 404 : 409).json({
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
      return;
    }
    if (isMapDraftError(error) && error.code === 'INVALID_INPUT') return sendError(response, 400, 'The map run request is invalid.');
    if (isJsonBodyError(error, 'entity.too.large', 413)) {
      return sendError(response, 413, 'The map run request is too large.');
    }
    if (error instanceof MapDesignRunRequestError || isJsonBodyError(error, 'entity.parse.failed', 400)) {
      return sendError(response, 400, 'The map run request is invalid.');
    }
    sendError(response, 500, 'The map run could not be processed.');
  });
  return router;
}

function isJsonBodyError(error: unknown, type: string, status: number): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { type?: unknown; status?: unknown };
  return candidate.type === type && candidate.status === status;
}

function validRunId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function runId(request: Request): string {
  return typeof request.params.runId === 'string' ? request.params.runId : '';
}

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next) => { void handler(request, response).catch(next); };
}

function sendError(response: Response, status: number, message: string): void {
  const code = status === 404
    ? 'NOT_FOUND'
    : status === 500
      ? 'INTERNAL_ERROR'
      : status === 409
        ? 'CONFLICT'
        : status === 413
          ? 'PAYLOAD_TOO_LARGE'
          : 'INVALID_INPUT';
  response.status(status).json({ error: { code, message } });
}
