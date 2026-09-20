import {
  MAP_TOOL_NAMES,
  MapIdentifierSchema,
  MapToolInputSchemas,
  MapToolOutputSchemas,
  type MapToolEnvelope,
  type MapToolName,
} from '@mapseekai/map-design-contracts';

import type { MapDraftService } from '../application/draft-service.js';
import { MapDraftError, isMapDraftError } from '../application/errors.js';
import type { MapPreviewRequestService } from '../application/preview-request-service.js';
import type { MapDesignQueryService } from '../application/query-service.js';
import type { MapRevisionService, MapTrustedRunStore } from '../application/revision-service.js';
import type { MapDesignValidationService } from '../application/validation-service.js';
import type { MapToolCallContext, MapToolHandler } from './tool-context.js';

export interface MapToolHandlerDependencies {
  query: Pick<MapDesignQueryService, 'getContext' | 'inspect' | 'searchLayers'>;
  draft: Pick<MapDraftService, 'applyTransaction' | 'updateSemantics'>;
  validation: Pick<MapDesignValidationService, 'validate'>;
  preview: MapPreviewRequestService;
  revision: Pick<MapRevisionService, 'commit' | 'discard'>;
  runStore: MapTrustedRunStore;
}

export type MapToolHandlerRegistry = Record<MapToolName, MapToolHandler>;
export type MapToolHandlers = MapToolHandlerRegistry;

export function createMapToolHandlers(deps: MapToolHandlerDependencies): MapToolHandlerRegistry {
  const registry = {
    map_get_context: handler('map_get_context', deps, (context) => deps.query.getContext(context.projectId)),
    map_inspect: handler('map_inspect', deps, (context, input) => deps.query.inspect(context.projectId, input)),
    map_search_layers: handler('map_search_layers', deps, (context, input) => deps.query.searchLayers(context.projectId, input)),
    map_apply_transaction: handler('map_apply_transaction', deps, (context, input) => deps.draft.applyTransaction(context, input)),
    map_update_semantics: handler('map_update_semantics', deps, (context, input) => deps.draft.updateSemantics(context, input)),
    map_validate: handler('map_validate', deps, (context, input) => deps.validation.validate(context.projectId, input)),
    map_render_preview: handler('map_render_preview', deps, (context, input) => deps.preview.requestAndWait(context, input)),
    map_commit_revision: handler('map_commit_revision', deps, (context, input) => deps.revision.commit(context, input)),
    map_discard_draft: handler('map_discard_draft', deps, (context, input) => deps.revision.discard(context, input)),
  } satisfies MapToolHandlerRegistry;
  if (Object.keys(registry).some((name, index) => name !== MAP_TOOL_NAMES[index])) {
    throw new TypeError('MapDesign tool registry does not match the contract');
  }
  return registry;
}

export const createMapDesignToolHandlers = createMapToolHandlers;
export const createMapDesignToolHandlerRegistry = createMapToolHandlers;

function handler(
  name: MapToolName,
  deps: Pick<MapToolHandlerDependencies, 'runStore'>,
  invoke: (context: MapToolCallContext, input: never) => Promise<unknown>,
): MapToolHandler {
  return async (context, rawInput) => {
    const meta = safeMeta(context);
    if (!meta) {
      return internalEnvelope({ requestId: 'invalid-request', projectId: 'invalid-project', runId: 'invalid-run' });
    }
    try {
      assertSignal(context.signal);
      if (context.signal.aborted) return cancelledEnvelope(meta);
      requireTrustedRun(deps.runStore, context);
      let parsedInput: never;
      try {
        parsedInput = MapToolInputSchemas[name].parse(rawInput) as never;
      } catch {
        return { ok: false, error: { code: 'INVALID_INPUT', message: 'The map tool input is invalid.', retryable: false }, meta };
      }
      const value = await abortable(Promise.resolve(invoke(context, parsedInput)), context.signal);
      const data = MapToolOutputSchemas[name].parse(value);
      const draftRevision = outputRevision(data);
      return {
        ok: true,
        data,
        meta: { ...meta, ...(draftRevision === undefined ? {} : { draftRevision }) },
      } as MapToolEnvelope<unknown>;
    } catch (error) {
      if (isAbort(error) || context.signal.aborted) return cancelledEnvelope(meta);
      if (isMapDraftError(error)) {
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
          meta,
        };
      }
      return internalEnvelope(meta);
    }
  };
}

function safeMeta(context: MapToolCallContext): { requestId: string; projectId: string; runId: string } | null {
  try {
    const requestId = MapIdentifierSchema.parse(context.requestId);
    const projectId = MapIdentifierSchema.parse(context.projectId);
    const runId = MapIdentifierSchema.parse(context.runId);
    if (requestId !== context.requestId || projectId !== context.projectId || runId !== context.runId) return null;
    return { requestId, projectId, runId };
  } catch {
    return null;
  }
}

function requireTrustedRun(runStore: MapTrustedRunStore, context: MapToolCallContext): void {
  let run;
  try {
    run = runStore.get(context.runId);
  } catch {
    throw new Error('trusted run store unavailable');
  }
  if (!run || run.runId !== context.runId || run.projectId !== context.projectId) {
    throw new MapDraftError('RUN_NOT_AUTHORIZED', 'The map tool run is not authorized.');
  }
}

function assertSignal(signal: AbortSignal): void {
  if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function') {
    throw new TypeError('invalid abort signal');
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function cancelledEnvelope(meta: { requestId: string; projectId: string; runId: string }): MapToolEnvelope<never> {
  return { ok: false, error: { code: 'INTERNAL', message: 'The map tool request was cancelled.', retryable: true }, meta };
}

function internalEnvelope(meta: { requestId: string; projectId: string; runId: string }): MapToolEnvelope<never> {
  return { ok: false, error: { code: 'INTERNAL', message: 'The map tool request failed.', retryable: false }, meta };
}

function outputRevision(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'draftRevision')) return undefined;
  const revision = (value as { draftRevision?: unknown }).draftRevision;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
