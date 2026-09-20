import type Database from 'better-sqlite3';
import {
  MapStyleEditInputSchema,
  MapStyleDocumentInputSchema,
  buildMapStyleEditPatch,
  MapApplyTransactionOutputSchema,
  type MapApplyTransactionOutput,
  type MapStyleEditInput,
} from '@mapseekai/map-design-contracts';
import type { StyleDocument } from 'maplibre-style-tools/core';

import { MapDraftError, invalidInput } from './errors.js';
import type { MapDraftMutationContext, MapDraftService } from './draft-service.js';
import { canonicalJson } from '../storage/canonical-json.js';
import { requestDigest } from './request-digest.js';

type ProjectRow = { lifecycle: string; revision: number; hash: string | null };

export class MapDesignStyleEditService {
  constructor(private readonly deps: {
    db: Database.Database;
    getStyle(projectId: string): Promise<StyleDocument>;
    applyTransaction: MapDraftService['applyTransaction'];
    replaceStyle?: MapDraftService['replaceStyle'];
    isProjectRunning(projectId: string): boolean;
  }) {}

  async applyDocument(projectId: string, requestId: string, value: unknown): Promise<MapApplyTransactionOutput> {
    const parsed = MapStyleDocumentInputSchema.safeParse(value);
    if (!parsed.success) throw invalidInput();
    if (!this.deps.replaceStyle) throw new MapDraftError('INTERNAL', 'Style replacement is unavailable.');
    return this.deps.replaceStyle({
      kind: 'ui', projectId, requestId,
      isProjectRunning: () => this.deps.isProjectRunning(projectId),
      requestWitness: { digest: requestDigest(parsed.data), json: canonicalJson(parsed.data) },
    }, parsed.data);
  }

  async apply(projectId: string, requestId: string, value: unknown): Promise<MapApplyTransactionOutput> {
    const parsed = MapStyleEditInputSchema.safeParse(value);
    if (!parsed.success) throw invalidInput();
    const input = parsed.data;
    const requestJson = canonicalJson(input);
    const digest = requestDigest(input);
    const replay = this.replay(projectId, input.idempotencyKey, digest, requestJson);
    if (replay) return replay;
    this.assertSnapshot(projectId, input);
    this.assertIdle(projectId);
    const style = await this.deps.getStyle(projectId);
    const layer = validateTarget(input, style);
    let patch: ReturnType<typeof buildMapStyleEditPatch>;
    try { patch = buildMapStyleEditPatch(layer, input); }
    catch (error) {
      if (error instanceof TypeError) throw invalidInput();
      throw error;
    }
    const operation = {
      op: 'setLayerProperties',
      layerId: layer.id,
      ...(Object.keys(patch.paint).length ? { paint: patch.paint } : {}),
      ...(Object.keys(patch.layout).length ? { layout: patch.layout } : {}),
    };
    const context: MapDraftMutationContext = {
      kind: 'ui', projectId, requestId,
      isProjectRunning: () => this.deps.isProjectRunning(projectId),
      requestWitness: { digest, json: requestJson },
    };
    return await this.deps.applyTransaction(context, {
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      transaction: { operations: [operation] },
      intentSummary: `Edit ${layer.id} style`,
    });
  }

  private project(projectId: string): ProjectRow {
    const row = this.deps.db.prepare(`SELECT lifecycle_state AS lifecycle, draft_revision AS revision,
      draft_style_hash AS hash FROM map_design_projects WHERE project_id = ?`).get(projectId) as ProjectRow | undefined;
    if (!row) throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
    return row;
  }

  private assertSnapshot(projectId: string, input: MapStyleEditInput): void {
    const project = this.project(projectId);
    if (project.lifecycle !== 'ready') throw new MapDraftError('PROJECT_NOT_READY', 'The map project is not ready.');
    if (project.revision !== input.expectedRevision || project.hash !== input.styleHash) {
      throw new MapDraftError('REVISION_CONFLICT', 'The map draft has changed. Pick the target again.', {
        retryable: true, details: { currentRevision: project.revision },
      });
    }
  }

  private assertIdle(projectId: string): void {
    if (this.deps.isProjectRunning(projectId)) {
      throw new MapDraftError('RUN_NOT_AUTHORIZED', 'A map run is active for this project.', {
        retryable: true, details: { reason: 'ACTIVE_RUN' },
      });
    }
  }

  private replay(projectId: string, key: string, digest: string, json: string): MapApplyTransactionOutput | null {
    const row = this.deps.db.prepare(`SELECT canonical_request_digest AS digest, canonical_request_json AS json,
      response_json AS response FROM map_design_idempotency
      WHERE project_id = ? AND operation = 'map_apply_transaction' AND idempotency_key = ?`).get(projectId, key) as
      { digest: string | null; json: string | null; response: string } | undefined;
    if (!row) return null;
    if (row.digest !== digest || row.json !== json) {
      throw new MapDraftError('IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different request.');
    }
    try { return MapApplyTransactionOutputSchema.parse(JSON.parse(row.response)); }
    catch { throw new MapDraftError('INTERNAL', 'The stored style edit receipt is invalid.'); }
  }
}

function validateTarget(input: MapStyleEditInput, style: StyleDocument): StyleDocument['layers'][number] {
  const { target } = input;
  const layer = style.layers.find((candidate) => candidate.id === target.layerId);
  const source = style.sources[target.sourceId];
  if (!layer || !('source' in layer) || layer.source !== target.sourceId || !source
    || ('source-layer' in layer ? layer['source-layer'] : undefined) !== target.sourceLayer
    || (source.type !== 'geojson' && source.type !== 'vector')) {
    throw new MapDraftError('REVISION_CONFLICT', 'The selected map feature has changed. Pick it again.');
  }
  if (input.scope === 'feature' && source.type === 'geojson' && source.generateId) {
    throw new MapDraftError('INVALID_INPUT', 'This feature has no stable identifier. Choose a category or layer scope.');
  }
  if (source.type === 'geojson' && typeof source.data === 'object' && source.data !== null) {
    const data = source.data;
    const raw: unknown[] = data.type === 'FeatureCollection' && Array.isArray(data.features)
      ? data.features : data.type === 'Feature' ? [data] : [];
    const features = raw.filter(isRecord);
    if (input.scope === 'feature') {
      const matches = features.filter((feature) => (typeof source.promoteId === 'string'
        ? isRecord(feature.properties) ? feature.properties[source.promoteId] : undefined : feature.id) === target.featureId);
      if (matches.length !== 1) throw new MapDraftError('INVALID_INPUT', 'The feature cannot be uniquely identified. Pick the target again.');
    }
    if (input.scope === 'similar' && !features.some((feature) => isRecord(feature.properties)
      && Object.hasOwn(feature.properties, input.match!.property)
      && feature.properties[input.match!.property] === input.match!.value)) {
      throw new MapDraftError('REVISION_CONFLICT', 'The selected feature category has changed. Pick the target again.');
    }
  }
  return layer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
