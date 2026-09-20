import type Database from 'better-sqlite3';
import {
  MAP_INSPECT_MAX_BYTES,
  MAP_REVISION_HISTORY_MAX,
  MapDesignProjectReadSchema,
  MapGetContextOutputSchema,
  MapInspectInputSchema,
  MapInspectOutputSchema,
  MapSearchLayersInputSchema,
  MapSearchLayersOutputSchema,
  MapRevisionHistoryOutputSchema,
  MapSourceManifestSchema,
  SemanticDocumentSchema,
  mapJsonByteLength,
  type MapDesignProjectRead,
  type MapGetContextOutput,
  type MapInspectInput,
  type MapInspectOutput,
  type MapSearchLayersInput,
  type MapSearchLayersOutput,
  type MapRevisionHistoryOutput,
  type MapSemanticSummary,
  type SemanticDocument,
} from '@mapseekai/map-design-contracts';
import type { StyleDocument } from 'maplibre-style-tools/core';

import type {
  MapDesignBlobStore,
  MapDesignProjectRecord,
  MapDesignProjectRepository,
} from '../storage/types.js';
import type { LoadedMapDesignSystem } from '../validation/design-system-loader.js';
import { MapDraftError, invalidInput, isMapDraftError } from './errors.js';
import {
  inspectMapStyleRoot,
  summarizeMapLayer,
  summarizeMapSources,
  summarizeMapStyle,
} from './map-style-summary.js';
import type { MapDesignValidationService } from './validation-service.js';

type SqliteDb = Database.Database;

export interface MapDesignQueryServiceDependencies {
  db: SqliteDb;
  repository: MapDesignProjectRepository;
  blobStore: MapDesignBlobStore;
  loadDesignSystem(input: { id: string; digest: string }): Promise<LoadedMapDesignSystem>;
  validationService: Pick<MapDesignValidationService, 'validate'>;
  now?: () => string;
}

interface ReadySnapshot {
  project: MapDesignProjectRecord;
  style: StyleDocument;
  semantics: SemanticDocument;
  sourceManifest: ReturnType<typeof MapSourceManifestSchema.parse>;
  designSystem: LoadedMapDesignSystem;
}

interface PreviewRow {
  draftRevision: number;
  styleHash: string;
  status: 'requested' | 'rendering' | 'passed' | 'failed' | 'expired';
  expiresAt: string;
}

export class MapDesignQueryService {
  private readonly now: () => string;

  constructor(private readonly deps: MapDesignQueryServiceDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async getProject(projectId: string): Promise<MapDesignProjectRead> {
    const project = this.project(projectId);
    return MapDesignProjectReadSchema.parse({
      projectId: project.projectId,
      lifecycle: project.lifecycleState,
      sourceKind: project.sourceKind,
      designSystemId: project.designSystemId,
      designSystemDigest: project.designSystemDigest,
      draftRevision: project.draftRevision,
      committedRevision: project.committedRevision,
      failure: project.failure,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
  }

  async getContext(projectId: string): Promise<MapGetContextOutput> {
    const snapshot = await this.loadReady(projectId);
    const validation = await this.deps.validationService.validate(projectId, {
      expectedRevision: snapshot.project.draftRevision,
    });
    return MapGetContextOutputSchema.parse({
      lifecycle: snapshot.project.lifecycleState,
      source: {
        kind: snapshot.sourceManifest.kind,
        digest: snapshot.sourceManifest.digest,
        status: 'available',
        resourceCount: snapshot.sourceManifest.resourceCount,
      },
      designSystem: {
        id: snapshot.designSystem.id,
        name: designSystemName(snapshot.designSystem),
        digest: snapshot.designSystem.digest,
      },
      draftRevision: snapshot.project.draftRevision,
      committedRevision: snapshot.project.committedRevision,
      styleHash: snapshot.project.draftStyleHash,
      styleSummary: summarizeMapStyle(snapshot.style),
      semanticSummary: semanticSummary(snapshot.semantics),
      validationStatus: validation.summary.status,
      previewStatus: this.previewStatus(snapshot.project),
      cartographicGuidance: guidanceLines(snapshot.designSystem.humanGuidance),
    });
  }

  async inspect(projectId: string, input: unknown | MapInspectInput): Promise<MapInspectOutput> {
    let parsed: MapInspectInput;
    try {
      parsed = MapInspectInputSchema.parse(input);
    } catch {
      throw invalidInput();
    }
    const snapshot = await this.loadReady(projectId);
    switch (parsed.target.kind) {
      case 'root': {
        return inspectMapStyleRoot(snapshot.style);
      }
      case 'layer': {
        const target = parsed.target;
        const layer = snapshot.style.layers.find((candidate) => candidate.id === target.layerId);
        if (!layer) throw new MapDraftError('NOT_FOUND', 'The map layer was not found.');
        const output = {
          target,
          view: {
            kind: 'layer' as const,
            layer: { ...summarizeMapLayer(layer), filter: layer.filter ?? null, paint: layer.paint ?? {}, layout: layer.layout ?? {} },
            semanticGroupIds: snapshot.semantics.groups
              .filter((group) => group.layerIds.includes(target.layerId))
              .map((group) => group.id),
          },
          truncated: false,
        };
        if (mapJsonByteLength(output) > MAP_INSPECT_MAX_BYTES) {
          return MapInspectOutputSchema.parse({ ...output, view: { ...output.view, layer: summarizeMapLayer(layer) }, truncated: true });
        }
        return MapInspectOutputSchema.parse(output);
      }
      case 'source': {
        const target = parsed.target;
        const source = summarizeMapSources(snapshot.style).find((candidate) => candidate.id === target.sourceId);
        if (!source) throw new MapDraftError('NOT_FOUND', 'The map source was not found.');
        const definition = snapshot.style.sources[target.sourceId]!;
        const output = { target, view: { kind: 'source' as const, source: { ...source,
          generateId: definition.generateId === true, promoteId: definition.promoteId ?? null,
        } }, truncated: false };
        if (mapJsonByteLength(output) > MAP_INSPECT_MAX_BYTES) {
          return MapInspectOutputSchema.parse({ target, view: { kind: 'source', source }, truncated: true });
        }
        return MapInspectOutputSchema.parse(output);
      }
      case 'source-layer': {
        const target = parsed.target;
        if (!Object.hasOwn(snapshot.style.sources, target.sourceId)) {
          throw new MapDraftError('NOT_FOUND', 'The map source was not found.');
        }
        const allIds = snapshot.style.layers
          .filter((layer) => layer.source === target.sourceId && layer['source-layer'] === target.sourceLayer)
          .map((layer) => layer.id);
        if (allIds.length === 0) throw new MapDraftError('NOT_FOUND', 'The map source layer was not found.');
        const output: MapInspectOutput = {
          target,
          view: { kind: 'source-layer', sourceId: target.sourceId, sourceLayer: target.sourceLayer, layerIds: [...allIds] },
          truncated: false,
        };
        while (mapJsonByteLength(output) > MAP_INSPECT_MAX_BYTES && output.view.kind === 'source-layer' && output.view.layerIds.length > 0) {
          output.view.layerIds.pop();
          output.truncated = true;
        }
        return MapInspectOutputSchema.parse(output);
      }
    }
  }

  async searchLayers(projectId: string, input: unknown | MapSearchLayersInput): Promise<MapSearchLayersOutput> {
    let parsed: MapSearchLayersInput;
    try {
      parsed = MapSearchLayersInputSchema.parse(input);
    } catch {
      throw invalidInput();
    }
    const snapshot = await this.loadReady(projectId);
    const query = parsed.query?.toLocaleLowerCase('en-US') ?? '';
    const matched = snapshot.style.layers.filter((layer) => {
      const summary = summarizeMapLayer(layer);
      if (query && ![summary.id, summary.title, summary.sourceId, summary.sourceLayer]
        .some((value) => value?.toLocaleLowerCase('en-US').includes(query))) return false;
      if (parsed.types && !parsed.types.includes(summary.type)) return false;
      if (parsed.sourceId !== undefined && summary.sourceId !== parsed.sourceId) return false;
      if (parsed.sourceLayer !== undefined && summary.sourceLayer !== parsed.sourceLayer) return false;
      return true;
    });
    const layers = matched.slice(0, parsed.limit).map(summarizeMapLayer);
    return MapSearchLayersOutputSchema.parse({ layers, returned: layers.length, truncated: matched.length > layers.length });
  }

  async getStyle(projectId: string): Promise<StyleDocument> {
    return (await this.loadReady(projectId)).style;
  }

  async getSemantics(projectId: string): Promise<SemanticDocument> {
    return (await this.loadReady(projectId)).semantics;
  }

  async listRevisions(projectId: string): Promise<MapRevisionHistoryOutput> {
    this.project(projectId);
    const stored = this.deps.repository.listRevisions(projectId);
    const revisions = stored.slice(0, MAP_REVISION_HISTORY_MAX).map((revision) => ({
      revision: revision.revision,
      draftRevision: revision.draftRevision,
      styleHash: revision.styleHash,
      semanticDigest: revision.semanticDigest,
      sourceDigest: revision.sourceManifestDigest,
      designSystemDigest: revision.designSystemDigest,
      previewId: revision.previewId,
      attestationDigest: revision.attestationDigest,
      committedAt: revision.createdAt,
    }));
    return MapRevisionHistoryOutputSchema.parse({
      revisions,
      returned: revisions.length,
      truncated: stored.length > revisions.length,
    });
  }

  private project(projectId: string): MapDesignProjectRecord {
    const project = this.deps.repository.get(projectId);
    if (!project) throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
    return project;
  }

  private async loadReady(projectId: string): Promise<ReadySnapshot> {
    const project = this.project(projectId);
    if (project.lifecycleState !== 'ready' || !project.sourceManifestDigest || !project.draftStyleDigest
      || !project.draftStyleHash || !project.draftSemanticDigest) {
      throw new MapDraftError('PROJECT_NOT_READY', 'The map project is not ready.');
    }
    try {
      const [style, semanticsValue, sourceValue, designSystem] = await Promise.all([
        this.deps.blobStore.getJson<StyleDocument>(projectId, 'styles', project.draftStyleDigest),
        this.deps.blobStore.getJson<unknown>(projectId, 'semantics', project.draftSemanticDigest),
        this.deps.blobStore.getJson<unknown>(projectId, 'sources', project.sourceManifestDigest),
        this.deps.loadDesignSystem({ id: project.designSystemId, digest: project.designSystemDigest }),
      ]);
      if (designSystem.id !== project.designSystemId || designSystem.digest !== project.designSystemDigest) {
        throw new MapDraftError('DESIGN_SYSTEM_VIOLATION', 'The project design system is unavailable.');
      }
      return {
        project,
        style,
        semantics: SemanticDocumentSchema.parse(semanticsValue),
        sourceManifest: MapSourceManifestSchema.parse(sourceValue),
        designSystem,
      };
    } catch (error) {
      if (isMapDraftError(error)) throw error;
      throw new MapDraftError('SOURCE_UNAVAILABLE', 'The current map draft could not be loaded.');
    }
  }

  private previewStatus(project: MapDesignProjectRecord): MapGetContextOutput['previewStatus'] {
    const preview = this.deps.db.prepare(`SELECT draft_revision AS draftRevision, style_hash AS styleHash, status,
      expires_at AS expiresAt
      FROM map_design_previews WHERE project_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`)
      .get(project.projectId) as PreviewRow | undefined;
    if (!preview) return 'missing';
    if (preview.draftRevision !== project.draftRevision || preview.styleHash !== project.draftStyleHash) return 'stale';
    if (preview.status === 'requested' || preview.status === 'rendering') return 'rendering';
    if (preview.status === 'passed') return previewExpired(preview.expiresAt, this.now()) ? 'stale' : 'current';
    if (preview.status === 'failed') return 'failed';
    return 'stale';
  }
}

function previewExpired(expiresAt: string, now: string): boolean {
  const expiry = Date.parse(expiresAt);
  const snapshot = Date.parse(now);
  if (!Number.isFinite(expiry) || !Number.isFinite(snapshot)) {
    throw new MapDraftError('INTERNAL', 'The stored map preview expiry is invalid.');
  }
  return expiry <= snapshot;
}

function semanticSummary(semantics: SemanticDocument): MapSemanticSummary {
  return {
    version: 1,
    groupCount: semantics.groups.length,
    mappedLayerCount: new Set(semantics.groups.flatMap((group) => group.layerIds)).size,
    mappedSourceCount: new Set(semantics.groups.flatMap((group) => group.sourceIds)).size,
  };
}

function designSystemName(designSystem: LoadedMapDesignSystem): string {
  const heading = designSystem.humanGuidance.split(/\r?\n/u)
    .map((line) => /^#+\s+(.+)$/u.exec(line.trim())?.[1]?.trim())
    .find((value): value is string => Boolean(value));
  return (heading ?? designSystem.id).slice(0, 256);
}

function guidanceLines(guidance: string): string[] {
  return guidance.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .slice(0, 256)
    .map((line) => line.slice(0, 500));
}
