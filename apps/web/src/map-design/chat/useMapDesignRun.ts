import {
  MapDesignRunEventSchema,
  type MapDesignMessage,
  type MapDesignRunEvent,
  type MapDesignRunResponse,
  type MapDesignRunStatus,
  type StartMapDesignRunRequest,
  type MapScreenshot,
  type MapTextAttachment,
} from '@mapseekai/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiClientError, cancelMapDesignRun, getMapDesignConversation, getMapDesignRun, startMapDesignRun } from '../../api/client';
import { useI18n } from '../../i18n';
import { runFailureCopy } from '../../i18n/locales/run-failures';
import { imageInputErrorCopy } from '../../i18n/locales/screenshots';

export interface MapDesignRuntime {
  revision: number;
  agentId: string;
  label?: string;
  model?: string;
  reasoning?: string;
  serviceTier?: string;
  updatedAt?: string;
}

interface UseMapDesignRunOptions {
  projectId: string;
  conversationId: string;
  runtime: MapDesignRuntime | null;
  readOnly?: boolean;
  viewedRevision?: number;
  readOnlyReason?: string | null;
  onStartAccepted?(): void | Promise<void>;
}

interface RunState {
  status: MapDesignRunStatus | 'idle';
  messages: MapDesignMessage[];
  error: string | null;
  runId: string | null;
}

const initialState: RunState = { status: 'idle', messages: [], error: null, runId: null };

function eventFromJson(value: unknown): MapDesignRunEvent | null {
  const parsed = MapDesignRunEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function applyRunEventBatch(
  current: RunState,
  events: readonly MapDesignRunEvent[],
  options: {
    conversationId: string;
    fallbackRun: MapDesignRunResponse;
    startedAt: number;
    toolLoopDetectedMessage: string;
    imageErrors: { unsupported: string; tooLarge: string };
  },
): RunState {
  let messages = current.messages;
  let status = current.status;
  let error = current.error;
  for (const event of events) {
    if (event.type === 'event_snapshot') {
      const known = messages.some((message) => message.id === event.messageId);
      messages = known
        ? messages.map((message) => message.id === event.messageId
            ? { ...message, events: [...event.events] }
            : message)
        : [...messages, {
            id: event.messageId,
            conversationId: options.conversationId,
            role: 'assistant' as const,
            content: '',
            events: [...event.events],
            runStatus: current.status === 'idle' ? options.fallbackRun.status : current.status,
            startedAt: options.startedAt,
            endedAt: 0,
          }];
    } else if (event.type === 'message_completed') {
      messages = messages.some((message) => message.id === event.message.id)
        ? messages.map((message) => message.id === event.message.id ? event.message : message)
        : [...messages, event.message];
    } else if (event.type === 'error') {
      status = 'failed';
      error = localizedRunError(event.error, options.toolLoopDetectedMessage, options.imageErrors);
    } else if (event.type === 'run_finished') {
      status = event.run.status;
      error = event.run.error
        ? localizedRunError(event.run.error, options.toolLoopDetectedMessage, options.imageErrors)
        : error;
    }
  }
  return { ...current, messages, status, error };
}

function localizedRunError(
  error: { code: string; message: string } | null | undefined,
  toolLoopDetectedMessage: string,
  imageErrors: { unsupported: string; tooLarge: string },
): string | null {
  if (!error) return null;
  if (error.code === 'IMAGE_INPUT_UNSUPPORTED') return imageErrors.unsupported;
  if (error.code === 'IMAGE_INPUT_TOO_LARGE') return imageErrors.tooLarge;
  return error.code === 'TOOL_LOOP_DETECTED' ? toolLoopDetectedMessage : error.message;
}

export function useMapDesignRun({ projectId, conversationId, runtime, readOnly = false, viewedRevision, readOnlyReason = null, onStartAccepted }: UseMapDesignRunOptions) {
  const { t, locale } = useI18n();
  const imageErrors = imageInputErrorCopy[locale];
  const toolLoopDetectedMessage = t('mapDesign.run.toolLoopDetected');
  const defaultReadOnlyReason = t('mapDesign.agent.mapEditingUnavailable');
  const [state, setState] = useState<RunState>(initialState);
  const controllerRef = useRef<AbortController | null>(null);
  const activeRunRef = useRef<string | null>(null);
  const terminalRef = useRef(false);
  const recoveryRef = useRef(false);
  const sequenceRef = useRef(0);
  const cancelRequestedRef = useRef(false);
  const queuedCancelWaitersRef = useRef<Array<() => void>>([]);
  const readOnlyRef = useRef(readOnly);
  const viewedRevisionRef = useRef(viewedRevision);
  const readOnlyReasonRef = useRef(readOnlyReason ?? defaultReadOnlyReason);
  const runtimeRef = useRef(runtime);
  readOnlyRef.current = readOnly;
  viewedRevisionRef.current = viewedRevision;
  readOnlyReasonRef.current = readOnlyReason ?? defaultReadOnlyReason;
  runtimeRef.current = runtime;

  const settleQueuedCancellation = useCallback(() => {
    cancelRequestedRef.current = false;
    const waiters = queuedCancelWaitersRef.current.splice(0);
    for (const resolve of waiters) resolve();
  }, []);

  const reconcile = useCallback(async (runId: string, signal: AbortSignal) => {
    if (recoveryRef.current || terminalRef.current) return;
    recoveryRef.current = true;
    try {
      const [run, conversation] = await Promise.all([getMapDesignRun(runId, signal), getMapDesignConversation(projectId, conversationId, signal)]);
      if (signal.aborted || terminalRef.current) return;
      setState({
        status: run.status,
        messages: conversation.messages,
        error: localizedRunError(run.error, toolLoopDetectedMessage, imageErrors),
        runId,
      });
      if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'canceled') terminalRef.current = true;
    } catch (error) {
      if (!signal.aborted) setState((current) => ({ ...current, error: error instanceof Error ? error.message : 'The map run connection was lost.' }));
    }
  }, [conversationId, projectId, toolLoopDetectedMessage, imageErrors]);

  const cancelAcceptedRun = useCallback(async (runId: string, controller: AbortController | null) => {
    controller?.abort();
    try {
      const canceled = await cancelMapDesignRun(runId);
      const conversation = await getMapDesignConversation(projectId, conversationId);
      terminalRef.current = true;
      setState({ status: canceled.status, messages: conversation.messages, error: null, runId });
    } catch (error) {
      try {
        const [latest, conversation] = await Promise.all([getMapDesignRun(runId), getMapDesignConversation(projectId, conversationId)]);
        terminalRef.current = latest.status === 'succeeded' || latest.status === 'failed' || latest.status === 'canceled';
        setState({
          status: latest.status,
          messages: conversation.messages,
          error: localizedRunError(latest.error, toolLoopDetectedMessage, imageErrors),
          runId,
        });
      } catch {
        setState((current) => ({ ...current, error: error instanceof Error ? error.message : 'The map run could not be canceled.' }));
      }
    } finally {
      if (activeRunRef.current === runId) activeRunRef.current = null;
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [conversationId, projectId, toolLoopDetectedMessage, imageErrors]);

  const send = useCallback(async (prompt: string, commentRefs?: StartMapDesignRunRequest['commentRefs'], screenshots?: MapScreenshot[], attachments?: MapTextAttachment[]) => {
    if (readOnlyRef.current) {
      setState((current) => ({ ...current, error: readOnlyReasonRef.current }));
      return false;
    }
    const text = prompt.trim();
    const selectedRuntime = runtimeRef.current;
    if (!text || !selectedRuntime || controllerRef.current || activeRunRef.current) return false;
    const controller = new AbortController();
    controllerRef.current = controller;
    cancelRequestedRef.current = false;
    terminalRef.current = false;
    recoveryRef.current = false;
    const nonce = `${Date.now()}-${++sequenceRef.current}`;
    const userMessageId = `map-user-${nonce}`;
    const assistantMessageId = `map-assistant-${nonce}`;
    const request: StartMapDesignRunRequest = {
      projectId,
      conversationId,
      prompt: text,
      runtimeRevision: selectedRuntime.revision,
      clientRequestId: `map-run-${nonce}`,
      userMessageId,
      assistantMessageId,
      ...(commentRefs ? { commentRefs } : {}),
      ...(screenshots?.length ? { screenshotIds: screenshots.map(({ id }) => id) } : {}),
      ...(attachments?.length ? { attachmentIds: attachments.map(({ id }) => id) } : {}),
      ...(viewedRevisionRef.current !== undefined ? { viewedRevision: viewedRevisionRef.current } : {}),
    };
    const startedAt = Date.now();
    setState((current) => ({ ...current, status: 'queued', error: null, runId: null }));
    let run: MapDesignRunResponse;
    try {
      run = await startMapDesignRun(request, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        setState((current) => ({
          ...current,
          status: 'failed',
          error: error instanceof ApiClientError && error.code === 'INVALID_INPUT'
            ? t('mapDesign.run.startError')
            : error instanceof Error ? error.message : 'The map run failed.',
        }));
      }
      if (controllerRef.current === controller) controllerRef.current = null;
      settleQueuedCancellation();
      return false;
    }
    if (controller.signal.aborted) {
      if (controllerRef.current === controller) controllerRef.current = null;
      settleQueuedCancellation();
      return false;
    }
    void Promise.resolve(onStartAccepted?.()).catch(() => undefined);
    activeRunRef.current = run.runId;
    setState((current) => ({
      ...current,
      status: run.status,
      runId: run.runId,
      error: localizedRunError(run.error, toolLoopDetectedMessage, imageErrors),
      messages: [
        ...current.messages,
        {
          id: userMessageId,
          conversationId,
          role: 'user',
          content: text,
          ...(screenshots?.length ? { screenshots } : {}),
          ...(attachments?.length ? { attachments } : {}),
          events: [{ kind: 'text', text }],
          runStatus: 'succeeded',
          startedAt,
          endedAt: startedAt,
        },
        {
          id: assistantMessageId,
          conversationId,
          role: 'assistant',
          content: '',
          events: [],
          runStatus: run.status,
          startedAt: run.startedAt ? Date.parse(run.startedAt) : startedAt,
          endedAt: 0,
        },
      ],
    }));
    if (cancelRequestedRef.current) {
      void cancelAcceptedRun(run.runId, controller).finally(settleQueuedCancellation);
      return true;
    }
    void (async () => {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(run.runId)}/events`, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
        if (!response.ok || !response.body) throw new Error('The map run stream could not be opened.');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          const accepted: MapDesignRunEvent[] = [];
          for (const frame of frames) {
            const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
            if (!line) continue;
            try {
              const event = eventFromJson(JSON.parse(line.slice(6)));
              if (!event) continue;
              const eventRunId = event.type === 'run_finished' ? event.run.runId : event.runId;
              if (eventRunId !== run.runId) continue;
              if (event.type === 'run_finished') {
                if (terminalRef.current) continue;
                terminalRef.current = true;
              }
              accepted.push(event);
            } catch {
              // Invalid or partial frames are ignored; stream recovery remains authoritative.
            }
          }
          if (accepted.length > 0) {
            setState((current) => applyRunEventBatch(current, accepted, {
              conversationId,
              fallbackRun: run,
              startedAt,
              toolLoopDetectedMessage, imageErrors,
            }));
          }
        }
        if (!controller.signal.aborted && !terminalRef.current) await reconcile(run.runId, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          if (activeRunRef.current) await reconcile(activeRunRef.current, controller.signal);
          else setState((current) => ({ ...current, status: 'failed', error: error instanceof Error ? error.message : 'The map run failed.' }));
        }
      } finally {
        if (terminalRef.current || controller.signal.aborted) {
          if (controllerRef.current === controller) controllerRef.current = null;
          activeRunRef.current = null;
        }
      }
    })();
    return true;
  }, [cancelAcceptedRun, conversationId, onStartAccepted, projectId, reconcile, settleQueuedCancellation, t, toolLoopDetectedMessage, imageErrors]);

  const cancel = useCallback(async () => {
    const runId = activeRunRef.current;
    const controller = controllerRef.current;
    if (!runId) {
      if (!controller) return;
      cancelRequestedRef.current = true;
      await new Promise<void>((resolve) => { queuedCancelWaitersRef.current.push(resolve); });
      return;
    }
    await cancelAcceptedRun(runId, controller);
  }, [cancelAcceptedRun]);

  useEffect(() => () => {
    controllerRef.current?.abort();
    settleQueuedCancellation();
  }, [settleQueuedCancellation]);

  // Translate known generic notices at the presentation boundary, including
  // recovered runs, without replacing specialized or unknown server details.
  const copy = runFailureCopy[locale];
  const error = state.error && [
    'The Codex app-server connection ended unexpectedly.', 'The map run connection was lost.',
    'The map run stream could not be opened.',
  ].includes(state.error) ? copy.connection
    : state.error && ['The Codex turn failed before completion.', 'The map run failed.'].includes(state.error)
      ? copy.failed : state.error;
  return { ...state, error, send, cancel, sending: state.status === 'queued' || state.status === 'running' || state.status === 'awaiting_input' };
}
