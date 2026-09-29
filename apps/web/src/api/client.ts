import type {
  LocalAgentInfo,
  MapDesignAppConfigResponse,
  MapDesignConversation,
  MapDesignConversationResponse,
  MapDesignConversationRuntimeResponse,
  CreateMapDesignConversationInput,
  CreateMapDesignConversationResponse,
  MapDesignConversationListResponse,
  MapDesignMessage,
  MapDesignRunResponse,
  StartMapDesignRunRequest,
  UpdateMapDesignConversationRuntimeRequest,
} from '@mapseekai/contracts';
import {
  LocalAgentListResponseSchema,
  MapDesignConversationRuntimeResponseSchema,
} from '@mapseekai/contracts';
import { ApiClientError, request } from './request';

export { ApiClientError, request } from './request';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  // The runtime guard above excludes every non-record JSON value.
  return value as JsonRecord;
}

function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isConversation(value: unknown): value is MapDesignConversation {
  const candidate = record(value);
  return candidate !== null && string(candidate.id) !== null && string(candidate.projectId) !== null && Array.isArray(candidate.messages);
}

function isConversationSummary(value: unknown): boolean {
  const candidate = record(value);
  return candidate !== null
    && string(candidate.conversationId) !== null
    && string(candidate.projectId) !== null
    && string(candidate.title) !== null
    && typeof candidate.titleIsDefault === 'boolean'
    && typeof candidate.messageCount === 'number'
    && Number.isInteger(candidate.messageCount)
    && candidate.messageCount >= 0
    && string(candidate.createdAt) !== null
    && string(candidate.lastActivityAt) !== null
    && (candidate.runState === 'idle' || candidate.runState === 'running');
}

function isConversationList(value: unknown): value is MapDesignConversationListResponse {
  const candidate = record(value);
  return candidate !== null && Array.isArray(candidate.conversations) && candidate.conversations.every(isConversationSummary);
}

function isConversationCreate(value: unknown): value is CreateMapDesignConversationResponse {
  const candidate = record(value);
  return candidate !== null && isConversationSummary(candidate.conversation);
}

function isRun(value: unknown): value is MapDesignRunResponse {
  const candidate = record(value);
  return candidate !== null && string(candidate.runId) !== null && string(candidate.projectId) !== null && string(candidate.conversationId) !== null && string(candidate.status) !== null;
}

export async function getLocalAgents(signal?: AbortSignal) {
  const value = await request(
    '/api/agents',
    { signal },
    (value) => LocalAgentListResponseSchema.safeParse(value).success,
  );
  return LocalAgentListResponseSchema.parse(value);
}

export async function getMapDesignConfig(signal?: AbortSignal): Promise<MapDesignAppConfigResponse> {
  return request('/api/config', { signal }, (value): value is MapDesignAppConfigResponse => {
    const outer = record(value);
    return outer !== null && record(outer.config) !== null;
  }) as Promise<MapDesignAppConfigResponse>;
}
export function listMapDesignConversations(projectId: string, signal?: AbortSignal): Promise<MapDesignConversationListResponse> {
  return request(`/api/map-design/projects/${encodeURIComponent(projectId)}/conversations`, { signal }, isConversationList) as Promise<MapDesignConversationListResponse>;
}

export async function deleteMapDesignConversation(projectId: string, conversationId: string, signal?: AbortSignal): Promise<void> {
  await request(`/api/map-design/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE', signal,
  }, (value) => value === null);
}

export function createMapDesignConversation(
  projectId: string,
  input: CreateMapDesignConversationInput,
  signal?: AbortSignal,
): Promise<CreateMapDesignConversationResponse> {
  return request(`/api/map-design/projects/${encodeURIComponent(projectId)}/conversations`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal,
  }, isConversationCreate) as Promise<CreateMapDesignConversationResponse>;
}

export function getMapDesignConversation(projectId: string, conversationId: string, signal?: AbortSignal): Promise<MapDesignConversationResponse>;
/** @deprecated Use the explicit project-scoped conversation identity. */
export function getMapDesignConversation(projectId: string, signal?: AbortSignal): Promise<MapDesignConversation>;
export async function getMapDesignConversation(
  projectId: string,
  conversationIdOrSignal?: string | AbortSignal,
  signal?: AbortSignal,
): Promise<MapDesignConversation> {
  const conversationId = typeof conversationIdOrSignal === 'string' ? conversationIdOrSignal : null;
  const requestSignal = typeof conversationIdOrSignal === 'string' ? signal : conversationIdOrSignal;
  const path = conversationId === null
    ? `/api/map-design/projects/${encodeURIComponent(projectId)}/conversation`
    : `/api/map-design/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`;
  const value = await request(path, { signal: requestSignal }, isConversation);
  const activeRun = record(value)?.activeRun;
  if (conversationId !== null && activeRun !== null && (!isRun(activeRun) || activeRun.projectId !== projectId || activeRun.conversationId !== conversationId)) {
    throw new ApiClientError('The local daemon returned an invalid conversation run.', 200);
  }
  if (!isConversation(value)) throw new ApiClientError('The local daemon returned an invalid conversation.', 200);
  return value;
}

export async function getMapDesignConversationRuntime(
  projectId: string,
  conversationId: string,
  signal?: AbortSignal,
): Promise<MapDesignConversationRuntimeResponse> {
  const value = await request(
    `/api/map-design/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/runtime`,
    { signal },
    (value) => MapDesignConversationRuntimeResponseSchema.safeParse(value).success,
  );
  return MapDesignConversationRuntimeResponseSchema.parse(value);
}

export async function updateMapDesignConversationRuntime(
  projectId: string,
  conversationId: string,
  input: UpdateMapDesignConversationRuntimeRequest,
  signal?: AbortSignal,
): Promise<MapDesignConversationRuntimeResponse> {
  const value = await request(
    `/api/map-design/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/runtime`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    },
    (value) => MapDesignConversationRuntimeResponseSchema.safeParse(value).success,
  );
  return MapDesignConversationRuntimeResponseSchema.parse(value);
}

export function startMapDesignRun(input: StartMapDesignRunRequest, signal?: AbortSignal): Promise<MapDesignRunResponse> {
  return request('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal }, isRun) as Promise<MapDesignRunResponse>;
}

export function getMapDesignRun(runId: string, signal?: AbortSignal): Promise<MapDesignRunResponse> {
  return request(`/api/runs/${encodeURIComponent(runId)}`, { signal }, isRun) as Promise<MapDesignRunResponse>;
}

export function cancelMapDesignRun(runId: string, signal?: AbortSignal): Promise<{ runId: string; status: 'canceled' }> {
  return request(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', signal }, (value) => {
    const candidate = record(value);
    return candidate !== null && string(candidate.runId) !== null && candidate.status === 'canceled';
  }) as Promise<{ runId: string; status: 'canceled' }>;
}

export type { LocalAgentInfo, MapDesignMessage };
