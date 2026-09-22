import { MapSourceManifestSchema, SemanticDocumentSchema } from '@mapseekai/map-design-contracts';
import type { MapDesignBlobStore, MapDesignProjectRecord, MapDesignProjectRepository } from '../storage/types.js';
import type { LoadedMapDesignSystem } from '../validation/design-system-loader.js';
import type { MapValidationInput } from '../validation/map-validator.js';
import { MapDraftError, isMapDraftError } from './errors.js';

export interface MapSnapshotDependencies {
  readonly repository: MapDesignProjectRepository;
  readonly blobStore: MapDesignBlobStore;
  readonly loadDesignSystem: (input: { id: string; digest: string }) => Promise<LoadedMapDesignSystem>;
}

export type ReadyMapProject = MapDesignProjectRecord & {
  readonly draftStyleDigest: string;
  readonly draftStyleHash: string;
  readonly draftSemanticDigest: string;
  readonly sourceManifestDigest: string;
};

export interface ReadyMapSnapshot extends MapValidationInput {
  readonly project: ReadyMapProject;
}

type PendingSnapshots = Map<string, Promise<ReadyMapSnapshot>>;
const pendingByRepository = new WeakMap<MapDesignProjectRepository,
  WeakMap<MapDesignBlobStore, WeakMap<MapSnapshotDependencies['loadDesignSystem'], PendingSnapshots>>>();
const MAX_PENDING_SNAPSHOTS = 64;

export function readyMapProject(repository: MapDesignProjectRepository, projectId: string): ReadyMapProject {
  const project = repository.get(projectId);
  if (!project) throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
  if (project.lifecycleState !== 'ready' || !project.sourceManifestDigest || !project.draftStyleDigest
    || !project.draftStyleHash || !project.draftSemanticDigest) {
    throw new MapDraftError('PROJECT_NOT_READY', 'The map project is not ready.');
  }
  return { ...project, sourceManifestDigest: project.sourceManifestDigest, draftStyleDigest: project.draftStyleDigest,
    draftStyleHash: project.draftStyleHash, draftSemanticDigest: project.draftSemanticDigest };
}

export function assertCurrentMapSnapshot(repository: MapDesignProjectRepository, project: ReadyMapProject): void {
  const current = readyMapProject(repository, project.projectId);
  if (snapshotKey(current) !== snapshotKey(project)) {
    throw new MapDraftError('REVISION_CONFLICT', 'The map draft revision has changed.', {
      retryable: true, details: { currentRevision: current.draftRevision },
    });
  }
}

export async function loadReadyMapSnapshot(deps: MapSnapshotDependencies, project: ReadyMapProject): Promise<ReadyMapSnapshot> {
  const pending = pendingSnapshots(deps);
  const key = snapshotKey(project);
  const existing = pending.get(key);
  if (existing) {
    const snapshot = await existing;
    assertCurrentMapSnapshot(deps.repository, project);
    return structuredClone(snapshot);
  }
  const loading = loadSnapshot(deps, project);
  if (pending.size < MAX_PENDING_SNAPSHOTS) pending.set(key, loading);
  try {
    const snapshot = await loading;
    assertCurrentMapSnapshot(deps.repository, project);
    return structuredClone(snapshot);
  } finally {
    if (pending.get(key) === loading) pending.delete(key);
  }
}

async function loadSnapshot(deps: MapSnapshotDependencies, project: ReadyMapProject): Promise<ReadyMapSnapshot> {
  try {
    const [style, semantics, sourceManifest, designSystem] = await Promise.all([
      deps.blobStore.getJson<MapValidationInput['style']>(project.projectId, 'styles', project.draftStyleDigest),
      deps.blobStore.getJson<unknown>(project.projectId, 'semantics', project.draftSemanticDigest),
      deps.blobStore.getJson<unknown>(project.projectId, 'sources', project.sourceManifestDigest),
      deps.loadDesignSystem({ id: project.designSystemId, digest: project.designSystemDigest }),
    ]);
    if (designSystem.id !== project.designSystemId || designSystem.digest !== project.designSystemDigest) {
      throw new MapDraftError('DESIGN_SYSTEM_VIOLATION', 'The project design system is unavailable.');
    }
    return { project, style, semantics: SemanticDocumentSchema.parse(semantics),
      sourceManifest: MapSourceManifestSchema.parse(sourceManifest), designSystem };
  } catch (error) {
    if (isMapDraftError(error)) throw error;
    throw new MapDraftError('SOURCE_UNAVAILABLE', 'The current map draft could not be loaded.');
  }
}

function snapshotKey(project: ReadyMapProject): string {
  return JSON.stringify([project.projectId, project.draftRevision, project.draftStyleDigest, project.draftStyleHash,
    project.draftSemanticDigest, project.sourceManifestDigest, project.designSystemId, project.designSystemDigest,
    project.committedRevision]);
}

function pendingSnapshots(deps: MapSnapshotDependencies): PendingSnapshots {
  let stores = pendingByRepository.get(deps.repository);
  if (!stores) { stores = new WeakMap(); pendingByRepository.set(deps.repository, stores); }
  let loaders = stores.get(deps.blobStore);
  if (!loaders) { loaders = new WeakMap(); stores.set(deps.blobStore, loaders); }
  let pending = loaders.get(deps.loadDesignSystem);
  if (!pending) { pending = new Map(); loaders.set(deps.loadDesignSystem, pending); }
  return pending;
}
