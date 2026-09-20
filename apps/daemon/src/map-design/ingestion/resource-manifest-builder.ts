import {
  MapSourceManifestSchema,
  SemanticDocumentSchema,
  type MapDesignResourceScope,
  type MapSourceKind,
  type MapSourceManifest,
  type SemanticDocument,
} from '@mapseekai/map-design-contracts';
import type { StyleDocument } from 'maplibre-style-tools/core';

import { blake3Digest } from '../storage/canonical-json.js';
import type { LoadedMapDesignSystem } from '../validation/design-system-loader.js';
import {
  validateMapDesign,
  type MapValidationResult,
} from '../validation/map-validator.js';

export interface ResourceDescriptorBase {
  id: string;
  kind: 'source-document' | 'tile' | 'glyph' | 'sprite' | 'pmtiles' | 'geojson' | 'image' | 'video';
  mediaType: string;
  sourceUrl: string;
  etag: string | null;
}

export type ResourceDescriptor =
  | (ResourceDescriptorBase & {
      mode: 'captured';
      byteLength: number;
      contentDigest: string;
    })
  | (ResourceDescriptorBase & {
      mode: 'remote';
      byteLength: null;
      contentDigest: null;
    });

export interface InitialMapBuild {
  style: StyleDocument;
  semantics: SemanticDocument;
  sourceManifest: MapSourceManifest;
  resources: readonly ResourceDescriptor[];
  validation: MapValidationResult;
}

export function finalizeInitialMapBuild(input: {
  style: StyleDocument;
  semantics: SemanticDocument;
  sourceManifest: MapSourceManifest;
  resources: readonly ResourceDescriptor[];
  designSystem: LoadedMapDesignSystem;
}): InitialMapBuild {
  return {
    style: input.style,
    semantics: input.semantics,
    sourceManifest: input.sourceManifest,
    resources: input.resources,
    validation: validateMapDesign({
      style: input.style,
      semantics: input.semantics,
      sourceManifest: input.sourceManifest,
      designSystem: input.designSystem,
    }),
  };
}

export function createResourceId(kind: ResourceDescriptorBase['kind'], sourceUrl: string): string {
  return blake3Digest(new TextEncoder().encode(`${kind}\0${sourceUrl}`));
}

export function resourceGatewayPath(
  projectId: string,
  resourceId: string,
  suffix: string,
  scope: MapDesignResourceScope = 'projects',
): string {
  const base = `/api/map-design/${scope}/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}`;
  return suffix.length === 0 ? base : `${base}/${suffix.replace(/^\/+|\/+$/gu, '')}`;
}

export function buildSourceManifest(input: {
  kind: MapSourceKind;
  mediaType: string;
  sourceBytes: Uint8Array;
  resourceCount: number;
  capturedAt: string;
}): MapSourceManifest {
  return MapSourceManifestSchema.parse({
    kind: input.kind,
    digest: blake3Digest(input.sourceBytes),
    mediaType: input.mediaType,
    byteLength: input.sourceBytes.byteLength,
    resourceCount: input.resourceCount,
    capturedAt: input.capturedAt,
  });
}

export function buildStyleSemantics(style: StyleDocument): SemanticDocument {
  const groups = Object.keys(style.sources).flatMap((sourceId, sourceIndex) => {
    const layerIds = style.layers
      .filter((layer) => layer.source === sourceId)
      .map((layer) => String(layer.id));
    const chunks = [];
    for (let offset = 0; offset < layerIds.length; offset += 128) {
      const id = `source-${sourceIndex + 1}-${Math.floor(offset / 128) + 1}`;
      chunks.push({
        id,
        label: sourceId,
        role: id,
        layerIds: layerIds.slice(offset, offset + 128),
        sourceIds: [sourceId],
      });
    }
    return chunks;
  });
  return SemanticDocumentSchema.parse({ version: 1, groups });
}
