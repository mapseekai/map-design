import { configure } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

configure({ asyncUtilTimeout: 3_000 });

// Radix's pointer/focus management calls browser APIs that jsdom does not implement.
if (typeof HTMLElement !== 'undefined') {
  HTMLElement.prototype.hasPointerCapture ??= () => false;
  HTMLElement.prototype.setPointerCapture ??= () => {};
  HTMLElement.prototype.releasePointerCapture ??= () => {};
  HTMLElement.prototype.scrollIntoView ??= () => {};
}
