import type { MapSourceManifest, MapValidationFinding, MapValidationSummary } from '@mapseekai/map-design-contracts';
import { validateStyleDocument, type StyleDocument } from 'maplibre-style-tools/core';

import { blake3Digest, canonicalJsonBytes } from '../storage/canonical-json.js';
import type { LoadedMapDesignSystem } from './design-system-loader.js';
import { DEFAULT_CARTOGRAPHIC_QUALITY_POLICY, validateCartographicQuality, type CartographicQualityPolicy } from './cartographic-quality-validator.js';
import { summarizeFindings } from './findings.js';
import { validateSemanticMapping, type MapSemanticMapping } from './semantic-validator.js';

export interface MapValidationInput {
  style: StyleDocument;
  semantics: MapSemanticMapping;
  sourceManifest: MapSourceManifest;
  designSystem: LoadedMapDesignSystem;
  runtimePolicy?: CartographicQualityPolicy;
}

export interface MapValidationResult {
  ok: boolean;
  findings: MapValidationFinding[];
  summary: MapValidationSummary;
  validationDigest: string;
}

export function validateMapDesign(input: MapValidationInput): MapValidationResult {
  const styleResult = validateStyleDocument(input.style);
  const legacy = input.designSystem.format === 'legacy-mapdesign';
  const policy = input.designSystem.format === 'legacy-mapdesign'
    ? input.designSystem.policy : input.runtimePolicy ?? DEFAULT_CARTOGRAPHIC_QUALITY_POLICY;
  const quality = validateCartographicQuality({
    style: input.style, semantics: input.semantics, policy,
    ...(legacy ? { scope: { kind: 'design-system' as const, id: input.designSystem.id } } : {}),
  });
  const findings: MapValidationFinding[] = [
    ...styleResult.errors.map((error) => styleFinding('error', error.message, error.path)),
    ...styleResult.warnings.map((warning) => styleFinding('warning', warning.message, warning.path)),
    ...validateSemanticMapping(input.style, input.semantics, input.sourceManifest),
    ...zoomFindings(input.style),
    ...(input.designSystem.format === 'cartography' ? input.designSystem.documentFindings : []),
    ...quality.map((finding) => legacy ? {
      ...finding, code: 'DESIGN_SYSTEM_VIOLATION',
      ...(finding.jsonPointer ? { jsonPointer: finding.jsonPointer.replace('/runtimePolicy/', '/rules/') } : {}),
    } : finding),
  ];
  const result = summarizeFindings(findings);
  return {
    ok: result.summary.errors === 0,
    findings: result.findings,
    summary: result.summary,
    validationDigest: blake3Digest(canonicalJsonBytes({
      style: input.style,
      semantics: input.semantics,
      sourceManifest: input.sourceManifest,
      designSystemDigest: input.designSystem.digest,
      // A policy change invalidates a preview even when its findings are unchanged.
      ...(legacy ? {} : { runtimePolicy: policy }),
      findings: result.findings,
      summary: result.summary,
    })),
  };
}

function styleFinding(
  severity: 'error' | 'warning', message: string, jsonPointer?: string,
): MapValidationFinding {
  return {
    severity,
    code: severity === 'error' ? 'STYLE_INVALID' : 'STYLE_WARNING',
    message,
    scope: { kind: 'root' },
    ...(jsonPointer ? { jsonPointer } : {}),
  };
}

function zoomFindings(style: StyleDocument): MapValidationFinding[] {
  return style.layers.flatMap((layer, index) => typeof layer.minzoom === 'number'
    && typeof layer.maxzoom === 'number' && layer.minzoom === layer.maxzoom
    ? [{
      severity: 'error' as const,
      code: 'DOMAIN_INVALID',
      message: 'Layer minzoom and maxzoom must not be equal.',
      scope: { kind: 'layer' as const, id: typeof layer.id === 'string' ? layer.id : `layer-${index}` },
      jsonPointer: `/layers/${index}`,
    }]
    : []);
}
