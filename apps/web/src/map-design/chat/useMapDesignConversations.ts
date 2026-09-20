import type { MapDesignConversationSummary } from '@mapseekai/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { createMapDesignConversation, deleteMapDesignConversation, listMapDesignConversations } from '../../api/client';
import { useI18n } from '../../i18n';

export type MapDesignConversationFailure =
  | { operation: 'list' }
  | { operation: 'create' };

function requestedConversationId(): string | null {
  return new URLSearchParams(window.location.search).get('conversation');
}

function writeConversationId(conversationId: string | null, mode: 'push' | 'replace'): void {
  const url = new URL(window.location.href);
  if (conversationId === null) url.searchParams.delete('conversation');
  else url.searchParams.set('conversation', conversationId);
  if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash === window.location.hash) return;
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (mode === 'push') window.history.pushState(window.history.state, '', next);
  else window.history.replaceState(window.history.state, '', next);
}

function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID?.() ?? `map-conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function mergeConversations(
  current: readonly MapDesignConversationSummary[],
  listed: readonly MapDesignConversationSummary[],
): readonly MapDesignConversationSummary[] {
  const currentIds = new Set(current.map((conversation) => conversation.conversationId));
  return [...current, ...listed.filter((conversation) => !currentIds.has(conversation.conversationId))];
}

function replaceWithAuthoritativeConversations(
  current: readonly MapDesignConversationSummary[],
  listed: readonly MapDesignConversationSummary[],
): readonly MapDesignConversationSummary[] {
  const listedIds = new Set(listed.map((conversation) => conversation.conversationId));
  return [...listed, ...current.filter((conversation) => !listedIds.has(conversation.conversationId))];
}

export function useMapDesignConversations(projectId: string, requestedConversationIdFromRoute: string | null, readOnly = false) {
  const { t } = useI18n();
  const [conversations, setConversations] = useState<readonly MapDesignConversationSummary[]>([]);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const [requestedId, setRequestedId] = useState<string | null>(requestedConversationIdFromRoute);
  const [selected, setSelected] = useState<MapDesignConversationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<MapDesignConversationFailure | null>(null);
  const [showUnavailableNotice, setShowUnavailableNotice] = useState(false);
  const deleteController = useRef<AbortController | null>(null);
  const listController = useRef<{ projectId: string; controller: AbortController } | null>(null);
  const createOperation = useRef<{ idempotencyKey: string; controller: AbortController | null } | null>(null);
  const retryOperation = useRef<{
    projectId: string;
    operation: MapDesignConversationFailure['operation'];
    promise: Promise<void>;
  } | null>(null);
  const failureRef = useRef<MapDesignConversationFailure | null>(failure);
  const routeRequest = useRef<string | null>(requestedConversationIdFromRoute);
  const currentProjectId = useRef(projectId);
  const readOnlyRef = useRef(readOnly);
  currentProjectId.current = projectId;
  readOnlyRef.current = readOnly;
  failureRef.current = failure;

  useEffect(() => {
    if (requestedConversationIdFromRoute === routeRequest.current) return;
    routeRequest.current = requestedConversationIdFromRoute;
    setRequestedId(requestedConversationIdFromRoute);
    setShowUnavailableNotice(false);
  }, [requestedConversationIdFromRoute]);

  useEffect(() => {
    deleteController.current?.abort(); deleteController.current = null;
    setRequestedId(requestedConversationIdFromRoute);
    const controller = new AbortController();
    listController.current?.controller.abort();
    listController.current = { projectId, controller };
    createOperation.current?.controller?.abort();
    createOperation.current = null;
    retryOperation.current = null;
    setLoadedProjectId(null);
    setConversations([]);
    setSelected(null);
    setLoading(true);
    setCreating(false);
    setFailure(null);
    setShowUnavailableNotice(false);
    void listMapDesignConversations(projectId, controller.signal).then(
      (response) => {
        if (controller.signal.aborted) return;
        setConversations((current) => mergeConversations(current, response.conversations));
        setLoadedProjectId(projectId);
        setFailure((current) => current?.operation === 'list' ? null : current);
      },
      () => {
        if (!controller.signal.aborted) setFailure({ operation: 'list' });
      },
    ).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => {
      if (currentProjectId.current !== projectId) return;
      const current = listController.current;
      if (current?.projectId === projectId) current.controller.abort();
    };
  }, [projectId]);

  useEffect(() => {
    if (!readOnly) return;
    const operation = createOperation.current;
    operation?.controller?.abort();
    if (operation) {
      operation.controller = null;
      setFailure({ operation: 'create' });
    }
    retryOperation.current = null;
    setCreating(false);
  }, [readOnly]);

  useEffect(() => {
    const onPopstate = () => {
      const next = requestedConversationId();
      setRequestedId(next);
      setShowUnavailableNotice(false);
    };
    window.addEventListener('popstate', onPopstate);
    return () => window.removeEventListener('popstate', onPopstate);
  }, []);

  useEffect(() => {
    if (loadedProjectId !== projectId) return;
    const projectConversations = conversations.filter((conversation) => conversation.projectId === projectId);
    const requested = requestedId === null ? null : projectConversations.find((conversation) => conversation.conversationId === requestedId) ?? null;
    const fallback = projectConversations[0] ?? null;
    const next = requested ?? fallback;
    setSelected(next);
    if (next === null) {
      writeConversationId(null, 'replace');
      return;
    }
    if (requested !== null) {
      return;
    }
    writeConversationId(next.conversationId, 'replace');
    setRequestedId(next.conversationId);
    setShowUnavailableNotice(requestedId !== null);
  }, [conversations, loadedProjectId, projectId, requestedId]);

  const select = useCallback((conversationId: string) => {
    const next = conversations.find((conversation) => conversation.projectId === projectId && conversation.conversationId === conversationId) ?? null;
    if (next === null) return;
    setSelected(next);
    setRequestedId(next.conversationId);
    setShowUnavailableNotice(false);
    writeConversationId(next.conversationId, 'push');
  }, [conversations, projectId]);

  const refresh = useCallback(async (): Promise<void> => {
    if (deleteController.current) return;
    const controller = new AbortController();
    listController.current?.controller.abort();
    listController.current = { projectId, controller };
    setLoading(true);
    setFailure((current) => current?.operation === 'list' ? null : current);
    try {
      const response = await listMapDesignConversations(projectId, controller.signal);
      if (controller.signal.aborted || currentProjectId.current !== projectId) return;
      setConversations((current) => replaceWithAuthoritativeConversations(current, response.conversations));
      setLoadedProjectId(projectId);
      setFailure((current) => current?.operation === 'list' ? null : current);
    } catch {
      if (!controller.signal.aborted && currentProjectId.current === projectId) {
        setFailure({ operation: 'list' });
      }
    } finally {
      if (!controller.signal.aborted && currentProjectId.current === projectId && listController.current?.controller === controller) {
        setLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    if (!conversations.some((conversation) => conversation.runState === 'running')) return;
    let stopped = false;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = window.setTimeout(poll, 1500);
    };
    let timer = window.setTimeout(poll, 1500);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [conversations, refresh]);

  const create = useCallback(async (): Promise<void> => {
    if (readOnlyRef.current || currentProjectId.current !== projectId || createOperation.current?.controller) return;
    const operation = createOperation.current ?? { idempotencyKey: newIdempotencyKey(), controller: null };
    const controller = new AbortController();
    operation.controller = controller;
    createOperation.current = operation;
    setCreating(true);
    setFailure((current) => current?.operation === 'create' ? null : current);
    try {
      const response = await createMapDesignConversation(projectId, { idempotencyKey: operation.idempotencyKey }, controller.signal);
      if (controller.signal.aborted || createOperation.current !== operation) return;
      const next = response.conversation;
      setConversations((current) => [next, ...current.filter((conversation) => conversation.conversationId !== next.conversationId)]);
      setSelected(next);
      setRequestedId(next.conversationId);
      setShowUnavailableNotice(false);
      writeConversationId(next.conversationId, 'push');
      setFailure((current) => current?.operation === 'create' ? null : current);
      operation.controller = null;
      createOperation.current = null;
      setCreating(false);
    } catch {
      if (!controller.signal.aborted && createOperation.current === operation) {
        setFailure({ operation: 'create' });
      }
    } finally {
      if (createOperation.current === operation && operation.controller === controller) {
        operation.controller = null;
        setCreating(false);
      }
    }
  }, [projectId]);

  const remove = useCallback(async (conversationId: string): Promise<boolean> => {
    if (readOnlyRef.current || currentProjectId.current !== projectId || deleteController.current) return false;
    const controller = new AbortController();
    deleteController.current = controller;
    listController.current?.controller.abort();
    setLoading(false);
    try {
      await deleteMapDesignConversation(projectId, conversationId, controller.signal);
      if (controller.signal.aborted || currentProjectId.current !== projectId) return false;
      setConversations((current) => current.filter((conversation) => conversation.conversationId !== conversationId));
      setRequestedId((current) => current === conversationId ? null : current);
      setShowUnavailableNotice(false);
      return true;
    } finally {
      if (deleteController.current === controller) deleteController.current = null;
    }
  }, [projectId]);

  const retry = useCallback((): Promise<void> => {
    if (readOnlyRef.current || currentProjectId.current !== projectId) return Promise.resolve();
    const operation = failureRef.current?.operation;
    if (operation === undefined) return Promise.resolve();
    const currentRetry = retryOperation.current;
    if (currentRetry?.projectId === projectId && currentRetry.operation === operation) return currentRetry.promise;
    const promise = operation === 'create' ? create() : refresh();
    const retrying = { projectId, operation, promise };
    retryOperation.current = retrying;
    void promise.finally(() => {
      if (retryOperation.current === retrying) retryOperation.current = null;
    });
    return promise;
  }, [create, projectId, refresh]);

  useEffect(() => () => { createOperation.current?.controller?.abort(); deleteController.current?.abort(); }, []);

  const error = failure?.operation === 'create'
    ? t('mapDesign.conversation.createError')
    : failure?.operation === 'list'
      ? t('mapDesign.conversation.listError')
      : null;

  return {
    conversations, selected, select, create, remove, refresh, retry, loading, creating, failure, error,
    notice: showUnavailableNotice ? t('mapDesign.conversation.unavailableNotice') : null,
  };
}
