// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import { MapDesignRevisionPanel } from '../../../src/map-design/components/MapDesignRevisionPanel';

afterEach(cleanup);

const revisions = {
  revisions: [
    {
      revision: 1,
      draftRevision: 3,
      styleHash: 'a'.repeat(64),
      sourceDigest: 'b'.repeat(64),
      semanticDigest: 'c'.repeat(64),
      designSystemDigest: 'd'.repeat(64),
      previewId: 'preview-1',
      attestationDigest: 'e'.repeat(64),
      committedAt: '2026-09-01T12:00:00.000Z',
    },
    {
      revision: 2,
      draftRevision: 4,
      styleHash: 'f'.repeat(64),
      sourceDigest: '1'.repeat(64),
      semanticDigest: '2'.repeat(64),
      designSystemDigest: '3'.repeat(64),
      previewId: 'preview-2',
      attestationDigest: '4'.repeat(64),
      committedAt: '2026-09-02T12:00:00.000Z',
    },
  ],
  returned: 2,
  truncated: false,
};

describe('MapDesignRevisionPanel', () => {
  it('disables the selected revision action while keeping the current commit row viewable', () => {
    const onViewRevision = vi.fn();
    render(<MapDesignRevisionPanel
      revisions={revisions}
      canCommit={false}
      committing={false}
      currentCommittedRevision={2}
      selectedRevision={1}
      onCommit={vi.fn()}
      onViewRevision={onViewRevision}
    />);

    const selected = screen.getAllByRole('listitem')[0];
    const current = screen.getAllByRole('listitem')[1];
    if (!selected) throw new Error('selected revision row was not rendered');
    if (!current) throw new Error('current revision row was not rendered');
    expect(selected).toHaveAttribute('aria-current', 'true');
    expect(within(selected).getByRole('button', { name: 'View revision 1' })).toBeDisabled();
    expect(within(selected).getByRole('button')).toHaveTextContent('View this version');
    expect(within(selected).getByText('Viewing')).toBeInTheDocument();
    expect(within(current).getByRole('button', { name: 'View revision 2' })).toBeEnabled();
    expect(within(current).getByText('Current commit')).toHaveAttribute('data-variant', 'default');
    expect(within(current).getByText('Current commit').parentElement).toContainElement(within(current).getByRole('button'));
    expect(screen.getByText('aaaaaaaaaa')).toBeInTheDocument();
    expect(screen.getByText(new Date('2026-09-01T12:00:00.000Z').toLocaleString())).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'View revision 2' }));
    expect(onViewRevision).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('uses commit terminology for the Spanish current commit badge', () => {
    render(<I18nProvider initial="es-ES"><MapDesignRevisionPanel
      revisions={revisions}
      canCommit={false}
      committing={false}
      currentCommittedRevision={2}
      selectedRevision={1}
      onCommit={vi.fn()}
      onViewRevision={vi.fn()}
    /></I18nProvider>);

    expect(screen.getByText('Commit actual')).toBeInTheDocument();
    expect(screen.queryByText('Confirmación actual')).not.toBeInTheDocument();
  });
});
