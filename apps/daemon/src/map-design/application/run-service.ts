import { apiConversationHistory } from '../storage/api-context.js';
import { apiProfileIdFromModel } from '@mapseekai/contracts';
import { resolveApiProfile } from './api-profile-service.js';
import type { MapRunHistory } from '../storage/run-history.js';
import { isMapDraftError } from './errors.js';
import type { MapTextAttachmentService } from './text-attachment-service.js';
import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  type ByokProviderSelection,
  type MapDesignAppConfig,
  type MapDesignMessage,
  type MapDesignRunByokProviderSelection,
  type MapDesignRunEvent,
  type MapDesignRunResponse,
  type MapDesignRuntimeProvenance,
  type StartMapDesignRunRequest,
} from '@mapseekai/contracts';
import { MAP_TOOL_NAMES } from '@mapseekai/map-design-contracts';
import type { RuntimeAgentDef } from '../../runtimes/types.js';
import { MAP_DESIGN_SKILL_ID } from '../../runtimes/map-design-skill.js';
import { MAP_DESIGN_RUN_TOOL_GRANT_SCOPE } from '../../runtimes/map-tools.js';
import { resolveChatToolTokenTtlMs, type MapDesignToolTokenRegistry, type ToolTokenGrant } from '../../tool-tokens.js';
import type { MapAgentAdapter, MapAgentEvent, MapRunHandle } from '../agents/types.js';
import { createRunToolCallback, type RunToolCallback } from '../agents/tool-callback.js';
import { createSdkMapToolRuntime, type SdkMapToolRuntime } from '../agents/sdk-tool-runtime.js';
import type { MapDesignLocalStore } from '../storage/local-store.js';
import type { MapDesignNativeToolRegistry } from '../tools/tool-context.js';
import { mapPromptContext } from '../tools/model-tool-content.js';
import { requestDigest } from './request-digest.js';
import { CartographyService, cartographyPrompt } from './cartography-service.js';
import { mapCommentPrompt, type MapDesignCommentService } from './comment-service.js';
import type { MapScreenshotService } from './screenshot-service.js';
import type { MapTrustedRunRecord, MapTrustedRunStore } from './revision-service.js';
import { appendRunContent, containsSensitiveText, fitMapDesignMessageToBudget, RunEventAccumulator, sanitizeEventText } from './run-events.js';
import type { MapDesignConversationRuntimeService } from './conversation-runtime-service.js';
import type { MapDesignRuntimeCatalog, ResolvedRuntimeChoice } from './runtime-catalog.js';

export interface SpawnedLocalAgent {
  pid?: number | undefined;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  stdout?: NodeJS.ReadableStream | null;
  stdin?: NodeJS.WritableStream | null;
  once(event: 'close', listener: (code: number | null) => void): this;
  once(event: 'error', listener: () => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface LocalAgentRegistry {
  get(agentId: string): Pick<RuntimeAgentDef, 'id' | 'bin' | 'buildArgs' | 'streamFormat' | 'eventParser' | 'promptViaStdin' | 'promptInputFormat' | 'resumesSessionViaCli' | 'capturesSessionIdFromStream' | 'inactivityTimeoutMs' | 'acpMcpEnvFormat' | 'acpTurnEndCompletesPrompt' | 'mapDesign'> | null;
  getMapAgent?(agentId: string): MapAgentAdapter | null;
  launchEnv?(agentId: string, options?: { byokProvider?: ByokProviderSelection; model: string | null }): NodeJS.ProcessEnv | null;
  spawn?(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean }): SpawnedLocalAgent;
  stageSkill?(skillId: 'map-design', cwd: string): Promise<void>;
}


export interface CreateMapDesignRunServiceDeps {
  runHistory?: MapRunHistory;
  retainedRunLimit?: number;
  retainedRunTtlMs?: number;
  store: MapDesignLocalStore;
  agents: LocalAgentRegistry;
  toolTokens: MapDesignToolTokenRegistry;
  dataDir: string;
  projectRoot: string;
  mcpCliPath: string;
  daemonUrl(): string;
  config?: { read(): MapDesignAppConfig };
  comments?: MapDesignCommentService;
  screenshots?: Pick<MapScreenshotService, 'resolve'>;
  attachments?: Pick<MapTextAttachmentService, 'resolve'>;
  now?(): number;
  randomId?(): string;
  processStopTimeoutMs?: number;
  stopProcessTree?: (child: SpawnedLocalAgent) => Promise<void>;
  mapContext: { getContext(projectId: string): Promise<unknown> };
  nativeToolRegistry?: MapDesignNativeToolRegistry;
  sdkToolRuntime?: SdkMapToolRuntime;
  runtimeChoices: Pick<MapDesignConversationRuntimeService, 'requireCurrent'>;
  runtimeCatalog: Pick<MapDesignRuntimeCatalog, 'resolveChoice'>;
}

export interface MapDesignRunService {
  start(request: StartMapDesignRunRequest): Promise<MapDesignRunResponse>;
  get(runId: string): MapDesignRunResponse | null;
  getActiveConversationRun(conversationId: string): MapDesignRunResponse | null;
  isConversationRunning(conversationId: string): boolean;
  isProjectRunning(projectId: string): boolean;
  getTrustedRun(runId: string): MapTrustedRunRecord | null;
  cancel(runId: string): Promise<{ runId: string; status: 'canceled' } | MapDesignRunResponse | null>;
  subscribe(runId: string, listener: (event: MapDesignRunEvent) => void): () => void;
  noteActivity(runId: string): void;
  shutdown(): Promise<void>;
}
export class MapDesignRunRequestError extends Error {}
export class MapDesignRunConflictError extends Error {}
export class MapDesignProjectRunConflictError extends Error {}

export function isMapDesignByokProvider(value: unknown): value is MapDesignRunByokProviderSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length === 0 || keys.length > 6 || !['anthropic', 'openai', 'azure', 'google', 'ollama', 'aihubmix'].includes(candidate.protocol as string)) return false;
  if (typeof candidate.apiKey !== 'string' || candidate.apiKey.length > 16_384) return false;
  for (const key of keys) {
    if (!['protocol', 'apiKey', 'baseUrl', 'apiVersion', 'apiFormat', 'requiresApiKey'].includes(key)) return false;
    const field = candidate[key];
    if (key === 'apiFormat' && field !== 'chat-completions' && field !== 'responses') return false;
    if (key === 'requiresApiKey' && typeof field !== 'boolean') return false;
    if (key !== 'protocol' && key !== 'requiresApiKey' && (typeof field !== 'string' || field.length > (key === 'baseUrl' ? 4_096 : 256))) return false;
  }
  return true;
}

type ActiveRun = {
  response: MapDesignRunResponse;
  assistant: MapDesignMessage;
  mapHandle: MapRunHandle | null;
  mapStarting: Promise<MapRunHandle> | null;
  stopping: Promise<void> | null;
  abortController: AbortController;
  grant: ToolTokenGrant;
  callback: RunToolCallback;
  events: MapDesignRunEvent[];
  listeners: Set<(event: MapDesignRunEvent) => void>;
  terminal: boolean;
  canceling: boolean;
  cancellation: Promise<{ runId: string; status: 'canceled' } | MapDesignRunResponse> | null;
  content: string;
  eventAccumulator: RunEventAccumulator;
  runtime: ResolvedRuntimeChoice;
  inactivityTimeoutMs: number;
  inactivityTimer: NodeJS.Timeout | null;
  snapshotTimer: NodeJS.Timeout | null;
};

const DEFAULT_RUN_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const EVENT_SNAPSHOT_FLUSH_INTERVAL_MS = 50;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function isRunBusy(run: ActiveRun): boolean {
  return !run.terminal || run.stopping !== null;
}

export function resolveMapDesignRunInactivityTimeoutMs(
  agentTimeoutMs: number | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number(environment.MAP_DESIGN_CHAT_RUN_INACTIVITY_TIMEOUT_MS);
  if (Number.isSafeInteger(override) && override > 0 && override <= MAX_TIMER_DELAY_MS) return override;
  if (
    Number.isSafeInteger(agentTimeoutMs)
    && (agentTimeoutMs ?? 0) > 0
    && (agentTimeoutMs ?? 0) <= MAX_TIMER_DELAY_MS
  ) return agentTimeoutMs!;
  return DEFAULT_RUN_INACTIVITY_TIMEOUT_MS;
}

export function createMapDesignRunService(deps: CreateMapDesignRunServiceDeps): MapDesignRunService & { getGrant(runId: string): ToolTokenGrant | null } {
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? randomUUID;
  const runs = new Map<string, ActiveRun>();
  const clientRequestRuns = new Map<string, { digest: string; runId: string }>();
  const sdkToolRuntime = deps.sdkToolRuntime
    ?? (deps.nativeToolRegistry ? createSdkMapToolRuntime(deps.nativeToolRegistry) : null);
  let shuttingDown = false;
  const retentionLimit = Math.max(0, Math.min(128, deps.retainedRunLimit ?? 0));
  const retentionTtl = Math.max(1, Math.min(3_600_000, deps.retainedRunTtlMs ?? 300_000));
  const pruneFinished = () => {
    if (!deps.runHistory) return;
    const finished = [...runs.entries()].filter(([, run]) => !isRunBusy(run));
    let excess = Math.max(0, finished.length - retentionLimit);
    for (const [id, run] of finished) {
      if (excess <= 0 && now() - Date.parse(run.response.finishedAt ?? '') < retentionTtl) continue;
      if (excess > 0) excess--;
      runs.delete(id);
      run.listeners.clear();
      for (const [key, value] of clientRequestRuns) if (value.runId === id) clientRequestRuns.delete(key);
    }
  };

  const emit = (active: ActiveRun, event: MapDesignRunEvent): void => {
    const snapshot = immutableSnapshot(event);
    if (snapshot.type === 'event_snapshot') {
      const previous = active.events.findIndex((candidate) => candidate.type === 'event_snapshot');
      if (previous >= 0) active.events[previous] = snapshot;
      else active.events.push(snapshot);
    } else {
      active.events.push(snapshot);
    }
    for (const listener of active.listeners) listener(snapshot);
  };
  const clearSnapshotTimer = (active: ActiveRun): void => {
    if (!active.snapshotTimer) return;
    clearTimeout(active.snapshotTimer);
    active.snapshotTimer = null;
  };
  const publishEventSnapshot = (active: ActiveRun): MapDesignMessage => {
    clearSnapshotTimer(active);
    const message = fitMapDesignMessageToBudget({
      ...active.assistant,
      content: active.content,
      events: active.eventAccumulator.snapshot(),
      runStatus: active.response.status,
      endedAt: active.assistant.endedAt,
    });
    deps.store.updateRunMessage(active.assistant.id, {
      content: message.content,
      events: message.events,
      runStatus: message.runStatus,
      endedAt: message.endedAt,
    });
    emit(active, {
      type: 'event_snapshot',
      runId: active.response.runId,
      messageId: active.assistant.id,
      events: message.events,
    });
    return message;
  };
  const scheduleEventSnapshot = (active: ActiveRun): void => {
    if (active.terminal || active.snapshotTimer) return;
    active.snapshotTimer = setTimeout(() => {
      active.snapshotTimer = null;
      publishEventSnapshot(active);
    }, EVENT_SNAPSHOT_FLUSH_INTERVAL_MS);
    active.snapshotTimer.unref?.();
  };
  const clearInactivityTimer = (active: ActiveRun): void => {
    if (!active.inactivityTimer) return;
    clearTimeout(active.inactivityTimer);
    active.inactivityTimer = null;
  };
  const stopMapRun = (active: ActiveRun): Promise<void> => {
    if (active.stopping) return active.stopping;
    // Keep ownership until both a pending handshake and the adapter's cleanup
    // settle, even when the public run has already reported a timeout.
    active.stopping = Promise.resolve().then(async () => {
      const handle = active.mapHandle ?? await active.mapStarting?.catch(() => null);
      if (!handle) return;
      await Promise.allSettled([handle.cancel(), handle.done]);
    }).finally(() => {
      active.stopping = null;
      pruneFinished();
    });
    return active.stopping;
  };
  const timeoutRun = (active: ActiveRun): void => {
    if (active.terminal || active.canceling) return;
    active.canceling = true;
    clearInactivityTimer(active);
    active.cancellation = stopMapRun(active).then(() => active.response);
    if (!active.abortController.signal.aborted) active.abortController.abort();
    finish(active, 'failed', {
      code: 'RUN_TIMED_OUT',
      message: 'The local agent stopped responding.',
    });
  };
  const resetInactivityTimer = (active: ActiveRun): void => {
    if (active.terminal || active.canceling) return;
    clearInactivityTimer(active);
    active.inactivityTimer = setTimeout(() => timeoutRun(active), active.inactivityTimeoutMs);
    active.inactivityTimer.unref?.();
  };
  const finish = (active: ActiveRun, status: Extract<MapDesignRunResponse['status'], 'succeeded' | 'failed' | 'canceled'>, error?: { code: string; message: string }): void => {
    if (active.terminal) return;
    active.terminal = true;
    clearInactivityTimer(active);
    clearSnapshotTimer(active);
    active.callback.close();
    if (!active.abortController.signal.aborted) active.abortController.abort();
    const endedAt = now();
    const updatedAt = new Date(endedAt).toISOString();
    active.response = { ...active.response, status, finishedAt: updatedAt, ...(error ? { error } : {}) };
    active.assistant = { ...active.assistant, content: active.content, runStatus: status, endedAt };
    active.eventAccumulator.finish(status, error, endedAt);
    const message = immutableSnapshot(publishEventSnapshot(active));
    deps.comments?.finish(active.response.projectId, active.response.runId, status);
    emit(active, { type: 'message_completed', runId: active.response.runId, message });
    deps.runHistory?.finish(active.response, message);
    emit(active, { type: 'run_finished', run: active.response });
    pruneFinished();
  };
  const onMapAdapterEvent = (active: ActiveRun, event: MapAgentEvent): void => {
    if (active.terminal || (active.canceling && event.kind !== 'tool_result')) return;
    if (event.kind === 'run_finished') return;
    if (event.kind === 'text') active.content = appendRunContent(active.content, event.text);
    if (active.eventAccumulator.apply(event)) {
      resetInactivityTimer(active);
      scheduleEventSnapshot(active);
    }
  };

  const service: MapDesignRunService & { getGrant(runId: string): ToolTokenGrant | null } = {
    async start(request) {
      pruneFinished();
      if (Object.hasOwn(request, 'viewedRevision')) {
        throw new MapDesignRunRequestError('Historical map revisions are read-only.');
      }
      const digest = requestDigest(request);
      const durable = deps.runHistory?.findRequest(request.clientRequestId);
      if (durable) {
        if (durable.requestDigest !== digest) throw new MapDesignRunConflictError('The client request identifier was reused with a different request.');
        return runs.get(durable.response.runId)?.response ?? durable.response;
      }
      const prior = clientRequestRuns.get(request.clientRequestId);
      if (prior) {
        if (prior.digest !== digest) throw new MapDesignRunConflictError('The client request identifier was reused with a different request.');
        const priorRun = runs.get(prior.runId);
        if (priorRun) return priorRun.response;
      }
      if (Object.hasOwn(request, 'byokProvider') && !isMapDesignByokProvider((request as unknown as Record<string, unknown>).byokProvider)) {
        throw new MapDesignRunRequestError('The requested BYOK provider is invalid.');
      }
      const project = deps.store.getProject(request.projectId);
      const conversation = deps.store.getConversation(request.conversationId);
      if (!project || !conversation || conversation.projectId !== request.projectId) throw new MapDesignRunRequestError('The map run request is invalid.');
      if ([...runs.values()].some((run) => isRunBusy(run) && run.response.projectId === request.projectId)) {
        throw new MapDesignProjectRunConflictError('Another run is already active for this project.');
      }
      if (request.commentRefs && !deps.comments) throw new MapDesignRunRequestError('Map comments are unavailable.');
      if (request.screenshotIds && !deps.screenshots) throw new MapDesignRunRequestError('Map screenshots are unavailable.');
      const captured = request.screenshotIds ? await deps.screenshots!.resolve(request.projectId, request.screenshotIds) : null;
      if (request.attachmentIds && !deps.attachments) throw new MapDesignRunRequestError('Text attachments are unavailable.');
      const attached = deps.attachments ? await deps.attachments.resolve(request.projectId, request.attachmentIds, conversation.messages).catch((error: unknown) => {
        if (isMapDraftError(error) && error.code === 'INVALID_INPUT') throw new MapDesignRunRequestError('The text attachment request is invalid.');
        throw error;
      }) : null;
      const comments = request.commentRefs ? await deps.comments!.prepare(request.projectId, request.commentRefs) : [];
      // Comment validation reads the canonical style asynchronously. Recheck both
      // replay and the project lock before creating any messages or claiming rows.
      if (request.commentRefs || request.screenshotIds || attached) {
        const replay = clientRequestRuns.get(request.clientRequestId);
        if (replay) {
          if (replay.digest !== digest) throw new MapDesignRunConflictError('The client request identifier was reused with a different request.');
          const existing = runs.get(replay.runId);
          if (existing) return existing.response;
        }
        if ([...runs.values()].some((run) => isRunBusy(run) && run.response.projectId === request.projectId)) {
          throw new MapDesignProjectRunConflictError('Another run is already active for this project.');
        }
      }
      const commentContext = mapCommentPrompt(comments);
      const screenshotContext = captured ? 'Attached map screenshots, in image order. These are visual references at capture time; inspect the current canonical map before editing. View metadata:\n'
        + JSON.stringify(captured.screenshots.map(({ id, draftRevision, styleHash, viewport, width, height }) => ({ id, draftRevision, styleHash, viewport, width, height }))) : '';
      const scopedPrompt = [request.prompt, commentContext, screenshotContext, attached?.prompt].filter(Boolean).join('\n\n');
      const choice = deps.runtimeChoices.requireCurrent(
        request.projectId,
        request.conversationId,
        request.runtimeRevision,
      );
      const resolved = deps.runtimeCatalog.resolveChoice(choice.agentId, choice);
      const apiProviderSnapshot = resolved.agentId === 'api' && !request.byokProvider
        ? resolveApiProfile(deps.config?.read() ?? {}, resolved.model) : undefined;
      if (resolved.agentId === 'api' && (resolved.model === 'default' || apiProfileIdFromModel(resolved.model))) {
        if (apiProviderSnapshot?.model) resolved.model = apiProviderSnapshot.model;
      }
      const agent = deps.agents.get(resolved.agentId);
      if (!agent) throw new MapDesignRunRequestError('The requested local agent is unavailable.');
      const mapAdapter = deps.agents.getMapAgent?.(agent.id) ?? null;
      if (
        !mapAdapter
        || mapAdapter.id !== agent.id
        || !mapAdapter.capabilities.nativeMapTools
        || !deps.nativeToolRegistry
        || !sdkToolRuntime
        || resolved.agentId !== agent.id
      ) {
        throw new MapDesignRunRequestError('Native map tools are unavailable for this local agent.');
      }
      const config = deps.config?.read();
      const inactivityTimeoutMs = resolveMapDesignRunInactivityTimeoutMs(agent.inactivityTimeoutMs);
      const runId = randomId();
      const startedAt = now();
      const createdAt = new Date(startedAt).toISOString();
      const user: MapDesignMessage = {
        id: request.userMessageId,
        conversationId: request.conversationId,
        role: 'user',
        content: request.prompt,
        ...(captured ? { screenshots: captured.screenshots } : {}),
        ...(attached?.attachments.length ? { attachments: attached.attachments } : {}),
        events: [],
        runStatus: 'succeeded',
        startedAt,
        endedAt: startedAt,
      };
      const assistant: MapDesignMessage = {
        id: request.assistantMessageId,
        conversationId: request.conversationId,
        role: 'assistant',
        content: '',
        events: [],
        runStatus: 'running',
        startedAt,
        endedAt: 0,
        runtime: runtimeProvenance(resolved),
      };
      const grant = deps.toolTokens.mint({
        runId,
        projectId: request.projectId,
        conversationId: request.conversationId,
        agentId: agent.id,
        allowedEndpoints: MAP_DESIGN_RUN_TOOL_GRANT_SCOPE.allowedEndpoints,
        allowedOperations: MAP_DESIGN_RUN_TOOL_GRANT_SCOPE.allowedOperations,
        nowMs: now(),
        ttlMs: resolveChatToolTokenTtlMs(inactivityTimeoutMs),
      });
      let callback: RunToolCallback;
      try {
        callback = createRunToolCallback({
          daemonUrl: deps.daemonUrl(),
          grant,
          close: () => {
            sdkToolRuntime.closeRun(runId);
            deps.toolTokens.revokeRun(runId, 'child_exit');
          },
        });
      } catch {
        deps.toolTokens.revokeRun(runId, 'manual');
        throw new MapDesignRunRequestError('The local map tool callback is unavailable.');
      }
      const response: MapDesignRunResponse = { runId, projectId: request.projectId, conversationId: request.conversationId, status: 'running', startedAt: createdAt };
      try {
        const persist = () => {
          if (comments.length) deps.comments!.claim(request.projectId, comments, runId);
          deps.store.appendMessage({ message: user, runId });
          deps.store.appendMessage({ message: assistant, runId });
          deps.runHistory?.start({ response, clientRequestId: request.clientRequestId, requestDigest: digest, message: assistant,
        trusted: { runId, projectId: request.projectId,
          runtime: { id: resolved.agentId, version: resolved.agentVersion ?? 'local', adapter: resolved.adapter },
          model: { id: resolved.model, provider: resolved.agentId } },
      });
        };
        if (comments.length || deps.runHistory) deps.store.inTransaction(persist);
        else persist();
      } catch (error) {
        callback.close();
        throw error;
      }

      const cwd = project.workingDirectory ?? deps.projectRoot;
      const active: ActiveRun = {
        response,
        assistant,
        mapHandle: null,
        mapStarting: null,
        stopping: null,
        abortController: new AbortController(),
        grant,
        callback,
        events: [],
        listeners: new Set(),
        terminal: false,
        canceling: false,
        cancellation: null,
        content: '',
        eventAccumulator: new RunEventAccumulator(),
        runtime: resolved,
        inactivityTimeoutMs,
        inactivityTimer: null,
        snapshotTimer: null,
      };
      runs.set(runId, active);
      clientRequestRuns.set(request.clientRequestId, { digest, runId });
      resetInactivityTimer(active);
      if (shuttingDown) { finish(active, 'canceled'); return response; }
      let mapContext: unknown;
      let cartography = '';
      try {
        mapContext = await deps.mapContext.getContext(request.projectId);
        cartography = cartographyPrompt(new CartographyService(deps.store).forProject(request.projectId));
      } catch {
        finish(active, 'failed', { code: 'RUN_FAILED', message: 'The current map context could not be loaded.' }); return response;
      }
      if (active.terminal || shuttingDown) { if (!active.terminal) finish(active, 'canceled'); return response; }
      if (agent.id !== 'api') {
        if (!deps.agents.stageSkill) { finish(active, 'failed', { code: 'RUN_FAILED', message: 'The required MapDesign skill could not be staged.' }); return response; }
        try { await deps.agents.stageSkill(MAP_DESIGN_SKILL_ID, cwd); } catch {
          finish(active, 'failed', { code: 'RUN_FAILED', message: 'The required MapDesign skill could not be staged.' }); return response;
        }
      }
      if (active.terminal || shuttingDown) { if (!active.terminal) finish(active, 'canceled'); return response; }
      const prompt = composeMapPrompt(scopedPrompt, agent.id === 'api' ? [] : conversation.messages, mapContext, request.projectId, runId, request.locale, config?.customInstructions, cartography);
      try {
          active.mapStarting = mapAdapter.startMapRun({
            runId,
            projectId: request.projectId,
            conversationId: request.conversationId,
            prompt,
            ...(agent.id === 'api' ? { apiHistory: apiConversationHistory(deps.store, request.conversationId, conversation.messages) } : {}),
            resumePrompt: composeMapPrompt(scopedPrompt, [], mapContext, request.projectId, runId, request.locale, config?.customInstructions, cartography),
            ...(captured ? { images: captured.images } : {}),
            cwd,
            model: resolved.model,
            reasoning: resolved.reasoning ?? null,
            serviceTier: resolved.serviceTier ?? null,
            ...(request.byokProvider === undefined ? {} : { byokProvider: request.byokProvider }),
            ...(apiProviderSnapshot ? { apiProviderSnapshot } : {}),
            toolRuntime: sdkToolRuntime,
            toolCallback: callback,
            signal: active.abortController.signal,
          }, [...deps.nativeToolRegistry.definitions()], (event) => {
            // The adapter's `done` terminal carries the safe error payload. Do
            // not let its event-only terminal finalize the run first and erase
            // that error before the handle settles.
            if (event.kind === 'run_finished') return;
            onMapAdapterEvent(active, event);
          });
          const handle = await active.mapStarting;
          active.mapHandle = handle;
          active.mapStarting = null;
          if (active.terminal || active.canceling || shuttingDown) {
            await service.cancel(runId);
            return active.response;
          }
          void handle.done.then(
            (result) => {
              if (!active.terminal && !active.canceling) finish(active, result.status, result.error);
            },
            () => {
              if (!active.terminal && !active.canceling) {
                finish(active, 'failed', {
                  code: 'NATIVE_TOOLS_UNAVAILABLE',
                  message: 'The local agent native tool channel failed.',
                });
              }
            },
          );
      } catch {
          active.mapStarting = null;
          if (!active.terminal && !active.canceling) {
            finish(active, 'failed', {
              code: 'NATIVE_TOOLS_UNAVAILABLE',
              message: 'The local agent native tool channel failed.',
            });
          }
      }
      return active.response;
    },
    get: (runId) => { pruneFinished(); return runs.get(runId)?.response ?? deps.runHistory?.get(runId)?.response ?? null; },
    getActiveConversationRun: (conversationId) => [...runs.values()].find((run) =>
      run.response.conversationId === conversationId && isRunBusy(run))?.response ?? null,
    isConversationRunning: (conversationId) => [...runs.values()].some((run) =>
      run.response.conversationId === conversationId && isRunBusy(run)),
    isProjectRunning: (projectId) => [...runs.values()].some((run) =>
      isRunBusy(run) && run.response.projectId === projectId),
    async cancel(runId) {
      const active = runs.get(runId);
      if (!active) return deps.runHistory?.get(runId)?.response ?? null;
      if (active.canceling && active.cancellation) return active.cancellation;
      if (active.terminal) return active.response.status === 'canceled' ? { runId, status: 'canceled' } : active.response;
      active.canceling = true;
      clearSnapshotTimer(active);
      active.cancellation = (async () => {
        if (!active.abortController.signal.aborted) active.abortController.abort();
        if (active.mapHandle || active.mapStarting) {
          await stopMapRun(active);
          const result = await active.mapHandle?.done.catch(() => ({
            status: 'failed' as const,
            error: {
              code: 'NATIVE_TOOLS_UNAVAILABLE',
              message: 'The local agent native tool channel failed.',
            },
          }));
          if (!active.terminal) finish(active, result?.status ?? 'canceled', result?.error);
          return active.response.status === 'canceled' ? { runId, status: 'canceled' as const } : active.response;
        }
        finish(active, 'canceled');
        return { runId, status: 'canceled' };
      })();
      return active.cancellation;
    },
    subscribe(runId, listener) {
      const active = runs.get(runId);
      if (!active) {
        const stored = deps.runHistory?.get(runId);
        if (stored) {
          if (stored.message) listener({ type: 'message_completed', runId, message: stored.message });
          listener({ type: 'run_finished', run: stored.response });
        }
        return () => undefined;
      }
      if (active.snapshotTimer) publishEventSnapshot(active);
      for (const event of active.events) listener(event);
      if (active.terminal) return () => undefined;
      active.listeners.add(listener);
      return () => active.listeners.delete(listener);
    },
    noteActivity(runId) {
      const active = runs.get(runId);
      if (active) resetInactivityTimer(active);
    },
    async shutdown() {
      shuttingDown = true;
      await Promise.all([...runs.values()]
        .filter(isRunBusy)
        .map((run) => service.cancel(run.response.runId)));
    },
    getTrustedRun(runId) {
      const active = runs.get(runId);
      if (!active) return deps.runHistory?.get(runId)?.trusted ?? null;
      return {
        runId,
        projectId: active.response.projectId,
        runtime: {
          id: active.runtime.agentId,
          version: active.runtime.agentVersion ?? 'local',
          adapter: active.runtime.adapter,
        },
        model: { id: active.runtime.model, provider: active.runtime.agentId },
      };
    },
    getGrant: (runId) => runs.get(runId)?.grant ?? null,
  };
  return service;
}

function runtimeProvenance(resolved: ResolvedRuntimeChoice): MapDesignRuntimeProvenance {
  return {
    agentId: resolved.agentId,
    ...(resolved.agentVersion === undefined ? {} : { agentVersion: resolved.agentVersion }),
    model: resolved.model,
    modelOrigin: resolved.modelOrigin,
    ...(resolved.reasoning === undefined ? {} : { reasoning: resolved.reasoning }),
    ...(resolved.serviceTier === undefined ? {} : { serviceTier: resolved.serviceTier }),
    adapter: resolved.adapter,
  };
}

export function normalizeLocalAgentFailure(payload: unknown): { code: string; message: string } {
  const value = record(payload);
  const error = record(value?.error);
  const rawMessage = typeof error?.message === 'string'
    ? error.message
    : typeof value?.message === 'string'
      ? value.message
      : '';
  const normalized = rawMessage.replace(/[\r\n\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 2_048);
  const message = sanitizeEventText(normalized, 'The local agent reported an error.', 2_048);
  if (message === 'The local agent could not connect to its model provider.') {
    return { code: 'AGENT_CONNECTION_DROPPED', message: 'The local agent could not connect to its model provider.' };
  }
  const rawCode = typeof error?.code === 'string' ? error.code : typeof value?.code === 'string' ? value.code : '';
  const code = /^[A-Z][A-Z0-9_]{1,63}$/u.test(rawCode) && !containsSensitiveText(rawCode) ? rawCode : 'RUN_FAILED';
  return { code, message };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function createMapDesignTrustedRunStore(runService: Pick<MapDesignRunService, 'getTrustedRun'>): MapTrustedRunStore {
  return { get: (runId) => runService.getTrustedRun(runId) };
}

const MAX_HISTORY_BYTES = 65_536;

function composeMapPrompt(prompt: string, messages: readonly MapDesignMessage[], mapContext: unknown, projectId: string, runId: string, locale?: string, customInstructions?: string | null, cartography = ''): string {
  const history = recentHistory(messages);
  let context = '{"unavailable":true}';
  try { context = mapPromptContext(mapContext); } catch { /* bounded fallback */ }
  const tools = MAP_TOOL_NAMES.map((name) => `\`${name}\``).join(', ');
  return [
    'You are the MapDesign agent.',
    `Use only the native run-scoped MapDesign tools in the \`map-design\` dynamic-tool namespace: ${tools}.`,
    'Do not use shell commands, `md tool`, MCP, or direct HTTP requests for map work.',
    'For every new logical write or batch, derive a new public idempotencyKey from the exact current Run, expected revision, and batch number; examples are shapes only and their literal keys must never be reused.',
    `Project: ${projectId}`,
    `Run: ${runId}`,
    ...(locale ? [`Locale: ${locale}`] : []),
    ...(customInstructions ? [`Custom instructions: ${customInstructions}`] : []),
    'Current canonical map context at Run start (reuse its revision; refresh only if missing or stale): ' + context,
    ...(cartography ? [cartography] : []),
    'Conversation:',
    history,
    `user: ${prompt}`,
  ].join('\n');
}

function recentHistory(messages: readonly MapDesignMessage[]): string {
  const retained: string[] = [];
  let bytes = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = `${messages[index]!.role}: ${messages[index]!.content}`;
    const size = Buffer.byteLength(item, 'utf8');
    const separatorBytes = retained.length === 0 ? 0 : 1;
    if (size > MAX_HISTORY_BYTES || bytes + separatorBytes + size > MAX_HISTORY_BYTES) break;
    retained.unshift(item);
    bytes += separatorBytes + size;
  }
  return retained.join('\n');
}

function immutableSnapshot<T>(value: T): T {
  const snapshot = structuredClone(value);
  const freeze = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object' || Object.isFrozen(candidate)) return;
    Object.freeze(candidate);
    for (const nested of Object.values(candidate)) freeze(nested);
  };
  freeze(snapshot);
  return snapshot;
}

export async function stopMapDesignProcessTree(
  child: SpawnedLocalAgent,
  timeoutMs: number,
  platform: NodeJS.Platform = process.platform,
  spawnTaskkill: (args: string[]) => SpawnedLocalAgent = (args) => spawnChild('taskkill', args, { windowsHide: true }),
): Promise<void> {
  if (platform === 'win32' && child.pid) {
    if (child.exitCode != null || child.signalCode != null) return;
    let childClosed = false;
    child.once('close', () => { childClosed = true; });
    if (await stopWindowsProcessTree(child.pid, false, timeoutMs, spawnTaskkill) === 0) return;
    // taskkill must enumerate the tree before it can terminate it; this can
    // outlast the agent's graceful-stop interval even on an idle machine.
    const forcedExitCode = await stopWindowsProcessTree(child.pid, true, Math.max(timeoutMs, 5_000), spawnTaskkill);
    if (forcedExitCode !== 0 && !(forcedExitCode === 128 && childClosed)) {
      console.warn(JSON.stringify({ event: 'map_agent_process_stop_failed', pid: child.pid, exitCode: forcedExitCode }));
      throw new Error('The Windows local agent process tree could not be stopped.');
    }
    return;
  }
  const closed = waitForClose(child, timeoutMs);
  signalProcessTree(child, 'SIGTERM', platform);
  if (await closed) return;
  signalProcessTree(child, 'SIGKILL', platform);
}

function signalProcessTree(child: SpawnedLocalAgent, signal: NodeJS.Signals, platform: NodeJS.Platform): void {
  if (platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* fall through */ }
  }
  child.kill(signal);
}

function waitForClose(child: SpawnedLocalAgent, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('close', () => { clearTimeout(timer); resolve(true); });
  });
}

function stopWindowsProcessTree(pid: number, force: boolean, timeoutMs: number, spawnTaskkill: (args: string[]) => SpawnedLocalAgent): Promise<number | null> {
  return new Promise((resolve) => {
    const taskkill = spawnTaskkill(['/pid', String(pid), '/T', ...(force ? ['/F'] : [])]);
    const timer = setTimeout(() => { taskkill.kill(); resolve(null); }, timeoutMs);
    taskkill.once('close', (code) => { clearTimeout(timer); resolve(code); });
    taskkill.once('error', () => { clearTimeout(timer); resolve(null); });
  });
}
