import {
  executeInspectStyle,
  type ApplyStyleTransactionInput,
  type CapabilityResult,
  type InspectStyleInput,
  type InspectionProjection,
  type StyleAuthority,
  type StyleMutationReceipt,
} from 'maplibre-style-tools/capabilities';
import {
  applyStyleTransaction,
  createStyleToolError,
  validateStyleDocument,
  type StyleDocument,
} from 'maplibre-style-tools/core';

export interface MapStyleSdk {
  inspect(
    style: StyleDocument,
    input: InspectStyleInput,
  ): CapabilityResult<InspectionProjection>;
  apply(
    style: StyleDocument,
    input: ApplyStyleTransactionInput,
  ): CapabilityResult<StyleMutationReceipt & { style: StyleDocument }>;
}

export function createMapStyleSdk(): MapStyleSdk {
  return { inspect, apply };
}

function inspect(
  style: StyleDocument,
  input: InspectStyleInput,
): CapabilityResult<InspectionProjection> {
  const snapshot = cloneAndValidate(style);
  if (!snapshot.success) return snapshot;

  const authority: StyleAuthority = {
    readStyle: () => ({ ok: true, style: snapshot.data, warnings: snapshot.warnings }),
    context: () => ({}),
    applyTransaction: () => {
      throw new TypeError('The inspection facade cannot apply transactions.');
    },
    applyDocument: () => {
      throw new TypeError('The inspection facade cannot apply documents.');
    },
  };
  return executeInspectStyle(() => authority, input);
}

function apply(
  style: StyleDocument,
  input: ApplyStyleTransactionInput,
): CapabilityResult<StyleMutationReceipt & { style: StyleDocument }> {
  const snapshot = cloneAndValidate(style);
  if (!snapshot.success) return snapshot;

  const result = applyStyleTransaction(snapshot.data, {
    ...input.transaction,
    validate: true,
  });
  if (!result.ok) {
    return { success: false, message: 'Style transaction failed.', error: result.error };
  }

  const validated = validateStyleDocument(result.style);
  if (!validated.ok) {
    return {
      success: false,
      message: 'Style transaction failed validation.',
      error: validated.errors[0]
        ?? createStyleToolError('STYLE_INVALID', 'MapLibre style validation failed.'),
    };
  }

  const noOp = result.diff.length === 0;
  return {
    success: true,
    message: noOp
      ? 'Style transaction completed without changes.'
      : 'Style transaction completed.',
    data: {
      applied: input.dryRun === true ? false : !noOp,
      noOp,
      changedLayers: [...result.changedLayers],
      changedSources: [...result.changedSources],
      ...(input.diff === false ? {} : { diff: structuredClone(result.diff) }),
      warnings: structuredClone(result.warnings),
      truncated: false,
      styleAuthority: 'not-checked',
      style: validated.style,
    },
  };
}

type StyleFailure = Extract<CapabilityResult<never>, { success: false }>;

type ValidatedStyle = {
  success: true;
  data: StyleDocument;
  warnings: ReturnType<typeof validateStyleDocument>['warnings'];
} | StyleFailure;

function cloneAndValidate(style: StyleDocument): ValidatedStyle {
  let clone: unknown;
  try {
    clone = structuredClone(style);
  } catch {
    return {
      success: false,
      message: 'Style snapshot could not be cloned.',
      error: createStyleToolError('STYLE_INVALID', 'MapLibre style snapshot is invalid.'),
    };
  }
  const validation = validateStyleDocument(clone);
  if (!validation.ok) {
    return {
      success: false,
      message: 'Style snapshot failed validation.',
      error: createStyleToolError('STYLE_INVALID', 'MapLibre style validation failed.'),
    };
  }
  return { success: true, data: validation.style, warnings: validation.warnings };
}
