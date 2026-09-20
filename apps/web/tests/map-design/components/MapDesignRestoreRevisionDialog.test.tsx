// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({ restore: vi.fn() }));

vi.mock('../../../src/map-design/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/map-design/client')>(),
  restoreMapDesignRevision: clientMocks.restore,
}));

import { MapDesignClientError } from '../../../src/map-design/client';
import { MapDesignRestoreRevisionDialog, mapDesignRestoreRevisionKey } from '../../../src/map-design/components/MapDesignRestoreRevisionDialog';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clientMocks.restore.mockReset();
});

beforeEach(() => {
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => 'request-identity'),
    subtle: globalThis.crypto.subtle,
  });
  clientMocks.restore.mockResolvedValue({
    draftRevision: 8,
    restoredRevision: 1,
    styleHash: 'a'.repeat(64),
    semanticDigest: 'b'.repeat(64),
    validationSummary: { status: 'valid', errors: 0, warnings: 0, infos: 0, totalFindings: 0, returnedFindings: 0, omittedFindings: 0 },
  });
});

function DialogHarness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>Open restore</button>
    {open ? <MapDesignRestoreRevisionDialog
      projectId="map-project"
      revision={1}
      expectedDraftRevision={7}
      onClose={() => { setOpen(false); triggerRef.current?.focus(); }}
      onRestored={async () => { setOpen(false); triggerRef.current?.focus(); }}
      onConflict={async () => undefined}
    /> : null}
  </>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const restoreResult = {
  draftRevision: 8,
  restoredRevision: 1,
  styleHash: 'a'.repeat(64),
  semanticDigest: 'b'.repeat(64),
  validationSummary: { status: 'valid' as const, errors: 0, warnings: 0, infos: 0, totalFindings: 0, returnedFindings: 0, omittedFindings: 0 },
};

function LifetimeHarness({ onRestored, expectedDraftRevision = 7, projectId = 'map-project' }: {
  onRestored(): void;
  expectedDraftRevision?: number;
  projectId?: string;
}) {
  return <MapDesignRestoreRevisionDialog
    projectId={projectId}
    revision={1}
    expectedDraftRevision={expectedDraftRevision}
    onClose={vi.fn()}
    onRestored={onRestored}
    onConflict={async () => undefined}
  />;
}

describe('MapDesignRestoreRevisionDialog', () => {
  it('explains the replacement, focuses its safe action, supports Escape, and returns focus to its trigger', async () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole('button', { name: 'Open restore' });
    trigger.focus();
    fireEvent.click(trigger);

    expect(await screen.findByRole('alertdialog', { name: 'Restore revision 1 as a new draft?' })).toBeInTheDocument();
    expect(screen.getByText(/Revision 1 will replace current draft revision 7/i)).toBeInTheDocument();
    expect(screen.getByText(/Committed history will stay unchanged/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
    const confirm = screen.getByRole('button', { name: 'Restore as new draft' });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('uses one idempotency key for a recoverable retry and announces a successful new draft', async () => {
    clientMocks.restore.mockRejectedValueOnce(new Error('temporary failure'));
    render(<DialogHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open restore' }));

    const confirm = await screen.findByRole('button', { name: 'Restore as new draft' });
    fireEvent.click(confirm);
    await waitFor(() => expect(clientMocks.restore).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not restore revision 1. Try again.');

    fireEvent.click(confirm);
    await waitFor(() => expect(clientMocks.restore).toHaveBeenCalledTimes(2));
    const first = clientMocks.restore.mock.calls[0]?.[2];
    const second = clientMocks.restore.mock.calls[1]?.[2];
    expect(first).toMatchObject({ expectedDraftRevision: 7, confirmReplaceDraft: true });
    expect(first.idempotencyKey).toBe('mapdesign-revision-restore:map-project:1:7:request-identity');
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('keeps a conflict dialog recoverable after it requests a current-context reload', async () => {
    const onConflict = vi.fn(async () => undefined);
    clientMocks.restore.mockRejectedValueOnce(new MapDesignClientError({
      code: 'REVISION_CONFLICT', message: 'draft changed', retryable: true,
    }));
    render(<MapDesignRestoreRevisionDialog
      projectId="map-project"
      revision={1}
      expectedDraftRevision={7}
      onClose={vi.fn()}
      onRestored={vi.fn()}
      onConflict={onConflict}
    />);

    fireEvent.click(await screen.findByRole('button', { name: 'Restore as new draft' }));
    expect(await screen.findByRole('status')).toHaveTextContent('The current draft changed. Reloaded the latest context; confirm restore again.');
    expect(onConflict).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore as new draft' })).toBeEnabled();
  });

  it('announces an active Run conflict without treating it as stale draft CAS', async () => {
    const onConflict = vi.fn(async () => undefined);
    clientMocks.restore.mockRejectedValueOnce(new MapDesignClientError({
      code: 'REVISION_CONFLICT',
      message: 'A map run is active for this project.',
      retryable: true,
      details: { reason: 'ACTIVE_RUN' },
    }));
    render(<MapDesignRestoreRevisionDialog
      projectId="map-project"
      revision={1}
      expectedDraftRevision={7}
      onClose={vi.fn()}
      onRestored={vi.fn()}
      onConflict={onConflict}
    />);

    fireEvent.click(await screen.findByRole('button', { name: 'Restore as new draft' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'A map run is active. Wait for it to finish or cancel it, then try restoring again.',
    );
    expect(onConflict).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Restore as new draft' })).toBeEnabled();
  });

  it('hashes only an idempotency identity that would exceed the contract bound', async () => {
    await expect(mapDesignRestoreRevisionKey('p'.repeat(128), 1, 7, 'request-identity'))
      .resolves.toMatch(/^mapdesign-revision-restore:[a-f0-9]{64}$/u);
    await expect(mapDesignRestoreRevisionKey('map-project', 1, 7, 'request-identity'))
      .resolves.toBe('mapdesign-revision-restore:map-project:1:7:request-identity');
  });

  it('aborts and ignores an in-flight restore when its current draft target changes', async () => {
    const pending = deferred<typeof restoreResult>();
    let signal: AbortSignal | undefined;
    const onRestored = vi.fn();
    clientMocks.restore.mockImplementation((_projectId, _revision, _input, nextSignal: AbortSignal) => {
      signal = nextSignal;
      return pending.promise;
    });
    const { rerender } = render(<LifetimeHarness onRestored={onRestored} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Restore as new draft' }));
    await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
    rerender(<LifetimeHarness onRestored={onRestored} expectedDraftRevision={8} />);
    expect(signal?.aborted).toBe(true);

    pending.resolve(restoreResult);
    await Promise.resolve();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('keeps focus on an internal fallback while all dialog actions are busy', async () => {
    const pending = deferred<typeof restoreResult>();
    clientMocks.restore.mockImplementation(() => pending.promise);
    render(<DialogHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open restore' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore as new draft' }));

    const focusGuard = await screen.findByTestId('restore-dialog-focus-guard');
    await waitFor(() => expect(focusGuard).toHaveFocus());
    fireEvent.keyDown(focusGuard, { key: 'Tab' });
    await waitFor(() => expect(focusGuard).toHaveFocus());
    fireEvent.keyDown(focusGuard, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(focusGuard).toHaveFocus());

    pending.resolve(restoreResult);
  });

  it('wraps focus from the guard to re-enabled controls after a recoverable failure', async () => {
    clientMocks.restore.mockRejectedValueOnce(new Error('temporary failure'));
    render(<DialogHarness />);
    const outside = screen.getByRole('button', { name: 'Open restore' });
    outside.focus();
    fireEvent.click(outside);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore as new draft' }));
    await screen.findByRole('alert');

    const focusGuard = screen.getByTestId('restore-dialog-focus-guard');
    focusGuard.focus();
    fireEvent.keyDown(focusGuard, { key: 'Tab' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());

    focusGuard.focus();
    fireEvent.keyDown(focusGuard, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Restore as new draft' })).toHaveFocus();

    outside.focus();
    fireEvent.keyDown(outside, { key: 'Tab' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());

    outside.focus();
    fireEvent.keyDown(outside, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Restore as new draft' })).toHaveFocus();
  });

  it('aborts and ignores a late restore after project navigation', async () => {
    const pending = deferred<typeof restoreResult>();
    let signal: AbortSignal | undefined;
    const onRestored = vi.fn();
    clientMocks.restore.mockImplementation((_projectId, _revision, _input, nextSignal: AbortSignal) => {
      signal = nextSignal;
      return pending.promise;
    });
    const { rerender } = render(<LifetimeHarness onRestored={onRestored} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Restore as new draft' }));
    await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
    rerender(<LifetimeHarness onRestored={onRestored} projectId="map-project-2" />);
    expect(signal?.aborted).toBe(true);
    pending.resolve(restoreResult);
    await Promise.resolve();
    expect(onRestored).not.toHaveBeenCalled();
  });
});
