import {
  CartographyGenerationSchema,
  CartographyDraftOutputSchema,
  type CartographyGenerateInput,
  type CartographyInitializeInput,
  type CartographyInitializeUrlInput,
  CartographyListOutputSchema,
  CartographySummarySchema,
  CartographyDocumentSchema,
  MapCommitRevisionInputSchema,
  MapCommitRevisionOutputSchema,
  MapCurrentPreviewOutputSchema,
  MapDesignProjectCreateInputSchema,
  MapDesignProjectCreateOutputSchema,
  MapDesignProjectListOutputSchema,
  MapDesignProjectReadSchema,
  MapGetContextOutputSchema,
  MapIdentifierSchema,
  MapInspectInputSchema,
  MapInspectOutputSchema,
  MapPreviewFulfillRequestSchema,
  MapProjectRetryInputSchema,
  MapRenderPreviewOutputSchema,
  MapRestoreRevisionInputSchema,
  MapRestoreRevisionOutputSchema,
  MapRevisionHistoryOutputSchema,
  MapRevisionSnapshotOutputSchema,
  MapSafeRevisionSchema,
  MapSourcePreflightInputSchema,
  MapSourcePreflightOutputSchema,
  MapValidateInputSchema,
  MapValidateOutputSchema,
  type MapCommitRevisionInput,
  type MapCommitRevisionOutput,
  type MapCurrentPreviewOutput,
  type MapDesignProjectCreateInput,
  type MapDesignProjectCreateOutput,
  type MapDesignProjectListOutput,
  type MapDesignProjectRead,
  type MapGetContextOutput,
  type MapInspectOutput,
  type MapPreviewFulfillRequest,
  type MapRenderPreviewOutput,
  type MapRestoreRevisionInput,
  type MapRestoreRevisionOutput,
  type MapRevisionHistoryOutput,
  type MapRevisionSnapshotOutput,
  type MapSourcePreflightOutput,
  type MapValidateOutput,
} from '@mapseekai/map-design-contracts';
import type { StyleSpecification } from 'maplibre-gl';
import { validateStyleDocument } from 'maplibre-style-tools/core';

import { ApiClientError, request } from '../api/request';

export { ApiClientError as MapDesignClientError } from '../api/request';

export function listCartographies(signal?: AbortSignal) {
  return requestContract('/api/map-design/cartographies', { signal }, CartographyListOutputSchema);
}

export function importCartography(source: string, signal?: AbortSignal, description?: string) {
  return requestContract('/api/map-design/cartographies', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source, ...(description === undefined ? {} : { description }) }), signal,
  }, CartographySummarySchema);
}

export function getCartography(id: string, signal?: AbortSignal) {
  return requestContract(`/api/map-design/cartographies/${encodeURIComponent(id)}`, { signal }, CartographyDocumentSchema);
}

export function deleteCartography(id: string, signal?: AbortSignal): Promise<void> {
  return request<null>(`/api/map-design/cartographies/${encodeURIComponent(id)}`,
    { method: 'DELETE', signal }, (value) => value === null).then(() => undefined);
}

interface ContractSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false };
}

function requestContract<T>(
  url: string,
  init: RequestInit,
  schema: ContractSchema<T>,
): Promise<T> {
  let parsed: { data: T } | null = null;
  return request<unknown>(
    url,
    init,
    (value) => {
      const result = schema.safeParse(value);
      if (!result.success) return false;
      parsed = { data: result.data };
      return true;
    },
    'MapDesign returned an invalid response.',
  ).then(() => parsed!.data);
}

export function createMapDesignProject(
  input: MapDesignProjectCreateInput,
  signal?: AbortSignal,
): Promise<MapDesignProjectCreateOutput> {
  return requestContract('/api/map-design/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(MapDesignProjectCreateInputSchema.parse(input)),
    signal,
  }, MapDesignProjectCreateOutputSchema);
}

export function preflightMapSource(
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<MapSourcePreflightOutput> {
  return requestContract('/api/map-design/source-preflight', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(MapSourcePreflightInputSchema.parse({ source: { url: sourceUrl } })),
    signal,
  }, MapSourcePreflightOutputSchema);
}

export function deleteMapSourcePreview(
  previewId: string,
  signal?: AbortSignal,
): Promise<void> {
  const parsed = MapIdentifierSchema.parse(previewId);
  return request<null>(
    `/api/map-design/source-previews/${encodeURIComponent(parsed)}`,
    { method: 'DELETE', signal },
    (value) => value === null,
    'MapDesign could not release the source preview.',
  ).then(() => undefined);
}

export function listMapDesignProjects(signal?: AbortSignal): Promise<MapDesignProjectListOutput> {
  return requestContract('/api/map-design/projects', { signal }, MapDesignProjectListOutputSchema);
}

export function getMapDesignProject(
  projectId: string,
  signal?: AbortSignal,
): Promise<MapDesignProjectCreateOutput> {
  return requestContract(
    `/api/map-design/projects/${encodeURIComponent(projectId)}`,
    { signal },
    MapDesignProjectCreateOutputSchema,
  );
}

export function retryMapDesignImport(
  projectId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<MapDesignProjectRead> {
  return requestContract(projectUrl(projectId, '/retry-import'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(MapProjectRetryInputSchema.parse({ idempotencyKey })),
    signal,
  }, MapDesignProjectReadSchema);
}

export function mapDesignInitialRunClientRequestId(projectId: string): string {
  return `mapdesign-initial-run:${projectId}`;
}

function projectUrl(projectId: string, suffix: string): string {
  return `/api/map-design/projects/${encodeURIComponent(projectId)}${suffix}`;
}

function getProjectContract<T>(
  projectId: string,
  suffix: string,
  schema: ContractSchema<T>,
  signal?: AbortSignal,
): Promise<T> {
  return requestContract(projectUrl(projectId, suffix), { signal }, schema);
}

function postProjectContract<TInput, TOutput>(
  projectId: string,
  suffix: string,
  input: TInput,
  schema: ContractSchema<TOutput>,
  signal?: AbortSignal,
): Promise<TOutput> {
  return requestContract(projectUrl(projectId, suffix), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  }, schema);
}

export function getMapDesignContext(
  projectId: string,
  signal?: AbortSignal,
): Promise<MapGetContextOutput> {
  return getProjectContract(projectId, '/context', MapGetContextOutputSchema, signal);
}

export function getMapDesignStyle(
  projectId: string,
  signal?: AbortSignal,
): Promise<StyleSpecification> {
  return getProjectContract(projectId, '/style', styleSchema, signal);
}

export function inspectMapDesignProject(
  projectId: string,
  signal?: AbortSignal,
): Promise<MapInspectOutput> {
  return postProjectContract(
    projectId,
    '/inspect',
    MapInspectInputSchema.parse({ target: { kind: 'root' } }),
    MapInspectOutputSchema,
    signal,
  );
}

export function validateMapDesignProject(
  projectId: string,
  expectedRevision: number,
  signal?: AbortSignal,
): Promise<MapValidateOutput> {
  return postProjectContract(
    projectId,
    '/validate',
    MapValidateInputSchema.parse({ expectedRevision }),
    MapValidateOutputSchema,
    signal,
  );
}

export function listMapDesignRevisions(
  projectId: string,
  signal?: AbortSignal,
): Promise<MapRevisionHistoryOutput> {
  return getProjectContract(projectId, '/revisions', MapRevisionHistoryOutputSchema, signal);
}

export type MapDesignRevisionSnapshotData = Omit<MapRevisionSnapshotOutput, 'style'> & {
  style: StyleSpecification;
};

export function getMapDesignRevisionSnapshot(
  projectId: string,
  revision: number,
  signal?: AbortSignal,
): Promise<MapDesignRevisionSnapshotData> {
  const parsedRevision = MapSafeRevisionSchema.parse(revision);
  return getProjectContract(
    projectId,
    `/revisions/${encodeURIComponent(String(parsedRevision))}/snapshot`,
    MapRevisionSnapshotOutputSchema,
    signal,
  ).then((snapshot) => {
    const style = styleSchema.safeParse(snapshot.style);
    if (!style.success) {
      throw new ApiClientError(
        'The historical revision response is invalid.',
        200,
        'INVALID_RESPONSE',
      );
    }
    return { ...snapshot, style: style.data };
  });
}

export function restoreMapDesignRevision(
  projectId: string,
  revision: number,
  input: MapRestoreRevisionInput,
  signal?: AbortSignal,
): Promise<MapRestoreRevisionOutput> {
  const parsedRevision = MapSafeRevisionSchema.parse(revision);
  return postProjectContract(
    projectId,
    `/revisions/${encodeURIComponent(String(parsedRevision))}/restore`,
    MapRestoreRevisionInputSchema.parse(input),
    MapRestoreRevisionOutputSchema,
    signal,
  );
}

export function getCurrentMapDesignPreview(
  projectId: string,
  signal?: AbortSignal,
): Promise<MapCurrentPreviewOutput> {
  return getProjectContract(projectId, '/previews/current', MapCurrentPreviewOutputSchema, signal);
}

export function fulfillMapDesignPreview(
  projectId: string,
  previewId: string,
  requestValue: MapPreviewFulfillRequest,
  signal?: AbortSignal,
): Promise<MapRenderPreviewOutput> {
  const input = MapPreviewFulfillRequestSchema.parse(requestValue);
  if (input.previewId !== previewId) throw new TypeError('Preview identity mismatch.');
  return postProjectContract(
    projectId,
    `/previews/${encodeURIComponent(previewId)}/fulfill`,
    input,
    MapRenderPreviewOutputSchema,
    signal,
  );
}

export function commitMapDesignRevisionFromPreview(
  projectId: string,
  requestValue: MapCommitRevisionInput,
  signal?: AbortSignal,
): Promise<MapCommitRevisionOutput> {
  return postProjectContract(
    projectId,
    '/revisions/commit-from-preview',
    MapCommitRevisionInputSchema.parse(requestValue),
    MapCommitRevisionOutputSchema,
    signal,
  );
}

const styleSchema: ContractSchema<StyleSpecification> = {
  safeParse(value) {
    const validated = validateStyleDocument(value);
    return validated.ok
      ? { success: true, data: validated.style as unknown as StyleSpecification }
      : { success: false };
  },
};

export function importCartographyUrl(url: string, signal?: AbortSignal, description?: string) {
  return requestContract('/api/map-design/cartography-tools/import-url', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, ...(description === undefined ? {} : { description }) }), signal,
  }, CartographySummarySchema);
}
export function initializeCartography(input: CartographyInitializeInput, signal?: AbortSignal) {
  return requestContract('/api/map-design/cartography-tools/initialize', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal,
  }, CartographyDraftOutputSchema);
}
export function initializeCartographyUrl(input: CartographyInitializeUrlInput, signal?: AbortSignal) {
  return requestContract('/api/map-design/cartography-tools/initialize-url', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal,
  }, CartographyDraftOutputSchema);
}
export async function generateCartography(input: Omit<CartographyGenerateInput, 'jobId'>, signal?: AbortSignal) {
  const jobId = crypto.randomUUID();
  const path = `/api/map-design/cartography-tools/generate/${jobId}`;
  try {
    let job = await requestContract('/api/map-design/cartography-tools/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, jobId }), signal,
    }, CartographyGenerationSchema);
    while (job.status === 'running') {
      await new Promise<void>((resolve, reject) => {
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, 1000);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Canceled')); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      job = await requestContract(path, { signal }, CartographyGenerationSchema);
    }
    if (job.status === 'failed') throw new Error(job.message);
    return job.draft;
  } finally {
    void fetch(path, { method: 'DELETE' }).catch(() => undefined);
  }
}

export function updateCartography(id: string, description: string, signal?: AbortSignal) {
  return requestContract(`/api/map-design/cartographies/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description }), signal,
  }, CartographySummarySchema);
}
