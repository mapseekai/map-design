// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useLocalAgents } from '../../src/map-design/hooks/useLocalAgents';
import { LOCAL_RUNTIMES_CHANGED } from '../../src/map-design/local-runtimes-client';

function LocalAgentsState() {
  const { error, loading } = useLocalAgents();
  if (error) return <p role="alert">{error}</p>;
  return <p role="status">{loading ? 'loading' : 'ready'}</p>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useLocalAgents', () => {
  it('removes disabled runtimes after settings change while preserving model opt-outs', async () => {
    const local = { id: 'local', label: 'Local', available: true, enabled: true,
      modelCatalogSource: 'live', mapDesign: { nativeMapTools: true, publicReasoningSummary: true },
      models: [{ id: 'disabled', label: 'Disabled', enabled: false, default: false, reasoningOptions: [], serviceTierOptions: [] }] };
    const request = vi.fn().mockImplementationOnce(async () => new Response(JSON.stringify({ agents: [local] })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ agents: [{ ...local, enabled: false }] })));
    vi.stubGlobal('fetch', request);
    function Choices() {
      const { agents } = useLocalAgents();
      return <p data-testid="choices">{agents.map(agent => `${agent.id}:${agent.models?.[0]?.enabled}`).join(',')}</p>;
    }
    render(<Choices />);
    await waitFor(() => expect(screen.getByTestId('choices')).toHaveTextContent('local:false'));
    act(() => window.dispatchEvent(new Event(LOCAL_RUNTIMES_CHANGED)));
    await waitFor(() => expect(screen.getByTestId('choices')).toBeEmptyDOMElement());
  });

  it.each([
    { agents: [{ id: 'codex', label: 'Codex', available: true }] },
    { agents: [{ id: 'codex', label: 'Codex', available: true, mapDesign: { nativeMapTools: true, publicReasoningSummary: false, reason: 'unsupported' } }] },
  ])('reports malformed capability data instead of publishing it to the selector', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));
    render(<LocalAgentsState />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The local daemon returned an invalid response.'));
  });
});
