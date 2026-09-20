// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ColorInput } from '../src/ui/color-input';

afterEach(cleanup);

it('keeps text drafts editable and opens the picker for incomplete values', async () => {
  const change = vi.fn();
  const view = render(<ColorInput aria-label="Color" swatchLabel="Choose color" value="#12" onTextChange={change} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Color' }), { target: { value: '' } });
  expect(change).toHaveBeenCalledWith('');
  fireEvent.click(screen.getByRole('button', { name: 'Choose color' }));
  expect(await screen.findByRole('slider', { name: 'α' })).toBeTruthy();
  view.rerender(<ColorInput aria-label="Color" swatchLabel="Choose color" value="" disabled />);
  expect((screen.getByRole('textbox', { name: 'Color' }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('textbox', { name: 'Color' }) as HTMLInputElement).value).toBe('');
});

it('supports uncontrolled text and preserves transparent colors when opening', async () => {
  const change = vi.fn();
  render(<ColorInput aria-label="Color" swatchLabel="Choose color" defaultValue="#00000000" onTextChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose color' }));
  expect((await screen.findByRole('slider', { name: 'α' })).getAttribute('aria-valuenow')).toBe('0');
  expect(change).not.toHaveBeenCalled();
});
