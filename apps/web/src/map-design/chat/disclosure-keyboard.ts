import type { KeyboardEvent } from 'react';

export function activateDisclosureFromKeyboard(
  event: KeyboardEvent<HTMLButtonElement>,
  toggle: () => void,
): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  toggle();
}
