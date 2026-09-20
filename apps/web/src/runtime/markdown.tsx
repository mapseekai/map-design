import { Badge, Button, Separator, cn } from '@mapseekai/components';
/**
 * A pocket-sized markdown renderer for assistant chat messages.
 *
 * We deliberately avoid a full parser library — chat output rarely uses
 * the long tail of markdown features and a hand-rolled walker keeps the
 * bundle slim. Block-level: ATX headings (# … ###), fenced code (```),
 * ordered (1.) and unordered (- / *) lists, GFM pipe tables, paragraphs,
 * blank-line separation. Inline: backtick code spans, **bold**,
 * *italic* / _italic_, and bare links (autolinked URLs).
 *
 * Output is a React fragment of typed elements — no dangerouslySetInnerHTML,
 * so untrusted text can't smuggle markup through.
 */
import { Fragment, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useT } from '../i18n';
import { copyToClipboard } from '../lib/copy-to-clipboard';
import { Check, ChevronDown, ChevronRight, Copy } from 'lucide-react';

export type MarkdownLinkClickHandler = (
  href: string,
  event: MouseEvent<HTMLAnchorElement>,
) => void;

export interface RenderMarkdownOptions {
  /**
   * Fired on every rendered `<a>` click before the default link
   * behavior. Callers that want to intercept (e.g. route in-project
   * file links to a workspace tab opener instead of letting Electron
   * open a new window) must call `event.preventDefault()` themselves.
   * Omitting the option keeps the previous default `target="_blank"`
   * behavior for every link.
   */
  onLinkClick?: MarkdownLinkClickHandler;
}

export function renderMarkdown(input: string, options?: RenderMarkdownOptions): ReactNode {
  const blocks = parseBlocks(input);
  return (
    <>
      {blocks.map((b, i) => renderBlock(b, i, options))}
    </>
  );
}

type TableAlign = 'left' | 'right' | 'center' | null;

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[]; start: number }
  | { kind: 'bq'; text: string }
  | { kind: 'code'; lang: string | null; body: string }
  | { kind: 'codeComment'; comment: CodeCommentDirective }
  | { kind: 'table'; aligns: TableAlign[]; headers: string[]; rows: string[][] }
  | { kind: 'hr' };

interface CodeCommentDirective {
  title: string;
  body: string;
  file: string;
  start?: number;
  end?: number;
  priority?: number;
}

function splitTableCells(line: string): string[] {
  // Walk char-by-char so we can respect three GFM cell-content rules without
  // any placeholder substitution:
  //   - `\|` resolves to a literal `|` inside the current cell.
  //   - A `|` inside a backtick code span is cell content, not a column
  //     boundary (handles cells like `` | status | `a | b` | ``).
  //   - A single optional leading `|` and unescaped trailing `|` are row
  //     terminators, not empty cells.
  // Placeholder-based escaping was rejected in review for two reasons: a
  // string sentinel can collide with real cell text, and an earlier draft
  // used NUL bytes which made the file render as binary on GitHub.
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (line[i] === '|') i++;
  for (; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '`') {
      inCode = !inCode;
      cur += ch;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  // A trailing unescaped `|` leaves `cur` empty — that's a row terminator,
  // not a final empty cell. Anything else (content after the last `|`, or a
  // row with no pipes at all) gets pushed.
  const tail = cur.trim();
  if (cells.length === 0 || tail !== '') cells.push(tail);
  return cells;
}

function parseTableAlignRow(line: string): TableAlign[] | null {
  if (!line.includes('|')) return null;
  const cells = splitTableCells(line);
  if (cells.length === 0) return null;
  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    if (!/^:?-{1,}:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

function isTableStartAt(lines: string[], i: number): boolean {
  const header = lines[i];
  const sep = lines[i + 1];
  if (header === undefined || sep === undefined) return false;
  if (!header.includes('|')) return false;
  return parseTableAlignRow(sep) !== null;
}

function parseBlocks(input: string): Block[] {
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }
    const codeComment = parseCodeCommentDirective(line);
    if (codeComment) {
      out.push({ kind: 'codeComment', comment: codeComment });
      i++;
      continue;
    }
    // Fenced code block.
    const fence = /^```(\w[\w+-]*)?\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? null;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        buf.push(lines[i] ?? '');
        i++;
      }
      // Skip the closing fence (if present).
      if (i < lines.length) i++;
      out.push({ kind: 'code', lang, body: buf.join('\n') });
      continue;
    }
    // ATX heading.
    const heading = /^(#{1,4})\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3 | 4;
      out.push({ kind: 'h', level, text: heading[2]! });
      i++;
      continue;
    }
    // Horizontal rule.
    if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      out.push({ kind: 'hr' });
      i++;
      continue;
    }
    // Blockquote. Group consecutive `>`-prefixed lines.
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? '')) {
        buf.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push({ kind: 'bq', text: buf.join('\n') });
      continue;
    }
    // Unordered list. Group consecutive items.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push({ kind: 'ul', items });
      continue;
    }
    // GFM pipe table: header row + alignment row + body rows.
    if (isTableStartAt(lines, i)) {
      const header = lines[i] as string;
      const sep = lines[i + 1] as string;
      const aligns = parseTableAlignRow(sep) as TableAlign[];
      const headers = splitTableCells(header);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length) {
        const row = lines[i];
        if (row === undefined || row.trim() === '' || !row.includes('|')) break;
        rows.push(splitTableCells(row));
        i++;
      }
      out.push({ kind: 'table', aligns, headers, rows });
      continue;
    }
    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const firstNumber = Number(/^\s*(\d+)\./.exec(line)![1]);
      const start = Number.isSafeInteger(firstNumber) ? firstNumber : 1;
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push({ kind: 'ol', items, start });
      continue;
    }
    // Paragraph: greedy until a blank line or another block-starter.
    const buf: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (next.trim() === '') break;
      if (/^```/.test(next)) break;
      if (/^#{1,4}\s+/.test(next)) break;
      if (/^\s*[-*+]\s+/.test(next)) break;
      if (/^\s*\d+\.\s+/.test(next)) break;
      if (/^\s*>\s?/.test(next)) break;
      if (parseCodeCommentDirective(next)) break;
      if (isTableStartAt(lines, i)) break;
      buf.push(next);
      i++;
    }
    out.push({ kind: 'p', text: buf.join('\n') });
  }
  return out;
}

function renderBlock(block: Block, key: number, options?: RenderMarkdownOptions): ReactNode {
  if (block.kind === 'p') {
    return <p key={key} data-ui="md-p" className="my-3 break-words text-sm leading-relaxed">{renderInline(block.text, options)}</p>;
  }
  if (block.kind === 'h') {
    const Tag = (`h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4');
    return <Tag key={key} className={cn("mb-3 mt-5 font-medium leading-snug", { 1: "text-2xl", 2: "text-xl", 3: "text-lg", 4: "text-base" }[block.level])}>{renderInline(block.text, options)}</Tag>;
  }
  if (block.kind === 'ul') {
    const hasTask = block.items.some((it) => /^\[[ xX]\]\s+/.test(it));
    return (
      <ul key={key} className={cn("my-3 flex flex-col gap-1 text-sm leading-relaxed", hasTask ? "list-none" : "list-disc pl-6")}>
        {block.items.map((item, i) => {
          const task = /^\[([ xX])\]\s+(.*)$/.exec(item);
          if (task) {
            const checked = task[1] !== ' ';
            return (
              <li key={i} data-ui="md-task-item" className="flex items-start gap-2" data-checked={checked ? 'true' : 'false'}>
                <span data-ui="md-task-check" className="mt-1 grid size-3.5 shrink-0 place-items-center rounded-sm border border-primary" aria-hidden>
                  {checked ? <Check size={11} /> : null}
                </span>
                <span>{renderInline(task[2] ?? '', options)}</span>
              </li>
            );
          }
          return <li key={i}>{renderInline(item, options)}</li>;
        })}
      </ul>
    );
  }
  if (block.kind === 'ol') {
    return (
      <ol key={key} start={block.start === 1 ? undefined : block.start} data-ui="md-ol" className="my-3 flex list-decimal flex-col gap-1 pl-6 text-sm leading-relaxed">
        {block.items.map((item, i) => (
          <li key={i}>{renderInline(item, options)}</li>
        ))}
      </ol>
    );
  }
  if (block.kind === 'bq') {
    return (
      <blockquote key={key} data-ui="md-quote" className="my-3 border-l-2 border-primary pl-4 text-sm leading-relaxed text-muted-foreground">
        {renderInline(block.text, options)}
      </blockquote>
    );
  }
  if (block.kind === 'code') {
    return (
      <MarkdownCodeBlock
        key={key}
        body={block.body}
        lang={block.lang}
      />
    );
  }
  if (block.kind === 'codeComment') {
    return <CodeCommentBlock key={key} comment={block.comment} />;
  }
  if (block.kind === 'table') {
    const { aligns, headers, rows } = block;
    const cellStyle = (idx: number): { textAlign: 'left' | 'right' | 'center' } | undefined => {
      const a = aligns[idx];
      return a ? { textAlign: a } : undefined;
    };
    return (
      <div key={key} data-ui="md-table-wrap" className="my-4 max-w-full overflow-x-auto rounded-lg border">
        <table data-ui="md-table" className="w-full border-collapse text-sm [&_th]:border-b [&_th]:bg-muted [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium [&_td]:border-b [&_td]:px-3 [&_td]:py-2 [&_tbody_tr:last-child_td]:border-b-0">
          <thead>
            <tr>
              {headers.map((cell, idx) => (
                <th key={idx} style={cellStyle(idx)}>{renderInline(cell, options)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rIdx) => (
              <tr key={rIdx}>
                {headers.map((_, cIdx) => (
                  <td key={cIdx} style={cellStyle(cIdx)}>{renderInline(row[cIdx] ?? '', options)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.kind === 'hr') {
    return <Separator key={key} className="my-4" />;
  }
  return null;
}

function parseCodeCommentDirective(line: string): CodeCommentDirective | null {
  const match = /^\s*::code-comment\{([\s\S]*)\}\s*$/.exec(line);
  if (!match) return null;
  const attrs = parseDirectiveAttributes(match[1] ?? '');
  const body = attrs.get('body')?.trim() ?? '';
  const file = attrs.get('file')?.trim() ?? '';
  if (!body || !file) return null;
  const title = attrs.get('title')?.trim() || 'Code comment';
  const start = parsePositiveInt(attrs.get('start'));
  const end = parsePositiveInt(attrs.get('end'));
  const priority = parsePositiveInt(attrs.get('priority'));
  return {
    title,
    body,
    file,
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    ...(priority === undefined ? {} : { priority }),
  };
}

function parseDirectiveAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const attrRe = /([A-Za-z_][\w-]*)\s*=\s*("([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|[^\s}]+)/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(raw))) {
    const key = match[1]!;
    const quoted = match[3] ?? match[4];
    const value = quoted ?? match[2] ?? '';
    attrs.set(key, unescapeDirectiveValue(value.replace(/^['"]|['"]$/g, '')));
  }
  return attrs;
}

function unescapeDirectiveValue(value: string): string {
  return value.replace(/\\(["'\\])/g, '$1');
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function CodeCommentBlock({ comment }: { comment: CodeCommentDirective }) {
  const location = codeCommentLocation(comment);
  return (
    <article data-ui="md-code-comment" className="my-3 flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm text-card-foreground" data-priority={comment.priority ?? undefined}>
      <div data-ui="md-code-comment-head" className="flex items-center gap-2">
        <span data-ui="md-code-comment-icon" className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden>!</span>
        <strong>{renderInline(comment.title)}</strong>
        {comment.priority ? (
          <Badge variant="outline">P{comment.priority}</Badge>
        ) : null}
      </div>
      <p data-ui="md-code-comment-body" className="m-0 leading-relaxed">{renderInline(comment.body)}</p>
      <code data-ui="md-code-comment-file" className="break-all font-mono text-xs text-muted-foreground">{location}</code>
    </article>
  );
}

function codeCommentLocation(comment: CodeCommentDirective): string {
  if (!comment.start) return comment.file;
  if (comment.end && comment.end !== comment.start) {
    return `${comment.file}:${comment.start}-${comment.end}`;
  }
  return `${comment.file}:${comment.start}`;
}

// Long blocks past this many lines start collapsed, matching Lobe's
// "fold tall code" affordance so a single dump can't swallow the viewport.
const CODE_COLLAPSE_LINE_THRESHOLD = 16;

function MarkdownCodeBlock({ body, lang }: { body: string; lang: string | null }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const resetTimerRef = useRef<number | null>(null);
  const copyLabel = copied ? t('chat.fileViewer.copied') : t('chat.fileViewer.copy');

  const lineCount = body.split('\n').length;
  const collapsible = lineCount > CODE_COLLAPSE_LINE_THRESHOLD;
  const [collapsed, setCollapsed] = useState(collapsible);

  useEffect(() => () => {
    if (resetTimerRef.current != null) window.clearTimeout(resetTimerRef.current);
  }, []);

  useEffect(() => {
    if (!lang) return;
    let cancelled = false;
    import('./shiki').then(({ highlightCode }) =>
      highlightCode(body, lang).then((html) => {
        if (!cancelled && html) setHighlightedHtml(html);
      }),
    ).catch(() => {});
    return () => { cancelled = true; };
  }, [body, lang]);

  async function handleCopy() {
    const ok = await copyToClipboard(body);
    if (!ok) return;
    setCopied(true);
    if (resetTimerRef.current != null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      resetTimerRef.current = null;
    }, 1600);
  }

  return (
    <div data-ui="md-code-block" className="group/code my-3 overflow-hidden rounded-lg border bg-muted/40" data-collapsed={collapsed ? 'true' : undefined}>
      <div data-ui="md-code-header" className="flex items-center justify-between gap-2 border-b bg-muted px-3 py-1">
        <span data-ui="md-code-lang" className="font-mono text-xs text-muted-foreground">{lang || 'text'}</span>
        <div data-ui="md-code-actions" className="flex items-center gap-1">
          {collapsible ? (
            <Button variant="ghost"
              type="button"
              size="icon-sm"
              onClick={() => setCollapsed((c) => !c)}
              aria-expanded={!collapsed}
              aria-label={collapsed ? t('chat.designFiles.expandGroup') : t('chat.designFiles.collapseGroup')}
              title={collapsed ? t('chat.designFiles.expandGroup') : t('chat.designFiles.collapseGroup')}
            >
              {collapsed ? <ChevronRight data-icon="inline-start" /> : <ChevronDown data-icon="inline-start" />}
            </Button>
          ) : null}
          <Button variant="ghost"
            type="button"
            size="sm"
            onClick={() => { void handleCopy(); }}
            aria-label={copyLabel}
            title={copyLabel}
          >
            {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            <span>{copyLabel}</span>
          </Button>
        </div>
      </div>
      <div data-ui="md-code-body" className="overflow-auto group-data-[collapsed=true]/code:max-h-48">
        {highlightedHtml ? (
          <div
            data-ui="md-code" className="overflow-x-auto text-xs leading-relaxed [&_pre]:m-0 [&_pre]:p-3 [&_code]:font-mono"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <pre data-ui="md-code" className="m-0 overflow-x-auto p-3 font-mono text-xs leading-relaxed">
            <code data-lang={lang ?? undefined}>{body}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

// Allowed schemes / forms for image `src` attributes. The BYOK chat
// tool loop emits relative URLs like `/api/byok-image/<id>.png` which
// the web's Next.js rewrites proxy to the daemon — that's the common
// case. data: + blob: cover inline / generated images. http(s):// is
// allowed so a model can reference public images. Anything else
// (javascript:, file:, vbscript:, …) is rejected so a hallucinated
// or adversarial URL cannot exfiltrate or execute.
function isSafeMarkdownImageSrc(src: string): boolean {
  if (!src) return false;
  if (src.startsWith('/') && !src.startsWith('//')) return true;
  return (
    src.startsWith('http://')
    || src.startsWith('https://')
    || src.startsWith('data:image/')
    || src.startsWith('blob:')
  );
}

const INLINE_CODE_HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PROSE_HEX_COLOR_RE = /(^|[^\w#])(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}))(?![\w-])/g;

function isInlineCodeHexColor(value: string): boolean {
  return INLINE_CODE_HEX_COLOR_RE.test(value);
}

function ColorSwatch({ color }: { color: string }) {
  return (
    <span
      data-ui="md-color-swatch" className="inline-block size-3 shrink-0 rounded-sm border border-foreground/20 align-middle"
      aria-hidden="true"
      style={{ backgroundColor: color }}
    />
  );
}

function renderInlineCodeSpan(value: string, key: number): ReactNode {
  if (!isInlineCodeHexColor(value)) {
    return (
      <code key={key} data-ui="md-inline-code" className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
        {value}
      </code>
    );
  }
  return (
    <code key={key} data-ui="md-inline-code" className="inline-flex items-center gap-1 rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
      <ColorSwatch color={value} />
      {value}
    </code>
  );
}

function renderColorToken(value: string, key: string): ReactNode {
  return (
    <span key={key} data-ui="md-color-token" className="inline-flex items-center gap-1 whitespace-nowrap">
      <ColorSwatch color={value} />
      {value}
    </span>
  );
}

// Inline pass: tokenize into runs of `code`, **bold**, *italic*, links,
// and plain text. We walk the string with a regex that matches whichever
// delimiter shows up next; everything between delimiters becomes a text
// span (which itself still gets autolink scanning).
function renderInline(text: string, options?: RenderMarkdownOptions): ReactNode {
  const out: ReactNode[] = [];
  const onLinkClick = options?.onLinkClick;
  const linkClickHandler = onLinkClick
    ? (href: string) => (event: MouseEvent<HTMLAnchorElement>) => onLinkClick(href, event)
    : undefined;
  // Order matters:
  //  1. inline code first so its contents are not re-tokenized as bold/italic.
  //  2. image syntax `![alt](url)` BEFORE the link branch. Both share
  //     `[…](…)` and the image is only distinguished by the leading `!`;
  //     letting the link branch win would render `[alt](url)` as a text
  //     link with `!` stranded as a sibling text node and the user would
  //     see the link copy but never the image.
  //  3. explicit `[text](url)` markdown links before bare URL autolink so the
  //     autolink does not greedily swallow the closing paren.
  //  4. bare http(s) URL autolink BEFORE italic markers — chat output often
  //     contains OAuth-style links with `_type=` / `_id=` query params, and
  //     leaving italic to win turns the URL into an italic-fragmented mess.
  //  5. bold (**a** / __a__) before italic (*a* / _a_).
  const re =
    /(`[^`]+`)|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)<>]+)|(\*\*[^*]+\*\*)|(?<![\p{L}\p{N}_])(__[^_]+__)(?![\p{L}\p{N}_])|(\*[^*\n]+\*)|(?<![\p{L}\p{N}_])(_[^_\n]+_)(?![\p{L}\p{N}_])/gu;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > lastIndex) {
      pushText(out, text.slice(lastIndex, m.index), key++, options);
    }
    if (m[1]) {
      out.push(renderInlineCodeSpan(m[1].slice(1, -1), key++));
    } else if (m[3] !== undefined) {
      // Image: m[2] = alt (may be empty), m[3] = src
      const src = m[3];
      const alt = m[2] || '';
      if (isSafeMarkdownImageSrc(src)) {
        out.push(
          <img
            key={key++}
            data-ui="md-image" className="my-2 max-h-96 max-w-full rounded-lg object-contain"
            src={src}
            alt={alt}
            loading="lazy"
            referrerPolicy="no-referrer"
            style={{ maxWidth: '100%', height: 'auto', borderRadius: 6 }}
          />,
        );
      } else {
        // Unsafe scheme — drop the image tag but keep the alt text so
        // the user sees what the model meant to show.
        pushText(out, alt, key++, options);
      }
    } else if (m[4] && m[5]) {
      const href = m[5];
      out.push(
        <a
          key={key++}
          data-ui="md-link" className="break-words text-primary underline underline-offset-2"
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          onClick={linkClickHandler?.(href)}
        >
          {m[4]}
        </a>,
      );
    } else if (m[6]) {
      // Bare URL — autolink with the URL as both href and visible text,
      // matching the Markdown `<https://…>` autolink convention.
      const [href, suffix] = splitTrailingAutolinkPunctuation(m[6]);
      out.push(
        <a
          key={key++}
          data-ui="md-link" className="break-all text-primary underline underline-offset-2"
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          onClick={linkClickHandler?.(href)}
        >
          {href}
        </a>,
      );
      if (suffix) pushText(out, suffix, key++);
    } else if (m[7]) {
      out.push(<strong key={key++}>{m[7].slice(2, -2)}</strong>);
    } else if (m[8]) {
      out.push(<strong key={key++}>{m[8].slice(2, -2)}</strong>);
    } else if (m[9]) {
      out.push(<em key={key++}>{m[9].slice(1, -1)}</em>);
    } else if (m[10]) {
      out.push(<em key={key++}>{m[10].slice(1, -1)}</em>);
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    pushText(out, text.slice(lastIndex), key++, options);
  }
  return <Fragment>{out}</Fragment>;
}

// Walk a plain text run, autolinking bare URLs and preserving the rest as
// text nodes. Newlines inside a paragraph become explicit <br />s — the
// upstream parser has already left them in place because chat output
// often relies on hard line breaks rather than blank-line separation.
function pushText(out: ReactNode[], text: string, baseKey: number, options?: RenderMarkdownOptions): void {
  if (!text) return;
  const onLinkClick = options?.onLinkClick;
  const urlRe = /(https?:\/\/[^\s)]+)/g;
  const segments: ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = urlRe.exec(text))) {
    if (m.index > lastIndex) {
      segments.push(...withBreaksAndColorSwatches(text.slice(lastIndex, m.index), `${baseKey}-${k++}`));
    }
    const [href, suffix] = splitTrailingAutolinkPunctuation(m[1]!);
    segments.push(
      <a
        key={`${baseKey}-${k++}`}
        data-ui="md-link" className="break-words text-primary underline underline-offset-2"
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        onClick={onLinkClick ? (event) => onLinkClick(href, event) : undefined}
      >
        {href}
      </a>,
    );
    if (suffix) {
      segments.push(...withBreaksAndColorSwatches(suffix, `${baseKey}-${k++}`));
    }
    lastIndex = urlRe.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push(...withBreaksAndColorSwatches(text.slice(lastIndex), `${baseKey}-${k++}`));
  }
  out.push(<Fragment key={baseKey}>{segments}</Fragment>);
}

function splitTrailingAutolinkPunctuation(url: string): [string, string] {
  const match = /([.,!?;:，。！？；：、'"」』】》〉）]+)$/.exec(url);
  if (!match || !match[1]) return [url, ''];
  const trimmed = url.slice(0, -match[1].length);
  return trimmed ? [trimmed, match[1]] : [url, ''];
}

function withBreaksAndColorSwatches(text: string, baseKey: string): ReactNode[] {
  const parts = text.split('\n');
  const out: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (i > 0) out.push(<br key={`${baseKey}-br-${i}`} />);
    if (part) out.push(...withProseColorSwatches(part, `${baseKey}-t-${i}`));
  });
  return out;
}

function withProseColorSwatches(text: string, baseKey: string): ReactNode[] {
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  PROSE_HEX_COLOR_RE.lastIndex = 0;
  while ((match = PROSE_HEX_COLOR_RE.exec(text))) {
    const prefix = match[1] ?? '';
    const color = match[2] ?? '';
    const colorIndex = match.index + prefix.length;
    if (colorIndex > lastIndex) {
      out.push(<Fragment key={`${baseKey}-${key++}`}>{text.slice(lastIndex, colorIndex)}</Fragment>);
    }
    out.push(renderColorToken(color, `${baseKey}-${key++}`));
    lastIndex = colorIndex + color.length;
  }
  if (lastIndex < text.length) {
    out.push(<Fragment key={`${baseKey}-${key++}`}>{text.slice(lastIndex)}</Fragment>);
  }
  return out;
}
