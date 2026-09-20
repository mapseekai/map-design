import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { MapToolErrorSchema, type MapToolErrorCode } from '@mapseekai/map-design-contracts';

export function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next) => { void handler(request, response).catch(next); };
}

export function requireJson(request: Request, response: Response, next: NextFunction): void {
  if (!request.is('application/json')) {
    sendError(response, 415, 'INVALID_INPUT', 'The request content type must be application/json.');
    return;
  }
  next();
}

export function sendError(
  response: Response,
  status: number,
  code: MapToolErrorCode,
  message: string,
  retryable = false,
  details?: unknown,
): void {
  response.status(status).json({
    error: MapToolErrorSchema.parse({
      code,
      message,
      retryable,
      ...(details === undefined ? {} : { details }),
    }),
  });
}

export function bodyErrorStatus(error: unknown): 400 | 413 | null {
  if (!error || typeof error !== 'object') return null;
  const type = (error as { type?: unknown }).type;
  return type === 'entity.parse.failed' ? 400 : type === 'entity.too.large' ? 413 : null;
}
