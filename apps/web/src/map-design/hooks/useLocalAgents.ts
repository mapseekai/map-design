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
    const controller = new AbortController();
    void getLocalAgents(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setAgents(result.agents);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  return { agents, loading, error };
}
