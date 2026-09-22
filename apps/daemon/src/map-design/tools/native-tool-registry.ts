import { createHash } from 'node:crypto';

import {
  MAP_TOOL_NAMES,
  MapApplyTransactionInputSchema,
  MapCommitRevisionInputSchema,
  MapDiscardDraftInputSchema,
  MapGetContextInputSchema,
  MapInspectInputSchema,
  MapRenderPreviewInputSchema,
  MapSearchLayersInputSchema,
  MapToolInputSchemas,
  MapToolNameSchema,
  MapToolOutputSchemas,
  MapUpdateSemanticsInputSchema,
  MapValidateInputSchema,
  type MapToolName,
} from '@mapseekai/map-design-contracts';
import type { SafeToolSummary } from '@mapseekai/contracts';
import { STYLE_TOOL_ERROR_CODES, type StyleDocument, type StyleToolError } from 'maplibre-style-tools/core';

import type { MapDraftService } from '../application/draft-service.js';
import { isMapDraftError } from '../application/errors.js';
import {
  isMapPreviewRequestCancellation,
  type MapPreviewRequestService,
} from '../application/preview-request-service.js';
import type { MapDesignQueryService } from '../application/query-service.js';
import type { MapRevisionService, MapTrustedRunStore } from '../application/revision-service.js';
import type { MapDesignValidationService } from '../application/validation-service.js';
import { createMapStyleSdk, type MapStyleSdk } from '../sdk/style-sdk.js';
import type { MapDesignBlobStore, MapDesignProjectRepository } from '../storage/types.js';
import {
  containsSensitivePublicText,
  summarizeNativeMapTool,
} from './safe-tool-summary.js';
import { nativeMapToolDefinitions } from './model-tool-definitions.js';
import { sdkInspectionInput } from './sdk-read-preflight.js';
import { mapModelContent } from './model-tool-content.js';
import type {
  MapDesignNativeToolRegistry,
  MapNativeToolCallContext,
  MapNativeToolResult,
  NativeMapToolDefinition,
} from './tool-context.js';

const ATOMIC_MUTATIONS = new Set<MapToolName>([
  'map_apply_transaction',
  'map_update_semantics',
  'map_render_preview',
  'map_commit_revision',
  'map_discard_draft',
]);
const NATIVE_IDEMPOTENT_WRITES = new Set<MapToolName>([
  'map_apply_transaction',
  'map_update_semantics',
  'map_render_preview',
  'map_commit_revision',
  'map_discard_draft',
]);

const DEFINITIONS = nativeMapToolDefinitions();
const MAX_SAFE_ISSUE_COUNT = 100;
const MAX_SAFE_DETAIL_ENTRIES = 8;
const MAX_SAFE_DETAIL_KEY_LENGTH = 64;
const MAX_SAFE_DETAIL_STRING_LENGTH = 256;
const MAX_SAFE_POINTER_SEGMENTS = 16;
const TRUSTED_SDK_POINTER_ROOTS = new Set(['transaction', 'operations', 'layers', 'sources']);
const SAFE_POINTER_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_-]*|0|[1-9][0-9]*)$/u;
const UNSAFE_SDK_DETAIL_KEY = /(error|message|path|provider|style|url)/iu;
const UNSAFE_SDK_DETAIL_VALUE = /(error|provider)/iu;

export interface CreateMapDesignNativeToolRegistryDependencies {
  repository: Pick<MapDesignProjectRepository, 'get'>;
  blobStore: Pick<MapDesignBlobStore, 'getJson'>;
  query: Pick<MapDesignQueryService, 'getContext' | 'inspect' | 'searchLayers'>;
  draft: Pick<MapDraftService, 'applyTransaction' | 'updateSemantics'>;
  validation: Pick<MapDesignValidationService, 'validate'>;
  preview: Pick<MapPreviewRequestService, 'requestAndWait'>;
  revision: Pick<MapRevisionService, 'commit' | 'discard'>;
  runStore: MapTrustedRunStore;
  sdk?: MapStyleSdk;
}

type NativeMapToolError = Extract<MapNativeToolResult, { ok: false }>['error'];

class MapReadPreflightError extends Error {
  constructor(readonly failure: NativeMapToolError) { super(failure.message); }
}

export function createMapDesignNativeToolRegistry(
  deps: CreateMapDesignNativeToolRegistryDependencies,
): MapDesignNativeToolRegistry {
  const sdk = deps.sdk ?? createMapStyleSdk();
  return {
    definitions: () => DEFINITIONS,
    call: async (context, name, rawInput) => {
      const toolUseId = safeToolUseId(context);
      if (!MapToolNameSchema.safeParse(name).success) return unknownTool(toolUseId);
      if (!validSignal(context.signal)) return invalidInput(toolUseId);
      if (context.signal.aborted) return cancelled(toolUseId);

      const authorization = authorizedRun(deps.runStore, context);
      if (!authorization) return failure(toolUseId, 'RUN_NOT_AUTHORIZED');

      const parsedInput = MapToolInputSchemas[name].safeParse(rawInput);
      if (!parsedInput.success) return invalidInput(toolUseId, zodIssueDetails(parsedInput.error.issues));
      const nativeInput = normalizeNativeInput(name, parsedInput.data, context.runId);

      const revisionFailure = NATIVE_IDEMPOTENT_WRITES.has(name)
        ? null
        : expectedRevisionFailure(deps.repository, context, nativeInput);
      if (revisionFailure) return { ok: false, toolUseId, error: revisionFailure };

      try {
        if (context.signal.aborted) return cancelled(toolUseId);

        const operation = invoke(deps, context, name, nativeInput, sdk);
        const output = ATOMIC_MUTATIONS.has(name)
          ? await operation
          : await abortable(operation, context.signal);
        if (!ATOMIC_MUTATIONS.has(name) && context.signal.aborted) return cancelled(toolUseId);
        const validatedOutput = MapToolOutputSchemas[name].parse(output);
        return {
          ok: true,
          toolUseId,
          summary: summarizeNativeMapTool(name, nativeInput, validatedOutput),
          ...mapModelContent(name, validatedOutput),
        };
      } catch (error) {
        if (error instanceof MapReadPreflightError) return { ok: false, toolUseId, error: error.failure };
        if (isMapPreviewRequestCancellation(error)) return cancelled(toolUseId);
        if (isMapDraftError(error)) {
          return {
            ok: false,
            toolUseId,
            error: {
              code: error.code,
              message: safeDomainMessage(error.code),
              retryable: error.retryable,
              ...safeDraftDiagnostics(error.details),
            },
          };
        }
        if (isAbort(error) || (!ATOMIC_MUTATIONS.has(name) && context.signal.aborted)) {
          return cancelled(toolUseId);
        }
        return failure(toolUseId, 'INTERNAL');
      }
    },
  };
}

function normalizeNativeInput(name: MapToolName, input: unknown, runId: string): unknown {
  switch (name) {
    case 'map_apply_transaction': {
      const request = MapApplyTransactionInputSchema.parse(input);
      return {
        ...request,
        idempotencyKey: nativeIdempotencyKey(runId, request.idempotencyKey),
        transaction: sdkTransactionFields(request.transaction),
      };
    }
    case 'map_update_semantics': {
      const request = MapUpdateSemanticsInputSchema.parse(input);
      return { ...request, idempotencyKey: nativeIdempotencyKey(runId, request.idempotencyKey) };
    }
    case 'map_render_preview': {
      const request = MapRenderPreviewInputSchema.parse(input);
      return { ...request, idempotencyKey: nativeIdempotencyKey(runId, request.idempotencyKey) };
    }
    case 'map_commit_revision': {
      const request = MapCommitRevisionInputSchema.parse(input);
      return { ...request, idempotencyKey: nativeIdempotencyKey(runId, request.idempotencyKey) };
    }
    case 'map_discard_draft': {
      const request = MapDiscardDraftInputSchema.parse(input);
      return { ...request, idempotencyKey: nativeIdempotencyKey(runId, request.idempotencyKey) };
    }
    default:
      return input;
  }
}

function nativeIdempotencyKey(runId: string, publicKey: string): string {
  const digest = createHash('sha256')
    .update(`${runId.length}:${runId}${publicKey.length}:${publicKey}`)
    .digest('hex');
  return `native:${digest}`;
}

function sdkTransactionFields(transaction: unknown): unknown {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) return transaction;
  const value = transaction as Record<string, unknown>;
  return {
    operations: value.operations,
    ...(Object.hasOwn(value, 'validate') ? { validate: value.validate } : {}),
  };
}

function invoke(
  deps: CreateMapDesignNativeToolRegistryDependencies,
  context: MapNativeToolCallContext,
  name: MapToolName,
  input: unknown,
  sdk: MapStyleSdk,
): Promise<unknown> {
  const runContext = {
    projectId: context.projectId,
    runId: context.runId,
    signal: context.signal,
  };
  const beforeRead = (style: StyleDocument) => {
    if (context.signal.aborted) throw new DOMException('Canceled', 'AbortError');
    const inspection = sdkInspectionInput(name, input);
    if (inspection === null) return;
    const result = sdk.inspect(style, inspection);
    if (!result.success) {
      const failure = sdkError(result.error);
      throw new MapReadPreflightError(failure);
    }
    if (context.signal.aborted) throw new DOMException('Canceled', 'AbortError');
  };
  switch (name) {
    case 'map_get_context':
      MapGetContextInputSchema.parse(input);
      return deps.query.getContext(context.projectId, beforeRead);
    case 'map_inspect':
      return deps.query.inspect(context.projectId, MapInspectInputSchema.parse(input), beforeRead);
    case 'map_search_layers':
      return deps.query.searchLayers(context.projectId, MapSearchLayersInputSchema.parse(input), beforeRead);
    case 'map_apply_transaction':
      return deps.draft.applyTransaction(runContext, MapApplyTransactionInputSchema.parse(input));
    case 'map_update_semantics':
      return deps.draft.updateSemantics(runContext, MapUpdateSemanticsInputSchema.parse(input));
    case 'map_validate':
      return deps.validation.validate(context.projectId, MapValidateInputSchema.parse(input));
    case 'map_render_preview':
      return deps.preview.requestAndWait(runContext, MapRenderPreviewInputSchema.parse(input));
    case 'map_commit_revision':
      return deps.revision.commit(runContext, MapCommitRevisionInputSchema.parse(input));
    case 'map_discard_draft':
      return deps.revision.discard(runContext, MapDiscardDraftInputSchema.parse(input));
  }
}

function expectedRevisionFailure(
  repository: Pick<MapDesignProjectRepository, 'get'>,
  context: MapNativeToolCallContext,
  input: unknown,
): NativeMapToolError | null {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'expectedRevision')) return null;
  const project = repository.get(context.projectId);
  if (!project) return error('NOT_FOUND', false);
  const expectedRevision = (input as { expectedRevision?: unknown }).expectedRevision;
  if (expectedRevision === project.draftRevision) return null;
  return error('REVISION_CONFLICT', true);
}

function authorizedRun(runStore: MapTrustedRunStore, context: MapNativeToolCallContext): boolean {
  try {
    const run = runStore.get(context.runId);
    return run?.runId === context.runId && run.projectId === context.projectId;
  } catch {
    return false;
  }
}

function validSignal(signal: AbortSignal): boolean {
  return Boolean(signal)
    && typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function'
    && typeof signal.removeEventListener === 'function';
}

function safeToolUseId(context: MapNativeToolCallContext): string {
  return typeof context?.toolUseId === 'string' && context.toolUseId.length > 0
    ? context.toolUseId
    : 'unknown-tool-call';
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (operationError: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(operationError);
      },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function isAbort(value: unknown): boolean {
  return value instanceof DOMException && value.name === 'AbortError';
}

function sdkError(sdkFailure: StyleToolError): NativeMapToolError {
  const code = sdkFailure.code === 'STYLE_INVALID'
    || sdkFailure.code === 'NOT_FOUND'
    || sdkFailure.code === 'INVALID_INPUT'
    ? sdkFailure.code
    : 'INTERNAL';
  return error(code, false, sdkErrorDetails(sdkFailure));
}

function safeDraftDiagnostics(value: unknown): { details?: SafeToolSummary } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const details: SafeToolSummary = {};
  if (STYLE_TOOL_ERROR_CODES.some((code) => code === input.category)) details.category = input.category as string;
  if (typeof input.operationIndex === 'number' && Number.isInteger(input.operationIndex) && input.operationIndex >= 0 && input.operationIndex < 100) {
    details.operationIndex = input.operationIndex;
  }
  if (typeof input.firstPath === 'string' && /^(?:transaction\.operations\.\d{1,2}(?:\.(?:op|sourceId|layerId|source|layer|data|type|paint|layout|filter|mode|properties|sourceOptions|beforeId|afterId|overrides))?|layers\.\d{1,4}\.(?:paint|layout)|sources)$/.test(input.firstPath)) {
    details.firstPath = input.firstPath;
  }
  return Object.keys(details).length ? { details } : {};
}

function safeDomainMessage(code: string): string {
  return error(code, code === 'REVISION_CONFLICT').message;
}

function error(
  code: string,
  retryable: boolean,
  details?: SafeToolSummary,
): NativeMapToolError {
  const messages: Record<string, string> = {
    CANCELLED: 'The map tool call was cancelled.',
    IDEMPOTENCY_CONFLICT: 'The idempotency key conflicts with an earlier request.',
    INTERNAL: 'The map tool call failed.',
    INVALID_INPUT: 'The map tool input is invalid.',
    NOT_FOUND: 'The requested map resource was not found.',
    PREVIEW_FAILED: 'The map preview failed.',
    PREVIEW_STALE: 'The map preview is stale.',
    PROJECT_NOT_READY: 'The map project is not ready.',
    REVISION_CONFLICT: 'The map draft revision has changed.',
    RUN_NOT_AUTHORIZED: 'The map run is not authorized.',
    SEMANTIC_INVALID: 'The map semantics are invalid.',
    SOURCE_UNAVAILABLE: 'The map source is unavailable.',
    STYLE_INVALID: 'The map style is invalid.',
    DESIGN_SYSTEM_VIOLATION: 'The map violates the selected design system.',
    UNKNOWN_TOOL: 'The map tool is not registered.',
  };
  return {
    code,
    message: messages[code] ?? messages.INTERNAL!,
    retryable,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
}

function failure(
  toolUseId: string,
  code: string,
  retryable = false,
  details?: SafeToolSummary,
): Extract<MapNativeToolResult, { ok: false }> {
  return { ok: false, toolUseId, error: error(code, retryable, details) };
}

function invalidInput(
  toolUseId: string,
  details?: SafeToolSummary,
): Extract<MapNativeToolResult, { ok: false }> {
  return failure(toolUseId, 'INVALID_INPUT', false, details);
}

function unknownTool(toolUseId: string): Extract<MapNativeToolResult, { ok: false }> {
  return failure(toolUseId, 'UNKNOWN_TOOL');
}

function cancelled(toolUseId: string): Extract<MapNativeToolResult, { ok: false }> {
  return failure(toolUseId, 'CANCELLED');
}

function zodIssueDetails(
  issues: readonly SafeZodIssue[],
): SafeToolSummary {
  const flattened = flattenZodIssues(issues);
  const first = flattened.reduce<(typeof flattened)[number] | undefined>((selected, candidate) => (
    !selected || candidate.path.length > selected.path.length ? candidate : selected
  ), undefined);
  const firstPath = first?.path
    .map((part) => typeof part === 'symbol' ? part.description ?? 'symbol' : String(part))
    .join('.')
    .slice(0, MAX_SAFE_DETAIL_STRING_LENGTH);
  return {
    issueCount: flattened.length,
    ...(first?.code ? { firstIssueCode: first.code.slice(0, MAX_SAFE_DETAIL_STRING_LENGTH) } : {}),
    ...(firstPath ? { firstPath } : {}),
  };
}

type SafeZodIssue = {
  code: string;
  path: readonly PropertyKey[];
  errors?: readonly (readonly SafeZodIssue[])[];
};

function flattenZodIssues(
  issues: readonly SafeZodIssue[],
): Array<{ code: string; path: readonly PropertyKey[] }> {
  const flattened: Array<{ code: string; path: readonly PropertyKey[] }> = [];
  const visit = (issue: SafeZodIssue, parentPath: readonly PropertyKey[]): void => {
    if (flattened.length >= MAX_SAFE_ISSUE_COUNT) return;
    const path = [...parentPath, ...issue.path];
    const nested = issue.errors?.flat();
    if (nested && nested.length > 0) {
      for (const child of nested) visit(child, path);
      return;
    }
    flattened.push({ code: issue.code, path });
  };
  for (const issue of issues) visit(issue, []);
  return flattened;
}

function sdkErrorDetails(sdkFailure: StyleToolError): SafeToolSummary | undefined {
  const details: SafeToolSummary = {};
  const firstPath = safeSdkPointerPath(sdkFailure.path);
  if (firstPath) details.firstPath = firstPath;
  if (sdkFailure.details) {
    let count = 0;
    for (const [key, value] of Object.entries(sdkFailure.details)) {
      if (count >= MAX_SAFE_DETAIL_ENTRIES) break;
      if (
        key.length === 0
        || key.length > MAX_SAFE_DETAIL_KEY_LENGTH
        || UNSAFE_SDK_DETAIL_KEY.test(key)
        || !safeSdkText(key, MAX_SAFE_DETAIL_KEY_LENGTH)
        || !safeSdkPrimitive(value)
      ) continue;
      details[key] = typeof value === 'string'
        ? value.slice(0, MAX_SAFE_DETAIL_STRING_LENGTH)
        : value;
      count += 1;
    }
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function safeSdkPointerPath(value: unknown): string | undefined {
  if (
    typeof value !== 'string'
    || value.length < 2
    || value.length > MAX_SAFE_DETAIL_STRING_LENGTH
    || !value.startsWith('/')
  ) return undefined;
  const encodedSegments = value.slice(1).split('/');
  if (
    encodedSegments.length === 0
    || encodedSegments.length > MAX_SAFE_POINTER_SEGMENTS
    || encodedSegments.some((segment) => segment.length === 0 || /~(?![01])/u.test(segment))
  ) return undefined;
  const segments = encodedSegments.map((segment) => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'));
  if (
    !TRUSTED_SDK_POINTER_ROOTS.has(segments[0]!)
    || segments.some((segment) => !SAFE_POINTER_SEGMENT.test(segment))
  ) return undefined;
  const normalized = segments.join('.');
  return safeSdkText(normalized, MAX_SAFE_DETAIL_STRING_LENGTH) ? normalized : undefined;
}

function safeSdkPrimitive(value: unknown): value is string | number | boolean | null {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string'
    && !UNSAFE_SDK_DETAIL_VALUE.test(value)
    && safeSdkText(value, MAX_SAFE_DETAIL_STRING_LENGTH);
}

function safeSdkText(value: string, maximumLength: number): boolean {
  return Array.from(value).length <= maximumLength
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && !containsSensitivePublicText(value);
}
