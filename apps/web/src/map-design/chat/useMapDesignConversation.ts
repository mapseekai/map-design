import type { MapDesignConversationResponse } from '@mapseekai/contracts';
import { useEffect, useRef, useState } from 'react';

import { getMapDesignConversation } from '../../api/client';
import { useI18n } from '../../i18n';

type MapDesignConversationLoadFailure = { operation: 'load' };

export function useMapDesignConversation(projectId: string, conversationId: string, refreshKey?: unknown, enabled = true) {
  const { t } = useI18n();
  const [conversation, setConversation] = useState<MapDesignConversationResponse | null>(null);
  const [failure, setFailure] = useState<MapDesignConversationLoadFailure | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useRef<(() => void) | null>(null);
  useEffect(() => {
    setConversation(null);
    setLoading(enabled);
    setFailure(null);
    if (!enabled) return;
    const controller = new AbortController();
    let inFlight = false;
    let pending = false;
    const request = () => {
      if (inFlight) { pending = true; return; }
      inFlight = true;
      pending = false;
      setFailure(null);
      void getMapDesignConversation(projectId, conversationId, controller.signal).then(
        (next) => { if (!controller.signal.aborted) setConversation(next); },
        () => { if (!controller.signal.aborted) setFailure({ operation: 'load' }); },
      ).finally(() => {
        if (controller.signal.aborted) return;
        inFlight = false;
        setLoading(false);
        if (pending) request();
      });
    };
    refresh.current = request;
    return () => { controller.abort(); refresh.current = null; };
  }, [conversationId, projectId, enabled]);

  useEffect(() => {
    refresh.current?.();
  }, [conversationId, projectId, enabled, refreshKey]);

  return {
    conversation,
    failure,
    error: failure ? t('mapDesign.conversation.loadError') : null,
    loading,
  };
}
