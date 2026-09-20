// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MapDesignStyleCode } from '../../src/map-design/MapDesignStyleCode';
import { saveMapStyleDocument } from '../../src/map-design/style-edit/document-client';

vi.mock('@mapseekai/components/json-editor', () => ({ JsonEditor: ({ text, onTextChange, readOnly }: any) => <textarea aria-label="style.json" value={text} readOnly={readOnly} onChange={event => onTextChange(event.target.value)} /> }));
vi.mock('../../src/map-design/style-edit/document-client', () => ({ saveMapStyleDocument: vi.fn() }));
const style = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#ffffff' } }] };
const nextStyle = { ...style, name: 'Edited' };
const props = { projectId: 'project', style, draftRevision: 1, styleHash: 'a'.repeat(64), readOnly: false, onSaved: vi.fn() };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(700); }); }

it('cancels pending saves for invalid JSON and preserves the exact text', async () => {
  vi.useFakeTimers(); render(<MapDesignStyleCode {...props} />);
  const editor = screen.getByRole('textbox');
  fireEvent.change(editor, { target: { value: JSON.stringify(nextStyle) } });
  fireEvent.change(editor, { target: { value: '{"version":' } });
  await tick();
  expect(saveMapStyleDocument).not.toHaveBeenCalled();
  expect((editor as HTMLTextAreaElement).value).toBe('{"version":');
  expect(screen.getByRole('status').textContent).toContain('Invalid JSON');
});

it('saves valid complete styles and updates the base for subsequent edits', async () => {
  vi.useFakeTimers();
  vi.mocked(saveMapStyleDocument).mockResolvedValue({ draftRevision: 2, styleHash: 'b'.repeat(64) } as any);
  render(<MapDesignStyleCode {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: JSON.stringify(nextStyle) } }); await tick();
  expect(saveMapStyleDocument).toHaveBeenCalledWith('project', expect.objectContaining({ style: nextStyle, expectedRevision: 1, styleHash: props.styleHash }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: JSON.stringify({ ...nextStyle, name: 'Second' }) } }); await tick();
  expect(vi.mocked(saveMapStyleDocument).mock.calls[1]?.[1].expectedRevision).toBe(2);
  expect(props.onSaved).toHaveBeenCalled();
});

it('preserves edits and blocks autosave when a different client updates the style', async () => {
  vi.useFakeTimers(); const ui = render(<MapDesignStyleCode {...props} />);
  const text = JSON.stringify(nextStyle);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  ui.rerender(<MapDesignStyleCode {...props} style={{ ...style, name: 'Remote' }} draftRevision={2} styleHash={'c'.repeat(64)} />);
  await tick();
  expect(saveMapStyleDocument).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(text);
  expect(screen.getByRole('status').textContent).toContain('changed elsewhere');
  fireEvent.click(screen.getByRole('button', { name: 'Discard edits and reload' }));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('Remote');
});

it('cancels queued edits when the project becomes read-only', async () => {
  vi.useFakeTimers(); const ui = render(<MapDesignStyleCode {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: JSON.stringify(nextStyle) } });
  ui.rerender(<MapDesignStyleCode {...props} readOnly />); await tick();
  expect(saveMapStyleDocument).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).readOnly).toBe(true);
});
