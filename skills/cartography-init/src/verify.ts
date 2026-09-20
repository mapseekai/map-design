import { lint } from '@mapseekai/cartography.md';

/** Validate generated CARTOGRAPHY.md content before it is written to disk. */
export function verifyDocument(docText: string, sourcePath = 'CARTOGRAPHY.md'): { ok: boolean; errors: string[] } {
  const report = lint(docText, { sourcePath });
  const errors = report.findings
    .filter(finding => finding.severity === 'error')
    .map(finding => `${finding.ruleId}: ${finding.message}`);
  return { ok: report.valid && errors.length === 0, errors };
}
