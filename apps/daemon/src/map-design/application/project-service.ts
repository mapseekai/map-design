import type Database from 'better-sqlite3';

import { randomUUID } from 'node:crypto';

import {
  CartographySummarySchema,
  MapDesignProjectCreateInputSchema,
  MapDesignProjectCreateOutputSchema,
  MapDesignProjectListOutputSchema,
  type MapDesignProjectCreateInput,
  type MapDesignProjectCreateOutput,
  type MapDesignProjectListOutput,
} from '@mapseekai/map-design-contracts';
import type { MapDesignConversation } from '@mapseekai/contracts';

import { invalidInput, MapDraftError } from './errors.js';
import { CartographyService } from './cartography-service.js';
import { requestDigest } from './request-digest.js';
import type { MapDesignQueryService } from './query-service.js';
import type { MapImportJobRunner } from '../ingestion/import-job-runner.js';
import type { MapSourceImportService } from '../ingestion/source-import-service.js';
import { canonicalJson } from '../storage/canonical-json.js';
import type { MapDesignLocalStore } from '../storage/local-store.js';

type ProjectCreateWitness = {
  canonicalRequestDigest: string | null;
  canonicalRequestJson: string | null;
  responseJson: string;
};

export class MapDesignProjectService {
  constructor(private readonly deps: {
    store: MapDesignLocalStore;
    sourceImportService: MapSourceImportService;
    importJobRunner: Pick<MapImportJobRunner, 'enqueue'>;
    queryService: Pick<MapDesignQueryService, 'getProject'>;
    verifyWorkingDirectoryGrant(grant: NonNullable<MapDesignProjectCreateInput['workingDirectory']>): Promise<string>;
    ensureInitialRun?(projectId: string): Promise<void>;
    randomId?(): string;
  }) {}

  async create(input: MapDesignProjectCreateInput): Promise<MapDesignProjectCreateOutput> {
    let parsed: MapDesignProjectCreateInput;
    try { parsed = MapDesignProjectCreateInputSchema.parse(input); } catch { throw invalidInput(); }
    const witnessRequest = sanitizedRequest(parsed);
    const witnessJson = canonicalJson(witnessRequest);
    const witnessDigest = requestDigest(witnessRequest);
    const replay = this.findWitness(parsed.idempotencyKey);
    if (replay) return this.replay(replay, witnessDigest, witnessJson);
    const cartography = parsed.cartographyId
      ? CartographySummarySchema.parse(new CartographyService(this.deps.store).get(parsed.cartographyId))
      : undefined;

    let verifiedWorkingDirectory: string | null = null;
    if (parsed.workingDirectory) {
      try {
        verifiedWorkingDirectory = await this.deps.verifyWorkingDirectoryGrant(parsed.workingDirectory);
      } catch {
        throw new MapDraftError('RUN_NOT_AUTHORIZED', 'The desktop working-directory grant is not authorized.');
      }
    }
    const conversationId = (this.deps.randomId ?? randomUUID)();
    const created = this.deps.store.inTransaction((db) => {
      const racedReplay = this.findWitness(parsed.idempotencyKey, db);
      if (racedReplay) return this.replay(racedReplay, witnessDigest, witnessJson);
      this.deps.store.createProjectInTransaction({ project: parsed, primaryConversationId: conversationId, verifiedWorkingDirectory });
      if (cartography) db.prepare('INSERT INTO project_cartography (project_id, cartography_id) VALUES (?, ?)')
        .run(parsed.projectId, cartography.id);
      const project = this.deps.sourceImportService.prepareImportInTransaction(db, parsed.projectId, {
        source: parsed.source,
        designRequirement: parsed.designRequirement,
        idempotencyKey: parsed.idempotencyKey,
      }, new Date().toISOString());
      db.prepare("INSERT INTO map_design_initial_runs (project_id, conversation_id, prompt, status) VALUES (?, ?, ?, 'pending')")
        .run(parsed.projectId, conversationId, parsed.designRequirement);
      const pinned = new CartographyService(this.deps.store).forProject(parsed.projectId);
      const boundCartography = pinned ? CartographySummarySchema.parse(pinned) : undefined;
      const output = MapDesignProjectCreateOutputSchema.parse({ project, conversationId, title: parsed.title, runtime: parsed.runtime, ...(boundCartography ? { cartography: boundCartography } : {}) });
      db.prepare(`INSERT INTO map_design_idempotency (
        project_id, operation, idempotency_key, request_digest, canonical_request_json,
        canonical_request_digest, response_json, created_at
      ) VALUES (?, 'project.create', ?, ?, ?, ?, ?, ?)`)
        .run(parsed.projectId, parsed.idempotencyKey, witnessDigest, witnessJson, witnessDigest, canonicalJson(output), new Date().toISOString());
      return output;
    });

    try {
      if (!this.deps.importJobRunner.enqueue(parsed.projectId)) {
        return this.persistEnqueueFailure(parsed.projectId, parsed.idempotencyKey, created);
      }
      return created;
    } catch {
      return this.persistEnqueueFailure(parsed.projectId, parsed.idempotencyKey, created);
    }
  }

  list(): MapDesignProjectListOutput {
    return MapDesignProjectListOutputSchema.parse({ projects: this.deps.store.listProjects() });
  }

  listCartographies() { return new CartographyService(this.deps.store).list(); }
  deleteCartography(id: string) { return new CartographyService(this.deps.store).delete(id); }
  importCartography(input: unknown) { return new CartographyService(this.deps.store).import(input); }
  updateCartography(id: string, input: unknown) { return new CartographyService(this.deps.store).updateMetadata(id, input); }
  getCartography(id: string) { return new CartographyService(this.deps.store).get(id); }

  async get(projectId: string): Promise<MapDesignProjectCreateOutput> {
    const local = this.deps.store.getProject(projectId);
    if (!local) throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
    const project = await this.deps.queryService.getProject(projectId);
    if (project.lifecycle === 'ready') await this.deps.ensureInitialRun?.(projectId);
    const document = new CartographyService(this.deps.store).forProject(projectId);
    const cartography = document ? CartographySummarySchema.parse(document) : undefined;
    return MapDesignProjectCreateOutputSchema.parse({ project, conversationId: local.primaryConversationId, title: local.title, runtime: local.runtime, ...(cartography ? { cartography } : {}) });
  }

  getConversation(projectId: string): MapDesignConversation {
    const local = this.deps.store.getProject(projectId);
    if (!local) throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
    if (!local.primaryConversationId) throw new MapDraftError('NOT_FOUND', 'The map conversation was not found.');
    const conversation = this.deps.store.getConversation(local.primaryConversationId);
    if (!conversation) throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
    return conversation;
  }

  delete(projectId: string): boolean {
    return this.deps.store.deleteProject(projectId);
  }

  private findWitness(idempotencyKey: string, db?: Database.Database): ProjectCreateWitness | null {
    if (!db) return this.deps.store.inTransaction((database) => this.findWitness(idempotencyKey, database));
    const row = db.prepare(`SELECT canonical_request_digest AS canonicalRequestDigest,
      canonical_request_json AS canonicalRequestJson, response_json AS responseJson
      FROM map_design_idempotency WHERE operation = 'project.create' AND idempotency_key = ?`).get(idempotencyKey) as ProjectCreateWitness | undefined;
    return row ?? null;
  }

  private replay(witness: ProjectCreateWitness, digest: string, json: string): MapDesignProjectCreateOutput {
    if (witness.canonicalRequestDigest !== digest || witness.canonicalRequestJson !== json) {
      throw new MapDraftError('IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.');
    }
    try { return MapDesignProjectCreateOutputSchema.parse(JSON.parse(witness.responseJson)); } catch {
      throw new MapDraftError('INTERNAL', 'The map project request failed.');
    }
  }

  private persistEnqueueFailure(projectId: string, idempotencyKey: string, created: MapDesignProjectCreateOutput): MapDesignProjectCreateOutput {
    const now = new Date().toISOString();
    const failed = MapDesignProjectCreateOutputSchema.parse({
      ...created,
      project: { ...created.project, lifecycle: 'failed', failure: { code: 'IMPORT_ENQUEUE_FAILED', message: 'Map import enqueue failed.' }, updatedAt: now },
    });
    this.deps.store.inTransaction((db) => {
      db.prepare(`UPDATE map_design_projects SET lifecycle_state = 'failed', failure_code = ?, failure_message = ?, updated_at = ? WHERE project_id = ?`)
        .run('IMPORT_ENQUEUE_FAILED', 'Map import enqueue failed.', now, projectId);
      db.prepare(`UPDATE map_design_import_jobs SET status = 'failed', finished_at = ?, failure_code = ?, failure_message = ? WHERE project_id = ?`)
        .run(now, 'IMPORT_ENQUEUE_FAILED', 'Map import enqueue failed.', projectId);
      db.prepare(`UPDATE map_design_idempotency SET response_json = ? WHERE project_id = ? AND operation = 'project.create' AND idempotency_key = ?`)
        .run(canonicalJson(failed), projectId, idempotencyKey);
    });
    return failed;
  }
}

function sanitizedRequest(input: MapDesignProjectCreateInput): Omit<MapDesignProjectCreateInput, 'workingDirectory'> & { workingDirectory?: { path: string } } {
  const { workingDirectory, ...rest } = input;
  return workingDirectory ? { ...rest, workingDirectory: { path: workingDirectory.path } } : rest;
}
