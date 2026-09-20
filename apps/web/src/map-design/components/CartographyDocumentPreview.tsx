import { useState } from 'react';
import { Button } from '@mapseekai/components';
import { useI18n } from '../../i18n';
import { cartographyCopy } from '../../i18n/locales/cartography';
import { cartographyPreviewCopy } from '../../i18n/locales/cartography-preview';
import { renderMarkdown } from '../../runtime/markdown';

export function CartographyDocumentPreview({ source, initiallyOpen = true }: { source: string; initiallyOpen?: boolean }) {
  const { locale } = useI18n();
  const [raw, setRaw] = useState(false);
  const [open, setOpen] = useState(initiallyOpen);
  const copy = cartographyPreviewCopy[locale];
  const preview = cartographyCopy[locale].preview;
  const body = source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
  // Keep external/local images as explicit links; opening a document must not fetch them.
  const markdown = body.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '[$1]($2)');
  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="min-w-0 rounded-lg border border-border bg-card p-4">
    <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 text-sm">
      <span>{open ? '▾' : '▸'} CARTOGRAPHY.md</span>
      <span className="ml-auto flex flex-wrap gap-2">
      <Button type="button" variant={!raw ? 'secondary' : 'ghost'} aria-pressed={!raw} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setRaw(false); setOpen(true); }}>{preview}</Button>
      <Button type="button" variant={raw ? 'secondary' : 'ghost'} aria-pressed={raw} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setRaw(true); setOpen(true); }}>{copy.source}</Button>
      </span>
    </summary>
    <div className="pt-4">
    {raw ? <pre tabIndex={0} aria-label={copy.source} className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words text-sm">{source}</pre>
      : <div aria-label={preview} className="min-w-0 break-words text-sm">{markdown ? renderMarkdown(markdown) : <p className="text-muted-foreground">{copy.noBody}</p>}</div>}
    </div>
  </details>;
}
