import { memo, useMemo, useState } from "react";
import { Button } from "@mapseekai/components";
import type { CartographyPreview } from "@mapseekai/map-design-contracts";
import { useI18n } from "../../i18n";
import { cartographyCopy } from "../../i18n/locales/cartography";
import { cartographyPreviewCopy } from "../../i18n/locales/cartography-preview";
import { renderMarkdown } from "../../runtime/markdown";

type Palette = Readonly<CartographyPreview["palette"]>;
const EMPTY_PALETTE: Palette = [];

export const CartographyDocumentPreview = memo(function CartographyDocumentPreview({ source, palette = EMPTY_PALETTE, initiallyOpen = true }: {
  readonly source: string;
  readonly palette?: Palette | undefined;
  readonly initiallyOpen?: boolean;
}) {
  const { locale } = useI18n();
  const [raw, setRaw] = useState(false);
  const [open, setOpen] = useState(initiallyOpen);
  const [hasOpened, setHasOpened] = useState(initiallyOpen);
  const copy = cartographyPreviewCopy[locale];
  const preview = cartographyCopy[locale].preview;
  function showDocument(asSource: boolean) {
    setRaw(asSource);
    setOpen(true);
    setHasOpened(true);
  }
  return <details open={open} onToggle={(event) => {
    const next = event.currentTarget.open;
    setOpen(next);
    if (next) setHasOpened(true);
  }} className="min-w-0 rounded-lg border border-border bg-card p-4">
    <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 text-sm">
      <span>{open ? "▾" : "▸"} CARTOGRAPHY.md</span>
      <span className="ml-auto flex flex-wrap gap-2">
      <Button type="button" variant={!raw ? "secondary" : "ghost"} aria-pressed={!raw} onClick={(event) => { event.preventDefault(); event.stopPropagation(); showDocument(false); }}>{preview}</Button>
      <Button type="button" variant={raw ? "secondary" : "ghost"} aria-pressed={raw} onClick={(event) => { event.preventDefault(); event.stopPropagation(); showDocument(true); }}>{copy.source}</Button>
      </span>
    </summary>
    {hasOpened ? <div className="pt-4">
      {raw ? <pre tabIndex={0} aria-label={copy.source} className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words text-sm">{source}</pre>
        : <FormattedDocument source={source} palette={palette} label={preview} emptyText={copy.noBody} />}
    </div> : null}
  </details>;
}, (previous, next) => {
  if (previous.source !== next.source || previous.initiallyOpen !== next.initiallyOpen) return false;
  const before = previous.palette ?? EMPTY_PALETTE;
  const after = next.palette ?? EMPTY_PALETTE;
  return before === after || (before.length === after.length && before.every((color, index) =>
    color.name === after[index]?.name && color.color === after[index]?.color));
});

const FormattedDocument = memo(function FormattedDocument({ source, palette, label, emptyText }: {
  readonly source: string; readonly palette: Palette; readonly label: string; readonly emptyText: string;
}) {
  const content = useMemo(() => {
    const body = source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
    const colors = new Map(palette.map(({ name, color }) => [name, color]));
    const resolved = body.replace(/\{colors\.([^{}\r\n]+)\}/g, (reference: string, name: string) => colors.get(name) ?? reference);
    const markdown = resolved.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, "[$1]($2)");
    return markdown ? renderMarkdown(markdown) : null;
  }, [source, palette]);
  return <div aria-label={label} className="min-w-0 break-words text-sm">{content ?? <p className="text-muted-foreground">{emptyText}</p>}</div>;
});
