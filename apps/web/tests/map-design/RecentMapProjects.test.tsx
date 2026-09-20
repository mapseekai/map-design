// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../src/i18n';
import { RecentMapProjects } from '../../src/map-design/components/RecentMapProjects';

const failedProject = {
  projectId: 'failed-map', title: 'Failed map', lifecycle: 'failed' as const, sourceKind: 'style' as const,
  draftRevision: 0, committedRevision: null, validationStatus: 'unknown' as const, updatedAt: '2026-08-26T00:00:00.000Z',
};

afterEach(cleanup);

describe('RecentMapProjects', () => {
  it('offers local retry, open, and delete actions for canonical project records', () => {
    const onOpenProject = vi.fn();
    const onRetryProject = vi.fn();
    const onDeleteProject = vi.fn();
    render(<I18nProvider><RecentMapProjects projects={[failedProject]} loading={false} error={null} projectErrors={{}} pendingProjectIds={new Set()} onOpenProject={onOpenProject} onRetryProject={onRetryProject} onDeleteProject={onDeleteProject} /></I18nProvider>);

    expect(screen.getByRole('img', { name: 'Failed map' })).toHaveAttribute('src', '/api/map-design/projects/failed-map/thumbnail');
    fireEvent.error(screen.getByRole('img', { name: 'Failed map' }));
    expect(screen.queryByRole('img', { name: 'Failed map' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More actions: Failed map' }));
    fireEvent.click(screen.getByRole('button', { name: /open/i }));
    fireEvent.click(screen.getByRole('button', { name: 'More actions: Failed map' }));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    fireEvent.click(screen.getByRole('button', { name: 'More actions: Failed map' }));
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(onDeleteProject).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /delete/i }));
    expect(onOpenProject).toHaveBeenCalledWith('failed-map');
    expect(onOpenProject).toHaveBeenCalledTimes(1);
    expect(onRetryProject).toHaveBeenCalledWith('failed-map');
    expect(onDeleteProject).toHaveBeenCalledWith('failed-map');
  });

  it('combines name and lifecycle filters and resets an empty result', async () => {
    const ready = { ...failedProject, projectId: 'ready', title: 'River atlas', lifecycle: 'ready' as const };
    const importing = { ...failedProject, projectId: 'loading', title: 'River draft', lifecycle: 'importing' as const };
    render(<RecentMapProjects projects={[failedProject, ready, importing]} loading={false} error={null} projectErrors={{}} pendingProjectIds={new Set()} onOpenProject={vi.fn()} onRetryProject={vi.fn()} onDeleteProject={vi.fn()} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'river' } });
    expect(screen.queryByText('Failed map')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Project status' }), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('option', { name: 'Ready' }), { key: 'Enter' });
    expect(screen.getByText('River atlas')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('River draft')).not.toBeInTheDocument());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
    expect(screen.getByRole('status')).toHaveTextContent('No matching projects');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('River draft')).toBeInTheDocument();
    expect(screen.getByText('Failed map')).toBeInTheDocument();
  });

  it('renders the project name and update time without type or status metadata', () => {
    const { rerender } = render(
      <I18nProvider>
        <RecentMapProjects projects={[]} loading={false} error={null} projectErrors={{}} pendingProjectIds={new Set()} onOpenProject={vi.fn()} onRetryProject={vi.fn()} onDeleteProject={vi.fn()} />
      </I18nProvider>,
    );

    expect(screen.getByText('No map projects yet')).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Recent map projects' })).toBeNull();

    rerender(
      <I18nProvider>
        <RecentMapProjects projects={[{ ...failedProject, lifecycle: 'importing', sourceKind: null, draftRevision: 3, validationStatus: 'valid' }]} loading={false} error={null} projectErrors={{}} pendingProjectIds={new Set()} onOpenProject={vi.fn()} onRetryProject={vi.fn()} onDeleteProject={vi.fn()} />
      </I18nProvider>,
    );

    expect(screen.queryByText('source pending')).not.toBeInTheDocument();
    expect(screen.getByText('Failed map')).toBeVisible();
    expect(document.querySelector('time')).toHaveAttribute('datetime', failedProject.updatedAt);
    expect(screen.queryByRole('button', { name: /^open$/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Importing')).not.toBeInTheDocument();
    expect(screen.queryByText('Revision: 3')).not.toBeInTheDocument();
    expect(screen.queryByText('Validation: valid')).not.toBeInTheDocument();
  });
});

it('opens from the image, footer and keyboard-accessible project title, but not the more trigger', () => {
  const open = vi.fn();
  render(<RecentMapProjects projects={[failedProject]} loading={false} error={null} projectErrors={{}} pendingProjectIds={new Set()} onOpenProject={open} onRetryProject={vi.fn()} onDeleteProject={vi.fn()} />);
  fireEvent.click(screen.getByRole('img', { name: 'Failed map' }));
  fireEvent.click(document.querySelector('time')!);
  fireEvent.click(screen.getByRole('button', { name: 'Failed map' }));
  expect(open).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole('button', { name: 'More actions: Failed map' }));
  expect(open).toHaveBeenCalledTimes(3);
});

it('cancels deletion without deleting or opening the project', () => {
  const remove = vi.fn();
  const open = vi.fn();
  render(<RecentMapProjects projects={[failedProject]} loading={false} error={null} projectErrors={{}} pendingProjectIds={new Set()} onOpenProject={open} onRetryProject={vi.fn()} onDeleteProject={remove} />);
  fireEvent.click(screen.getByRole('button', { name: 'More actions: Failed map' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(screen.getByRole('alertdialog')).toHaveTextContent('Failed map');
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
  expect(remove).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});
