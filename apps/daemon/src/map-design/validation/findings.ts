import type { MapValidationFinding, MapValidationSummary } from '@mapseekai/map-design-contracts';

const MAX_FINDINGS = 500;
const severityRank = { error: 0, warning: 1, info: 2 } as const;

function scopeSortKey(scope: MapValidationFinding['scope']): string {
  if ('id' in scope) return scope.id;
  if ('sourceId' in scope) return `${scope.sourceId}/${scope.sourceLayer}`;
  return '';
}

export function compareFindings(left: MapValidationFinding, right: MapValidationFinding): number {
  return compareCodeUnits(findingSortKey(left), findingSortKey(right))
    || compareCodeUnits(left.jsonPointer ?? '', right.jsonPointer ?? '');
}

function findingSortKey(finding: MapValidationFinding): string {
  return `${severityRank[finding.severity]}\u0000${finding.code}\u0000${finding.scope.kind}\u0000${scopeSortKey(finding.scope)}\u0000${finding.message}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function summarizeFindings(input: readonly MapValidationFinding[]): {
  findings: MapValidationFinding[];
  summary: MapValidationSummary;
} {
  const findings = [...input].sort(compareFindings);
  const errors = findings.filter((finding) => finding.severity === 'error').length;
  const warnings = findings.filter((finding) => finding.severity === 'warning').length;
  const infos = findings.length - errors - warnings;
  const returned = findings.slice(0, MAX_FINDINGS);
  return {
    findings: returned,
    summary: {
      status: errors > 0 ? 'invalid' : 'valid',
      errors,
      warnings,
      infos,
      totalFindings: findings.length,
      returnedFindings: returned.length,
      omittedFindings: findings.length - returned.length,
    },
  };
}
