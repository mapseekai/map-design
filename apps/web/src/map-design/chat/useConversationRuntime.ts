import { MAP_API_PROFILE_UNAVAILABLE_NOTICE } from '@mapseekai/contracts';
import { apiProfilesCopy } from '../../i18n/locales/api-profiles';
import type {
  MapDesignConversationRuntimeChoice,
  MapDesignRuntimeSelectionInput,
  UpdateMapDesignConversationRuntimeRequest,
} from '@mapseekai/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getMapDesignConversationRuntime,
  updateMapDesignConversationRuntime,
} from '../../api/client';
import { useI18n } from '../../i18n';

interface RuntimeState {
  scope: string;
  runtime: MapDesignConversationRuntimeChoice | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  notice: string | null;
}

interface RetainedUpdate {
  scope: string;
  signature: string;
  request: UpdateMapDesignConversationRuntimeRequest;
}

function sameSelection(
  choice: MapDesignConversationRuntimeChoice,
  selection: MapDesignRuntimeSelectionInput,
): boolean {
  return choice.agentId === selection.agentId
    && choice.model === selection.model
    && choice.modelOrigin === selection.modelOrigin
    && choice.reasoning === selection.reasoning
    && choice.serviceTier === selection.serviceTier;
}

function selectionSignature(selection: MapDesignRuntimeSelectionInput): string {
  return JSON.stringify({
    agentId: selection.agentId,
    model: selection.model ?? null,
    modelOrigin: selection.modelOrigin ?? null,
    reasoning: selection.reasoning ?? null,
    serviceTier: selection.serviceTier ?? null,
  });
}

export function useConversationRuntime(_options: {
  projectId: string;
  conversationId: string;
  disabled?: boolean;
  enabled?: boolean;
}): {
  runtime: MapDesignConversationRuntimeChoice | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  notice: string | null;
  update(next: MapDesignRuntimeSelectionInput): Promise<void>;
} {
  const { projectId, conversationId, disabled = false, enabled = true } = _options;
  const { t, locale } = useI18n();
  const scope = `${projectId}\u0000${conversationId}`;
  const [state, setState] = useState<RuntimeState>({
    scope,
    runtime: null,
    loading: true,
    saving: false,
    error: null,
    notice: null,
  });
  const contextRef = useRef({ projectId, conversationId, disabled, scope });
  const runtimeRef = useRef<MapDesignConversationRuntimeChoice | null>(null);
  const generationRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const updateControllerRef = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const retainedUpdateRef = useRef<RetainedUpdate | null>(null);
  const copyRef = useRef({
    loadError: t('mapDesign.runtime.loadError'),
    saveError: t('mapDesign.runtime.saveError'),
    conflict: t('mapDesign.runtime.conflict'),
    normalized: t('mapDesign.runtime.normalized'),
    unavailable: apiProfilesCopy[locale].unavailable,
  });
  const visibleState = state.scope === scope ? state : {
    scope,
    runtime: null,
    loading: true,
    saving: false,
    error: null,
    notice: null,
  };
  contextRef.current = { projectId, conversationId, disabled, scope };
  runtimeRef.current = visibleState.runtime;
  copyRef.current = {
    loadError: t('mapDesign.runtime.loadError'),
    saveError: t('mapDesign.runtime.saveError'),
    conflict: t('mapDesign.runtime.conflict'),
    normalized: t('mapDesign.runtime.normalized'),
    unavailable: apiProfilesCopy[locale].unavailable,
  };

  useEffect(() => {
    if (!enabled) { setState({ scope, runtime: null, loading: false, saving: false, error: null, notice: null }); return; }
    const controller = new AbortController();
    loadControllerRef.current?.abort();
    updateControllerRef.current?.abort();
    loadControllerRef.current = controller;
    retainedUpdateRef.current = null;
    savingRef.current = false;
    const generation = ++generationRef.current;
    setState({ scope, runtime: null, loading: true, saving: false, error: null, notice: null });
    void getMapDesignConversationRuntime(projectId, conversationId, controller.signal).then((response) => {
      if (controller.signal.aborted || generationRef.current !== generation || contextRef.current.scope !== scope) return;
      const effectiveRuntime = response.effectiveRuntime ?? response.runtime;
      runtimeRef.current = effectiveRuntime;
      setState({
        scope,
        runtime: effectiveRuntime,
        loading: false,
        saving: false,
        error: null,
        notice: response.normalizationNotice === MAP_API_PROFILE_UNAVAILABLE_NOTICE ? copyRef.current.unavailable
          : response.normalizationNotice ? copyRef.current.normalized : null,
      });
    }).catch(() => {
      if (controller.signal.aborted || generationRef.current !== generation || contextRef.current.scope !== scope) return;
      setState({ scope, runtime: null, loading: false, saving: false, error: copyRef.current.loadError, notice: null });
    });
    return () => {
      controller.abort();
      if (loadControllerRef.current === controller) loadControllerRef.current = null;
      updateControllerRef.current?.abort();
      generationRef.current += 1;
    };
  }, [conversationId, projectId, scope, enabled]);

  const update = useCallback(async (next: MapDesignRuntimeSelectionInput) => {
    const context = contextRef.current;
    const current = runtimeRef.current;
    if (context.disabled || !current || savingRef.current) return;
    const signature = selectionSignature(next);
    const retained = retainedUpdateRef.current;
    const request = retained?.scope === context.scope && retained.signature === signature
      ? retained.request
      : {
          expectedRevision: current.revision,
          runtime: next,
          clientRequestId: `map-runtime:${crypto.randomUUID()}`,
        };
    const logicalUpdate: RetainedUpdate = { scope: context.scope, signature, request };
    retainedUpdateRef.current = logicalUpdate;
    const controller = new AbortController();
    updateControllerRef.current?.abort();
    updateControllerRef.current = controller;
    const generation = generationRef.current;
    savingRef.current = true;
    setState((value) => value.scope === context.scope
      ? { ...value, saving: true, error: null, notice: null }
      : value);
    const currentScope = () => !controller.signal.aborted
      && generationRef.current === generation
      && contextRef.current.scope === context.scope;
    try {
      const response = await updateMapDesignConversationRuntime(
        context.projectId,
        context.conversationId,
        request,
        controller.signal,
      );
      if (!currentScope()) return;
      retainedUpdateRef.current = null;
      const effectiveRuntime = response.effectiveRuntime ?? response.runtime;
      runtimeRef.current = effectiveRuntime;
      setState({
        scope: context.scope,
        runtime: effectiveRuntime,
        loading: false,
        saving: false,
        error: null,
        notice: response.normalizationNotice || !sameSelection(effectiveRuntime, next)
          ? copyRef.current.normalized : null,
      });
    } catch (error) {
      if (!currentScope()) return;
      if (error && typeof error === 'object' && 'code' in error && error.code === 'RUNTIME_CONFLICT') {
        retainedUpdateRef.current = null;
        try {
          const response = await getMapDesignConversationRuntime(
            context.projectId,
            context.conversationId,
            controller.signal,
          );
          if (!currentScope()) return;
          const effectiveRuntime = response.effectiveRuntime ?? response.runtime;
          runtimeRef.current = effectiveRuntime;
          setState({
            scope: context.scope,
            runtime: effectiveRuntime,
            loading: false,
            saving: false,
            error: null,
            notice: copyRef.current.conflict,
          });
        } catch {
          if (!currentScope()) return;
          setState((value) => value.scope === context.scope
            ? { ...value, saving: false, error: copyRef.current.loadError, notice: copyRef.current.conflict }
            : value);
        }
      } else {
        setState((value) => value.scope === context.scope
          ? { ...value, saving: false, error: copyRef.current.saveError }
          : value);
      }
    } finally {
      if (currentScope()) savingRef.current = false;
      if (updateControllerRef.current === controller) updateControllerRef.current = null;
    }
  }, []);

  return {
    runtime: visibleState.runtime,
    loading: visibleState.loading,
    saving: visibleState.saving,
    error: visibleState.error,
    notice: visibleState.notice,
    update,
  };
}
