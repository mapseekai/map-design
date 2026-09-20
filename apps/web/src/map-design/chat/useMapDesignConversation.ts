import type { MapDesignConversation } from '@mapseekai/contracts';
import { useEffect, useRef, useState } from 'react';

import { getMapDesignConversation } from '../../api/client';
import { useI18n } from '../../i18n';

type MapDesignConversationLoadFailure = { operation: 'load' };

export function useMapDesignConversation(projectId: string, conversationId: string, refreshKey?: unknown, enabled = true) {
  const { t } = useI18n();
  const [conversation, setConversation] = useState<MapDesignConversation | null>(null);
  const [failure, setFailure] = useState<MapDesignConversationLoadFailure | null>(null);
  const [loading, setLoading] = useState(true);

  const loadedScope = useRef('');
  useEffect(() => {
    if (!enabled) { setConversation(null); setLoading(false); return; }
    const controller = new AbortController();
    const scope = `${projectId}:${conversationId}`;
    if (loadedScope.current !== scope) { setConversation(null); setLoading(true); loadedScope.current = scope; }
    setFailure(null);
    void getMapDesignConversation(projectId, conversationId, controller.signal).then(
      (next) => { if (!controller.signal.aborted) setConversation(next); },
      () => { if (!controller.signal.aborted) setFailure({ operation: 'load' }); },
    ).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [conversationId, projectId, refreshKey, enabled]);

  return {
    conversation,
    failure,
    error: failure ? t('mapDesign.conversation.loadError') : null,
    loading,
  };
}
