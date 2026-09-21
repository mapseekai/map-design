import { LocalAgentListResponseSchema, type LocalAgentInfo, type MapApiConnectionTest, type MapDesignAppConfig } from '@mapseekai/contracts';

export const LOCAL_RUNTIMES_CHANGED = 'map-design:local-runtimes-changed';

async function send(path: string, method: string, signal: AbortSignal, body?: unknown) {
  const response = await fetch(path, { method, signal, credentials: 'same-origin',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result?.error?.code === 'string' ? result.error.code : 'RUNTIME_TEST_FAILED');
  return result;
}

export async function refreshLocalRuntimes(signal: AbortSignal): Promise<LocalAgentInfo[]> {
  const result = LocalAgentListResponseSchema.parse(await send('/api/agents/refresh', 'POST', signal));
  window.dispatchEvent(new Event(LOCAL_RUNTIMES_CHANGED));
  return result.agents;
}

export async function saveRuntimePreference(agentId: string, preference: NonNullable<MapDesignAppConfig['runtimePreferences']>[string], signal: AbortSignal): Promise<MapDesignAppConfig> {
  const result = await send('/api/config', 'PUT', signal, { runtimePreferences: { [agentId]: preference } });
  window.dispatchEvent(new Event(LOCAL_RUNTIMES_CHANGED));
  return result.config as MapDesignAppConfig;
}

export async function testLocalModel(agentId: string, model: string, signal: AbortSignal): Promise<MapApiConnectionTest> {
  const result = await send(`/api/agents/${encodeURIComponent(agentId)}/test`, 'POST', signal, { model });
  if (!['passed', 'failed'].includes(result.status) || typeof result.testedAt !== 'string' || typeof result.latencyMs !== 'number') throw new Error('RUNTIME_TEST_FAILED');
  return result as MapApiConnectionTest;
}
