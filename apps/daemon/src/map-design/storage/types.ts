export const JSON_BLOB_KINDS = ['styles', 'semantics', 'sources', 'reports', 'attestations'] as const;
export const BINARY_BLOB_KINDS = ['previews', 'resources'] as const;

export type JsonBlobKind = typeof JSON_BLOB_KINDS[number];
export type BinaryBlobKind = typeof BINARY_BLOB_KINDS[number];
export type MapDesignBlobKind = JsonBlobKind | BinaryBlobKind;
export type MapDesignProjectLifecycleState = 'importing' | 'ready' | 'failed';
export type MapDesignSourceKind = 'style' | 'tilejson' | 'pmtiles' | 'geojson';

export interface StoredBlob {
  digest: string;
  byteLength: number;
  kind: MapDesignBlobKind;
  mediaType: string;
}

export interface MapDesignBlobStore {
  putJson(projectId: string, kind: JsonBlobKind, value: unknown): Promise<StoredBlob>;
  putBytes(projectId: string, kind: BinaryBlobKind, bytes: Uint8Array, mediaType: string): Promise<StoredBlob>;
  getJson<T>(projectId: string, kind: JsonBlobKind, digest: string): Promise<T>;
  getBytes(projectId: string, kind: BinaryBlobKind, digest: string): Promise<Uint8Array>;
}

export interface PublicImportFailure {
  code: string;
  message: string;
}

export interface CreateImportingProject {
  projectId: string;
  designSystemId: string;
  designSystemDigest: string;
  draftRevision: number;
  createdAt: string;
}

export interface MarkProjectReady {
  projectId: string;
  sourceKind: MapDesignSourceKind;
  sourceManifestDigest: string;
  draftStyleDigest: string;
  draftStyleHash: string;
  draftSemanticDigest: string;
  updatedAt: string;
}

export interface MapDesignProjectRecord {
  projectId: string;
  lifecycleState: MapDesignProjectLifecycleState;
  sourceKind: MapDesignSourceKind | null;
  sourceManifestDigest: string | null;
  designSystemId: string;
  designSystemDigest: string;
  draftRevision: number;
  draftStyleDigest: string | null;
  draftStyleHash: string | null;
  draftSemanticDigest: string | null;
  committedRevision: number | null;
  failure: PublicImportFailure | null;
  createdAt: string;
  updatedAt: string;
}

export interface MapDesignRevisionRecord {
  projectId: string;
  revision: number;
  draftRevision: number;
  styleDigest: string;
  styleHash: string;
  semanticDigest: string;
  sourceManifestDigest: string;
  designSystemDigest: string;
  previewId: string | null;
  attestationDigest: string;
  runId: string | null;
  createdAt: string;
}

export interface IdempotencyRecord {
  projectId: string;
  operation: string;
  key: string;
  requestDigest: string;
  response: unknown;
  createdAt: string;
}

export interface MapDesignProjectRepository {
  createImporting(input: CreateImportingProject): void;
  get(projectId: string): MapDesignProjectRecord | null;
  markReady(input: MarkProjectReady): void;
  markFailed(projectId: string, failure: PublicImportFailure): void;
  getRevision(projectId: string, revision: number): MapDesignRevisionRecord | null;
  listRevisions(projectId: string): MapDesignRevisionRecord[];
  getIdempotency(projectId: string, operation: string, key: string): IdempotencyRecord | null;
}
