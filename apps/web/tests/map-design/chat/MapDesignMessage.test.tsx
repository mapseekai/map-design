// @vitest-environment jsdom

import type { MapDesignMessage as Message, PersistedMapAgentEvent } from '@mapseekai/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MapDesignMessage } from '../../../src/map-design/chat/MapDesignMessage';

afterEach(cleanup);

function assistant(
  content: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    id: 'message-1',
    conversationId: 'conversation-1',
    role: 'assistant',
    content,
    events: content ? [{ kind: 'text', text: content }] : [],
    runStatus: 'succeeded',
    startedAt: 1_788_100_000_000,
    endedAt: 1_788_100_002_000,
    ...overrides,
  };
}

describe('MapDesignMessage', () => {
  it('renders a persisted text attachment as a project-scoped preview link', () => {
    const file = { id: 'c'.repeat(64), projectId: 'map-1', fileName: 'points.csv', mediaType: 'text/plain' as const,
      byteLength: 14, createdAt: '2026-09-09T00:00:00.000Z' };
    render(<MapDesignMessage message={{ id: 'u1', conversationId: 'c1', role: 'user', content: 'Analyze the file',
      events: [], runStatus: 'succeeded', startedAt: 1, endedAt: 1, attachments: [file] }} />);
    expect(screen.getByRole('link', { name: 'points.csv' })).toHaveAttribute('href', `/api/map-design/projects/map-1/attachments/${file.id}/content`);
  });

  it('renders immutable assistant provenance from the message record', () => {
    render(<MapDesignMessage message={assistant('Map ready.', {
      runtime: {
        agentId: 'opencode',
        agentVersion: '1.2.3',
        model: 'openai/gpt-5.6-terra',
        reasoning: 'high',
        serviceTier: 'priority',
        adapter: 'opencode-plugin',
      },
    })} />);

    expect(screen.getByText('OpenCode · 1.2.3 · openai/gpt-5.6-terra · high · priority · opencode-plugin')).toBeInTheDocument();
  });

  it('does not render or request remote markdown images', () => {
    render(<MapDesignMessage message={assistant('![Tracking pixel](https://example.test/pixel.png)')} />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('Tracking pixel')).toBeInTheDocument();
  });

  it('keeps safe local markdown images', () => {
    render(<MapDesignMessage message={assistant('![Local legend](/api/map-design/projects/map-1/legend.png)')} />);
    expect(document.querySelector('img')).toHaveAttribute('src', '/api/map-design/projects/map-1/legend.png');
  });

  it('renders one current Run card before its final answer', () => {
    render(<MapDesignMessage message={assistant('Map ready.', {
      runStatus: 'running',
      endedAt: 0,
      events: [
        { kind: 'status', label: 'validating' },
        { kind: 'thinking', text: 'Checking the public map constraints.' },
        { kind: 'tool_use', id: 'tool-1', name: 'map_validate', summary: { scope: 'draft' } },
        { kind: 'text', text: 'Map ready.' },
      ],
    })} />);

    const taskCard = screen.getByTestId('task-activity-toggle');
    const finalAnswer = screen.getByText('Map ready.');
    expect(taskCard).toHaveAttribute('data-run-state', 'running');
    expect(taskCard).toHaveAttribute('aria-expanded', 'true');
    expect(finalAnswer.compareDocumentPosition(taskCard) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(screen.getAllByTestId('task-activity-toggle')).toHaveLength(1);
  });

  it('renders only public thinking fields from persisted events', () => {
    const thinking = {
      kind: 'thinking',
      text: 'Public reasoning summary.',
      privateText: 'PRIVATE CHAIN OF THOUGHT MUST NOT RENDER',
    } as PersistedMapAgentEvent;

    render(<MapDesignMessage message={assistant('', {
      runStatus: 'running',
      endedAt: 0,
      events: [thinking],
    })} />);

    expect(screen.getByText('Public reasoning summary.')).toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE CHAIN OF THOUGHT/)).not.toBeInTheDocument();
  });

  it('renders a reloaded failed Run as a collapsed task record', () => {
    render(<MapDesignMessage message={assistant('', {
      runStatus: 'failed',
      events: [{ kind: 'run_finished', status: 'failed' }],
    })} />);

    const taskCard = screen.getByTestId('task-activity-toggle');
    expect(taskCard).toHaveAttribute('data-run-state', 'failed');
    expect(taskCard).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('article', { name: 'Assistant message' })).toContainElement(taskCard);
  });

  it('renders streamed event text before message_completed supplies authoritative content', () => {
    render(<MapDesignMessage message={assistant('', {
      runStatus: 'running',
      endedAt: 0,
      events: [
        { kind: 'text', text: 'Streaming ' },
        { kind: 'text', text: 'answer.' },
      ],
    })} />);

    expect(screen.getByText('Streaming answer.')).toBeInTheDocument();
  });

  it('preserves text blocks separated by tool activity instead of concatenating them', () => {
    render(<MapDesignMessage message={assistant('First.Second.', {
      runStatus: 'running',
      endedAt: 0,
      events: [
        { kind: 'text', text: 'First.' },
        { kind: 'tool_use', id: 'tool-1', name: 'map_inspect', summary: { target: 'roads' } },
        { kind: 'tool_result', toolUseId: 'tool-1', status: 'succeeded', summary: { matched: 2 } },
        { kind: 'text', text: 'Second.' },
        { kind: 'run_finished', status: 'succeeded' },
      ],
    })} />);

    expect(screen.getByText('First.')).toBeInTheDocument();
    expect(screen.getByText('Second.')).toBeInTheDocument();
    expect(screen.queryByText('First.Second.')).not.toBeInTheDocument();
  });

  it('renders canonical terminal content instead of unavailable placeholders from persisted deltas', () => {
    render(<MapDesignMessage message={assistant('First.\n\n- Second.\n- Third.', {
      events: [
        { kind: 'text', text: 'First.' },
        { kind: 'text', text: 'Content unavailable.' },
        { kind: 'text', text: '- Second.' },
        { kind: 'text', text: 'Content unavailable.' },
        { kind: 'text', text: '- Third.' },
        { kind: 'run_finished', status: 'succeeded' },
      ],
    })} />);

    expect(screen.getByText('First.')).toBeInTheDocument();
    expect(screen.getByText('Second.')).toBeInTheDocument();
    expect(screen.getByText('Third.')).toBeInTheDocument();
    expect(screen.queryByText(/Content unavailable\./u)).not.toBeInTheDocument();
  });

  it('reads and prepares a stable message event snapshot once across parent rerenders', () => {
    const stableEvents: PersistedMapAgentEvent[] = [
      { kind: 'status', label: 'analyzing' },
      { kind: 'thinking', text: 'Public summary.' },
    ];
    let eventReads = 0;
    const message = assistant('');
    Object.defineProperty(message, 'events', {
      configurable: true,
      get: () => {
        eventReads += 1;
        return stableEvents;
      },
    });

    const view = render(<MapDesignMessage message={message} />);
    expect(eventReads).toBe(1);

    view.rerender(<MapDesignMessage message={message} />);
    expect(eventReads).toBe(1);
  });
});
