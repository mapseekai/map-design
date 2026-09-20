import { consolidate, type Consolidated } from './consolidate.js';
import { emitDocument } from './emit.js';
import type { ExtractedStyle } from './ir.js';
import { renderReportJson, renderReportMarkdown } from './report.js';
import { verifyDocument } from './verify.js';

export interface InitResult {
  document: string;
  reportJson: string;
  reportMarkdown: string;
  ir: ExtractedStyle;
  consolidated: Consolidated;
}

export class VerificationError extends Error {
  constructor(errors: string[]) {
    super(`生成的 CARTOGRAPHY.md 未通过 lint:\n${errors.join('\n')}`);
    this.name = 'VerificationError';
  }
}

/** Consolidate extracted facts, emit the draft, and reject it unless the linter accepts it. */
export function initializeDocument(
  ir: ExtractedStyle,
  options: { name?: string; sourceFile: string },
): InitResult {
  const consolidated = consolidate(ir);
  const document = emitDocument(consolidated, ir, {
    name: options.name ?? 'Imported cartographic design',
    sourceFile: options.sourceFile,
  });
  const verification = verifyDocument(document, options.sourceFile);
  if (!verification.ok) throw new VerificationError(verification.errors);
  return {
    document,
    reportJson: renderReportJson(ir, consolidated, options.sourceFile),
    reportMarkdown: renderReportMarkdown(ir, consolidated, options.sourceFile),
    ir,
    consolidated,
  };
}
