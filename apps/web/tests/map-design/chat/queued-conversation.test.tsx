// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MapScreenshot } from '@mapseekai/contracts';
import { screenshotCopy } from '../../../src/i18n/locales/screenshots';
import { WorkspaceTabsProvider, useWorkspaceTabDraft } from '../../../src/map-design/WorkspaceTabs';
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
      updatedAt: '2026-09-22T00:00:00Z', activeRun: null, messages: [] }), { headers: { 'content-type': 'application/json' } });
  });
  render(<MapDesignChatPane projectId="p" conversationId="a" />);
  const composer = screen.getByRole('textbox', { name: 'Message map agent' });
  fireEvent.change(composer, { target: { value: 'First request must survive' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
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
      createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z', activeRun: null, messages: [] });
    throw new Error(`Unexpected request ${url}`);
  });
  const view = render(<MapDesignChatPane projectId="p" conversationId="a" />);
  const composer = screen.getByRole('textbox', { name: 'Message map agent' });
  fireEvent.change(composer, { target: { value: 'First run' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
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

const screenshot: MapScreenshot = { id: 'a'.repeat(64), projectId: 'p', capturedAt: '2026-09-22T00:00:00Z', draftRevision: 1,
  styleHash: 'b'.repeat(64), width: 100, height: 100, viewport: { center: [0, 0], zoom: 3, bearing: 0, pitch: 0 } };
function ScreenshotPane() {
  const [screenshots, setScreenshots] = useWorkspaceTabDraft('captured-screenshots', [screenshot, { ...screenshot, id: 'c'.repeat(64) }]);
  return <MapDesignChatPane projectId="p" conversationId="a" screenshots={screenshots}
    onScreenshotsSent={ids => setScreenshots(current => current.filter(item => !ids.includes(item.id)))} />;
}
it('recovers rejected screenshots in an editable queue without overwriting a new draft across workspace remount', async () => {
  let rejectStart: (response: Response) => void = () => undefined;
  const starts = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(resolve => { rejectStart = resolve; }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) === '/api/runs') return starts(input, init);
    return new Response(JSON.stringify({ id: 'a', projectId: 'p', createdAt: '2026-09-22T00:00:00Z',
      updatedAt: '2026-09-22T00:00:00Z', activeRun: null, messages: [] }));
  });
  function Workspace({ home = false }: { home?: boolean }) {
    return <WorkspaceTabsProvider route={home ? { kind: 'home' } : { kind: 'project', projectId: 'p' }}>
      {home ? null : <ScreenshotPane />}
    </WorkspaceTabsProvider>;
  }
  const view = render(<Workspace />);
  const composer = screen.getByRole('textbox', { name: 'Message map agent' });
  fireEvent.change(composer, { target: { value: 'Inspect screenshots' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(starts).toHaveBeenCalledOnce());
  await waitFor(() => expect(composer).toHaveValue(''));
  fireEvent.change(composer, { target: { value: 'Later queued request' } });
  fireEvent.click(screen.getByRole('button', { name: messageQueueCopy.en.enqueue }));
  await waitFor(() => expect(composer).toHaveValue(''));
  fireEvent.change(composer, { target: { value: 'New unsent draft' } });
  await act(async () => rejectStart(new Response(JSON.stringify({ error: { code: 'RUNTIME_REVISION_CONFLICT' } }), { status: 409 })));
  const queue = screen.getByRole('region', { name: messageQueueCopy.en.title });
  const first = within(queue).getAllByRole('listitem').at(0);
  if (!first) throw new Error('Rejected row missing');
  expect(within(first).getAllByRole('img', { name: screenshotCopy.en.image })).toHaveLength(2);
  fireEvent.click(within(first).getByRole('button', { name: messageQueueCopy.en.edit }));
  const removeScreenshot = within(first).getAllByRole('button', { name: screenshotCopy.en.remove }).at(0);
  if (!removeScreenshot) throw new Error('Screenshot action missing');
  fireEvent.click(removeScreenshot);
  fireEvent.change(within(first).getByRole('textbox'), { target: { value: 'Inspect remaining screenshot' } });
  fireEvent.click(within(first).getByRole('button', { name: messageQueueCopy.en.save }));
  view.rerender(<Workspace home />);
  view.rerender(<Workspace />);
  const restored = await screen.findByRole('region', { name: messageQueueCopy.en.title });
  const rows = within(restored).getAllByRole('listitem');
  expect(rows.at(0)).toHaveTextContent('Inspect remaining screenshot');
  expect(rows.at(1)).toHaveTextContent('Later queued request');
  expect(within(restored).getAllByRole('img')).toHaveLength(1);
  expect(screen.getByRole('textbox', { name: 'Message map agent' })).toHaveValue('New unsent draft');
  fireEvent.click(within(restored).getByRole('button', { name: messageQueueCopy.en.resume }));
  await waitFor(() => expect(starts).toHaveBeenCalledTimes(2));
  const original: unknown = JSON.parse(String(starts.mock.calls[0]?.[1]?.body));
  const retry: unknown = JSON.parse(String(starts.mock.calls[1]?.[1]?.body));
  expect(retry).toMatchObject({ prompt: 'Inspect remaining screenshot', screenshotIds: ['c'.repeat(64)] });
  if (!original || typeof original !== 'object' || !('clientRequestId' in original)) throw new Error('Original request missing');
  expect(retry).not.toMatchObject({ clientRequestId: original.clientRequestId });
  await act(async () => rejectStart(new Response('{}', { status: 409 })));
});
