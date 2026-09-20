import type Database from 'better-sqlite3';
import { MAP_REVISION_HISTORY_MAX } from '@mapseekai/map-design-contracts';
import { canonicalJson } from './canonical-json.js';
import type {
  CreateImportingProject,
  IdempotencyRecord,
  MapDesignProjectRecord,
  MapDesignProjectRepository,
  MapDesignRevisionRecord,
  MarkProjectReady,
  MapDesignSourceKind,
  PublicImportFailure,
} from './types.js';

type SqliteDb = Database.Database;
type RawRow = Record<string, unknown>;
const SOURCE_KINDS = new Set<MapDesignSourceKind>(['style', 'tilejson', 'pmtiles', 'geojson']);
const LIFECYCLE_STATES = new Set(['importing', 'ready', 'failed']);

const PROJECT_COLUMNS = `
  project_id AS projectId, lifecycle_state AS lifecycleState, source_kind AS sourceKind,
  source_manifest_digest AS sourceManifestDigest, design_system_id AS designSystemId,
  design_system_digest AS designSystemDigest, draft_revision AS draftRevision,
  draft_style_digest AS draftStyleDigest, draft_style_hash AS draftStyleHash,
  draft_semantic_digest AS draftSemanticDigest, committed_revision AS committedRevision,
  failure_code AS failureCode, failure_message AS failureMessage, created_at AS createdAt,
  updated_at AS updatedAt`;

export class MapDesignSqliteProjectRepository implements MapDesignProjectRepository {
  private readonly createImportingStatement;
  private readonly getStatement;
  private readonly markReadyStatement;
  private readonly markFailedStatement;
  private readonly revisionStatement;
  private readonly revisionsStatement;
  private readonly idempotencyStatement;

  constructor(db: SqliteDb) {
    this.createImportingStatement = db.prepare(`INSERT INTO map_design_projects (
      project_id, lifecycle_state, design_system_id, design_system_digest, draft_revision, created_at, updated_at
    ) VALUES (?, 'importing', ?, ?, ?, ?, ?)`);
    this.getStatement = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM map_design_projects WHERE project_id = ?`);
    this.markReadyStatement = db.prepare(`UPDATE map_design_projects SET
      lifecycle_state = 'ready', source_kind = ?, source_manifest_digest = ?, draft_style_digest = ?,
      draft_style_hash = ?, draft_semantic_digest = ?, failure_code = NULL, failure_message = NULL, updated_at = ?
      WHERE project_id = ?`);
    this.markFailedStatement = db.prepare(`UPDATE map_design_projects SET
      lifecycle_state = 'failed', failure_code = ?, failure_message = ?, updated_at = ? WHERE project_id = ?`);
    this.revisionStatement = db.prepare(`SELECT
      project_id AS projectId, revision, draft_revision AS draftRevision,
      style_digest AS styleDigest, style_hash AS styleHash,
      semantic_digest AS semanticDigest, source_manifest_digest AS sourceManifestDigest,
      design_system_digest AS designSystemDigest, preview_id AS previewId,
      attestation_digest AS attestationDigest, run_id AS runId, created_at AS createdAt
      FROM map_design_revisions WHERE project_id = ? AND revision = ?`);
    this.revisionsStatement = db.prepare(`SELECT
      project_id AS projectId, revision, draft_revision AS draftRevision,
      style_digest AS styleDigest, style_hash AS styleHash,
      semantic_digest AS semanticDigest, source_manifest_digest AS sourceManifestDigest,
      design_system_digest AS designSystemDigest, preview_id AS previewId,
      attestation_digest AS attestationDigest, run_id AS runId, created_at AS createdAt
      FROM map_design_revisions WHERE project_id = ? ORDER BY revision DESC LIMIT ?`);
    this.idempotencyStatement = db.prepare(`SELECT project_id AS projectId, operation,
      idempotency_key AS key, request_digest AS requestDigest, response_json AS responseJson,
      created_at AS createdAt FROM map_design_idempotency
      WHERE project_id = ? AND operation = ? AND idempotency_key = ?`);
  }

  createImporting(input: CreateImportingProject): void {
    this.createImportingStatement.run(
      input.projectId, input.designSystemId, input.designSystemDigest, input.draftRevision,
      input.createdAt, input.createdAt,
    );
  }

  get(projectId: string): MapDesignProjectRecord | null {
    const raw = this.getStatement.get(projectId) as RawRow | undefined;
    return raw ? decodeProject(raw) : null;
  }

  markReady(input: MarkProjectReady): void {
    const result = this.markReadyStatement.run(
      input.sourceKind, input.sourceManifestDigest, input.draftStyleDigest, input.draftStyleHash,
      input.draftSemanticDigest, input.updatedAt, input.projectId,
    );
    if (result.changes !== 1) throw new Error('MapDesign project not found');
  }

  markFailed(projectId: string, failure: PublicImportFailure): void {
    const result = this.markFailedStatement.run(failure.code, failure.message, new Date().toISOString(), projectId);
    if (result.changes !== 1) throw new Error('MapDesign project not found');
  }

  getRevision(projectId: string, revision: number): MapDesignRevisionRecord | null {
    const raw = this.revisionStatement.get(projectId, revision) as RawRow | undefined;
    return raw ? decodeRevision(raw) : null;
  }

  listRevisions(projectId: string): MapDesignRevisionRecord[] {
    return (this.revisionsStatement.all(projectId, MAP_REVISION_HISTORY_MAX + 1) as RawRow[]).map(decodeRevision);
  }

  getIdempotency(projectId: string, operation: string, key: string): IdempotencyRecord | null {
    const raw = this.idempotencyStatement.get(projectId, operation, key) as RawRow | undefined;
    return raw ? decodeIdempotency(raw) : null;
  }
}

function decodeProject(raw: RawRow): MapDesignProjectRecord {
  const lifecycleState = requiredString(raw, 'lifecycleState');
  if (!LIFECYCLE_STATES.has(lifecycleState)) invalidRow();
  const sourceKind = nullableString(raw, 'sourceKind');
  if (sourceKind !== null && !SOURCE_KINDS.has(sourceKind as MapDesignSourceKind)) invalidRow();
  const failureCode = nullableString(raw, 'failureCode');
  const failureMessage = nullableString(raw, 'failureMessage');
  if ((failureCode === null) !== (failureMessage === null)) invalidRow();
  return {
    projectId: requiredString(raw, 'projectId'), lifecycleState: lifecycleState as MapDesignProjectRecord['lifecycleState'],
    sourceKind: sourceKind as MapDesignSourceKind | null, sourceManifestDigest: nullableString(raw, 'sourceManifestDigest'),
    designSystemId: requiredString(raw, 'designSystemId'), designSystemDigest: requiredString(raw, 'designSystemDigest'),
    draftRevision: requiredInteger(raw, 'draftRevision'), draftStyleDigest: nullableString(raw, 'draftStyleDigest'),
    draftStyleHash: nullableString(raw, 'draftStyleHash'), draftSemanticDigest: nullableString(raw, 'draftSemanticDigest'),
    committedRevision: nullableInteger(raw, 'committedRevision'),
    failure: failureCode === null ? null : { code: failureCode, message: failureMessage as string },
    createdAt: requiredString(raw, 'createdAt'), updatedAt: requiredString(raw, 'updatedAt'),
  };
}

function decodeRevision(raw: RawRow): MapDesignRevisionRecord {
  return {
    projectId: requiredString(raw, 'projectId'), revision: requiredInteger(raw, 'revision'),
    draftRevision: requiredInteger(raw, 'draftRevision'),
    styleDigest: requiredString(raw, 'styleDigest'), styleHash: requiredString(raw, 'styleHash'),
    semanticDigest: requiredString(raw, 'semanticDigest'), sourceManifestDigest: requiredString(raw, 'sourceManifestDigest'),
    designSystemDigest: requiredString(raw, 'designSystemDigest'), previewId: nullableString(raw, 'previewId'),
    attestationDigest: requiredString(raw, 'attestationDigest'), runId: nullableString(raw, 'runId'),
    createdAt: requiredString(raw, 'createdAt'),
  };
}

function decodeIdempotency(raw: RawRow): IdempotencyRecord {
  const responseJson = requiredString(raw, 'responseJson');
  let response: unknown;
  try {
    response = JSON.parse(responseJson);
    canonicalJson(response);
  } catch {
    throw new TypeError('invalid stored JSON');
  }
  return {
    projectId: requiredString(raw, 'projectId'), operation: requiredString(raw, 'operation'),
    key: requiredString(raw, 'key'), requestDigest: requiredString(raw, 'requestDigest'), response,
    createdAt: requiredString(raw, 'createdAt'),
  };
}

function requiredString(raw: RawRow, key: string): string {
  return typeof raw[key] === 'string' ? raw[key] : invalidRow();
}

function nullableString(raw: RawRow, key: string): string | null {
  return raw[key] === null ? null : typeof raw[key] === 'string' ? raw[key] : invalidRow();
}

function requiredInteger(raw: RawRow, key: string): number {
  return typeof raw[key] === 'number' && Number.isSafeInteger(raw[key]) ? raw[key] : invalidRow();
}

function nullableInteger(raw: RawRow, key: string): number | null {
  return raw[key] === null ? null : typeof raw[key] === 'number' && Number.isSafeInteger(raw[key]) ? raw[key] : invalidRow();
}

function invalidRow(): never {
  throw new TypeError('invalid stored row');
}
