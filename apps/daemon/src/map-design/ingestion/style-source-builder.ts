import { resolveDirectStyleResources } from './direct-style-resources.js';
import type { MapDesignResourceScope } from '@mapseekai/map-design-contracts';

import { canonicalJsonBytes } from '../storage/canonical-json.js';
import type { MapDesignBlobStore } from '../storage/types.js';
import type { LoadedMapDesignSystem } from '../validation/design-system-loader.js';
import type { PinnedTransport } from './pinned-transport.js';
import type { DetectedMapSource } from './source-detector.js';
import {
  buildSourceManifest,
  buildStyleSemantics,
  finalizeInitialMapBuild,
  type InitialMapBuild,
} from './resource-manifest-builder.js';
import { rewriteStyleResources } from './style-resource-rewriter.js';

export async function buildStyleSource(input: {
  projectId: string;
  source: DetectedMapSource;
  approvedFinalUrl: URL;
  etag: string | null;
  capturedAt: string;
  blobStore?: Pick<MapDesignBlobStore, 'putBytes'>;
  transport?: PinnedTransport;
  designSystem: LoadedMapDesignSystem;
  resourceScope?: MapDesignResourceScope;
  signal?: AbortSignal;
  resourceMode?: 'direct' | 'gateway';
}): Promise<InitialMapBuild> {
  if (input.source.kind !== 'style') throw new TypeError('Expected a detected Style source');
  const sourceBytes = canonicalJsonBytes(input.source.document);
  const rewritten = input.resourceMode === 'direct'
    ? resolveDirectStyleResources({ style: input.source.document, approvedFinalUrl: input.approvedFinalUrl })
    : await rewriteStyleResources({
    style: input.source.document,
    projectId: input.projectId,
    ...(input.signal ? { signal: input.signal } : {}),
    approvedFinalUrl: input.approvedFinalUrl,
    ...(input.blobStore ? { blobStore: input.blobStore } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.resourceScope ? { resourceScope: input.resourceScope } : {}),
  });
  const semantics = buildStyleSemantics(rewritten.style);
  const sourceManifest = buildSourceManifest({
      kind: 'style',
      mediaType: input.source.mediaType,
      sourceBytes,
      resourceCount: rewritten.resources.length,
      capturedAt: input.capturedAt,
  });
  return finalizeInitialMapBuild({
    style: rewritten.style,
    semantics,
    sourceManifest,
    resources: rewritten.resources,
    designSystem: input.designSystem,
  });
}
