// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CartographyEditSession } from '@mapseekai/map-design-contracts';
import { CartographyEditor } from '../../src/map-design/CartographyEditor';
import { I18nProvider } from '../../src/i18n';
import * as api from '../../src/api/client';
vi.mock('../../src/api/client', () => ({ listMapDesignConversations: vi.fn(), getMapDesignConversation: vi.fn(), getMapDesignConversationRuntime: vi.fn(), getLocalAgents: vi.fn(), createMapDesignConversation: vi.fn(), deleteMapDesignConversation: vi.fn(), updateMapDesignConversationRuntime: vi.fn() }));
import * as client from '../../src/map-design/cartography-edit-client';
vi.mock('../../src/map-design/cartography-edit-client', () => ({ getCartographyEdit: vi.fn(), sendCartographyEdit: vi.fn(), saveCartographyEdit: vi.fn(), cancelCartographyEdit: vi.fn(), rememberCartographyEdit: vi.fn() }));
vi.mock('../../src/map-design/components/CartographySpecificationMap', () => ({ default: () => <div>Example map</div> }));
vi.mock('@mapseekai/components', async (load) => {
  const actual = await load<typeof import('@mapseekai/components')>();
  return { ...actual,
    ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ResizableHandle: () => null,
  };
});
const source = '---\nversion: "0.4.0"\nname: Atlas\n---\n\n## Overview\nOriginal guidance.';
const session: CartographyEditSession = {
  id: '12345678-1234-4234-8234-123456789abc', name: 'Atlas', source, description: '',
  runtime: 'api', initialPrompt: 'Improve this specification', revision: 0, status: 'idle', error: null,
  savedId: null, savedRevision: null, createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z', messages: [],
};
const running: CartographyEditSession = { ...session, status: 'running', messages: [{ id: session.id, role: 'user', content: session.initialPrompt, createdAt: session.createdAt }] };
const summary = { conversationId: session.id, projectId: session.id, title: 'Specification discussion', titleIsDefault: false, createdAt: session.createdAt, lastActivityAt: session.createdAt, messageCount: 0, runState: 'idle' as const };
const runtime = { agentId: 'opencode', model: 'provider/model', revision: 3, updatedAt: session.createdAt };
beforeEach(() => {
  window.history.replaceState({}, '', '/');
  localStorage.clear();
  vi.mocked(api.listMapDesignConversations).mockResolvedValue({ conversations: [summary] });
  vi.mocked(api.getMapDesignConversationRuntime).mockResolvedValue({ runtime, effectiveRuntime: runtime });
  const conversation = { id: session.id, projectId: session.id, createdAt: session.createdAt, updatedAt: session.updatedAt, activeRun: null, messages: [] };
  vi.mocked(api.getMapDesignConversation).mockResolvedValue(conversation);
  vi.mocked(api.getLocalAgents).mockResolvedValue({ agents: ['opencode', 'pi'].map((id) => ({ id, label: id === 'opencode' ? 'OpenCode' : 'Pi', available: true, modelCatalogSource: 'live', mapDesign: { nativeMapTools: true, publicReasoningSummary: true }, models: [{ id: 'provider/model', label: 'Provider model', enabled: true, default: true, reasoningOptions: [], serviceTierOptions: [] }] })) });
  vi.mocked(client.getCartographyEdit).mockResolvedValue(session);
  vi.mocked(client.sendCartographyEdit).mockResolvedValue(running);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('selects the conversation tab for a newly started AI creation', async () => {
  vi.mocked(client.getCartographyEdit).mockResolvedValue({ ...running, initialAnalysisStarted: true });
  render(<I18nProvider><CartographyEditor sessionId={session.id} /></I18nProvider>);
  expect(await screen.findByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
  expect(client.sendCartographyEdit).not.toHaveBeenCalled();
});
it('prefills the initial prompt and waits for the author to edit and send it', async () => {
  const view = render(<I18nProvider><CartographyEditor sessionId={session.id} /></I18nProvider>);
  expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  const input = await screen.findByRole('textbox');
  await waitFor(() => expect(input).toBeEnabled());
  expect(input).toHaveValue(session.initialPrompt);
  expect(client.sendCartographyEdit).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '' } });
  expect(input).toHaveValue('');
  fireEvent.change(input, { target: { value: 'Only improve the color guidance' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(client.sendCartographyEdit).toHaveBeenCalledWith(session.id, { requestId: expect.any(String), expectedRevision: 0, prompt: 'Only improve the color guidance', conversationId: session.id, runtimeRevision: 3 }));
  expect(screen.queryByText('Example map')).not.toBeInTheDocument();
  view.unmount();
  vi.mocked(client.getCartographyEdit).mockResolvedValue(running);
  render(<I18nProvider><CartographyEditor sessionId={session.id} /></I18nProvider>);
  await screen.findByRole('heading', { name: 'Overview' });
  expect(await screen.findByRole('textbox')).toHaveValue('');
  expect(client.sendCartographyEdit).toHaveBeenCalledTimes(1);
});
it('updates the document and conversation after the agent finishes, then saves explicitly', async () => {
  const completed: CartographyEditSession = { ...running, status: 'idle', revision: 1, source: `${source}\n\n## Scale guidance\nKeep label hierarchy.`, messages: [...running.messages, { id: '22345678-1234-4234-8234-123456789abc', role: 'assistant', content: 'Added scale guidance.', createdAt: session.createdAt }] };
  vi.mocked(client.getCartographyEdit).mockResolvedValueOnce(running).mockResolvedValue(completed);
  vi.mocked(client.saveCartographyEdit).mockResolvedValue({ session: { ...completed, savedId: 'a'.repeat(64), savedRevision: 1 }, document: { id: 'a'.repeat(64), name: 'Atlas', version: '0.4.0', description: '' } });
  render(<I18nProvider><CartographyEditor sessionId={session.id} /></I18nProvider>);
  expect(await screen.findByRole('heading', { name: 'Scale guidance' })).toBeInTheDocument();
  expect(api.getMapDesignConversation).toHaveBeenCalled();
  expect(client.saveCartographyEdit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Sample map' }));
  expect(await screen.findByText('Example map')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save as new specification' }));
  const saveDialog = await screen.findByRole('dialog');
  fireEvent.change(within(saveDialog).getByRole('textbox'), { target: { value: 'Atlas copy' } });
  fireEvent.click(within(saveDialog).getByRole('button', { name: 'Save as new specification' }));
  expect(await screen.findByText('Saved to library.')).toBeInTheDocument();
  expect(client.saveCartographyEdit).toHaveBeenCalledWith(session.id, { expectedRevision: 1, mode: 'new', name: 'Atlas copy' });
});

it('overwrites the current specification explicitly and still allows saving a copy', async () => {
  // Given an edited library specification.
  const edited = { ...session, revision: 1, sourceDocumentId: 'b'.repeat(64), canOverwrite: true };
  vi.mocked(client.getCartographyEdit).mockResolvedValue(edited);
  vi.mocked(client.saveCartographyEdit).mockResolvedValue({ session: { ...edited, savedId: edited.sourceDocumentId, savedRevision: 1 }, document: { id: edited.sourceDocumentId, name: 'Atlas', version: '0.4.0', description: '' } });
  render(<I18nProvider><CartographyEditor sessionId={session.id} /></I18nProvider>);
  // When the author saves over the current specification.
  fireEvent.click(await screen.findByRole('button', { name: 'Overwrite specification' }));
  // Then the overwrite request is explicit and save-as remains available.
  await waitFor(() => expect(client.saveCartographyEdit).toHaveBeenCalledWith(session.id, { expectedRevision: 1, mode: 'overwrite' }));
  expect(await screen.findByText('Saved to library.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Overwrite specification' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save as new specification' })).toBeEnabled();
});

it('keeps the copy name and draft visible when saving fails', async () => {
  // Given a draft whose library save fails.
  vi.mocked(client.saveCartographyEdit).mockRejectedValue(new Error('offline'));
  render(<I18nProvider><CartographyEditor sessionId={session.id} /></I18nProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Save as new specification' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'My Atlas' } });
  // When the author saves a copy.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save as new specification' }));
  // Then retry stays in the save dialog and does not run the Agent again.
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('could not be saved');
  expect(within(dialog).getByRole('textbox')).toHaveValue('My Atlas');
  expect(screen.getByText('Original guidance.')).toBeInTheDocument();
  expect(client.sendCartographyEdit).not.toHaveBeenCalled();
});
it('retains the valid document on failure and lets the author retry deliberately', async () => {
  vi.mocked(client.getCartographyEdit).mockResolvedValue({ ...running, status: 'failed', error: 'generation-failed' });
  render(<I18nProvider><CartographyEditor sessionId={session.id} /></I18nProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Your last valid draft is safe');
  expect(screen.getByText('Original guidance.')).toBeInTheDocument();
  expect(client.sendCartographyEdit).not.toHaveBeenCalled();
  const retry = screen.getByRole('button', { name: 'Retry' });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await waitFor(() => expect(client.sendCartographyEdit).toHaveBeenCalledTimes(1));
  expect(vi.mocked(client.sendCartographyEdit).mock.calls[0]?.[1].requestId).not.toBe(session.id);
});

it('waits for the conversation runtime before enabling a failed generation retry', async () => {
  vi.mocked(client.getCartographyEdit).mockResolvedValue({ ...running, status: 'failed', error: 'generation-failed' });
  let resolveRuntime: ((value: Awaited<ReturnType<typeof api.getMapDesignConversationRuntime>>) => void) | undefined;
  vi.mocked(api.getMapDesignConversationRuntime).mockReturnValue(new Promise((resolve) => { resolveRuntime = resolve; }));
  render(<I18nProvider><CartographyEditor sessionId={session.id} /></I18nProvider>);
  const retry = await screen.findByRole('button', { name: 'Retry' });
  expect(retry).toBeDisabled();
  fireEvent.click(retry);
  expect(client.sendCartographyEdit).not.toHaveBeenCalled();

  await act(async () => { resolveRuntime?.({ runtime, effectiveRuntime: runtime }); });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await waitFor(() => expect(client.sendCartographyEdit).toHaveBeenCalledWith(session.id, expect.objectContaining({
    conversationId: session.id, runtimeRevision: 3, prompt: session.initialPrompt,
  })));
});

it('uses the shared Agent picker and sends the map update to the selected conversation', async () => {
  vi.mocked(client.getCartographyEdit).mockResolvedValue({ ...session, initialAnalysisStarted: true });
  render(<I18nProvider><CartographyEditor sessionId={session.id} /></I18nProvider>);
  const picker = await screen.findByRole('button', { name: /Change runtime/ });
  fireEvent.click(picker);
  expect(await screen.findByRole('option', { name: /OpenCode/ })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /Pi/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sample map' }));
  fireEvent.click(await screen.findByRole('button', { name: /Update sample map/ }));
  await waitFor(() => expect(client.sendCartographyEdit).toHaveBeenCalledWith(session.id, expect.objectContaining({ conversationId: session.id, runtimeRevision: 3, prompt: expect.stringContaining('sample map') })));
  expect(screen.queryByTitle('Atlas')).not.toBeInTheDocument();
});

it('creates and deletes discussions through the same conversation menu as map projects', async () => {
  vi.mocked(client.getCartographyEdit).mockResolvedValue({ ...session, initialAnalysisStarted: true });
  const created = { ...summary, conversationId: '32345678-1234-4234-8234-123456789abc', title: 'New discussion' };
  vi.mocked(api.createMapDesignConversation).mockResolvedValue({ conversation: created });
  vi.mocked(api.deleteMapDesignConversation).mockResolvedValue(undefined);
  render(<I18nProvider><CartographyEditor sessionId={session.id} /></I18nProvider>);
  await screen.findByRole('button', { name: 'Project conversations' });
  fireEvent.click(await screen.findByRole('button', { name: 'New conversation' }));
  await waitFor(() => expect(api.createMapDesignConversation).toHaveBeenCalledWith(session.id, expect.objectContaining({ idempotencyKey: expect.any(String) }), expect.any(AbortSignal)));
  fireEvent.click(await screen.findByRole('button', { name: 'Project conversations' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Delete conversation' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete conversation' }));
  await waitFor(() => expect(api.deleteMapDesignConversation).toHaveBeenCalledWith(session.id, created.conversationId, expect.any(AbortSignal)));
  expect(screen.getByText('Original guidance.')).toBeInTheDocument();
});
