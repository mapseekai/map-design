import type Database from 'better-sqlite3';
import {
  MAP_REVISION_HISTORY_MAX,
  MapDesignProjectReadSchema,
  MapGetContextOutputSchema,
  MapInspectInputSchema,
  MapSearchLayersInputSchema,
  MapRevisionHistoryOutputSchema,
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
import { MapDraftError, invalidInput } from './errors.js';
import { loadReadyMapSnapshot, readyMapProject, type ReadyMapSnapshot } from './map-ready-snapshot.js';
import { summarizeMapStyle } from './map-style-summary.js';
import { inspectMapStyle, searchMapLayers } from './map-layer-read.js';
import type { MapDesignValidationService } from './validation-service.js';

type SqliteDb = Database.Database;

export interface MapDesignQueryServiceDependencies {
  db: SqliteDb;
  repository: MapDesignProjectRepository;
  blobStore: MapDesignBlobStore;
  loadDesignSystem(input: { id: string; digest: string }): Promise<LoadedMapDesignSystem>;
  validationService: Pick<MapDesignValidationService, 'validateSnapshot'>;
  now?: () => string;
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

  async getContext(projectId: string, beforeRead?: (style: StyleDocument) => void): Promise<MapGetContextOutput> {
    const snapshot = await this.loadReady(projectId);
    beforeRead?.(snapshot.style);
    const validation = this.deps.validationService.validateSnapshot(snapshot);
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
      cartographicGuidance: guidanceLines(snapshot.designSystem.source),
    });
  }

  async inspect(projectId: string, input: unknown | MapInspectInput, beforeRead?: (style: StyleDocument) => void): Promise<MapInspectOutput> {
    let parsed: MapInspectInput;
    try {
      parsed = MapInspectInputSchema.parse(input);
    } catch {
      throw invalidInput();
    }
    const snapshot = await this.loadReady(projectId);
    beforeRead?.(snapshot.style);
    return inspectMapStyle(snapshot, parsed);
  }

  async searchLayers(projectId: string, input: unknown | MapSearchLayersInput, beforeRead?: (style: StyleDocument) => void): Promise<MapSearchLayersOutput> {
    let parsed: MapSearchLayersInput;
    try {
      parsed = MapSearchLayersInputSchema.parse(input);
    } catch {
      throw invalidInput();
    }
    const snapshot = await this.loadReady(projectId);
    beforeRead?.(snapshot.style);
    return searchMapLayers(snapshot.style, parsed);
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

  private loadReady(projectId: string): Promise<ReadyMapSnapshot> {
    return loadReadyMapSnapshot(this.deps, readyMapProject(this.deps.repository, projectId));
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
  return designSystem.name.slice(0, 256);
}

function guidanceLines(guidance: string): string[] {
  return guidance.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .slice(0, 256)
    .map((line) => line.slice(0, 500));
}
