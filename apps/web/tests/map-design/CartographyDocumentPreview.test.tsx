// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { CartographyDocumentPreview } from '../../src/map-design/components/CartographyDocumentPreview';
afterEach(cleanup);
it('defaults to formatted Markdown while keeping complete frontmatter in Source', () => {
  const source = '---\nname: Atlas\n---\n## Visual identity\n\nUse **clear labels**.\n\n- Water\n- Roads';
  render(<I18nProvider><CartographyDocumentPreview source={source} /></I18nProvider>);
  expect(screen.getByRole('heading', { name: 'Visual identity' })).toBeInTheDocument();
  expect(screen.getByText('clear labels').tagName).toBe('STRONG');
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.queryByText('name: Atlas')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Source' }));
  expect(screen.getByLabelText('Source')).toHaveTextContent('name: Atlas');
});
it('does not inject HTML or fetch linked images', () => {
  const { container } = render(<I18nProvider><CartographyDocumentPreview source={'<script>alert(1)</script>\n\n![Remote](https://example.com/image.png)'} /></I18nProvider>);
  expect(container.querySelectorAll('script, img')).toHaveLength(0);
  expect(screen.getByRole('link', { name: 'Remote' })).toBeInTheDocument();
});
