// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MapLoading } from '../src/ui/map-loading';
afterEach(cleanup);
it('announces the localized loading state while keeping the animated illustration decorative', () => {
  render(<MapLoading label="正在加载地图…" variant="screen" />);
  expect(screen.getByRole('status').textContent).toContain('正在加载地图…');
  expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
  expect(screen.queryByRole('img')).toBeNull();
});
it('gives multiple loader illustrations unique clipping references', () => {
  const { container } = render(<><MapLoading label="Loading" /><MapLoading variant="inline" label="Checking" /></>);
  const ids = [...container.querySelectorAll('clipPath')].map(node => node.id);
  expect(new Set(ids).size).toBe(2);
});

it('ships the first-paint illustration styles with the component', () => {
  const { container } = render(<MapLoading label="Loading" variant="screen" />);
  expect(container.querySelector('style')?.textContent).toContain('.map-loading__district');
  expect(container.querySelector('style')?.textContent).toContain('@keyframes map-style-color');
});
