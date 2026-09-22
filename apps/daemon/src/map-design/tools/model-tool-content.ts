import {
  MapApplyTransactionOutputSchema, MapGetContextOutputSchema, MapInspectOutputSchema,
  MapSearchLayersOutputSchema, MapValidateOutputSchema, MapUpdateSemanticsOutputSchema,
  type MapValidationFinding, type MapToolName,
} from '@mapseekai/map-design-contracts';
import { containsSensitivePublicText } from './safe-tool-summary.js';

const DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_FINDINGS = 20;

export function compactMapContext(output: unknown): Record<string, unknown> {
  const value = MapGetContextOutputSchema.parse(output);
  const { cartographicGuidance, ...context } = value;
  return { ...context, guidanceLineCount: cartographicGuidance.length };
}

export function mapPromptContext(output: unknown): string {
  const parsed = MapGetContextOutputSchema.safeParse(output);
  const serialized = JSON.stringify(parsed.success ? compactMapContext(parsed.data) : output);
  return typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') <= 8_192
    ? serialized : '{"unavailable":true}';
}

export function mapModelContent(name: MapToolName, output: unknown): { modelContent?: string } {
  switch (name) {
    case 'map_get_context':
      return { modelContent: JSON.stringify(compactMapContext(output)) };
    case 'map_inspect':
      return { modelContent: JSON.stringify(MapInspectOutputSchema.parse(output)) };
    case 'map_search_layers':
      return { modelContent: JSON.stringify(MapSearchLayersOutputSchema.parse(output)) };
    case 'map_validate': {
      const value = MapValidateOutputSchema.parse(output);
      const findings: ReturnType<typeof modelFinding>[] = [];
      const result = { draftRevision: value.draftRevision, styleHash: value.styleHash,
        validationDigest: value.validationDigest, summary: value.summary, findings,
        omittedFindings: value.summary.totalFindings };
      for (const finding of value.findings.slice(0, MAX_FINDINGS)) {
        const projected = modelFinding(finding);
        if (Buffer.byteLength(JSON.stringify({ ...result, findings: [...findings, projected] })) > DIAGNOSTIC_BYTES) break;
        findings.push(projected);
      }
      result.omittedFindings -= findings.length;
      result.summary = { ...value.summary, returnedFindings: findings.length,
        omittedFindings: result.omittedFindings };
      return { modelContent: JSON.stringify(result) };
    }
    case 'map_apply_transaction': {
      const value = MapApplyTransactionOutputSchema.parse(output);
      return { modelContent: JSON.stringify({ draftRevision: value.draftRevision, styleHash: value.styleHash,
        changedLayers: value.changedLayers.slice(0, 100), changedSources: value.changedSources.slice(0, 100),
        omittedChangedLayers: Math.max(0, value.changedLayers.length - 100),
        omittedChangedSources: Math.max(0, value.changedSources.length - 100),
        validationSummary: value.validationSummary,
        warnings: value.warnings.slice(0, MAX_FINDINGS).map((warning) => ({ code: safeText(warning.code),
          message: safeText(warning.message), ...(safePointer(warning.jsonPointer) ? { jsonPointer: warning.jsonPointer } : {}) })),
        omittedWarnings: Math.max(0, value.warnings.length - MAX_FINDINGS) }) };
    }
    case 'map_update_semantics':
      return { modelContent: JSON.stringify(MapUpdateSemanticsOutputSchema.parse(output)) };
    case 'map_render_preview':
    case 'map_commit_revision':
    case 'map_discard_draft':
      return {};
    default:
      return assertNever(name);
  }
}

function modelFinding(finding: MapValidationFinding) {
  const safeScope = Object.values(finding.scope).every((value) => !containsSensitivePublicText(value));
  return { severity: finding.severity, code: safeText(finding.code), message: safeText(finding.message),
    scope: safeScope ? finding.scope : { kind: 'root' as const },
    ...(safePointer(finding.jsonPointer) ? { jsonPointer: finding.jsonPointer } : {}) };
}

function safeText(value: string): string {
  return containsSensitivePublicText(value) ? 'Details redacted.' : value.slice(0, 384);
}

function safePointer(value: string | undefined): boolean {
  return value !== undefined && /^\/(?:layers|sources|groups|rules)(?:\/[A-Za-z0-9_~.-]+)*$/u.test(value)
    && value.split('/').every((part) => !containsSensitivePublicText(part));
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected map tool: ${String(value)}`);
}
