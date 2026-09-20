// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { CartographyVisualPreview } from '../../src/map-design/components/CartographyVisualPreview';

afterEach(cleanup);
it('shows explicit empty states and never renders a default map', () => {
  const { container } = render(<I18nProvider><CartographyVisualPreview name="Empty" /></I18nProvider>);
  expect(screen.getByText('No colors defined')).toBeInTheDocument();
  expect(screen.getByText('No fonts defined')).toBeInTheDocument();
  expect(container.querySelectorAll('svg, img, image, iframe')).toHaveLength(0);
});
it('shows declared colors and all font roles with their specified size and weight', () => {
  render(<I18nProvider><CartographyVisualPreview name="Atlas" preview={{
    palette: [{ name: 'water', color: '#123456' }], typography: [
      { name: 'display', fontFamily: 'Georgia', fontSize: '24px', fontWeight: 600 },
      { name: 'body', fontFamily: 'Arial', fontSize: '12px' },
    ],
  }} /></I18nProvider>);
  expect(screen.getByLabelText('water: #123456')).toHaveStyle({ backgroundColor: '#123456' });
  expect(screen.getByText('24px · 600')).toBeInTheDocument();
  expect(screen.getByText('12px')).toBeInTheDocument();
  expect(screen.getAllByText('Aa')).toHaveLength(2);
});
it('uses a compact real color strip for the specification selector', () => {
  render(<I18nProvider><CartographyVisualPreview name="Atlas" compact preview={{ palette: [{name: 'ink', color: '#123456'}] }} /></I18nProvider>);
  expect(screen.getByLabelText('Specification palette: Atlas')).toHaveStyle({ width: '44px', height: '40px' });
  expect(screen.getByLabelText('Specification palette: Atlas').firstElementChild).toHaveStyle({ backgroundColor: '#123456' });
  expect(screen.queryByText('Aa')).not.toBeInTheDocument();
});
