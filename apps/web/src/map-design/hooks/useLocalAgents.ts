import { API_PROFILES_CHANGED } from '../api-profiles-client';
import type { LocalAgentInfo } from '@mapseekai/contracts';
import { useEffect, useState } from 'react';
import { getLocalAgents } from '../../api/client';

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'Unable to load local agents.';
}

export function useLocalAgents() {
  const [agents, setAgents] = useState<LocalAgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let controller: AbortController | null = null;
    const refresh = () => {
      controller?.abort();
      const request = new AbortController(); controller = request;
      void getLocalAgents(request.signal).then((result) => {
        if (!request.signal.aborted) { setAgents(result.agents); setError(null); }
      }).catch((reason: unknown) => {
        if (!request.signal.aborted) setError(errorMessage(reason));
      }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    };
    refresh();
    window.addEventListener(API_PROFILES_CHANGED, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      controller?.abort(); window.removeEventListener(API_PROFILES_CHANGED, refresh); window.removeEventListener('focus', refresh);
    };
  }, []);

  return { agents, loading, error };
}
