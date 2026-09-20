type EventSink = (event: { type: 'text_delta'; delta: string }) => void;

export interface ArtifactTextSuppressor {
  strip(text: string): string;
  flush(): string;
  isSuppressing(): boolean;
  hasPendingCandidate(): boolean;
  stats(): ArtifactTextSuppressorStats;
}

export interface ArtifactTextSuppressorStats {
  suppressedChars: number;
  suppressedChunks: number;
  openedBlocks: number;
  closedBlocks: number;
  pendingCandidateChars: number;
  suppressing: boolean;
}

const MAX_CANDIDATE_LENGTH = 512;

export function createDsmlArtifactTextSuppressor(): ArtifactTextSuppressor {
  return createTaggedTextSuppressor(
    /(?:<\s*\|?\s*DSML[\s,]+artifact\b[^>]*>|<\s*artifact\b[^>]*>)/i,
    /(?:<\/artifact>|<\/\s*\|?\s*DSML\s*>|<\s*\|?\s*\/\s*DSML\s*\|?\s*>)/i,
    isPossibleDsmlArtifactPrefix,
    isPossibleDsmlArtifactClosePrefix,
  );
}

export function createToolCallTextSuppressor(): ArtifactTextSuppressor {
  return createTaggedTextSuppressor(
    /(?:<\s*tool_call\b[^>]*>|<\s*edit\s*>)/i,
    /(?:<\/\s*tool_call\s*>|<\/\s*edit\s*>)/i,
    isPossibleToolCallPrefix,
    isPossibleToolCallClosePrefix,
  );
}

function createTaggedTextSuppressor(
  openRe: RegExp,
  closeRe: RegExp,
  isPossibleOpenPrefix: (value: string) => boolean,
  isPossibleClosePrefix: (value: string) => boolean,
): ArtifactTextSuppressor {
  let suppressing = false;
  let candidate = '';
  let suppressedChars = 0;
  let suppressedChunks = 0;
  let openedBlocks = 0;
  let closedBlocks = 0;
  const suppress = (value: string) => {
    if (value.length > 0) {
      suppressedChars += value.length;
      suppressedChunks += 1;
    }
  };
  const strip = (text: string): string => {
    const current = candidate + text;
    candidate = '';
    if (suppressing) {
      const close = closeRe.exec(current);
      if (!close || close.index === undefined) {
        const possible = possibleTagStart(current, isPossibleClosePrefix);
        if (possible !== -1) {
          candidate = current.slice(possible);
          suppress(current.slice(0, possible));
        } else {
          suppress(current);
        }
        return '';
      }
      suppressing = false;
      closedBlocks += 1;
      const end = close.index + close[0].length;
      suppress(current.slice(0, end));
      return strip(current.slice(end));
    }
    const open = openRe.exec(current);
    if (open && open.index !== undefined) {
      suppressing = true;
      openedBlocks += 1;
      suppress(open[0]);
      return current.slice(0, open.index) + strip(current.slice(open.index + open[0].length));
    }
    const possible = possibleTagStart(current, isPossibleOpenPrefix);
    if (possible !== -1) {
      candidate = current.slice(possible);
      return current.slice(0, possible);
    }
    return current;
  };
  return {
    strip,
    flush: () => {
      const text = candidate;
      candidate = '';
      return suppressing ? '' : text;
    },
    isSuppressing: () => suppressing,
    hasPendingCandidate: () => candidate.length > 0,
    stats: () => ({ suppressedChars, suppressedChunks, openedBlocks, closedBlocks, pendingCandidateChars: candidate.length, suppressing }),
  };
}

function possibleTagStart(value: string, isPossiblePrefix: (candidate: string) => boolean): number {
  const min = Math.max(0, value.length - MAX_CANDIDATE_LENGTH);
  let start = value.lastIndexOf('<');
  while (start >= min) {
    if (isPossiblePrefix(value.slice(start))) return start;
    if (start === 0) break;
    start = value.lastIndexOf('<', start - 1);
  }
  return -1;
}

function isPossibleDsmlArtifactPrefix(value: string): boolean {
  return isPossibleNamedTagPrefix(value, 'artifact', true)
    || isPossibleDsmlPrefix(value);
}

function isPossibleDsmlPrefix(value: string): boolean {
  const match = /^<\s*\|?\s*([a-z]*)([\s\S]*)$/i.exec(value);
  if (!match) return false;
  const name = match[1] ?? '';
  const rest = match[2] ?? '';
  const lowerName = name.toLowerCase();
  if (!'dsml'.startsWith(lowerName)) return false;
  if (lowerName !== 'dsml') return rest.length === 0;
  if (rest.length === 0) return true;

  const artifact = /^[\s,]+([a-z]*)([\s\S]*)$/i.exec(rest);
  if (!artifact) return false;
  const artifactName = artifact[1] ?? '';
  const artifactRest = artifact[2] ?? '';
  const lowerArtifactName = artifactName.toLowerCase();
  if (!'artifact'.startsWith(lowerArtifactName)) return false;
  return lowerArtifactName !== 'artifact'
    ? artifactRest.length === 0
    : artifactRest.length === 0 || /^\s[\s\S]*$/.test(artifactRest);
}

function isPossibleDsmlArtifactClosePrefix(value: string): boolean {
  return isPossibleNamedClosePrefix(value, 'artifact')
    || isPossibleNamedClosePrefix(value, 'dsml', true);
}

function isPossibleToolCallPrefix(value: string): boolean {
  return isPossibleNamedTagPrefix(value, 'tool_call', true)
    || isPossibleNamedTagPrefix(value, 'edit', false, true);
}

function isPossibleToolCallClosePrefix(value: string): boolean {
  return isPossibleNamedClosePrefix(value, 'tool_call')
    || isPossibleNamedClosePrefix(value, 'edit');
}

function isPossibleNamedTagPrefix(
  value: string,
  tag: string,
  allowsAttributes: boolean,
  allowsTrailingWhitespace = false,
): boolean {
  const match = /^<\s*([a-z_]*)([\s\S]*)$/i.exec(value);
  if (!match) return false;
  const name = match[1] ?? '';
  const rest = match[2] ?? '';
  const lowerName = name.toLowerCase();
  if (!tag.startsWith(lowerName)) return false;
  if (lowerName !== tag) return rest.length === 0;
  return rest.length === 0
    || (allowsAttributes && /^\s[\s\S]*$/.test(rest))
    || (allowsTrailingWhitespace && /^\s*$/.test(rest));
}

function isPossibleNamedClosePrefix(value: string, tag: string, allowsPipe = false): boolean {
  if (value === '<') return true;
  const prefix = allowsPipe ? '^<\\s*\\|?\\s*\\/\\s*' : '^<\\s*\\/\\s*';
  const match = new RegExp(`${prefix}([a-z_]*)([\\s\\S]*)$`, 'i').exec(value);
  if (!match) return false;
  const name = match[1] ?? '';
  const rest = match[2] ?? '';
  const lowerName = name.toLowerCase();
  return tag.startsWith(lowerName)
    && (lowerName !== tag ? rest.length === 0 : /^\s*\|?\s*$/.test(rest));
}

export function emitWithTextSuppressor(suppressor: ArtifactTextSuppressor, onEvent: EventSink, text: string): boolean {
  const delta = suppressor.strip(text);
  if (!delta) return false;
  onEvent({ type: 'text_delta', delta });
  return true;
}
