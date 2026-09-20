// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeHook = vi.hoisted(() => ({
  states: new Map<string, {
    runtime: { agentId: string; revision: number; updatedAt: string; model?: string; reasoning?: string; serviceTier?: string } | null;
    loading: boolean;
    error: string | null;
  }>(),
  update: vi.fn(async () => undefined),
}));

vi.mock('../../../src/map-design/chat/useConversationRuntime', async () => {
  const { useRef } = await import('react');
  return {
    useConversationRuntime: ({ conversationId }: { conversationId: string }) => {
      const scope = useRef(conversationId);
      const invalidated = useRef(false);
      if (scope.current !== conversationId) {
        scope.current = conversationId;
        invalidated.current = true;
      }
      const configured = runtimeHook.states.get(conversationId) ?? {
        runtime: { agentId: 'claude', revision: 0, updatedAt: '2026-09-02T00:00:00.000Z' },
        loading: false,
        error: null,
      };
      return {
        ...configured,
        ...(invalidated.current ? { runtime: null, loading: true } : {}),
        saving: false,
        notice: null,
        update: runtimeHook.update,
      };
    },
  };
});

import { MapDesignChatPane, type MapCommentSubmission } from '../../../src/map-design/chat/MapDesignChatPane';
import type { MapComment } from '@mapseekai/map-design-contracts';
import { latestUnansweredFormOccurrence } from '../../../src/map-design/chat/MapDesignChatPane';
import { MapDesignComposer } from '../../../src/map-design/chat/MapDesignComposer';
import { MapDesignMessage } from '../../../src/map-design/chat/MapDesignMessage';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function ComposerHarness({ onSend }: { onSend(prompt: string): boolean | Promise<boolean> }) {
  const [draft, setDraft] = useState('');
  return <MapDesignComposer projectId="map-1" runtime={{ revision: 0, agentId: 'claude', label: 'Claude Code' }} sending={false} draft={draft} onDraftChange={setDraft} onSend={onSend} />;
}

function persistedAssistant(id: string, conversationId: string, content: string) {
  return {
    id,
    conversationId,
    role: 'assistant' as const,
    content,
    events: content ? [{ kind: 'text' as const, text: content }] : [],
    runStatus: 'succeeded' as const,
    startedAt: 1_788_100_000_000,
    endedAt: 1_788_100_002_000,
  };
}

const runtimeAgents = [{
  id: 'opencode', label: 'OpenCode', available: true,
  mapDesign: { nativeMapTools: true, publicReasoningSummary: true },
  models: [{
    id: 'openai/gpt-5.6-terra', label: 'GPT 5.6 Terra', enabled: true, default: true,
    reasoningOptions: ['high'], serviceTierOptions: ['priority'],
  }, {
    id: 'openai/gpt-5.6-luna', label: 'GPT 5.6 Luna', enabled: true, default: false,
    reasoningOptions: ['medium'], serviceTierOptions: [],
  }],
  modelCatalogSource: 'live' as const,
}];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  runtimeHook.states.clear();
  runtimeHook.update.mockClear();
});

describe('focused map chat rendering', () => {
  it('shows a return-to-bottom button after the reader scrolls away', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ id: 'conversation-1', projectId: 'map-1',
      createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z',
      messages: [persistedAssistant('a1', 'conversation-1', 'Ready to inspect')] }));
    render(<MapDesignChatPane projectId="map-1" conversationId="conversation-1" />);
    const message = await screen.findByRole('article', { name: 'Assistant message' });
    const scroller = message.parentElement!.parentElement!;
    Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 }, scrollTop: { configurable: true, writable: true, value: 0 } });
    fireEvent.scroll(scroller);
    const button = await screen.findByRole('button', { name: /bottom/i });
    fireEvent.click(button);
    expect(scroller.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: /bottom/i })).toBeNull();
  });

  it('routes comments to the selected conversation and invalidates old and historical submission handles', async () => {
    const starts: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const conversationId = /\/conversations\/(conversation-[ab])$/u.exec(url)?.[1];
      if (conversationId) return Promise.resolve(json({ id: conversationId, projectId: 'map-1', createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z', messages: [] }));
      if (url === '/api/runs') {
        starts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Promise.resolve(json({ runId: 'run-b', projectId: 'map-1', conversationId: 'conversation-b', status: 'succeeded' }, 202));
      }
      if (url.endsWith('/events')) return Promise.resolve(new Response('data: {"type":"run_finished","run":{"runId":"run-b","projectId":"map-1","conversationId":"conversation-b","status":"succeeded"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    let submission: MapCommentSubmission | null = null;
    const register = (value: MapCommentSubmission | null) => { submission = value; };
    const comment: MapComment = { id: 'comment-1', version: 2, projectId: 'map-1', text: 'Make this road red', scope: 'layer',
      draftRevision: 1, styleHash: 'a'.repeat(64), target: { layerId: 'roads', sourceId: 'streets', geometryType: 'LineString', anchor: [120, 30], properties: {} },
      status: 'draft', runId: null, createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z' };
    const view = render(<MapDesignChatPane projectId="map-1" conversationId="conversation-a" onCommentSubmissionChange={register} />);
    await waitFor(() => expect(submission?.disabled).toBe(false));
    const first = submission!;
    view.rerender(<MapDesignChatPane projectId="map-1" conversationId="conversation-b" onCommentSubmissionChange={register} />);
    await waitFor(() => expect(submission?.conversationId).toBe('conversation-b'));
    await act(async () => { expect(await first.send([comment])).toBe(false); });
    await act(async () => { expect(await submission!.send([comment])).toBe(true); });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ conversationId: 'conversation-b', commentRefs: [{ id: 'comment-1', version: 2 }] });
    const second = submission!;
    view.rerender(<MapDesignChatPane projectId="map-1" conversationId="conversation-b" onCommentSubmissionChange={register} readOnly />);
    await act(async () => { expect(await second.send([comment])).toBe(false); });
    expect(starts).toHaveLength(1);
  });
  it('uses the selected conversation runtime revision and locks mutations before Run fetch', async () => {
    runtimeHook.states.set('conversation-1', { runtime: {
      agentId: 'opencode', model: 'openai/gpt-5.6-terra', reasoning: 'high', serviceTier: 'priority',
      revision: 7, updatedAt: '2026-09-02T00:00:00.000Z',
    }, loading: false, error: null });
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/conversations/conversation-1')) return Promise.resolve(json({
        id: 'conversation-1', projectId: 'map-1', createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z', messages: [],
      }));
      if (url === '/api/runs' && init?.method === 'POST') return Promise.resolve(json({
        runId: 'run-1', projectId: 'map-1', conversationId: 'conversation-1', status: 'running',
      }, 202));
      if (url === '/api/runs/run-1/events') return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
      }), { headers: { 'content-type': 'text/event-stream' } }));
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });

    const view = render(<MapDesignChatPane projectId="map-1" conversationId="conversation-1" agents={runtimeAgents} />);
    const input = await screen.findByRole('textbox', { name: 'Message map agent' });
    fireEvent.change(input, { target: { value: 'Adjust labels' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(fetchSpy.mock.calls.some(([url]) => String(url) === '/api/runs')).toBe(true));
    const runCall = fetchSpy.mock.calls.find(([url]) => String(url) === '/api/runs');
    const request = JSON.parse(String(runCall?.[1]?.body)) as Record<string, unknown>;
    expect(request.runtimeRevision).toBe(7);
    expect(request).not.toHaveProperty('agentId');
    expect(request).not.toHaveProperty('model');
    expect(request).not.toHaveProperty('reasoning');
    expect(request).not.toHaveProperty('serviceTier');
    expect(screen.getByRole('button', { name: /Change runtime/iu })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Change runtime/iu }));
    expect(runtimeHook.update).not.toHaveBeenCalled();

    view.unmount();
    await act(async () => streamController?.close());
  });

  it('retains each session runtime and keeps active cancellation available across A to B to A', async () => {
    runtimeHook.states.set('conversation-a', { runtime: {
      agentId: 'opencode', model: 'openai/gpt-5.6-terra', reasoning: 'high', serviceTier: 'priority', revision: 3,
      updatedAt: '2026-09-02T00:00:00.000Z',
    }, loading: false, error: null });
    runtimeHook.states.set('conversation-b', { runtime: {
      agentId: 'opencode', model: 'openai/gpt-5.6-luna', reasoning: 'medium', revision: 8,
      updatedAt: '2026-09-02T00:00:01.000Z',
    }, loading: false, error: null });
    const starts: Array<Record<string, unknown>> = [];
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      const conversationMatch = /\/conversations\/(conversation-[ab])$/u.exec(url);
      if (conversationMatch?.[1]) return Promise.resolve(json({
        id: conversationMatch[1], projectId: 'map-1', createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z', messages: [],
      }));
      if (url === '/api/runs' && init?.method === 'POST') {
        starts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Promise.resolve(json({
          runId: 'run-a', projectId: 'map-1', conversationId: 'conversation-a', status: 'running',
        }, 202));
      }
      if (url === '/api/runs/run-a/events') return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
      }), { headers: { 'content-type': 'text/event-stream' } }));
      if (url === '/api/runs/run-a/cancel' && init?.method === 'POST') {
        return Promise.resolve(json({ runId: 'run-a', status: 'canceled' }));
      }
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });

    const view = render(<MapDesignChatPane projectId="map-1" conversationId="conversation-a" agents={runtimeAgents} />);
    const composerA = await screen.findByRole('textbox', { name: 'Message map agent' });
    fireEvent.change(composerA, { target: { value: 'Keep A running' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Cancel run' });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ conversationId: 'conversation-a', runtimeRevision: 3 });

    view.rerender(<MapDesignChatPane projectId="map-1" conversationId="conversation-b" agents={runtimeAgents} />);
    expect(await screen.findByRole('button', { name: /Change runtime/iu })).toHaveTextContent('OpenCode · GPT 5.6 Luna · medium');

    view.rerender(<MapDesignChatPane projectId="map-1" conversationId="conversation-a" agents={runtimeAgents} />);
    expect(await screen.findByRole('button', { name: /Change runtime/iu })).toHaveTextContent('OpenCode · GPT 5.6 Terra · high');
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeEnabled();

    runtimeHook.states.set('conversation-a', { runtime: null, loading: false, error: 'Runtime temporarily unavailable.' });
    view.rerender(<MapDesignChatPane projectId="map-1" conversationId="conversation-a" agents={runtimeAgents} />);
    const cancel = screen.getByRole('button', { name: 'Cancel run' });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    await waitFor(() => expect(fetchSpy.mock.calls.some(([url]) => String(url) === '/api/runs/run-a/cancel')).toBe(true));

    view.unmount();
    await act(async () => streamController?.close());
  });

  it('replaces the expanded conversation with an accessible active-run rail when collapsed', () => {
    const onExpand = vi.fn();
    const onCreateConversation = vi.fn();
    render(<MapDesignChatPane
      projectId="map-1"
      conversationId="conversation-1"
      collapsed
      onExpand={onExpand}
      onCreateConversation={onCreateConversation}
    />);

    expect(screen.queryByRole('textbox', { name: 'Message map agent' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand design conversation' }));
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(onExpand).toHaveBeenCalledOnce();
    expect(onCreateConversation).toHaveBeenCalledOnce();
  });

  it('disables every collapsed-rail action while viewing a historical revision', () => {
    const onExpand = vi.fn();
    const onCreateConversation = vi.fn();
    render(<MapDesignChatPane projectId="map-1" conversationId="conversation-1"
      collapsed readOnly onExpand={onExpand} onCreateConversation={onCreateConversation} />);

    const expand = screen.getByRole('button', { name: 'Expand design conversation' });
    const create = screen.getByRole('button', { name: 'New conversation' });
    expect(expand).toBeDisabled();
    expect(create).toBeDisabled();
    fireEvent.click(expand);
    fireEvent.click(create);
    expect(onExpand).not.toHaveBeenCalled();
    expect(onCreateConversation).not.toHaveBeenCalled();
  });

  it('announces an unavailable persisted agent and blocks every composer submission control', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/map-design/projects/map-1/conversations/conversation-1') {
        return Promise.resolve(json({
          id: 'conversation-1', projectId: 'map-1',
          createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z', messages: [],
        }));
      }
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });

    render(<MapDesignChatPane
      projectId="map-1"
      conversationId="conversation-1"
      agentBlocked
      agentStatusMessage="Map editing unavailable"
    />);

    expect(await screen.findByRole('status')).toHaveTextContent('Map editing unavailable');
    expect(screen.getByRole('textbox', { name: 'Message map agent' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('locks the composer with a localized historical-view reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input) === '/api/map-design/projects/map-1/conversations/conversation-1') {
        return Promise.resolve(json({
          id: 'conversation-1', projectId: 'map-1',
          createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z', messages: [],
        }));
      }
      return Promise.reject(new Error(`Unexpected request ${String(input)}`));
    });

    render(<MapDesignChatPane
      projectId="map-1"
      conversationId="conversation-1"
      readOnly
      viewedRevision={1}
      readOnlyReason="Viewing revision 1 is read only."
    />);

    expect(await screen.findByRole('status')).toHaveTextContent('Viewing revision 1 is read only.');
    expect(screen.getByRole('textbox', { name: 'Message map agent' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('keeps the sole cancel control inside the composer action group and cancels the run once', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/map-design/projects/map-1/conversations/conversation-1') {
        return Promise.resolve(json({
          id: 'conversation-1',
          projectId: 'map-1',
          createdAt: '2026-08-30T00:00:00.000Z',
          updatedAt: '2026-08-30T00:00:00.000Z',
          messages: [],
        }));
      }
      if (url === '/api/runs' && init?.method === 'POST') {
        return Promise.resolve(json({ runId: 'run-1', projectId: 'map-1', conversationId: 'conversation-1', status: 'running' }, 202));
      }
      if (url === '/api/runs/run-1/events') {
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          headers: { 'content-type': 'text/event-stream' },
        }));
      }
      if (url === '/api/runs/run-1/cancel' && init?.method === 'POST') {
        return Promise.resolve(json({ runId: 'run-1', status: 'canceled' }));
      }
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    const { container } = render(<MapDesignChatPane projectId="map-1" conversationId="conversation-1" />);
    const composer = await screen.findByRole('textbox', { name: 'Message map agent' });
    fireEvent.change(composer, { target: { value: 'Adjust labels' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    const group = await screen.findByRole('group', { name: 'Run actions' });
    const cancel = within(group).getByRole('button', { name: 'Cancel run' });
    expect(cancel.closest('form')).toBe(container.querySelector('form'));
    expect(screen.getAllByRole('button', { name: 'Cancel run' })).toEqual([cancel]);

    fireEvent.click(cancel);
    await waitFor(() => expect(fetchSpy.mock.calls.filter(([input]) => String(input) === '/api/runs/run-1/cancel')).toHaveLength(1));
  });

  it('leaves activity announcements to the task aggregate live region', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url === '/api/map-design/projects/map-1/conversations/conversation-1') return Promise.resolve(json({
        id: 'conversation-1',
        projectId: 'map-1',
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
        messages: [{
          ...persistedAssistant('assistant-running', 'conversation-1', ''),
          runStatus: 'running',
          endedAt: 0,
          events: [{ kind: 'status', label: 'validating' }],
        }],
      }));
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });

    render(<MapDesignChatPane projectId="map-1" conversationId="conversation-1" />);

    const article = await screen.findByRole('article', { name: 'Assistant message' });
    expect(article.parentElement).not.toHaveAttribute('aria-live');
    expect(within(article).getAllByRole('status')).toHaveLength(1);
    expect(within(article).getByRole('status')).toHaveTextContent('Working');
  });

  it('does not rerender historical messages when an active sibling receives an event snapshot', async () => {
    const nativeParse = JSON.parse.bind(JSON);
    let historicalEventReads = 0;
    let assistantMessageId = '';
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      const parsed = nativeParse(text, reviver) as unknown;
      if (parsed && typeof parsed === 'object' && 'id' in parsed && parsed.id === 'conversation-1' && 'messages' in parsed && Array.isArray(parsed.messages)) {
        const historical = parsed.messages.find((message): message is Record<string, unknown> => (
          Boolean(message) && typeof message === 'object' && 'id' in message && message.id === 'assistant-history'
        ));
        if (historical) {
          const events = historical.events;
          Object.defineProperty(historical, 'events', {
            configurable: true,
            get: () => {
              historicalEventReads += 1;
              return events;
            },
          });
        }
      }
      return parsed;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/map-design/projects/map-1/conversations/conversation-1') return Promise.resolve(json({
        id: 'conversation-1',
        projectId: 'map-1',
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
        messages: [persistedAssistant('assistant-history', 'conversation-1', 'Historical answer.')],
      }));
      if (url === '/api/runs' && init?.method === 'POST') {
        assistantMessageId = (nativeParse(String(init.body)) as { assistantMessageId: string }).assistantMessageId;
        return Promise.resolve(json({ runId: 'run-1', projectId: 'map-1', conversationId: 'conversation-1', status: 'running' }, 202));
      }
      if (url === '/api/runs/run-1/events') return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
      }), { headers: { 'content-type': 'text/event-stream' } }));
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });

    const view = render(<MapDesignChatPane projectId="map-1" conversationId="conversation-1" />);
    const composer = await screen.findByRole('textbox', { name: 'Message map agent' });
    await screen.findByText('Historical answer.');
    fireEvent.change(composer, { target: { value: 'Continue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(assistantMessageId).not.toBe(''));
    await waitFor(() => expect(screen.getAllByRole('article', { name: 'Assistant message' })).toHaveLength(2));
    const readsBeforeSnapshot = historicalEventReads;

    await act(async () => {
      streamController?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
        type: 'event_snapshot',
        runId: 'run-1',
        messageId: assistantMessageId,
        events: [
          { kind: 'status', label: 'analyzing' },
          { kind: 'text', text: 'Streaming answer.' },
        ],
      })}\n\n`));
    });

    await screen.findByText('Streaming answer.');
    expect(historicalEventReads).toBe(readsBeforeSnapshot);
    expect(screen.getByText('Historical answer.')).toBeInTheDocument();
    view.unmount();
    await act(async () => { streamController?.close(); });
  });

  it('retains the active background run and blocks every alternate conversation submission path', async () => {
    const encoder = new TextEncoder();
    let activeStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let activeStreamSignal: AbortSignal | undefined;
    const starts: Array<Record<string, unknown>> = [];
    const conversation = (id: string) => ({
      id, projectId: 'map-1', createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z',
      messages: id === 'conversation-b' ? [persistedAssistant(
        'assistant-question-b',
        id,
        '<question-form id="style" title="Style">{"questions":[{"id":"style","label":"Style","type":"text"}]}</question-form>',
      )] : [],
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/map-design/projects/map-1/conversations/conversation-a') return Promise.resolve(json(conversation('conversation-a')));
      if (url === '/api/map-design/projects/map-1/conversations/conversation-b') return Promise.resolve(json(conversation('conversation-b')));
      if (url === '/api/runs' && init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        starts.push(request);
        const runId = request.conversationId === 'conversation-a' ? 'run-a' : 'run-b';
        return Promise.resolve(json({ runId, projectId: 'map-1', conversationId: request.conversationId, status: 'running' }, 202));
      }
      if (url === '/api/runs/run-a/events') {
        activeStreamSignal = init?.signal ?? undefined;
        return Promise.resolve(new Response(new ReadableStream({ start(controller) { activeStream = controller; } }), {
          headers: { 'content-type': 'text/event-stream' },
        }));
      }
      if (url === '/api/runs/run-b/events') return Promise.resolve(new Response(new ReadableStream({ start(controller) { controller.close(); } }), {
        headers: { 'content-type': 'text/event-stream' },
      }));
      if (url === '/api/runs/run-b') return Promise.resolve(json({ runId: 'run-b', projectId: 'map-1', conversationId: 'conversation-b', status: 'succeeded' }));
      if (url === '/api/runs/run-a/cancel') return Promise.reject(new Error('A switched conversation must not be cancelled.'));
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });

    const view = render(<MapDesignChatPane projectId="map-1" conversationId="conversation-a" />);
    const firstComposer = await screen.findByRole('textbox', { name: 'Message map agent' });
    fireEvent.change(firstComposer, { target: { value: 'Keep running' } });
    fireEvent.keyDown(firstComposer, { key: 'Enter' });
    await screen.findByRole('button', { name: 'Cancel run' });

    view.rerender(<MapDesignChatPane projectId="map-1" conversationId="conversation-b" />);
    const secondComposer = await screen.findByRole('textbox', { name: 'Message map agent' });
    expect(secondComposer).not.toBe(firstComposer);
    expect(secondComposer).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    const skip = await screen.findByRole('button', { name: 'Skip all' });
    expect(skip).toBeDisabled();
    skip.removeAttribute('disabled');
    fireEvent.click(skip);
    await act(async () => { await Promise.resolve(); });
    expect(starts.map((request) => request.conversationId)).toEqual(['conversation-a']);
    expect(screen.queryByRole('button', { name: 'Cancel run' })).not.toBeInTheDocument();
    expect(activeStreamSignal?.aborted).toBe(false);
    await act(async () => { await Promise.resolve(); });

    view.rerender(<MapDesignChatPane projectId="map-1" conversationId="conversation-b" collapsed />);
    expect(screen.getByRole('status')).toHaveTextContent('Run active');
    expect(activeStreamSignal?.aborted).toBe(false);

    view.rerender(<MapDesignChatPane projectId="map-1" conversationId="conversation-b" />);
    await act(async () => {
      activeStream?.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'run_finished', run: { runId: 'run-a', projectId: 'map-1', conversationId: 'conversation-a', status: 'succeeded' } })}\n\n`));
      activeStream?.close();
    });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message map agent' })).toBeEnabled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Skip all' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Skip all' }));
    await waitFor(() => expect(starts.map((request) => request.conversationId)).toEqual(['conversation-a', 'conversation-b']));
    await waitFor(() => expect(screen.getAllByRole('textbox', { name: 'Message map agent', hidden: true })).toHaveLength(1));
  });

  it('preserves pruned conversation drafts exactly and clears only an accepted send', async () => {
    const conversation = (id: string) => ({
      id, projectId: 'map-1', createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z', messages: [],
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/map-design/projects/map-1/conversations/conversation-a') return Promise.resolve(json(conversation('conversation-a')));
      if (url === '/api/map-design/projects/map-1/conversations/conversation-b') return Promise.resolve(json(conversation('conversation-b')));
      if (url === '/api/runs' && init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as { conversationId: string };
        if (request.conversationId === 'conversation-b') return Promise.resolve(json({ error: { code: 'CONFLICT', message: 'Another run is already active for this project.' } }, 409));
        return Promise.resolve(json({ runId: 'run-a', projectId: 'map-1', conversationId: 'conversation-a', status: 'running' }, 202));
      }
      if (url === '/api/runs/run-a/events') return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        const event = { type: 'run_finished', run: { runId: 'run-a', projectId: 'map-1', conversationId: 'conversation-a', status: 'succeeded' } };
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } }));
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });

    const view = render(<MapDesignChatPane projectId="map-1" conversationId="conversation-a" />);
    const draftA = await screen.findByRole('textbox', { name: 'Message map agent' });
    fireEvent.change(draftA, { target: { value: 'Exact A draft\nwith spacing  ' } });

    view.rerender(<MapDesignChatPane projectId="map-1" conversationId="conversation-b" />);
    const draftB = await screen.findByRole('textbox', { name: 'Message map agent' });
    fireEvent.change(draftB, { target: { value: 'Rejected B draft' } });

    view.rerender(<MapDesignChatPane projectId="map-1" conversationId="conversation-a" />);
    const restoredA = await screen.findByRole('textbox', { name: 'Message map agent' });
    expect(restoredA).toHaveValue('Exact A draft\nwith spacing  ');
    fireEvent.change(restoredA, { target: { value: 'Accepted A draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(restoredA).toHaveValue(''));

    view.rerender(<MapDesignChatPane projectId="map-1" conversationId="conversation-b" />);
    const restoredB = await screen.findByRole('textbox', { name: 'Message map agent' });
    expect(restoredB).toHaveValue('Rejected B draft');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('alert');
    expect(restoredB).toHaveValue('Rejected B draft');
    expect(restoredB).toHaveFocus();
  });

  it('bounds pruned drafts by evicting the least recently used conversation', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      const match = /\/conversations\/(conversation-\d+)$/u.exec(url);
      if (!match?.[1]) return Promise.reject(new Error(`Unexpected request ${url}`));
      return Promise.resolve(json({
        id: match[1], projectId: 'map-1', createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z', messages: [],
      }));
    });
    const view = render(<MapDesignChatPane projectId="map-1" conversationId="conversation-0" />);

    for (let index = 0; index <= 20; index += 1) {
      const input = await screen.findByRole('textbox', { name: 'Message map agent' });
      fireEvent.change(input, { target: { value: `draft-${index}` } });
      if (index < 20) view.rerender(<MapDesignChatPane projectId="map-1" conversationId={`conversation-${index + 1}`} />);
    }

    view.rerender(<MapDesignChatPane projectId="map-1" conversationId="conversation-1" />);
    expect(await screen.findByRole('textbox', { name: 'Message map agent' })).toHaveValue('draft-1');
    view.rerender(<MapDesignChatPane projectId="map-1" conversationId="conversation-0" />);
    expect(await screen.findByRole('textbox', { name: 'Message map agent' })).toHaveValue('');
  });

  it('sends Enter, preserves Shift+Enter, and announces the selected runtime', () => {
    const send = vi.fn();
    render(<ComposerHarness onSend={send} />);
    const input = screen.getByRole('textbox', { name: 'Message map agent' });
    fireEvent.change(input, { target: { value: 'Adjust labels' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).toHaveBeenCalledWith('Adjust labels');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Claude Code')).toHaveAttribute('aria-live', 'polite');
  });

  it('renders safe question forms while hiding unsupported host identifiers and details', () => {
    const content = 'Which option?\n<question-form id="style" title="Style choice">\n{"questions":[{"id":"style","label":"Style","type":"select","options":["Muted"]}]}\n</question-form>';
    render(<MapDesignMessage message={{
      ...persistedAssistant('assistant-1', 'conversation-1', content),
      events: [
        { kind: 'tool_use', id: 'todo-1', name: 'TodoWrite', summary: { task: 'Review labels' } },
        { kind: 'tool_result', toolUseId: 'todo-1', status: 'succeeded', summary: { completed: true } },
        { kind: 'tool_use', id: 'tool-1', name: 'shell', summary: { command: 'local command' } },
        { kind: 'tool_result', toolUseId: 'tool-1', status: 'failed', summary: { message: 'Exited 1' } },
        { kind: 'tool_use', id: 'artifact-1', name: 'artifact_create', summary: {} },
        { kind: 'text', text: content },
      ],
    }} />);
    expect(screen.getByText('Style choice')).toBeInTheDocument();
    expect(screen.getAllByText('Tool activity')).toHaveLength(3);
    expect(screen.queryByText('Review labels')).not.toBeInTheDocument();
    expect(screen.queryByText('Exited 1')).not.toBeInTheDocument();
    expect(screen.queryByText('TodoWrite')).not.toBeInTheDocument();
    expect(screen.queryByText('shell')).not.toBeInTheDocument();
    expect(screen.queryByText('artifact_create')).not.toBeInTheDocument();
  });

  it('hides trailing partial form openers with streamed attributes but preserves ordinary angle-bracket prose', () => {
    const { rerender } = render(
      <MapDesignMessage message={persistedAssistant(
        'assistant-partial',
        'conversation-1',
        'Visible before <QUESTION-FORM id="style"',
      )} />,
    );
    expect(screen.getByText('Visible before')).toBeInTheDocument();
    expect(screen.queryByText(/QUESTION-FORM/i)).not.toBeInTheDocument();

    rerender(<MapDesignMessage message={persistedAssistant('assistant-prose', 'conversation-1', 'Keep this lone <')} />);
    expect(screen.getByText('Keep this lone <')).toBeInTheDocument();
  });

  it.each([
    'Keep <question-formation visible',
    'Keep <ask-questionable visible',
    'Keep <question-x visible',
  ])('preserves non-protocol trailing tag-like prose: %s', (text) => {
    render(<MapDesignMessage message={persistedAssistant('assistant-prose-prefix', 'conversation-1', text)} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it.each(['<q', '<question-', '<ask-que', '<question-form', '<ask-question'])(
    'hides a partial protocol opener: %s',
    (opener) => {
      const { container } = render(<MapDesignMessage message={persistedAssistant(
        `assistant-${opener}`,
        'conversation-1',
        `Visible before ${opener}`,
      )} />);
      expect(within(container).getByText('Visible before')).toBeInTheDocument();
      expect(within(container).queryByText(opener)).not.toBeInTheDocument();
    },
  );


  it('keeps a deferred form submission interactive after start rejection without rendering an answer turn', async () => {
    let rejectStart: ((error: Error) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/map-design/projects/map-1/conversations/conversation-1') {
        return Promise.resolve(json({
          id: 'conversation-1',
          projectId: 'map-1',
          createdAt: '2026-08-26T00:00:00Z',
          updatedAt: '2026-08-26T00:00:00Z',
          messages: [persistedAssistant(
            'assistant-question',
            'conversation-1',
            '<question-form id="style" title="Style">{"questions":[{"id":"style","label":"Style","type":"text"}]}</question-form>',
          )],
        }));
      }
      if (url === '/api/runs' && init?.method === 'POST') {
        return new Promise<Response>((_resolve, reject) => { rejectStart = reject; });
      }
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    const { container } = render(<MapDesignChatPane
      projectId="map-1"
      conversationId="conversation-1"
    />);
    const pane = within(container);
    const skip = await pane.findByRole('button', { name: 'Skip all' });

    fireEvent.click(skip);
    await waitFor(() => expect(skip).toBeDisabled());
    expect(pane.queryByText(/\[form answers/)).not.toBeInTheDocument();

    rejectStart?.(new Error('offline'));
    await waitFor(() => expect(skip).toBeEnabled());
    expect(pane.queryByText(/\[form answers/)).not.toBeInTheDocument();
  });

  it('locks the form only after the deferred start accepts its submitted answer', async () => {
    let resolveStart: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/api/map-design/projects/map-1/conversations/conversation-1') {
        return Promise.resolve(json({
          id: 'conversation-1',
          projectId: 'map-1',
          createdAt: '2026-08-26T00:00:00Z',
          updatedAt: '2026-08-26T00:00:00Z',
          messages: [persistedAssistant(
            'assistant-question',
            'conversation-1',
            '<question-form id="style" title="Style">{"questions":[{"id":"style","label":"Style","type":"text"}]}</question-form>',
          )],
        }));
      }
      if (url === '/api/runs' && init?.method === 'POST') {
        return new Promise<Response>((resolve) => { resolveStart = resolve; });
      }
      if (url === '/api/runs/run-1/events') {
        return Promise.resolve(new Response(new ReadableStream({ start() {} }), {
          headers: { 'content-type': 'text/event-stream' },
        }));
      }
      return Promise.reject(new Error(`Unexpected request ${url}`));
    });
    const { container, unmount } = render(<MapDesignChatPane
      projectId="map-1"
      conversationId="conversation-1"
    />);
    const pane = within(container);
    const skip = await pane.findByRole('button', { name: 'Skip all' });

    fireEvent.click(skip);
    await waitFor(() => expect(skip).toBeDisabled());
    resolveStart?.(json({ runId: 'run-1', projectId: 'map-1', conversationId: 'conversation-1', status: 'running' }, 202));
    await waitFor(() => expect(pane.getByText('answered')).toBeInTheDocument());
    expect(pane.queryByRole('button', { name: 'Skip all' })).not.toBeInTheDocument();
    unmount();
  });
  it('keeps same-id form occurrences independent and submits only the latest occurrence', async () => {
    const onSubmitQuestion = vi.fn().mockResolvedValue(true);
    render(<MapDesignMessage
      message={persistedAssistant('assistant-forms', 'conversation-1', [
          '<question-form id="default" title="First">{"questions":[{"id":"a","label":"First answer","type":"text"}]}</question-form>',
          '<question-form id="default" title="Last">{"questions":[{"id":"b","label":"Last answer","type":"text"}]}</question-form>',
        ].join('\n'))}
      activeFormOccurrence="assistant-forms:2"
      submittedForms={{}}
      onSubmitQuestion={onSubmitQuestion}
    />);

    const firstForm = screen.getByText('First').closest<HTMLElement>('[data-form-id]');
    const lastForm = screen.getByText('Last').closest<HTMLElement>('[data-form-id]');
    expect(firstForm).not.toBeNull();
    expect(lastForm).not.toBeNull();
    expect(within(firstForm!).getByText('This form is from a previous turn.')).toBeInTheDocument();
    const skipLast = within(lastForm!).getByRole('button', { name: 'Skip all' });
    expect(skipLast).toBeEnabled();
    fireEvent.click(skipLast);
    await waitFor(() => expect(onSubmitQuestion).toHaveBeenCalledWith(
      'assistant-forms:2',
      expect.objectContaining({ id: 'default', title: 'Last' }),
      expect.any(String),
      expect.any(Object),
    ));
  });

  it('selects the final unanswered form occurrence across forms in one message', () => {
    const message = persistedAssistant('assistant-forms', 'conversation-1', [
        '<question-form id="default" title="First">{"questions":[{"id":"a","label":"First answer","type":"text"}]}</question-form>',
        '<question-form id="default" title="Last">{"questions":[{"id":"b","label":"Last answer","type":"text"}]}</question-form>',
      ].join('\n'));
    expect(latestUnansweredFormOccurrence([message], {})).toMatchObject({
      key: 'assistant-forms:2',
      form: { title: 'Last' },
    });
  });
});
