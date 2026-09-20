import type { SafeToolSummary } from '@mapseekai/contracts';
import {
  MapApplyTransactionInputSchema,
  MapApplyTransactionOutputSchema,
  MapCommitRevisionOutputSchema,
  MapDiscardDraftOutputSchema,
  MapGetContextOutputSchema,
  MapInspectOutputSchema,
  MapRenderPreviewOutputSchema,
  MapSearchLayersOutputSchema,
  MapUpdateSemanticsInputSchema,
  MapUpdateSemanticsOutputSchema,
  MapValidateOutputSchema,
  type MapToolName,
} from '@mapseekai/map-design-contracts';

const MAX_SUMMARY_STRING_CODE_POINTS = 2_048;
const SENSITIVE_PUBLIC_TEXT_PATTERN = /(?:file:\/\/|https?:\/\/(?:[^\s"')]*|$)|(?:^|[\s\p{P}])\/(?!\/)[^\s)"']+|\b[A-Za-z]:[\\/]|(?:^|[\s\p{P}])\\\\[^\s]+|\b(?:authorization|credential|password|secret|token|api[_-]?key|access[_-]?token|client[_-]?secret)\b|\b(?:sk|token|secret|password|credential|api[_-]?key|access[_-]?token|client[_-]?secret)[_-][A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\b|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|ya29\.[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,})\b)/iu;

export function containsSensitivePublicText(value: string): boolean {
  return SENSITIVE_PUBLIC_TEXT_PATTERN.test(value);
}

export function toSafeToolSummary(
  values: Record<string, unknown>,
): SafeToolSummary {
  const summary: SafeToolSummary = {};
  for (const [key, value] of Object.entries(values)) {
    if (!safeString(key)) continue;
    if (value === null || typeof value === 'boolean') {
      summary[key] = value;
      continue;
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value)) summary[key] = value;
      continue;
    }
    if (typeof value === 'string' && safeString(value)) summary[key] = value;
  }
  return summary;
}

export function summarizeNativeMapTool(
  name: MapToolName,
  input: unknown,
  output: unknown,
): SafeToolSummary {
  switch (name) {
    case 'map_get_context': {
      const value = MapGetContextOutputSchema.parse(output);
      return toSafeToolSummary({
        lifecycle: value.lifecycle,
        draftRevision: value.draftRevision,
        committedRevision: value.committedRevision,
        layerCount: value.styleSummary.layerCount,
        sourceCount: value.styleSummary.sourceCount,
        validationStatus: value.validationStatus,
        previewStatus: value.previewStatus,
      });
    }
    case 'map_inspect': {
      const value = MapInspectOutputSchema.parse(output);
      return toSafeToolSummary({
        targetKind: value.target.kind,
        returned: inspectedItemCount(value),
        truncated: value.truncated,
      });
    }
    case 'map_search_layers': {
      const value = MapSearchLayersOutputSchema.parse(output);
      return toSafeToolSummary({ returned: value.returned, truncated: value.truncated });
    }
    case 'map_apply_transaction': {
      const request = MapApplyTransactionInputSchema.parse(input);
      const value = MapApplyTransactionOutputSchema.parse(output);
      return toSafeToolSummary({
        operationCount: transactionOperationCount(request.transaction),
        changedLayerCount: value.changedLayers.length,
        changedSourceCount: value.changedSources.length,
        warningCount: value.warnings.length,
        revision: value.draftRevision,
      });
    }
    case 'map_update_semantics': {
      const request = MapUpdateSemanticsInputSchema.parse(input);
      const value = MapUpdateSemanticsOutputSchema.parse(output);
      return toSafeToolSummary({
        groupCount: request.semantics.groups.length,
        revision: value.draftRevision,
        validationStatus: value.validationSummary.status,
      });
    }
    case 'map_validate': {
      const value = MapValidateOutputSchema.parse(output);
      return toSafeToolSummary({
        revision: value.draftRevision,
        validationStatus: value.summary.status,
        errorCount: value.summary.errors,
        warningCount: value.summary.warnings,
        findingCount: value.summary.totalFindings,
      });
    }
    case 'map_render_preview': {
      const value = MapRenderPreviewOutputSchema.parse(output);
      return toSafeToolSummary({
        previewId: value.previewId,
        status: value.status,
        revision: value.draftRevision,
        validationStatus: value.validationSummary.status,
      });
    }
    case 'map_commit_revision': {
      const value = MapCommitRevisionOutputSchema.parse(output);
      return toSafeToolSummary({
        revision: value.revision,
        draftRevision: value.draftRevision,
      });
    }
    case 'map_discard_draft': {
      const value = MapDiscardDraftOutputSchema.parse(output);
      return toSafeToolSummary({
        revision: value.draftRevision,
        restoredCommittedRevision: value.restoredCommittedRevision,
        validationStatus: value.validationSummary.status,
      });
    }
  }
}

function safeString(value: string): boolean {
  return Array.from(value).length <= MAX_SUMMARY_STRING_CODE_POINTS
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && !containsSensitivePublicText(value);
}

function transactionOperationCount(value: unknown): number {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'operations')) return 0;
  const operations = (value as { operations?: unknown }).operations;
  return Array.isArray(operations) ? operations.length : 0;
}

function inspectedItemCount(value: ReturnType<typeof MapInspectOutputSchema.parse>): number {
  switch (value.view.kind) {
    case 'root':
      return value.view.layers.length + value.view.sources.length;
    case 'layer':
    case 'source':
      return 1;
    case 'source-layer':
      return value.view.layerIds.length;
  }
}
