// @vitest-environment jsdom

import { StrictMode, createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ClientApp } from '../../app/[[...slug]]/client-app';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-map-design-app-mounted');
});

describe('ClientApp', () => {
  it('marks the browser app mounted for its lifetime, including StrictMode remounts', () => {
    const view = render(createElement(StrictMode, null, createElement(ClientApp)));

    expect(document.documentElement.getAttribute('data-map-design-app-mounted')).toBe('1');

    view.unmount();

    expect(document.documentElement.hasAttribute('data-map-design-app-mounted')).toBe(false);
  });
});
