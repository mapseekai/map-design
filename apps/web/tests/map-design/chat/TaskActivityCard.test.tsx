// @vitest-environment jsdom

import type { PersistedMapAgentEvent } from '@mapseekai/contracts';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildMapDesignEventBlocks,
  splitTaskActivity,
  TaskActivityCard,
} from '../../../src/map-design/chat/TaskActivityCard';

afterEach(cleanup);

const events: PersistedMapAgentEvent[] = [
  { kind: 'status', label: 'analyzing' },
  { kind: 'thinking', text: 'Inspecting ' },
  { kind: 'thinking', text: 'the road hierarchy.' },
  { kind: 'tool_use', id: 'tool-1', name: 'map_inspect', summary: { target: 'roads/primary' } },
  { kind: 'tool_result', toolUseId: 'tool-1', status: 'succeeded', summary: { matchedFeatures: 12 } },
  { kind: 'text', text: 'The map ' },
  { kind: 'text', text: 'is ready.' },
];

function activityFor(input: readonly PersistedMapAgentEvent[]) {
  return splitTaskActivity(buildMapDesignEventBlocks(input)).taskActivity;
}

describe('TaskActivityCard', () => {
  it('builds ordered blocks by combining deltas and pairing tools by stable ID', () => {
    const split = splitTaskActivity(buildMapDesignEventBlocks(events));

    expect(split.contentBlocks).toEqual([{ kind: 'text', text: 'The map is ready.' }]);
    expect(split.taskActivity).toEqual({
      stage: 'analyzing',
      entries: [
        { kind: 'thinking', text: 'Inspecting the road hierarchy.' },
        {
          kind: 'tool',
          activity: {
            id: 'tool-1',
            name: 'map_inspect',
            summary: { target: 'roads/primary' },
            result: { status: 'succeeded', summary: { matchedFeatures: 12 } },
          },
        },
      ],
    });
  });

  it('deduplicates tool uses, pairs an early result by ID, and ignores orphan results', () => {
    const split = splitTaskActivity(buildMapDesignEventBlocks([
      { kind: 'tool_result', toolUseId: 'tool-1', status: 'succeeded', summary: { matchedFeatures: 12 } },
      { kind: 'tool_result', toolUseId: 'orphan', status: 'failed', summary: { message: 'Ignored' } },
      { kind: 'tool_use', id: 'tool-1', name: 'map_inspect', summary: { target: 'roads' } },
      { kind: 'tool_use', id: 'tool-1', name: 'map_inspect', summary: { target: 'roads/primary' } },
    ]));

    expect(split.taskActivity?.entries).toEqual([{
      kind: 'tool',
      activity: {
        id: 'tool-1',
        name: 'map_inspect',
        summary: { target: 'roads/primary' },
        result: { status: 'succeeded', summary: { matchedFeatures: 12 } },
      },
    }]);
  });

  it('opens the current Run and announces only its aggregate state', () => {
    render(<TaskActivityCard activity={activityFor(events)} runStatus="running" />);

    const toggle = screen.getByTestId('task-activity-toggle');
    expect(toggle).toHaveAttribute('data-run-state', 'running');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls');
    expect(toggle).toHaveAccessibleName(/Analyzing.*Working/i);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Working');
    expect(screen.getByRole('status')).not.toHaveTextContent('road hierarchy');
    expect(screen.getByText('Inspecting the road hierarchy.').closest('[aria-live="off"]')).not.toBeNull();
  });

  it('initializes a reloaded terminal Run closed but preserves an open live Run when it settles', () => {
    const terminalView = render(<TaskActivityCard activity={activityFor(events)} runStatus="succeeded" />);
    expect(screen.getByTestId('task-activity-toggle')).toHaveAttribute('aria-expanded', 'false');
    terminalView.unmount();

    const liveView = render(<TaskActivityCard activity={activityFor(events)} runStatus="running" />);
    expect(screen.getByTestId('task-activity-toggle')).toHaveAttribute('aria-expanded', 'true');
    liveView.rerender(<TaskActivityCard
      activity={activityFor([...events, { kind: 'run_finished', status: 'succeeded' }])}
      runStatus="succeeded"
    />);
    expect(screen.getByTestId('task-activity-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggles its disclosure from real Enter and Space key events', () => {
    render(<TaskActivityCard activity={activityFor(events)} runStatus="succeeded" />);
    const toggle = screen.getByTestId('task-activity-toggle');
    expect(toggle.tagName).toBe('BUTTON');
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'Enter' });
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(toggle, { key: ' ' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('marks only the latest unresolved tool as running', () => {
    render(<TaskActivityCard
      activity={activityFor([
        { kind: 'tool_use', id: 'tool-1', name: 'map_inspect', summary: { target: 'roads' } },
        { kind: 'tool_use', id: 'tool-2', name: 'map_validate', summary: { scope: 'draft' } },
      ])}
      runStatus="running"
    />);

    expect(screen.getByRole('button', { name: /Inspect map.*Failed/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Validate map.*Working/i })).toBeInTheDocument();
  });

  it('pairs an explicit canceled tool result without rewriting it as failed', () => {
    const activity = activityFor([
      { kind: 'tool_use', id: 'tool-1', name: 'map_inspect', summary: { target: 'roads' } },
      { kind: 'tool_result', toolUseId: 'tool-1', status: 'canceled', summary: { retryable: false } },
    ]);
    expect(activity?.entries).toEqual([{
      kind: 'tool',
      activity: {
        id: 'tool-1',
        name: 'map_inspect',
        summary: { target: 'roads' },
        result: { status: 'canceled', summary: { retryable: false } },
      },
    }]);

    render(<TaskActivityCard activity={activity} runStatus="canceled" />);
    fireEvent.click(screen.getByTestId('task-activity-toggle'));
    expect(screen.getByRole('button', { name: /Inspect map.*Canceled/i })).toBeInTheDocument();
  });
});
