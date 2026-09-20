// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from '../src/button';
import { Input, Textarea } from '../src/form-controls';
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../src/dialog';

afterEach(cleanup);

// DismissableLayer installs its document pointer listener on the next task.
async function waitForOutsidePointerListener() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('Dialog', () => {
  it('portals the labelled panel to body outside its rendering container', () => {
    const { container } = render(<Dialog ariaLabelledBy="dialog-title" ariaDescribedBy="dialog-description">
      <DialogTitle id="dialog-title">Rename design</DialogTitle>
      <DialogDescription id="dialog-description">Choose a recognizable name.</DialogDescription>
    </Dialog>);
    const panel = screen.getByRole('dialog', { name: 'Rename design' });
    expect(panel.closest('[data-base-ui-portal]')?.parentElement).toBe(document.body);
    expect(container.contains(panel)).toBe(false);
    expect(panel.getAttribute('aria-describedby')).toBe('dialog-description');
  });

  it('dismisses on an outside pointer down but ignores inside interaction', async () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} ariaLabel="Backdrop close"><Button>Inside action</Button></Dialog>);
    await waitForOutsidePointerListener();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Inside action' }), { pointerType: 'mouse', button: 0, ctrlKey: false });
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Inside action' }), { pointerType: 'mouse', button: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Inside action' }));
    expect(onClose).not.toHaveBeenCalled();
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).not.toBeNull();
    // Complete each pointer sequence; an inside-to-outside drag must not dismiss.
    fireEvent.pointerDown(overlay!, { pointerType: 'mouse', button: 0, ctrlKey: false });
    fireEvent.mouseDown(overlay!, { button: 0 });
    fireEvent.pointerUp(overlay!, { pointerType: 'mouse', button: 0 });
    fireEvent.mouseUp(overlay!, { button: 0 });
    fireEvent.click(overlay!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss protected work on backdrop or Escape', async () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} closeOnBackdrop={false} closeOnEscape={false} ariaLabel="Saving design">
      <Button disabled>Saving</Button>
    </Dialog>);
    await waitForOutsidePointerListener();
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')!;
    fireEvent.pointerDown(overlay, { pointerType: 'mouse', button: 0, ctrlKey: false });
    fireEvent.pointerUp(overlay, { pointerType: 'mouse', button: 0 });
    fireEvent.click(overlay);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Saving design' })).toBeTruthy();
  });

  it('closes on Escape when enabled', () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} closeOnEscape ariaLabel="Escape close"><Button>Continue</Button></Dialog>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('merges caller layout classes with shared dialog and overlay styling', () => {
    render(<Dialog className="plugin-details-modal w-[420px] gap-3" backdropClassName="plugin-overlay"
      includeChromeClassName={false} ariaLabel="Plugin details"><p>Details</p></Dialog>);
    const panel = screen.getByRole('dialog', { name: 'Plugin details' });
    expect(panel.classList.contains('plugin-details-modal')).toBe(true);
    expect(panel.classList.contains('w-[420px]')).toBe(true);
    expect(panel.classList.contains('w-full')).toBe(false);
    expect(panel.classList.contains('gap-3')).toBe(true);
    expect(panel.classList.contains('gap-4')).toBe(false);
    expect(panel.classList.contains('fixed')).toBe(true);
    expect(document.querySelector('[data-slot="dialog-overlay"]')?.classList.contains('plugin-overlay')).toBe(true);
  });

  it('supports accessible sectioned forms with shared header/body/footer primitives', () => {
    const onSubmit = vi.fn();
    render(<Dialog as="form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      layout="sectioned" ariaLabelledBy="dialog-title">
      <DialogHeader><DialogTitle id="dialog-title">Sketch text</DialogTitle>
        <DialogDescription>Add a note to the canvas.</DialogDescription></DialogHeader>
      <DialogBody><label>Text<Input /></label></DialogBody>
      <DialogFooter><Button type="button">Cancel</Button><Button type="submit">Save</Button></DialogFooter>
    </Dialog>);
    const panel = screen.getByRole('dialog', { name: 'Sketch text' });
    expect(panel.querySelector('[data-slot="dialog-header"]')).not.toBeNull();
    expect(panel.querySelector('[data-slot="dialog-body"]')).not.toBeNull();
    expect(panel.querySelector('[data-slot="dialog-footer"]')).not.toBeNull();
    expect(within(panel).getByRole('textbox', { name: 'Text' })).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('contains keyboard focus while open and restores the opener after closing', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><Button onClick={() => setOpen(true)}>Open editor</Button>{open ?
        <Dialog closeOnEscape onClose={() => setOpen(false)} ariaLabel="Editor">
          <Input aria-label="Design name" /><Button onClick={() => setOpen(false)}>Done</Button>
        </Dialog> : null}</>;
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open editor' });
    opener.focus();
    fireEvent.click(opener);
    const first = screen.getByRole('textbox', { name: 'Design name' });
    const last = screen.getByRole('button', { name: 'Done' });
    await waitFor(() => expect(document.activeElement).toBe(first));
    const guards = document.querySelectorAll<HTMLElement>('[data-base-ui-focus-guard][data-type="inside"]');
    expect(guards.length).toBe(2);
    act(() => guards[0]!.focus());
    await waitFor(() => expect(document.activeElement).toBe(last));
    act(() => guards[1]!.focus());
    await waitFor(() => expect(document.activeElement).toBe(first));
    fireEvent.click(last);
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('forwards imperative refs to native Button, Input, and Textarea elements', () => {
    const button = createRef<HTMLButtonElement>();
    const input = createRef<HTMLInputElement>();
    const textarea = createRef<HTMLTextAreaElement>();
    render(<><Button ref={button}>Focus target</Button><Input ref={input} aria-label="Name" />
      <Textarea ref={textarea} aria-label="Description" /></>);
    expect(button.current).toBe(screen.getByRole('button', { name: 'Focus target' }));
    expect(input.current).toBe(screen.getByRole('textbox', { name: 'Name' }));
    expect(textarea.current).toBe(screen.getByRole('textbox', { name: 'Description' }));
    for (const ref of [button, input, textarea]) { ref.current?.focus(); expect(document.activeElement).toBe(ref.current); }
  });
});
