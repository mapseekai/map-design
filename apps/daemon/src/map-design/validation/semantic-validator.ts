import type { MapSourceManifest, MapValidationFinding, SemanticDocument } from '@mapseekai/map-design-contracts';
import type { StyleDocument } from 'maplibre-style-tools/core';

export type MapSemanticMapping = SemanticDocument;

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function finding(message: string, jsonPointer: string, scope: MapValidationFinding['scope'] = { kind: 'root' }): MapValidationFinding {
  return { severity: 'error', code: 'SEMANTIC_INVALID', message, scope, jsonPointer };
}

export function validateSemanticMapping(
  style: StyleDocument,
  semantics: MapSemanticMapping,
  sourceManifest: MapSourceManifest,
): MapValidationFinding[] {
  const findings: MapValidationFinding[] = [];
  const sourceIds = new Set(Object.keys(style.sources));
  const layerIds = new Set<string>();
  const assignedRoles = new Set<string>();
  const assignedLayers = new Set<string>();

  if (sourceManifest.resourceCount < 1) {
    findings.push({
      severity: 'error', code: 'SOURCE_INVALID', message: 'Source manifest must describe at least one resource.',
      scope: { kind: 'root' }, jsonPointer: '/resourceCount',
    });
  }

  style.layers.forEach((layer, layerIndex) => {
    const layerId = typeof layer.id === 'string' ? layer.id : `layer-${layerIndex}`;
    layerIds.add(layerId);
    if (typeof layer.source === 'string' && !sourceIds.has(layer.source)) {
      findings.push({
        severity: 'error', code: 'SOURCE_INVALID', message: `Layer references unknown source "${layer.source}".`,
        scope: { kind: 'layer', id: layerId }, jsonPointer: `/layers/${layerIndex}/source`,
      });
    }
  });

  semantics.groups.forEach((group, groupIndex) => {
    const groupPath = `/groups/${groupIndex}`;
    if (assignedRoles.has(group.role)) {
      findings.push(finding(`Semantic role "${group.role}" is assigned more than once.`, `${groupPath}/role`));
    }
    assignedRoles.add(group.role);

    group.layerIds.forEach((layerId, layerIndex) => {
      const pointer = `${groupPath}/layerIds/${layerIndex}`;
      if (!layerIds.has(layerId)) {
        findings.push(finding(`Semantic layer "${layerId}" does not exist in the style.`, pointer));
      }
      if (assignedLayers.has(layerId)) {
        findings.push(finding(`Style layer "${layerId}" is assigned to more than one semantic group.`, pointer));
      }
      assignedLayers.add(layerId);
    });

    group.sourceIds.forEach((sourceId, sourceIndex) => {
      if (!sourceIds.has(sourceId)) {
        findings.push(finding(
          `Semantic source "${sourceId}" does not exist in the style.`,
          `${groupPath}/sourceIds/${sourceIndex}`,
        ));
      }
    });
  });

  return findings;
}

export { escapePointer };
