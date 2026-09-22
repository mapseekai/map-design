import { describe, expect, it } from 'vitest';
import { mapModelContent } from '../../../src/map-design/tools/model-tool-content.js';

const summary = { status: 'invalid', errors: 1, warnings: 0, infos: 0, totalFindings: 1, returnedFindings: 1, omittedFindings: 0 };

describe('model map diagnostics', () => {
  it('preserves the revision and actionable validation location', () => {
    const output = { draftRevision: 4, styleHash: 'a'.repeat(64), validationDigest: 'b'.repeat(64), summary,
      findings: [{ severity: 'error', code: 'STYLE_INVALID', message: 'Line width must be a number.',
        scope: { kind: 'layer', id: 'roads' }, jsonPointer: '/layers/0/paint/line-width' }] };
    const result = JSON.parse(mapModelContent('map_validate', output).modelContent ?? 'null');
    expect(result).toMatchObject({ draftRevision: 4, summary, findings: output.findings, omittedFindings: 0 });
  });

  it('redacts secret-bearing diagnostic text without hiding the failure', () => {
    const output = { draftRevision: 4, styleHash: 'a'.repeat(64), validationDigest: 'b'.repeat(64), summary,
      findings: [{ severity: 'error', code: 'STYLE_INVALID', message: 'Failed https://private.test/?token=secret-value',
        scope: { kind: 'source', id: 'credential-sensitive-value' }, jsonPointer: '/sources/credential-sensitive-value' }] };
    const text = mapModelContent('map_validate', output).modelContent ?? '';
    expect(text).not.toMatch(/private\.test|secret-value|credential-sensitive-value/);
    expect(JSON.parse(text)).toMatchObject({ findings: [{ severity: 'error', code: 'STYLE_INVALID' }] });
  });

  it('bounds diagnostic output and reports omitted findings', () => {
    const findings = Array.from({ length: 100 }, (_, index) => ({ severity: 'error', code: 'STYLE_INVALID',
      message: `Invalid layer ${String(index).padStart(3, '0')}.`, scope: { kind: 'root' } }));
    const output = { draftRevision: 4, styleHash: 'a'.repeat(64), validationDigest: 'b'.repeat(64),
      summary: { ...summary, errors: 100, totalFindings: 100, returnedFindings: 100 }, findings };
    const text = mapModelContent('map_validate', output).modelContent ?? '';
    const result = JSON.parse(text);
    expect(result.findings.length).toBe(20);
    expect(result.omittedFindings).toBe(80);
    expect(result.summary).toMatchObject({ returnedFindings: 20, omittedFindings: 80, totalFindings: 100 });
    expect(Buffer.byteLength(text)).toBeLessThan(16_384);
  });
});
