import { openSelect, selectValue } from '../helpers/select';
// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CartographyPicker } from '../../src/map-design/components/CartographyPicker';
import { I18nProvider } from '../../src/i18n';
import { getCartography, importCartography, listCartographies } from '../../src/map-design/client';

vi.mock('../../src/map-design/client', () => ({
  listCartographies: vi.fn(), importCartography: vi.fn(), getCartography: vi.fn(),
}));
const document = { id: 'a'.repeat(64), name: 'Quiet Atlas', description: 'Warm paper', version: '0.4.0' };
const source = '---\nversion: "0.4.0"\nname: Quiet Atlas\n---\n## Overview\nWarm paper.';
function Harness() {
  const [value, setValue] = useState('');
  return <CartographyPicker value={value} onChange={setValue} />;
}
beforeEach(() => {
  vi.mocked(listCartographies).mockResolvedValue({ documents: [document] });
  vi.mocked(getCartography).mockResolvedValue({ ...document, source });
  vi.mocked(importCartography).mockResolvedValue(document);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('selects a saved identity without loading or previewing its document', async () => {
  render(<I18nProvider><Harness /></I18nProvider>);
  openSelect(screen.getByLabelText('Map design system'));
  await screen.findByRole('option', { name: 'Quiet Atlas' });
  selectValue(screen.getByLabelText('Map design system'), document.id);
  expect(screen.queryByText('Preview specification')).not.toBeInTheDocument();
  expect(getCartography).not.toHaveBeenCalled();
  expect(screen.getByText('Warm paper')).toBeInTheDocument();
  expect(screen.getByLabelText('Map design system')).toHaveTextContent('Quiet Atlas');
  selectValue(screen.getByLabelText('Map design system'), '');
  expect(screen.queryByText('Preview specification')).not.toBeInTheDocument();
});

it('offers only saved specifications and links to their manager', async () => {
  render(<I18nProvider><Harness /></I18nProvider>);
  openSelect(screen.getByLabelText('Map design system'));
  await screen.findByRole('option', { name: 'Quiet Atlas' });
  expect(screen.queryByLabelText('Import local specification')).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Design specifications' }));
  expect(window.location.pathname).toBe('/cartographies');
  window.history.replaceState(null, '', '/');
});
