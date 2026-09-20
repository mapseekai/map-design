import { Alert, AlertDescription, Button, Field, InputGroup, InputGroupAddon, InputGroupTextarea, Popover, PopoverTrigger, PopoverContent } from '@mapseekai/components';
import type {
  LocalAgentInfo,
  MapDesignConversationRuntimeChoice,
  MapDesignRuntimeSelectionInput,
} from '@mapseekai/contracts';
import { ArrowUp, BookOpen, Paperclip, Square, FileText, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

import { useI18n } from '../../i18n';
import { mapScreenshotUrl, mapTextAttachmentUrl, type MapScreenshot, type MapTextAttachment } from '@mapseekai/contracts';
import { attachmentsCopy } from '../../i18n/locales/attachments';
import { uploadTextAttachment, validateTextAttachmentSelection, type TextAttachmentSelectionError } from './text-attachments-client';
import { screenshotCopy } from '../../i18n/locales/screenshots';
import { MapDesignRuntimeSwitcher } from './MapDesignRuntimeSwitcher';
import type { MapDesignRuntime } from './useMapDesignRun';

const MAX_PROMPT_LENGTH = 16_384;

export function MapDesignComposer({
  projectId, cartographyLabel, cartographyHref,
  runtime, maxPromptLength = MAX_PROMPT_LENGTH, placeholder,
  runtimeAgents = [],
  runtimeSaving = false,
  runtimeNotice = null,
  runtimeDisabled,
  runtimeDisabledReason,
  onRuntimeChange,
  sending,
  disabled = false,
  disabledReason = null,
  draft,
  onCancel,
  onDraftChange,
  onSend,
  screenshots = [],
  onRemoveScreenshot,
  onScreenshotsSent,
  attachments = [], onAttachmentsChange, showScrollToBottom = false, onScrollToBottom,
}: {
  projectId: string;
  cartographyLabel?: string; cartographyHref?: string;
  runtime: MapDesignRuntime | null;
  maxPromptLength?: number;
  placeholder?: string;
  runtimeAgents?: readonly LocalAgentInfo[];
  runtimeSaving?: boolean;
  runtimeNotice?: string | null;
  runtimeDisabled?: boolean;
  runtimeDisabledReason?: string | null;
  onRuntimeChange?(next: MapDesignRuntimeSelectionInput): Promise<void>;
  sending: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  draft: string;
  onCancel?: () => void | Promise<void>;
  onDraftChange(draft: string): void;
  onSend(prompt: string, screenshots?: MapScreenshot[], attachments?: MapTextAttachment[]): boolean | Promise<boolean>;
  screenshots?: MapScreenshot[];
  onRemoveScreenshot?(id: string): void;
  onScreenshotsSent?(ids: string[]): void;
  attachments?: MapTextAttachment[];
  onAttachmentsChange?(files: MapTextAttachment[]): void;
  showScrollToBottom?: boolean;
  onScrollToBottom?(): void;
}) {
  const { locale, t } = useI18n();
  const copy = screenshotCopy[locale];
  const filesCopy = attachmentsCopy[locale];
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadController = useRef<AbortController | null>(null);
  const latestAttachments = useRef(attachments); latestAttachments.current = attachments;
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<TextAttachmentSelectionError | 'uploadFailed' | null>(null);
  useEffect(() => {
    setUploading(false); setUploadError(null);
    return () => { uploadController.current?.abort(); uploadController.current = null; };
  }, [projectId]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editGeneration = useRef(0);
  const cancelPendingRef = useRef(false);
  const [cancelPending, setCancelPending] = useState(false);
  const blocked = sending || disabled || runtimeSaving || uploading;
  const [restoreInputFocus, setRestoreInputFocus] = useState(false);
  useLayoutEffect(() => {
    if (!restoreInputFocus || blocked) return;
    inputRef.current?.focus();
    setRestoreInputFocus(false);
  }, [blocked, restoreInputFocus]);
  const hasContent = Boolean(draft.trim() || screenshots.length || attachments.length);
  const error = draft.length > maxPromptLength
    ? t('mapDesign.composer.limit', { limit: new Intl.NumberFormat(locale).format(maxPromptLength) })
    : null;
  const submit = async () => {
    if (blocked || uploadController.current || error || !hasContent) return;
    const submitted = draft.trim() ? draft : filesCopy.defaultPrompt;
    const submittedAttachments = attachments;
    const submittedScreenshots = screenshots;
    const submittedGeneration = editGeneration.current;
    try {
      if (await (submittedAttachments.length ? onSend(submitted, submittedScreenshots, submittedAttachments)
        : submittedScreenshots.length ? onSend(submitted, submittedScreenshots) : onSend(submitted))) {
        if (submittedAttachments.length) {
          const sentIds = new Set(submittedAttachments.map(({ id }) => id));
          onAttachmentsChange?.(latestAttachments.current.filter(({ id }) => !sentIds.has(id)));
        }
        setUploadError(null);
        if (submittedScreenshots.length) onScreenshotsSent?.(submittedScreenshots.map(({ id }) => id));
        if (editGeneration.current === submittedGeneration) onDraftChange('');
      } else setRestoreInputFocus(true);
    } catch {
      setRestoreInputFocus(true);
    }
  };
  const upload = async (files: File[]) => {
    if (!files.length || blocked || uploadController.current || !onAttachmentsChange) return;
    const invalid = validateTextAttachmentSelection(files, latestAttachments.current);
    if (invalid) { setUploadError(invalid); return; }
    const controller = new AbortController(); uploadController.current = controller;
    setUploading(true); setUploadError(null);
    const added: MapTextAttachment[] = [];
    try {
      for (const file of files) {
        const uploaded = await uploadTextAttachment(projectId, file, controller.signal);
        if (controller.signal.aborted || uploadController.current !== controller) return;
        added.push(uploaded);
        onAttachmentsChange([...new Map([...latestAttachments.current, ...added].map((item) => [item.id, item])).values()]);
      }
    } catch {
      if (!controller.signal.aborted && uploadController.current === controller) setUploadError('uploadFailed');
    } finally {
      if (uploadController.current === controller) { uploadController.current = null; setUploading(false); }
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void submit();
  };
  const cancel = async () => {
    if (!onCancel || cancelPendingRef.current) return;
    cancelPendingRef.current = true;
    setCancelPending(true);
    try {
      await onCancel();
    } finally {
      cancelPendingRef.current = false;
      setCancelPending(false);
    }
  };
  return <form className="relative flex shrink-0 flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    {showScrollToBottom && onScrollToBottom ? <Button type="button" size="sm" variant="secondary"
      className="absolute left-1/2 top-0 z-10 -translate-x-1/2 -translate-y-1/2" aria-label={filesCopy.scrollBottom} title={filesCopy.scrollBottom}
      onClick={onScrollToBottom}>{sending ? <span className="inline-flex items-center gap-1" aria-hidden="true">{[0, 1, 2].map((dot) => <span key={dot} className="size-1 rounded-full bg-current motion-safe:animate-bounce" style={{ animationDelay: `${dot * 120}ms`, animationDuration: '900ms' }} />)}</span> : filesCopy.scrollBottom}</Button> : null}
    <input ref={fileInput} type="file" hidden multiple accept=".txt,.md,.csv,.tsv,.json,.geojson" aria-label={filesCopy.select}
      disabled={blocked || !onAttachmentsChange} onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void upload(files); }} />
    <Field data-invalid={Boolean(error)}>
      <InputGroup>
        <InputGroupTextarea aria-invalid={Boolean(error)} className="min-h-20 resize-y" ref={inputRef}
          aria-label={placeholder ?? t('mapDesign.composer.label')} value={draft} disabled={blocked}
          onChange={(event) => { editGeneration.current += 1; onDraftChange(event.target.value); }} onKeyDown={keyDown}
          placeholder={placeholder ?? t('mapDesign.composer.placeholder')} />
        {screenshots.length || attachments.length ? <InputGroupAddon align="block-start"><div className="flex flex-wrap items-start gap-2">
          {screenshots.map((screenshot) => <div key={screenshot.id} className="relative overflow-hidden rounded-md border">
            <a href={mapScreenshotUrl(screenshot)} target="_blank" rel="noreferrer"><img src={mapScreenshotUrl(screenshot)} alt={copy.image} className="h-20 w-28 object-cover" /></a>
            {onRemoveScreenshot ? <Button type="button" className="absolute end-0 top-0" size="icon-xs" variant="secondary" aria-label={copy.remove} disabled={blocked} onClick={() => onRemoveScreenshot(screenshot.id)}><X aria-hidden="true" /></Button> : null}
          </div>)}
          {attachments.map((file) => <div key={file.id} className="flex min-w-0 max-w-full items-center gap-1">
            <Button nativeButton={false} role="link" variant="outline" size="sm" className="min-w-0" render={<a href={mapTextAttachmentUrl(file)} target="_blank" rel="noreferrer" title={file.fileName} />}>
              <FileText data-icon="inline-start" aria-hidden="true" /><span className="max-w-40 truncate">{file.fileName}</span>
            </Button>
            {onAttachmentsChange ? <Button type="button" size="icon-xs" variant="ghost" disabled={blocked}
              aria-label={filesCopy.remove.replace('{file}', file.fileName)} onClick={() => onAttachmentsChange(attachments.filter((item) => item.id !== file.id))}><X aria-hidden="true" /></Button> : null}
          </div>)}
        </div></InputGroupAddon> : null}
      </InputGroup>
    </Field>
    <div className="flex min-h-8 flex-wrap items-center gap-2 px-1">
          <Popover open={attachmentMenuOpen} onOpenChange={setAttachmentMenuOpen}>
            <PopoverTrigger render={<Button type="button" variant="ghost" size="icon-sm" />} aria-label={filesCopy.attach}
              title={filesCopy.attach} disabled={blocked || !onAttachmentsChange} aria-busy={uploading}>
              <Paperclip aria-hidden="true" />
            </PopoverTrigger>
            <PopoverContent side="top" align="start" size="sm" className="w-52">
              {[
                { label: 'TXT / Markdown', accept: '.txt,.md' },
                { label: 'CSV / TSV', accept: '.csv,.tsv' },
                { label: 'JSON / GeoJSON', accept: '.json,.geojson' },
              ].map(({ label, accept }) => <Button key={accept} type="button" variant="ghost" className="w-full justify-start"
                disabled={blocked || !onAttachmentsChange} onClick={() => {
                  if (!fileInput.current) return;
                  fileInput.current.accept = accept;
                  fileInput.current.click();
                  setAttachmentMenuOpen(false);
                }}><FileText aria-hidden="true" />{label}</Button>)}
            </PopoverContent>
          </Popover>
          <div className="ms-auto flex min-w-0 items-center gap-2">
            {cartographyLabel ? <Button nativeButton={false} variant="outline" size="xs" className="min-w-0 max-w-36"
              render={cartographyHref ? <a href={cartographyHref} /> : <span />} role={cartographyHref ? 'link' : undefined} title={cartographyLabel}>
              <BookOpen aria-hidden="true" /><span className="truncate">{cartographyLabel}</span>
            </Button> : null}
            {runtime && onRuntimeChange && 'updatedAt' in runtime
              ? <MapDesignRuntimeSwitcher agents={runtimeAgents} runtime={runtime as MapDesignConversationRuntimeChoice}
                  disabled={runtimeDisabled ?? (sending || disabled)} disabledReason={runtimeDisabledReason ?? disabledReason}
                  saving={runtimeSaving} notice={runtimeNotice} onChange={onRuntimeChange} />
              : <span className="text-xs text-muted-foreground" aria-live="polite">{runtime ? runtime.label ?? runtime.agentId : t('common.loading')}</span>}
            <div className="flex items-center gap-2" role="group" aria-label={t('mapDesign.composer.runActions')}>
              <Button shape="circle" size="icon-sm" variant={sending ? 'destructive' : 'default'}
                type={sending ? 'button' : 'submit'}
                aria-label={sending ? t('mapDesign.conversation.cancelRun') : t('mapDesign.composer.send')}
                aria-busy={sending && cancelPending}
                disabled={sending ? !onCancel || cancelPending : blocked || !hasContent || Boolean(error)}
                onClick={sending ? () => { void cancel(); } : undefined}>
                {sending ? <Square data-icon="inline-start" fill="currentColor" aria-hidden="true" /> : <ArrowUp data-icon="inline-start" aria-hidden="true" />}
              </Button>
            </div>
          </div>
    </div>
    {uploading ? <p role="status" className="text-xs text-muted-foreground">{filesCopy.uploading}</p> : null}
    {disabledReason ? <Alert variant="destructive" role="status"><AlertDescription>{disabledReason}</AlertDescription></Alert> : null}
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    {uploadError ? <span className="sr-only" role="status">{filesCopy[uploadError]}</span> : null}
  </form>;
}
