import { parseCartography } from '@mapseekai/cartography.md';
import type { CartographySampleBindings, CartographyStyleFile } from '@mapseekai/map-design-contracts';
import { invalidInput } from './errors.js';

export type CartographyLibrarySave = {
  readonly source: string;
  readonly description: string;
  readonly sourceFile?: CartographyStyleFile;
  readonly sampleBindings?: CartographySampleBindings;
  readonly targetId?: string;
} & ({ readonly mode: 'overwrite' } | { readonly mode: 'new'; readonly name: string });

export function renameCartographySource(source: string, name: string): string {
  const parsed = parseCartography(source);
  if (!parsed.config || !parsed.rawFrontmatter || typeof parsed.rawFrontmatter !== 'object' || Array.isArray(parsed.rawFrontmatter)) throw invalidInput();
  if (parsed.config.name === name) return source;
  // JSON is a YAML subset; parsing preserves quoted, multiline and flow-style names.
  return `---\n${JSON.stringify({ ...parsed.rawFrontmatter, name }, null, 2)}\n---\n${parsed.body}`;
}
