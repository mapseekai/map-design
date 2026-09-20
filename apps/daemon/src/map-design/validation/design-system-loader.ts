import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { FORMAT_VERSION, lintCartography } from '@mapseekai/cartography.md';
import { CARTOGRAPHY_MAX_BYTES, CartographySourceSchema, MapIdentifierSchema, type MapValidationFinding } from '@mapseekai/map-design-contracts';

import { blake3Digest } from '../storage/canonical-json.js';
import type { LegacyMapDesignSystem } from './legacy-design-system.js';

export interface CartographyDesignSystem {
  format: 'cartography';
  id: string;
  digest: string;
  name: string;
  version: '0.4.0';
  source: string;
  documentFindings: MapValidationFinding[];
}

/** The legacy branch is read-only revision evidence, never a selectable preset. */
export type LoadedMapDesignSystem = CartographyDesignSystem | LegacyMapDesignSystem;

export interface LoadMapDesignSystemInput {
  projectRoot: string;
  designSystemId: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate the actual standard, not a private code block hidden in Markdown. */
export function parseCartographyDesignSystem(id: string, source: string): CartographyDesignSystem {
  MapIdentifierSchema.parse(id);
  if (!CartographySourceSchema.safeParse(source).success) throw new TypeError('Invalid CARTOGRAPHY.md size.');
  const report = lintCartography(source, { maxDocumentBytes: CARTOGRAPHY_MAX_BYTES });
  if (!report.valid || !report.cartography || report.cartography.version !== FORMAT_VERSION) {
    const codes = [...new Set(report.findings.filter((finding) => finding.severity === 'error').map((finding) => finding.ruleId))];
    throw new TypeError(`Invalid CARTOGRAPHY.md: ${codes.join(', ').slice(0, 512)}`);
  }
  if (report.cartography.name.length > 256) throw new TypeError('Invalid CARTOGRAPHY.md name.');
  return {
    format: 'cartography', id, source,
    digest: blake3Digest(new TextEncoder().encode(source)),
    name: report.cartography.name,
    version: report.cartography.version,
    // Informational authoring hints do not masquerade as map-output failures.
    documentFindings: report.findings.filter((finding) => finding.severity === 'warning').map((finding) => ({
      severity: 'warning', code: 'CARTOGRAPHY_DOCUMENT_WARNING',
      message: `${finding.ruleId}: ${finding.message}`.slice(0, 2048),
      scope: { kind: 'design-system', id },
    })),
  };
}

export async function loadMapDesignSystem(input: LoadMapDesignSystemInput): Promise<CartographyDesignSystem> {
  if (!SAFE_ID.test(input.designSystemId) || input.designSystemId === '.' || input.designSystemId === '..') {
    throw new TypeError('invalid design system id');
  }
  const root = path.resolve(input.projectRoot);
  const file = path.resolve(root, 'design-systems', input.designSystemId, 'CARTOGRAPHY.md');
  let source: string;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
    if (!realFile.startsWith(`${realRoot}${path.sep}`)) throw new TypeError('design system file is outside configured root');
    const handle = await open(realFile, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > CARTOGRAPHY_MAX_BYTES) throw new TypeError('Invalid CARTOGRAPHY.md size.');
      // Bound the read as well as stat, including files that grow concurrently.
      const bytes = Buffer.alloc(CARTOGRAPHY_MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > CARTOGRAPHY_MAX_BYTES) throw new TypeError('Invalid CARTOGRAPHY.md size.');
      source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof TypeError && /^(?:design system file|Invalid CARTOGRAPHY)/u.test(error.message)) throw error;
    throw new TypeError('could not read map design system');
  }
  return parseCartographyDesignSystem(input.designSystemId, source);
}
