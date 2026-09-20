// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MapDesignComposer } from '../../../src/map-design/chat/MapDesignComposer';
import { I18nProvider } from '../../../src/i18n';
import { useState } from 'react';
import { mapScreenshotUrl, mapTextAttachmentUrl, type MapTextAttachment } from '@mapseekai/contracts';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const shot = { id: 'a'.repeat(64), projectId: 'p', draftRevision: 1, styleHash: 'b'.repeat(64), width: 800, height: 600,
  capturedAt: '2026-09-08T00:00:00.000Z', viewport: { center: [0, 0] as [number, number], zoom: 1, bearing: 0, pitch: 0 } };

it('shows a removable screenshot and keeps it when send is rejected', async () => {
  const send = vi.fn(async () => false); const remove = vi.fn(); const sent = vi.fn();
  render(<I18nProvider initial="en"><MapDesignComposer projectId="p" runtime={{ revision: 0, agentId: 'codex' }} sending={false} draft="Fix this"
    onDraftChange={() => {}} onSend={send} screenshots={[shot]} onRemoveScreenshot={remove} onScreenshotsSent={sent} /></I18nProvider>);
  expect(screen.getByRole('img', { name: 'Map screenshot' })).toHaveAttribute('src', mapScreenshotUrl(shot));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith('Fix this', [shot]));
  expect(sent).not.toHaveBeenCalled();
  expect(screen.getByRole('img', { name: 'Map screenshot' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Remove screenshot' }));
  expect(remove).toHaveBeenCalledWith(shot.id);
});

it('removes only the submitted screenshot set after acceptance', async () => {
  const sent = vi.fn(); const clear = vi.fn();
  render(<I18nProvider initial="en"><MapDesignComposer projectId="p" runtime={{ revision: 0, agentId: 'codex' }} sending={false} draft="Fix this"
    onDraftChange={clear} onSend={async () => true} screenshots={[shot]} onScreenshotsSent={sent} /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(sent).toHaveBeenCalledWith([shot.id]));
  expect(clear).toHaveBeenCalledWith('');
});

const attachment: MapTextAttachment = { id: 'c'.repeat(64), projectId: 'p', fileName: 'notes.txt', mediaType: 'text/plain', byteLength: 5, createdAt: '2026-09-09T00:00:00.000Z' };
function textFile(name = 'notes.txt', content = 'hello'): File {
  const file = new File([content], name, { type: 'text/plain' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer });
  return file;
}
function AttachmentComposer({ send = async () => false }: { send?(prompt: string, shots?: typeof shot[], files?: MapTextAttachment[]): Promise<boolean> }) {
  const [files, setFiles] = useState<MapTextAttachment[]>([]);
  return <I18nProvider initial="en"><MapDesignComposer projectId="p" runtime={{ revision: 0, agentId: 'codex' }} sending={false}
    draft="" onDraftChange={() => {}} onSend={send} attachments={files} onAttachmentsChange={setFiles} /></I18nProvider>;
}

it('places screenshot previews and text input in the same InputGroup', () => {
  render(<MapDesignComposer projectId="p" runtime={null} sending={false} draft="" onDraftChange={() => {}} onSend={async () => false} screenshots={[shot]} />);
  const image = screen.getByRole('img', { name: 'Map screenshot' });
  const group = image.closest('[data-slot="input-group"]');
  expect(group).toContainElement(screen.getByRole('textbox'));
  expect(image.closest('[data-align]')).toHaveAttribute('data-align', 'block-start');
});

it('uploads a file, previews it as text, and preserves it after rejected file-only send', async () => {
  const upload = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(attachment), { status: 201 }));
  const send = vi.fn(async () => false);
  render(<AttachmentComposer send={send} />);
  fireEvent.change(screen.getByLabelText('Choose text files'), { target: { files: [textFile()] } });
  const link = await screen.findByRole('link', { name: 'notes.txt' });
  expect(link).toHaveAttribute('href', mapTextAttachmentUrl(attachment));
  expect(link).toHaveAttribute('target', '_blank');
  expect(link.closest('[data-slot="input-group"]')).toContainElement(screen.getByRole('textbox'));
  expect(JSON.parse(String(upload.mock.calls[0]?.[1]?.body))).toEqual({ fileName: 'notes.txt', contentBase64: 'aGVsbG8=' });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith('Please review the attached files.', [], [attachment]));
  expect(screen.getByRole('link', { name: 'notes.txt' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
  expect(screen.queryByRole('link', { name: 'notes.txt' })).not.toBeInTheDocument();
});

it('blocks sending and another selection while uploading and aborts on unmount', async () => {
  const upload = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
  const view = render(<AttachmentComposer />);
  fireEvent.change(screen.getByLabelText('Choose text files'), { target: { files: [textFile()] } });
  await waitFor(() => expect(upload).toHaveBeenCalledOnce());
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled();
  const signal = upload.mock.calls[0]?.[1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
});

it.each([
  ['photo.png', 1, 1, 'Choose TXT, MD, CSV, TSV, JSON or GeoJSON files.'],
  ['notes.txt', 65537, 1, 'Each file must be at most 64 KiB.'],
  ['notes.txt', 1, 5, 'Attach at most 4 files.'],
  ['notes.txt', 65536, 3, 'The total file size must be at most 128 KiB.'],
])('rejects invalid file selections before upload: %s/%i/%i', async (name, size, count, expected) => {
  const upload = vi.spyOn(globalThis, 'fetch');
  render(<AttachmentComposer />);
  const files = Array.from({ length: count }, () => textFile(name, 'a'.repeat(size)));
  fireEvent.change(screen.getByLabelText('Choose text files'), { target: { files } });
  expect(await screen.findByRole('status')).toHaveTextContent(expected);
  expect(screen.getByRole('status')).toHaveClass('sr-only');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(upload).not.toHaveBeenCalled();
});

it('clears only the attachment set accepted by the send, preserving later additions', async () => {
  let accept!: (value: boolean) => void;
  const send = vi.fn(() => new Promise<boolean>((resolve) => { accept = resolve; }));
  const change = vi.fn();
  const next = { ...attachment, id: 'd'.repeat(64), fileName: 'later.md' };
  const props = { projectId: 'p', runtime: null, sending: false, draft: '', onDraftChange: vi.fn(), onSend: send, onAttachmentsChange: change };
  const view = render(<MapDesignComposer {...props} attachments={[attachment]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  view.rerender(<MapDesignComposer {...props} attachments={[attachment, next]} />);
  await act(async () => accept(true));
  expect(change).toHaveBeenCalledWith([next]);
});

it('shows the bottom button at the composer top with an accessible action while sending', () => {
  const scroll = vi.fn();
  render(<MapDesignComposer projectId="p" runtime={null} sending draft="" onDraftChange={() => {}} onSend={async () => false} showScrollToBottom onScrollToBottom={scroll} />);
  const button = screen.getByRole('button', { name: 'Back to bottom' });
  expect(button.querySelectorAll('[aria-hidden="true"] > span')).toHaveLength(3);
  fireEvent.click(button);
  expect(scroll).toHaveBeenCalledOnce();
});
