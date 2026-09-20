// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useLocalAgents } from '../../src/map-design/hooks/useLocalAgents';

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
  it.each([
    { agents: [{ id: 'codex', label: 'Codex', available: true }] },
    { agents: [{ id: 'codex', label: 'Codex', available: true, mapDesign: { nativeMapTools: true, publicReasoningSummary: false, reason: 'unsupported' } }] },
  ])('reports malformed capability data instead of publishing it to the selector', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));
    render(<LocalAgentsState />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The local daemon returned an invalid response.'));
  });
});
