import {
  type MapDesignRunResponse,
  type StartMapDesignRunRequest,
  type MapScreenshot,
  type MapTextAttachment,
} from '@mapseekai/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiClientError, cancelMapDesignRun, getMapDesignConversation, getMapDesignRun, startMapDesignRun } from '../../api/client';
import { useI18n } from '../../i18n';
import { imageInputErrorCopy } from '../../i18n/locales/screenshots';
import { randomUUID } from '../../utils/uuid';
import { applyRunEventBatch, initialState, localizedRunError, presentedRunError, streamRunEvents, type RunState, type UseMapDesignRunOptions } from './map-run-events';

export type { MapDesignRuntime } from './map-run-events';

function waitForRecovery(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, 1_000);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function isTerminal(status: MapDesignRunResponse['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

export function useMapDesignRun({ projectId, conversationId, runtime, conversation, readOnly = false, viewedRevision, readOnlyReason = null, onStartAccepted }: UseMapDesignRunOptions) {
  const { t, locale } = useI18n();
  const imageErrors = imageInputErrorCopy[locale];
  const toolLoopDetectedMessage = t('mapDesign.run.toolLoopDetected');
  const defaultReadOnlyReason = t('mapDesign.agent.mapEditingUnavailable');
  const [state, setState] = useState<RunState>(initialState);
  const [ready, setReady] = useState(false);
  const initializedScopeRef = useRef<string | null>(null);
  const scope = JSON.stringify([projectId, conversationId]);
  const cancelingRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const activeRunRef = useRef<string | null>(null);
  const terminalRef = useRef(false);
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
    while (!signal.aborted && !terminalRef.current && activeRunRef.current === runId) {
      try {
        const [run, conversation] = await Promise.all([getMapDesignRun(runId, signal), getMapDesignConversation(projectId, conversationId, signal)]);
        if (signal.aborted || terminalRef.current || activeRunRef.current !== runId) return;
        setState({
          status: run.status,
          messages: conversation.messages,
          error: localizedRunError(run.error, toolLoopDetectedMessage, imageErrors),
          runId,
        });
        terminalRef.current = isTerminal(run.status);
      } catch (error) {
        if (signal.aborted || terminalRef.current || activeRunRef.current !== runId) return;
        setState((current) => ({ ...current, error: error instanceof Error ? error.message : 'The map run connection was lost.' }));
      }
      if (!terminalRef.current) await waitForRecovery(signal);
    }
  }, [conversationId, projectId, toolLoopDetectedMessage, imageErrors]);

  const cancelAcceptedRun = useCallback(async (runId: string, controller: AbortController | null) => {
    if (cancelingRef.current) return;
    cancelingRef.current = true;
    const isCurrent = () => controllerRef.current === controller && activeRunRef.current === runId && !controller?.signal.aborted;
    try {
      const canceled = await cancelMapDesignRun(runId, controller?.signal);
      const conversation = await getMapDesignConversation(projectId, conversationId, controller?.signal);
      if (!isCurrent() || terminalRef.current) return;
      terminalRef.current = isTerminal(canceled.status);
      setState({ status: canceled.status, messages: conversation.messages, error: null, runId });
    } catch (error) {
      if (!isCurrent() || terminalRef.current) return;
      try {
        const [latest, conversation] = await Promise.all([getMapDesignRun(runId, controller?.signal), getMapDesignConversation(projectId, conversationId, controller?.signal)]);
        if (!isCurrent() || terminalRef.current) return;
        terminalRef.current = isTerminal(latest.status);
        setState({
          status: latest.status,
          messages: conversation.messages,
          error: localizedRunError(latest.error, toolLoopDetectedMessage, imageErrors),
          runId,
        });
      } catch {
        if (isCurrent() && !terminalRef.current) setState((current) => ({ ...current, error: error instanceof Error ? error.message : 'The map run could not be canceled.' }));
      }
    } finally {
      cancelingRef.current = false;
      if (terminalRef.current && activeRunRef.current === runId && controllerRef.current === controller) {
        controller?.abort();
        activeRunRef.current = null;
        controllerRef.current = null;
        setReady(true);
      }
    }
  }, [conversationId, projectId, toolLoopDetectedMessage, imageErrors]);

  const monitor = useCallback(async (run: MapDesignRunResponse, controller: AbortController, startedAt: number) => {
    try {
      for await (const batch of streamRunEvents(run.runId, controller.signal)) {
        if (controller.signal.aborted || controllerRef.current !== controller) break;
        const accepted = batch.filter((event) => {
          if (event.type !== 'run_finished') return true;
          if (terminalRef.current) return false;
          terminalRef.current = true;
          return true;
        });
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
      if (!cancelingRef.current && terminalRef.current && controllerRef.current === controller && activeRunRef.current === run.runId) {
        controllerRef.current = null;
        activeRunRef.current = null;
        setReady(true);
      }
    }
  }, [conversationId, reconcile, toolLoopDetectedMessage, imageErrors]);

  const send = useCallback(async (prompt: string, commentRefs?: StartMapDesignRunRequest['commentRefs'], screenshots?: MapScreenshot[], attachments?: MapTextAttachment[], requestId?: string) => {
    if (readOnlyRef.current) {
      setState((current) => ({ ...current, error: readOnlyReasonRef.current }));
      return false;
    }
    const text = prompt.trim();
    const selectedRuntime = runtimeRef.current;
    if (initializedScopeRef.current !== scope || !text || !selectedRuntime || controllerRef.current || activeRunRef.current) return false;
    const controller = new AbortController();
    controllerRef.current = controller;
    setReady(false);
    cancelRequestedRef.current = false;
    terminalRef.current = false;
    const nonce = requestId ?? randomUUID();
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
      if (requestId) {
        const latest = await getMapDesignConversation(projectId, conversationId, controller.signal);
        const accepted = latest.messages.some((message) => message.id === userMessageId && message.role === 'user');
        if (controller.signal.aborted) return accepted;
        if (accepted) {
          const activeRun = latest.activeRun;
          const answer = [...latest.messages].reverse().find((message) => message.role === 'assistant');
          setState({ messages: latest.messages, runId: activeRun?.runId ?? null,
            status: activeRun?.status ?? (answer && isTerminal(answer.runStatus) ? answer.runStatus : 'idle'),
            error: localizedRunError(activeRun?.error, toolLoopDetectedMessage, imageErrors) });
          if (activeRun) {
            activeRunRef.current = activeRun.runId;
            if (cancelRequestedRef.current) void cancelAcceptedRun(activeRun.runId, controller).finally(settleQueuedCancellation);
            void monitor(activeRun, controller, activeRun.startedAt ? Date.parse(activeRun.startedAt) : Date.now());
          } else {
            controllerRef.current = null;
            setReady(true);
            settleQueuedCancellation();
          }
          return true;
        }
      }
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
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setReady(true);
      }
      settleQueuedCancellation();
      return false;
    }
    if (controller.signal.aborted) {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setReady(true);
      }
      settleQueuedCancellation();
      return true;
    }
    void Promise.resolve(onStartAccepted?.()).catch(() => undefined);
    activeRunRef.current = run.runId;
    setState((current) => ({
      ...current,
      status: run.status,
      runId: run.runId,
      error: localizedRunError(run.error, toolLoopDetectedMessage, imageErrors),
      messages: [
        ...current.messages.filter((message) => message.id !== userMessageId && message.id !== assistantMessageId),
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
    }
    void monitor(run, controller, startedAt);
    return true;
  }, [cancelAcceptedRun, conversationId, onStartAccepted, projectId, monitor, scope, settleQueuedCancellation, t, toolLoopDetectedMessage, imageErrors]);

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

  useEffect(() => {
    initializedScopeRef.current = null;
    setState(initialState);
    setReady(false);
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      activeRunRef.current = null;
      initializedScopeRef.current = null;
      terminalRef.current = false;
      cancelingRef.current = false;
      settleQueuedCancellation();
    };
  }, [scope, settleQueuedCancellation]);

  useEffect(() => {
    if (initializedScopeRef.current === scope || !conversation
      || conversation.id !== conversationId || conversation.projectId !== projectId) return;
    initializedScopeRef.current = scope;
    const run = conversation.activeRun;
    if (!run) {
      const latest = [...conversation.messages].reverse().find((message) => message.role === 'assistant');
      setState({ ...initialState, messages: conversation.messages,
        status: latest && isTerminal(latest.runStatus) ? latest.runStatus : 'idle' });
      setReady(true);
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    activeRunRef.current = run.runId;
    terminalRef.current = false;
    setReady(false);
    setState({ status: run.status, runId: run.runId, messages: conversation.messages,
      error: localizedRunError(run.error, toolLoopDetectedMessage, imageErrors) });
    void monitor(run, controller, run.startedAt ? Date.parse(run.startedAt) : Date.now());
  }, [conversation, conversationId, projectId, scope, monitor, toolLoopDetectedMessage, imageErrors]);

  const error = presentedRunError(state.error, locale);
  return { ...state, error, send, cancel, ready: ready && initializedScopeRef.current === scope, sending: state.status === 'queued' || state.status === 'running' || state.status === 'awaiting_input' };
}
