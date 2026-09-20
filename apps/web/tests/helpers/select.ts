import { fireEvent, screen } from '@testing-library/react';

export function openSelect(trigger: HTMLElement) {
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.keyDown(trigger, { key: 'ArrowDown' });
}

export function selectValue(trigger: HTMLElement, value: string) {
  openSelect(trigger);
  const option = screen.getAllByRole('option').find((item) => item.getAttribute('data-value') === (value || '__none__'));
  if (!option) throw new Error(`Missing select option: ${value}`);
  fireEvent.keyDown(option, { key: 'Enter' });
}
