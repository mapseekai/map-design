// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceTabsProvider } from '../../../src/map-design/WorkspaceTabs';
import { MapDesignChatPane } from '../../../src/map-design/chat/MapDesignChatPane';
import type { MapDesignRoute } from '../../../src/router';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const attachment = { id: 'a'.repeat(64), projectId: 'map-1', fileName: 'review-notes.txt', mediaType: 'text/plain', byteLength: 5, createdAt: '2026-09-29T00:00:00Z' };
const runtime = { agentId: 'codex', revision: 0, updatedAt: '2026-09-29T00:00:00Z' };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
it.each([false, true])('sends uploaded draft attachments after workspace navigation=%s', async navigateAway => {
  const posts: unknown[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/runtime')) return json({ runtime, effectiveRuntime: runtime });
    if (url.endsWith('/attachments')) return json(attachment);
    if (url.endsWith('/conversations/conversation-1')) return json({ id: 'conversation-1', projectId: 'map-1', createdAt: '', updatedAt: '', activeRun: null, messages: [] });
    const run = { runId: 'run-1', projectId: 'map-1', conversationId: 'conversation-1', status: 'succeeded' };
    if (url === '/api/runs') { posts.push(JSON.parse(String(init?.body))); return json(run); }
    if (url.endsWith('/events')) return new Response('data: ' + JSON.stringify({ type: 'run_finished', run }) + String.fromCharCode(10, 10));
    throw new Error('Unexpected request: ' + url);
  });
  function Harness({ away }: { away: boolean }) {
    const route: MapDesignRoute = away ? { kind: 'settings' } : { kind: 'project', projectId: 'map-1' };
    return <WorkspaceTabsProvider route={route}>{away ? null : <MapDesignChatPane projectId="map-1" conversationId="conversation-1" />}</WorkspaceTabsProvider>;
  }
  const view = render(<Harness away={false} />);
  const input = screen.getByRole('textbox', { name: 'Message map agent' });
  await waitFor(() => expect(input).not.toBeDisabled());
  fireEvent.change(input, { target: { value: 'Use the attached notes' } });
  const file = new File(['notes'], attachment.fileName, { type: 'text/plain' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('notes').buffer });
  fireEvent.change(screen.getByLabelText('Choose text files'), { target: { files: [file] } });
  await screen.findByRole('button', { name: 'Remove review-notes.txt' });
  if (navigateAway) {
    view.rerender(<Harness away />);
    view.rerender(<Harness away={false} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    expect(screen.getByRole('textbox', { name: 'Message map agent' })).toHaveValue('Use the attached notes');
    expect(screen.getByRole('button', { name: 'Remove review-notes.txt' })).toBeVisible();
  }
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toHaveProperty('attachmentIds', [attachment.id]);
  view.rerender(<Harness away />);
  view.rerender(<Harness away={false} />);
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message map agent' })).not.toBeDisabled());
  expect(screen.queryByRole('button', { name: 'Remove review-notes.txt' })).toBeNull();
});
