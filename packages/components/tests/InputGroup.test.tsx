// @vitest-environment jsdom
import { createRef } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupTextarea } from '../src/ui/input-group';

afterEach(cleanup);

it('forwards React 18 input refs so a composer can restore focus', () => {
  const input = createRef<HTMLInputElement>();
  const textarea = createRef<HTMLTextAreaElement>();
  render(<><InputGroup><InputGroupInput ref={input} aria-label="Title" /></InputGroup>
    <InputGroup><InputGroupTextarea ref={textarea} aria-label="Message" /><InputGroupAddon align="block-end">Attachments</InputGroupAddon></InputGroup></>);
  expect(input.current).toBe(screen.getByRole('textbox', { name: 'Title' }));
  expect(textarea.current).toBe(screen.getByRole('textbox', { name: 'Message' }));
  textarea.current?.focus();
  expect(document.activeElement).toBe(textarea.current);
});
