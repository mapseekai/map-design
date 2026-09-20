// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Slider } from '../src/ui/slider';

afterEach(cleanup);

it('passes labels to one scalar thumb or both range thumbs', () => {
  const view = render(<Slider aria-label="Opacity" value={40} />);
  expect(screen.getAllByRole('slider', { hidden: true })).toHaveLength(1);
  expect(screen.getByRole('slider', { hidden: true }).getAttribute('aria-label')).toBe('Opacity');
  view.rerender(<Slider aria-label="Range" value={[20, 80]} />);
  expect(screen.getAllByRole('slider', { hidden: true }).map((thumb) => thumb.getAttribute('aria-label'))).toEqual(['Range', 'Range']);
});
