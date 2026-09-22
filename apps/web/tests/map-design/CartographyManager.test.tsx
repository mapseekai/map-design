// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CartographyManager } from '../../src/map-design/CartographyManager';
import { I18nProvider } from '../../src/i18n';
import * as client from '../../src/map-design/client';
import { createCartographyEdit, listActiveCartographyEdits, listCartographyEditHistory, lastCartographyEdit } from '../../src/map-design/cartography-edit-client';
vi.mock('../../src/map-design/cartography-edit-client', () => ({ createCartographyEdit: vi.fn(), listActiveCartographyEdits: vi.fn(), listCartographyEditHistory: vi.fn(), lastCartographyEdit: vi.fn(), rememberCartographyEdit: vi.fn() }));
import { ApiClientError } from '../../src/api/request';
import { selectValue } from '../helpers/select';
import { useLocalAgents } from '../../src/map-design/hooks/useLocalAgents';
vi.mock('../../src/map-design/hooks/useLocalAgents', () => ({ useLocalAgents: vi.fn() }));
vi.mock('../../src/map-design/client', () => ({ listCartographies: vi.fn(), getCartography: vi.fn(), deleteCartography: vi.fn(), updateCartography: vi.fn(), importCartography: vi.fn(), importCartographyUrl: vi.fn(), initializeCartography: vi.fn(), initializeCartographyUrl: vi.fn(), generateCartography: vi.fn() }));
const document = { id: 'a'.repeat(64), name: 'Quiet Atlas', description: 'Warm paper', version: '0.4.0' };
const source = '---\nname: Quiet Atlas\nversion: "0.4.0"\n---\n## Overview\nWarm paper.';
const draft = { source, reportMarkdown: 'Conversion evidence', reportJson: '{"bindings":[]}' };
beforeEach(() => {
  vi.mocked(listActiveCartographyEdits).mockResolvedValue({ sessions: [] });
  vi.mocked(listCartographyEditHistory).mockResolvedValue({ sessions: [] });
  vi.mocked(useLocalAgents).mockReturnValue({ loading: false, error: null, agents: [
    { id: 'api', label: 'API Model', available: true, modelCatalogSource: 'fallback',
      mapDesign: { nativeMapTools: true, publicReasoningSummary: true },
      models: [
        { id: 'api-profile:first', label: 'First model', enabled: true, default: true, reasoningOptions: [], serviceTierOptions: [] },
        { id: 'api-profile:second', label: 'Second model', enabled: true, default: false, reasoningOptions: [], serviceTierOptions: [] },
      ] },
  ] });
  vi.mocked(client.listCartographies).mockResolvedValue({ documents: [] });
  vi.mocked(client.getCartography).mockResolvedValue({ ...document, source });
  vi.mocked(client.importCartography).mockResolvedValue(document);
  vi.mocked(client.importCartographyUrl).mockResolvedValue(document);
  vi.mocked(client.initializeCartography).mockResolvedValue(draft);
  vi.mocked(client.initializeCartographyUrl).mockResolvedValue(draft);
  vi.mocked(client.generateCartography).mockResolvedValue({ ...draft, reportMarkdown: '', reportJson: '' });
});
afterEach(() => { window.history.replaceState(null, '', '/'); cleanup(); vi.resetAllMocks(); });
it('renames a specification in the title and library without changing its identity', async () => {
  vi.mocked(client.listCartographies).mockResolvedValue({ documents: [document] });
  vi.mocked(client.updateCartography).mockResolvedValue({ ...document, name: 'Renamed Atlas' });
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Rename: Quiet Atlas' }));
  const input = screen.getByRole('textbox', { name: 'Specification name' });
  fireEvent.change(input, { target: { value: ' Renamed Atlas ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  expect(await screen.findByRole('heading', { name: 'Renamed Atlas' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Preview specification: Renamed Atlas' })).toBeInTheDocument();
  expect(client.updateCartography).toHaveBeenCalledWith(document.id, { name: 'Renamed Atlas' }, expect.any(AbortSignal));
});
it('shows active edits after returning to the library and reopens the running session', async () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  vi.mocked(client.listCartographies).mockResolvedValue({ documents: [document] });
  vi.mocked(listActiveCartographyEdits).mockResolvedValue({ sessions: [{ id, sourceDocumentId: document.id }] });
  vi.mocked(listCartographyEditHistory).mockResolvedValue({ sessions: [{ id, name: document.name, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z', status: 'running', revision: 0 }] });
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  const editButton = await screen.findByRole('button', { name: 'Analyzing and improving the specification…' });
  await waitFor(() => expect(editButton).toBeEnabled());
  expect(editButton.querySelector('.animate-spin')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Preview specification: Quiet Atlas' }).querySelector('.animate-spin')).toBeNull();
  fireEvent.click(editButton);
  await waitFor(() => expect(window.location.pathname).toBe(`/cartographies/edit/${id}`));
  expect(createCartographyEdit).not.toHaveBeenCalled();
  vi.mocked(listActiveCartographyEdits).mockResolvedValue({ sessions: [] });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2100)); });
  expect(screen.queryByRole('button', { name: 'Analyzing and improving the specification…' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit with Agent' }).querySelector('.animate-spin')).toBeNull();
});
it('restores the last viewed historical session instead of the latest session', async () => {
  const oldId = '12345678-1234-4234-8234-123456789abc';
  const latestId = '22345678-1234-4234-8234-123456789abc';
  vi.mocked(client.listCartographies).mockResolvedValue({ documents: [document] });
  vi.mocked(lastCartographyEdit).mockReturnValue(oldId);
  vi.mocked(listCartographyEditHistory).mockResolvedValue({ sessions: [latestId, oldId].map(id => ({ id, name: document.name, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z', status: 'idle', revision: 1 })) });
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  const button = await screen.findByRole('button', { name: 'Edit with Agent' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(window.location.pathname).toBe(`/cartographies/edit/${oldId}`));
  expect(createCartographyEdit).not.toHaveBeenCalled();
});
it('confirms deletion, keeps the card on failure, and removes it after success', async () => {
  vi.mocked(client.listCartographies).mockResolvedValue({ documents: [document] });
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete: Quiet Atlas' }));
  expect(screen.getByRole('alertdialog')).toHaveTextContent('Quiet Atlas');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(client.deleteCartography).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete: Quiet Atlas' }));
  vi.mocked(client.deleteCartography).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  vi.mocked(client.deleteCartography).mockResolvedValueOnce(undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Specification deleted.');
  expect(screen.queryByRole('button', { name: 'Preview specification: Quiet Atlas' })).not.toBeInTheDocument();
});
it('explains project references and clears the selected deep link after deletion', async () => {
  window.history.replaceState(null, '', `/cartographies?cartography=${document.id}`);
  vi.mocked(client.listCartographies).mockResolvedValue({ documents: [document] });
  vi.mocked(client.deleteCartography).mockRejectedValueOnce(new ApiClientError('In use', 400, 'INVALID_INPUT', { reason: 'CARTOGRAPHY_IN_USE' }));
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  await screen.findByLabelText('Preview specification');
  fireEvent.click(screen.getByRole('button', { name: 'Delete: Quiet Atlas' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('This specification is used by a project and cannot be deleted.');
  expect(window.location.search).toContain(document.id);
  vi.mocked(client.deleteCartography).mockResolvedValueOnce(undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Specification deleted.');
  expect(window.location.search).toBe('');
  expect(screen.queryByLabelText('Preview specification')).not.toBeInTheDocument();
});
it('imports a local document into the library and offers workbench selection', async () => {
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Add specification' }));
  const file = { name: 'CARTOGRAPHY.md', size: source.length, arrayBuffer: async () => new TextEncoder().encode(source).buffer };
  fireEvent.change(screen.getByLabelText('Import local specification', { selector: 'input' }), { target: { files: [file] } });
  await act(async () => { fireEvent.submit(screen.getByLabelText('Import local specification', { selector: 'input' }).closest('form')!); });
  expect(await screen.findByRole('heading', { name: 'Quiet Atlas' })).toBeInTheDocument();
  const link = await screen.findByRole('link', { name: /Use in workbench/ });
  expect(link).toHaveAttribute('href', `/?cartography=${document.id}`);
  fireEvent.click(link);
  expect(window.location.search).toBe(`?cartography=${document.id}`);
  window.history.replaceState(null, '', '/');
});
it('imports an online document and preserves the library on failure', async () => {
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Add specification' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Online document' }));
  fireEvent.change(screen.getByLabelText('Document URL'), { target: { value: 'https://example.com/CARTOGRAPHY.md' } });
  await act(async () => { fireEvent.submit(screen.getByLabelText('Document URL').closest('form')!); });
  expect(await screen.findByRole('heading', { name: 'Quiet Atlas' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add specification' }));
  vi.mocked(client.importCartographyUrl).mockRejectedValueOnce(new Error('unavailable'));
  await act(async () => { fireEvent.submit(screen.getByLabelText('Document URL').closest('form')!); });
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('heading', { name: 'Quiet Atlas' })).toBeInTheDocument();
});
it('shows style conversion reports and saves only when the draft is accepted', async () => {
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Add specification' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Create from style' }));
  fireEvent.change(screen.getByLabelText('Specification name'), { target: { value: 'Quiet Atlas' } });
  const input = screen.getByLabelText('Create from style', { selector: 'input' });
  expect(input).toHaveAttribute('accept', '.json,.qgs,.qgz,.lyrx,.stylx,.sld,.xml');
  fireEvent.change(input, { target: { files: [{ name: 'style.json', size: 2, arrayBuffer: async () => new TextEncoder().encode('{}').buffer }] } });
  await act(async () => { fireEvent.submit(input.closest('form')!); });
  expect(await screen.findByText('Conversion evidence')).toBeInTheDocument();
  expect(client.importCartography).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save to library' }));
  expect(await screen.findByText('Saved to library.')).toBeInTheDocument();
});
it('opens the AI editing conversation immediately with the selected model and design brief', async () => {
  const sessionId = '12345678-1234-4234-8234-123456789abc';
  vi.mocked(createCartographyEdit).mockResolvedValue({
    id: sessionId, name: document.name, source, description: 'Warm paper', runtime: 'api',
    initialPrompt: 'Calm walking map', revision: 0, status: 'running', error: null,
    savedId: null, savedRevision: null, createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z', messages: [], initialAnalysisStarted: true,
  });
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Add specification' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Create with AI' }));
  await selectValue(screen.getByRole('combobox', { name: 'Local agent' }), 'api');
  await selectValue(screen.getByRole('combobox', { name: 'Saved API models' }), 'api-profile:second');
  fireEvent.change(screen.getByLabelText('Specification name'), { target: { value: 'Quiet Atlas' } });
  fireEvent.change(screen.getByLabelText('Design brief'), { target: { value: 'Calm walking map' } });
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Warm paper' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate draft' }));
  await waitFor(() => expect(window.location.pathname).toBe(`/cartographies/edit/${sessionId}`));
  expect(createCartographyEdit).toHaveBeenCalledWith({
    name: 'Quiet Atlas', requirements: 'Calm walking map', description: 'Warm paper',
    runtime: { agentId: 'api', model: 'api-profile:second' },
  }, expect.any(AbortSignal));
  expect(client.generateCartography).not.toHaveBeenCalled();
  expect(client.importCartography).not.toHaveBeenCalled();
});

it('keeps the creation form and brief available when the AI session cannot be started', async () => {
  vi.mocked(createCartographyEdit).mockRejectedValueOnce(new Error('unavailable'));
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Add specification' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Create with AI' }));
  await selectValue(screen.getByRole('combobox', { name: 'Local agent' }), 'api');
  fireEvent.change(screen.getByLabelText('Specification name'), { target: { value: 'Quiet Atlas' } });
  fireEvent.change(screen.getByLabelText('Design brief'), { target: { value: 'Calm walking map' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate draft' }));
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.getByLabelText('Design brief')).toHaveValue('Calm walking map');
  expect(screen.getByRole('button', { name: 'Generate draft' })).toBeEnabled();
  expect(window.location.pathname).toBe('/');
});


it('shows the description near the title as read-only content', async () => {
  vi.mocked(client.listCartographies).mockResolvedValue({ documents: [document] });
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  await screen.findByRole('heading', { name: 'Quiet Atlas' });
  expect(screen.getByLabelText('Description')).toHaveTextContent('Warm paper');
  expect(screen.queryByRole('textbox', { name: 'Description' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save description' })).not.toBeInTheDocument();
  expect(client.updateCartography).not.toHaveBeenCalled();
});

it('opens the requested specification preview from the conversation deep link', async () => {
  window.history.replaceState(null, '', `/cartographies?cartography=${document.id}`);
  vi.mocked(client.listCartographies).mockResolvedValueOnce({ documents: [document] });
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  expect(await screen.findByLabelText('Preview specification')).toHaveTextContent('Warm paper');
  expect(client.getCartography).toHaveBeenCalledWith(document.id, expect.any(AbortSignal));
});

it('keeps the specification selector beside details and collapses the original document', async () => {
  const second = { ...document, id: 'b'.repeat(64), name: 'Second Atlas' };
  vi.mocked(client.listCartographies).mockResolvedValue({ documents: [document, second] });
  vi.mocked(client.getCartography).mockImplementation(async (id) => ({ ...(id === second.id ? second : document), source }));
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  expect(await screen.findByRole('heading', { name: 'Quiet Atlas' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Preview specification: Quiet Atlas' })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByLabelText('Preview specification').closest('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByRole('button', { name: 'Preview specification: Second Atlas' }));
  expect(await screen.findByRole('heading', { name: 'Second Atlas' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Preview specification: Quiet Atlas' })).toBeInTheDocument();
});

it('filters user systems and explicitly marked presets using real counts', async () => {
  const preset = { ...document, id: 'b'.repeat(64), name: 'Preset', origin: 'preset' as const };
  vi.mocked(client.listCartographies).mockResolvedValue({ documents: [document, preset] });
  vi.mocked(client.getCartography).mockImplementation(async (id) => ({ ...(id === preset.id ? preset : document), source }));
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  expect(await screen.findByRole('button', { name: 'Your systems 1' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByRole('button', { name: 'Preview specification: Preset' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'System presets 1' }));
  expect(await screen.findByRole('heading', { name: 'Preset' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Preview specification: Preset' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Preview specification: Quiet Atlas' })).not.toBeInTheDocument();
});
it('creates a reviewable style draft from a URL without uploading a file', async () => {
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Add specification' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Create from style' }));
  fireEvent.click(screen.getByRole('button', { name: 'Style URL' }));
  fireEvent.change(screen.getByLabelText('Specification name'), { target: { value: 'Online Atlas' } });
  fireEvent.change(screen.getByLabelText('Style URL'), { target: { value: 'https://example.com/download' } });
  fireEvent.change(screen.getByLabelText('File name (optional)'), { target: { value: 'map.qgz' } });
  await act(async () => { fireEvent.submit(screen.getByLabelText('Style URL').closest('form')!); });
  expect(client.initializeCartographyUrl).toHaveBeenCalledWith({ name: 'Online Atlas', url: 'https://example.com/download', fileName: 'map.qgz' }, expect.any(AbortSignal));
  expect(await screen.findByText('Conversion evidence')).toBeInTheDocument();
  expect(client.importCartography).not.toHaveBeenCalled();
});

it('opens an agent editing workspace from the extracted draft without publishing it', async () => {
  const sessionId = '12345678-1234-4234-8234-123456789abc';
  vi.mocked(createCartographyEdit).mockResolvedValue({ id: sessionId } as Awaited<ReturnType<typeof createCartographyEdit>>);
  render(<I18nProvider><CartographyManager /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Add specification' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Create from style' }));
  fireEvent.click(screen.getByRole('button', { name: 'Style URL' }));
  fireEvent.change(screen.getByLabelText('Specification name'), { target: { value: 'Atlas' } });
  fireEvent.change(screen.getByLabelText('Style URL'), { target: { value: 'https://example.com/style' } });
  await act(async () => { fireEvent.submit(screen.getByLabelText('Style URL').closest('form')!); });
  fireEvent.click(await screen.findByRole('button', { name: 'Edit with Agent' }));
  await act(async () => {});
  expect(createCartographyEdit).toHaveBeenCalledWith(expect.objectContaining({ source: draft.source, reportMarkdown: draft.reportMarkdown, runtime: 'api' }), expect.any(AbortSignal));
  expect(window.location.pathname).toBe(`/cartographies/edit/${sessionId}`);
  expect(client.importCartography).not.toHaveBeenCalled();
});
