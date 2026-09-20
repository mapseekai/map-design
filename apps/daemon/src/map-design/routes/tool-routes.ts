import { randomUUID } from 'node:crypto';

import {
  MAP_TOOL_NAMES,
  MapToolInputSchemas,
  type MapPublicErrorDetails,
  type MapToolErrorCode,
  type MapToolName,
} from '@mapseekai/map-design-contracts';

import { json, type Express, type Request, type Response } from 'express';

import { isMapDraftError } from '../application/errors.js';
import type { ToolTokenGrant } from '../../tool-tokens.js';
import {
  MAP_DESIGN_TOOL_ENDPOINTS,
  MAP_DESIGN_TOOL_OPERATIONS,
} from '../../tool-tokens.js';
import type { MapToolHandlerRegistry } from '../tools/tool-handlers.js';
import type { SdkMapToolRuntime } from '../agents/sdk-tool-runtime.js';
import {
  RUN_TOOL_CALLBACK_AGENT_HEADER,
  RUN_TOOL_CALLBACK_CONVERSATION_HEADER,
  RUN_TOOL_CALLBACK_PROJECT_HEADER,
  RUN_TOOL_CALLBACK_RUN_HEADER,
  RUN_TOOL_CALLBACK_TOOL_USE_HEADER,
} from '../agents/tool-callback.js';


export interface MapDesignToolRouteDefinition {
  readonly name: MapToolName;
  readonly endpoint: (typeof MAP_DESIGN_TOOL_ENDPOINTS)[number];
  readonly operation: (typeof MAP_DESIGN_TOOL_OPERATIONS)[number];
}

export interface MapDesignToolProjectReader {
  getProject(projectId: string): Promise<{ lifecycle: 'importing' | 'ready' | 'failed' }>;
}


export const MAP_DESIGN_TOOL_ROUTES: readonly MapDesignToolRouteDefinition[] = MAP_TOOL_NAMES.map(
  (name, index) => ({
    name,
    endpoint: MAP_DESIGN_TOOL_ENDPOINTS[index]!,
    operation: MAP_DESIGN_TOOL_OPERATIONS[index]!,
  }),
);

export interface RegisterMapDesignToolRoutesDeps {
  auth: {
    authorizeToolRequest(
      req: Request,
      res: Response,
      operation: string,
      options?: {
        endpoint?: string;
        runId?: string;
        projectId?: string;
        conversationId?: string;
        agentId?: string;
      },
    ): ToolTokenGrant | null;
  };
  projectReader: MapDesignToolProjectReader;
  handlers: MapToolHandlerRegistry;
  sdkToolRuntime?: SdkMapToolRuntime;
  noteActivity?(runId: string): void;
  randomId?: () => string;
}

export function registerMapDesignToolRoutes(
  app: Express,
  deps: RegisterMapDesignToolRoutesDeps,
): void {
  app.use('/api/map-design/tools', json({ limit: '1mb', strict: true }));
  for (const definition of MAP_DESIGN_TOOL_ROUTES) {
    app.post(definition.endpoint, async (req, res) => {
      const grant = deps.auth.authorizeToolRequest(
        req,
        res,
        definition.operation,
        {
          endpoint: definition.endpoint,
          ...optionalHeaderIdentity('runId', req.get(RUN_TOOL_CALLBACK_RUN_HEADER)),
          ...optionalHeaderIdentity('projectId', req.get(RUN_TOOL_CALLBACK_PROJECT_HEADER)),
          ...optionalHeaderIdentity('conversationId', req.get(RUN_TOOL_CALLBACK_CONVERSATION_HEADER)),
          ...optionalHeaderIdentity('agentId', req.get(RUN_TOOL_CALLBACK_AGENT_HEADER)),
        },
      );
      if (!grant) return;

      const requestId = (deps.randomId ?? randomUUID)();
      const meta = {
        requestId,
        projectId: grant.projectId,
        runId: grant.runId,
      };
      const callbackToolUseId = grant.agentId === undefined
        ? null
        : safeHeaderIdentifier(req.get(RUN_TOOL_CALLBACK_TOOL_USE_HEADER));
      try {
        const project = await deps.projectReader.getProject(grant.projectId);
        if (project.lifecycle !== 'ready') {
          res.json(routeError(grant, callbackToolUseId, meta, 'PROJECT_NOT_READY', 'The map project is not ready.'));
          return;
        }
      } catch (error) {
        if (isMapDraftError(error)) {
          res.json(routeError(grant, callbackToolUseId, meta, error.code, error.message, error.retryable, error.details));
          return;
        }
        res.json(routeError(grant, callbackToolUseId, meta, 'INTERNAL', 'The map tool request failed.'));
        return;
      }
      const parsed = MapToolInputSchemas[definition.name].safeParse(req.body);
      if (!parsed.success) {
        res.json(routeError(grant, callbackToolUseId, meta, 'INVALID_INPUT', 'The map tool input is invalid.'));
        return;
      }

      if (grant.agentId !== undefined) {
        if (!deps.sdkToolRuntime || !grant.conversationId || !callbackToolUseId) {
          res.status(400).json(routeError(grant, callbackToolUseId, meta, 'INVALID_INPUT', 'The map tool callback is invalid.'));
          return;
        }
        const controller = new AbortController();
        req.once('aborted', () => controller.abort());
        const result = await deps.sdkToolRuntime.execute({
          runId: grant.runId,
          projectId: grant.projectId,
          conversationId: grant.conversationId,
          agentId: grant.agentId,
          toolUseId: callbackToolUseId,
          name: definition.name,
          input: parsed.data,
          signal: controller.signal,
          activity: () => deps.noteActivity?.(grant.runId),
        });
        res.json(result);
        return;
      }

      const envelope = await deps.handlers[definition.name](
        { ...meta, signal: new AbortController().signal },
        parsed.data,
      );
      res.json(envelope);
    });
  }
}

function routeError(
  grant: ToolTokenGrant,
  callbackToolUseId: string | null,
  meta: { requestId: string; projectId: string; runId: string },
  code: MapToolErrorCode,
  message: string,
  retryable = false,
  details?: MapPublicErrorDetails,
) {
  if (grant.agentId !== undefined && callbackToolUseId !== null) {
    return {
      ok: false as const,
      toolUseId: callbackToolUseId,
      error: { code, message, retryable },
    };
  }
  return errorEnvelope(meta, code, message, retryable, details);
}

function optionalHeaderIdentity<Key extends 'runId' | 'projectId' | 'conversationId' | 'agentId'>(
  key: Key,
  value: string | undefined,
): Partial<Record<Key, string>> {
  const parsed = safeHeaderIdentifier(value);
  return parsed === null ? {} : { [key]: parsed } as Partial<Record<Key, string>>;
}

function safeHeaderIdentifier(value: unknown): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\r\n\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function errorEnvelope(
  meta: { requestId: string; projectId: string; runId: string },
  code: MapToolErrorCode,
  message: string,
  retryable = false,
  details?: MapPublicErrorDetails,
) {
  return {
    ok: false as const,
    error: {
      code,
      message,
      retryable,
      ...(details === undefined ? {} : { details }),
    },
    meta,
  };
}
