import { Router, json as expressJson, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { MapIdentifierSchema, MapProjectRetryInputSchema, type MapToolErrorCode } from '@mapseekai/map-design-contracts';
import {
  UpdateMapDesignConversationRuntimeRequestSchema,
  type CreateMapDesignConversationInput,
  type UpdateMapDesignConversationRuntimeRequest,
} from '@mapseekai/contracts';

import type { MapDesignConversationService } from '../application/conversation-service.js';
import type { MapDesignConversationRuntimeService } from '../application/conversation-runtime-service.js';
import { invalidInput, isMapDraftError } from '../application/errors.js';
import { route, requireJson, sendError } from './route-helpers.js';

export interface CreateMapDesignConversationRouterDependencies {
  service: Pick<MapDesignConversationService, 'list' | 'get' | 'create' | 'delete'>;
  runtimeService?: Pick<MapDesignConversationRuntimeService, 'get' | 'update'>;
  requireLocalDaemonRequest: RequestHandler;
}

const COLLECTION = '/api/map-design/projects/:projectId/conversations';
const CONVERSATION = `${COLLECTION}/:conversationId`;
const parseJson = expressJson({ limit: 64 * 1024, strict: true });

export function createMapDesignConversationRouter(deps: CreateMapDesignConversationRouterDependencies): Router {
  const router = Router();
  router.use(COLLECTION, deps.requireLocalDaemonRequest);
  router.use(COLLECTION, requireProjectId);
  router.get(COLLECTION, rejectReadBody, route(async (request, response) => {
    response.json(deps.service.list(projectId(request)));
  }));
  router.use(CONVERSATION, requireConversationId);
  router.get(CONVERSATION, rejectReadBody, route(async (request, response) => {
    response.json(deps.service.get(projectId(request), conversationId(request)));
  }));
  router.delete(CONVERSATION, rejectReadBody, route(async (request, response) => {
    deps.service.delete(projectId(request), conversationId(request));
    response.status(204).end();
  }));
  if (deps.runtimeService) {
    router.get(`${CONVERSATION}/runtime`, rejectReadBody, route(async (request, response) => {
      response.json(deps.runtimeService!.get(projectId(request), conversationId(request)));
    }));
    router.put(`${CONVERSATION}/runtime`, parseJson, requireJson, route(async (request, response) => {
      response.json(deps.runtimeService!.update(
        projectId(request), conversationId(request), parseRuntimeUpdateInput(request.body),
      ));
    }));
  }
  router.post(COLLECTION, parseJson, requireJson, route(async (request, response) => {
    response.status(201).json(deps.service.create(projectId(request), parseCreateInput(request.body)));
  }));
  router.use(COLLECTION, errorHandler);
  return router;
}

function requireConversationId(request: Request, response: Response, next: NextFunction): void {
  if (!MapIdentifierSchema.safeParse(request.params.conversationId).success) {
    sendError(response, 400, 'INVALID_INPUT', 'The map conversation request is invalid.');
    return;
  }
  next();
}

function requireProjectId(request: Request, response: Response, next: NextFunction): void {
  if (!MapIdentifierSchema.safeParse(request.params.projectId).success) {
    sendError(response, 400, 'INVALID_INPUT', 'The map conversation request is invalid.');
    return;
  }
  next();
}

function projectId(request: Request): string {
  return MapIdentifierSchema.parse(request.params.projectId);
}

function conversationId(request: Request): string {
  return MapIdentifierSchema.parse(request.params.conversationId);
}

function parseCreateInput(value: unknown): CreateMapDesignConversationInput {
  try {
    return MapProjectRetryInputSchema.parse(value);
  } catch {
    throw invalidInput();
  }
}

function parseRuntimeUpdateInput(value: unknown): UpdateMapDesignConversationRuntimeRequest {
  try {
    const parsed = UpdateMapDesignConversationRuntimeRequestSchema.parse(value);
    return {
      expectedRevision: parsed.expectedRevision,
      clientRequestId: parsed.clientRequestId,
      runtime: {
        agentId: parsed.runtime.agentId,
        ...(parsed.runtime.model === undefined ? {} : { model: parsed.runtime.model }),
        ...(parsed.runtime.reasoning === undefined ? {} : { reasoning: parsed.runtime.reasoning }),
        ...(parsed.runtime.serviceTier === undefined ? {} : { serviceTier: parsed.runtime.serviceTier }),
      },
    };
  } catch {
    throw invalidInput();
  }
}

function rejectReadBody(request: Request, response: Response, next: NextFunction): void {
  const contentLength = request.get('content-length');
  const hasTransportBody = (contentLength !== undefined && contentLength.trim() !== '' && contentLength !== '0')
    || request.get('transfer-encoding') !== undefined;
  if (hasTransportBody || (isRecord(request.body) && Object.keys(request.body).length > 0)) {
    sendError(response, 400, 'INVALID_INPUT', 'Read endpoints do not accept a request body.');
    return;
  }
  next();
}

function errorHandler(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  if (response.headersSent) { next(error); return; }
  if (isMapDraftError(error)) {
    sendError(response, statusFor(error.code), error.code, error.message, error.retryable, error.details);
    return;
  }
  const bodyStatus = jsonBodyErrorStatus(error);
  if (bodyStatus !== null) {
    sendError(response, bodyStatus, 'INVALID_INPUT', 'The map conversation request is invalid.');
    return;
  }
  sendError(response, 500, 'INTERNAL', 'The map conversation request failed.');
}

function statusFor(code: MapToolErrorCode): number {
  if (code === 'INVALID_INPUT') return 400;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'RUN_NOT_AUTHORIZED') return 403;
  if (code === 'IDEMPOTENCY_CONFLICT' || code === 'RUNTIME_CONFLICT') return 409;
  return 500;
}

function jsonBodyErrorStatus(error: unknown): 400 | 413 | null {
  if (!error || typeof error !== 'object') return null;
  const type = (error as { type?: unknown }).type;
  if (type === 'entity.parse.failed') return 400;
  if (type === 'entity.too.large') return 413;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
