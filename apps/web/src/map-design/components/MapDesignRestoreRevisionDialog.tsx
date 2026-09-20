import { Button, Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@mapseekai/components';
import type { MapRestoreRevisionOutput } from '@mapseekai/map-design-contracts';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { useT } from '../../i18n';
import { MapDesignClientError, restoreMapDesignRevision } from '../client';

export interface MapDesignRestoreRevisionDialogProps {
  projectId: string;
  revision: number;
  expectedDraftRevision: number;
  onClose(): void;
  onRestored(result: MapRestoreRevisionOutput): void | Promise<void>;
  onConflict(): void | Promise<void>;
  conflictMessage?: string | null;
}

export async function mapDesignRestoreRevisionKey(
  projectId: string,
  revision: number,
  expectedDraftRevision: number,
  requestIdentity = globalThis.crypto.randomUUID(),
): Promise<string> {
  const identity = `mapdesign-revision-restore:${projectId}:${revision}:${expectedDraftRevision}:${requestIdentity}`;
  if (identity.length <= 128) return identity;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `mapdesign-revision-restore:${hex}`;
}

export function mapDesignRestoreRevisionIntent(projectId: string, revision: number): string {
  const summarizedProject = projectId.length <= 240
    ? projectId
    : `${projectId.slice(0, 120)}…${projectId.slice(-120)} [${projectId.length}]`;
  return `Restore MapDesign revision ${revision} as a new draft for project ${summarizedProject}.`;
}

function dialogFocusableElements(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ) ?? []).filter((element) => !element.matches(':disabled, [aria-disabled="true"]')
    && !element.closest('[hidden], [inert], [aria-hidden="true"]'));
}

function isActiveRunConflict(reason: unknown): reason is MapDesignClientError {
  if (!(reason instanceof MapDesignClientError) || reason.code !== 'REVISION_CONFLICT') return false;
  const details = reason.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
  const record = details as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 1 && keys[0] === 'reason' && record.reason === 'ACTIVE_RUN';
}

export function MapDesignRestoreRevisionDialog({ projectId, revision, expectedDraftRevision, onClose, onRestored, onConflict, conflictMessage = null }: MapDesignRestoreRevisionDialogProps) {
  const t = useT();
  const titleId = `map-restore-title-${useId().replace(/:/gu, '')}`;
  const descriptionId = `map-restore-description-${useId().replace(/:/gu, '')}`;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogBodyRef = useRef<HTMLDivElement>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const operationControllerRef = useRef<AbortController | null>(null);
  const operationGenerationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationGenerationRef.current += 1;
      operationControllerRef.current?.abort();
      operationControllerRef.current = null;
    };
  }, []);
  useEffect(() => {
    let active = true;
    operationGenerationRef.current += 1;
    operationControllerRef.current?.abort();
    operationControllerRef.current = null;
    setSubmitting(false);
    setError(null);
    void mapDesignRestoreRevisionKey(projectId, revision, expectedDraftRevision, globalThis.crypto.randomUUID())
      .then((key) => { if (active) setIdempotencyKey(key); })
      .catch(() => { if (active) setError(t('mapDesign.revision.restoreFailed', { revision })); });
    return () => { active = false; };
  }, [expectedDraftRevision, projectId, revision, t]);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => { if (submitting) dialogBodyRef.current?.focus(); }, [submitting]);
  useEffect(() => {
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Tab') return;
      const root = dialogBodyRef.current;
      if (!root || root.contains(document.activeElement)) return;
      event.preventDefault();
      const focusable = dialogFocusableElements(root);
      if (focusable.length === 0) root.focus();
      else (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
    };
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => document.removeEventListener('keydown', onDocumentKeyDown);
  }, []);

  const close = () => {
    if (!submitting) onClose();
  };
  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const root = dialogBodyRef.current;
    const focusable = dialogFocusableElements(root);
    if (focusable.length === 0) {
      event.preventDefault();
      root?.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (document.activeElement === root) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const submit = async () => {
    if (!idempotencyKey || submitting) return;
    const controller = new AbortController();
    const generation = operationGenerationRef.current + 1;
    operationGenerationRef.current = generation;
    operationControllerRef.current = controller;
    setSubmitting(true);
    setError(null);
    const currentOperation = () => mountedRef.current
      && !controller.signal.aborted
      && operationGenerationRef.current === generation
      && operationControllerRef.current === controller;
    try {
      const result = await restoreMapDesignRevision(projectId, revision, {
        expectedDraftRevision,
        idempotencyKey,
        confirmReplaceDraft: true,
        intentSummary: mapDesignRestoreRevisionIntent(projectId, revision),
      }, controller.signal);
      if (!currentOperation()) return;
      await onRestored(result);
    } catch (reason: unknown) {
      if (!currentOperation()) return;
      if (isActiveRunConflict(reason)) {
        setError(t('mapDesign.revision.restoreActiveRun'));
      } else if (reason instanceof MapDesignClientError && reason.code === 'REVISION_CONFLICT') {
        try { await onConflict(); } catch { /* preserve a retryable dialog even when its context refresh fails */ }
        if (!currentOperation()) return;
        setError(t('mapDesign.revision.restoreConflict'));
      } else {
        setError(t('mapDesign.revision.restoreFailed', { revision }));
      }
    } finally {
      if (currentOperation()) {
        operationControllerRef.current = null;
        setSubmitting(false);
      }
    }
  };
  const visibleError = error ?? conflictMessage;
  const errorRole = visibleError === t('mapDesign.revision.restoreActiveRun')
    || visibleError === t('mapDesign.revision.restoreConflict')
    || visibleError === conflictMessage ? 'status' : 'alert';

  return <Dialog as="form" role="alertdialog" ariaLabelledBy={titleId} ariaDescribedBy={descriptionId}
    onClose={close} closeOnBackdrop={!submitting} closeOnEscape={!submitting}
    initialFocus={() => submitting ? dialogBodyRef.current : cancelRef.current} finalFocus={false}
    onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <div ref={dialogBodyRef} className="flex min-w-0 flex-col gap-4 [&_p]:leading-relaxed" tabIndex={-1} data-testid="restore-dialog-focus-guard" onKeyDown={trapFocus}>
      <DialogHeader>
        <DialogTitle id={titleId}>{t('mapDesign.revision.restoreTitle', { revision })}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <DialogDescription id={descriptionId}>{t('mapDesign.revision.restoreDescription', { revision, draftRevision: expectedDraftRevision })}</DialogDescription>
        <p>{t('mapDesign.revision.historyPreserved')}</p>
        {visibleError ? <p role={errorRole} aria-live={errorRole === 'status' ? 'polite' : undefined}>{visibleError}</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button ref={cancelRef} type="button" variant="secondary" disabled={submitting} onClick={close}>{t('mapDesign.revision.cancel')}</Button>
        <Button type="submit" variant="default" disabled={!idempotencyKey || submitting} aria-busy={submitting}>
          {submitting ? t('mapDesign.revision.restoring') : t('mapDesign.revision.restore')}
        </Button>
      </DialogFooter>
    </div>
  </Dialog>;
}
