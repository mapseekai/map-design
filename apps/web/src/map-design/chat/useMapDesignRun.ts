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
import { applyRunEventBatch, initialState, localizedRunError, presentedRunError, streamRunEvents, type RunState, type UseMapDesignRunOptions } from './map-run-events';

export type { MapDesignRuntime } from './map-run-events';

export function useMapDesignRun({ projectId, conversationId, runtime, readOnly = false, viewedRevision, readOnlyReason = null, onStartAccepted }: UseMapDesignRunOptions) {
  const { t, locale } = useI18n();
  const imageErrors = imageInputErrorCopy[locale];
  const toolLoopDetectedMessage = t('mapDesign.run.toolLoopDetected');
  const defaultReadOnlyReason = t('mapDesign.agent.mapEditingUnavailable');
  const [state, setState] = useState<RunState>(initialState);
  const [ready, setReady] = useState(true);
  const cancelingRef = useRef(false);
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
    if (cancelingRef.current) return;
    cancelingRef.current = true;
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
      cancelingRef.current = false;
      if (terminalRef.current && activeRunRef.current === runId && controllerRef.current === controller) {
        activeRunRef.current = null;
        controllerRef.current = null;
        setReady(true);
      }
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
    setReady(false);
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

  const error = presentedRunError(state.error, locale);
  return { ...state, error, send, cancel, ready, sending: state.status === 'queued' || state.status === 'running' || state.status === 'awaiting_input' };
}
