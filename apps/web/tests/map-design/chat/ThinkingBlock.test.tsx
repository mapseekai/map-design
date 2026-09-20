// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ThinkingBlock } from '../../../src/map-design/chat/ThinkingBlock';

afterEach(cleanup);

describe('ThinkingBlock', () => {
  it('renders only the supplied public reasoning summary in an accessible disclosure', () => {
    render(<ThinkingBlock text="Public reasoning: inspect the road hierarchy." running />);

    const toggle = screen.getByRole('button', { name: /thinking|reasoning/i });
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls');
    expect(screen.getByText('Public reasoning: inspect the road hierarchy.')).toBeInTheDocument();
    expect(screen.queryByText(/private chain of thought/i)).not.toBeInTheDocument();
  });

  it('initializes historical reasoning closed and remains keyboard-operable through its native button', () => {
    render(<ThinkingBlock text="Public reasoning summary." />);

    const toggle = screen.getByRole('button', { name: /reasoning/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'Enter' });
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});
