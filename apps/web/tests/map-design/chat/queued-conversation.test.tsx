// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MapDesignChatPane } from '../../../src/map-design/chat/MapDesignChatPane';
import { messageQueueCopy } from '../../../src/i18n/locales/message-queue';

vi.mock('../../../src/map-design/chat/useConversationRuntime', () => ({ useConversationRuntime: () => ({
  runtime: { agentId: 'codex', revision: 0, updatedAt: '2026-09-22T00:00:00Z' },
  loading: false, saving: false, error: null, notice: null, update: vi.fn(),
}) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('retains the first rejected request ahead of messages queued while it was submitting', async () => {
  let rejectStart: (response: Response) => void = () => undefined;
  const starts = vi.fn(() => new Promise<Response>(resolve => { rejectStart = resolve; }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    if (String(input) === '/api/runs') return starts();
    return new Response(JSON.stringify({ id: 'a', projectId: 'p', createdAt: '2026-09-22T00:00:00Z',
      updatedAt: '2026-09-22T00:00:00Z', messages: [] }), { headers: { 'content-type': 'application/json' } });
  });
  render(<MapDesignChatPane projectId="p" conversationId="a" />);
  const composer = screen.getByRole('textbox', { name: 'Message map agent' });
  fireEvent.change(composer, { target: { value: 'First request must survive' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(starts).toHaveBeenCalledOnce());
  await waitFor(() => expect(composer).toHaveValue(''));
  fireEvent.change(composer, { target: { value: 'Second queued request' } });
  fireEvent.click(screen.getByRole('button', { name: messageQueueCopy.en.enqueue }));
  await act(async () => rejectStart(new Response(JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'Rejected' } }), {
    status: 400, headers: { 'content-type': 'application/json' },
  })));
  const queue = screen.getByRole('region', { name: messageQueueCopy.en.title });
  const rows = within(queue).getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('First request must survive');
  expect(rows[1]).toHaveTextContent('Second queued request');
  expect(within(queue).getByRole('button', { name: messageQueueCopy.en.resume })).toBeEnabled();
  expect(within(queue).getAllByRole('button', { name: messageQueueCopy.en.edit })[0]).toBeEnabled();
  expect(starts).toHaveBeenCalledOnce();
});

it('retains queued messages and an edit when switching away as the active run finishes', async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const starts: string[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === '/api/runs') {
      const body: unknown = JSON.parse(String(init?.body));
      if (!body || typeof body !== 'object' || !('prompt' in body) || typeof body.prompt !== 'string') throw new Error('Missing prompt');
      starts.push(body.prompt);
      return json({ runId: `run-${starts.length}`, projectId: 'p', conversationId: 'a', status: 'running' });
    }
    if (url.endsWith('/run-1/events')) return new Response(new ReadableStream<Uint8Array>({ start(value) { stream = value; } }));
    if (url.endsWith('/run-2/events')) return new Response('data: {"type":"run_finished","run":{"runId":"run-2","projectId":"p","conversationId":"a","status":"succeeded"}}\n\n');
    if (url.includes('/conversations/')) return json({ id: url.endsWith('/b') ? 'b' : 'a', projectId: 'p',
      createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z', messages: [] });
    throw new Error(`Unexpected request ${url}`);
  });
  const view = render(<MapDesignChatPane projectId="p" conversationId="a" />);
  const composer = screen.getByRole('textbox', { name: 'Message map agent' });
  fireEvent.change(composer, { target: { value: 'First run' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(stream).toBeDefined());
  await waitFor(() => expect(composer).toHaveValue(''));
  fireEvent.change(composer, { target: { value: 'Pending original' } });
  fireEvent.click(screen.getByRole('button', { name: messageQueueCopy.en.enqueue }));
  const queue = await screen.findByRole('region', { name: messageQueueCopy.en.title });
  fireEvent.click(within(queue).getByRole('button', { name: messageQueueCopy.en.edit }));
  fireEvent.change(within(queue).getByRole('textbox'), { target: { value: 'Pending edited' } });
  view.rerender(<MapDesignChatPane projectId="p" conversationId="b" />);
  await act(async () => {
    stream?.enqueue(new TextEncoder().encode('data: {"type":"run_finished","run":{"runId":"run-1","projectId":"p","conversationId":"a","status":"succeeded"}}\n\n'));
    stream?.close();
  });
  expect(starts).toEqual(['First run']);
  view.rerender(<MapDesignChatPane projectId="p" conversationId="a" />);
  const restored = await screen.findByRole('region', { name: messageQueueCopy.en.title });
  expect(within(restored).getByRole('textbox')).toHaveValue('Pending edited');
  fireEvent.click(within(restored).getByRole('button', { name: messageQueueCopy.en.save }));
  await waitFor(() => expect(starts).toEqual(['First run', 'Pending edited']));
});
