import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

import { MapDigestSchema, MapIdentifierSchema } from '@mapseekai/map-design-contracts';
import { parseCartographyDesignSystem, type CartographyDesignSystem, type LoadedMapDesignSystem } from '../validation/design-system-loader.js';
import { LEGACY_QUIET_WALKING_ID, loadLegacyDesignSystem } from '../validation/legacy-design-system.js';

export interface CartographyBinding { id: string; digest: string }
type Snapshot = { id: string; digest: string; source: string };

/** Persist full source bytes so an upgraded preset cannot invalidate pinned revisions. */
export function pinCartographyDocument(db: Database.Database, id: string, source: string): CartographyDesignSystem {
  const document = parseCartographyDesignSystem(id, source);
  db.prepare('INSERT OR IGNORE INTO map_design_cartography_snapshots (id, digest, source) VALUES (?, ?, ?)')
    .run(document.id, document.digest, document.source);
  const stored = db.prepare('SELECT source FROM map_design_cartography_snapshots WHERE id = ? AND digest = ?')
    .get(document.id, document.digest) as { source: string };
  if (stored.source !== source) throw new TypeError('Cartography snapshot integrity mismatch.');
  return document;
}

/** Register a real selectable preset; do not reclassify an identical existing user import. */
export function registerBundledCartography(db: Database.Database, document: CartographyDesignSystem): void {
  const id = createHash('sha256').update(document.source).digest('hex');
  db.prepare(`INSERT OR IGNORE INTO cartography_documents (id, name, description, version, source, updated_at, origin)
    VALUES (?, ?, '', ?, ?, NULL, 'preset')`).run(id, document.name, document.version, document.source);
  const stored = db.prepare('SELECT source FROM cartography_documents WHERE id = ?').get(id) as { source: string };
  if (stored.source !== document.source) throw new TypeError('Bundled cartography content digest mismatch.');
}

export function loadPinnedCartography(db: Database.Database, binding: CartographyBinding): LoadedMapDesignSystem {
  MapIdentifierSchema.parse(binding.id);
  MapDigestSchema.parse(binding.digest);
  const snapshot = db.prepare('SELECT id, digest, source FROM map_design_cartography_snapshots WHERE id = ? AND digest = ?')
    .get(binding.id, binding.digest) as Snapshot | undefined;
  if (snapshot) {
    const document = parseCartographyDesignSystem(snapshot.id, snapshot.source);
    if (document.digest !== binding.digest) throw new TypeError('Cartography snapshot digest mismatch.');
    return document;
  }
  const legacy = loadLegacyDesignSystem(binding.id, binding.digest);
  if (legacy) return legacy;
  throw new TypeError('The pinned CARTOGRAPHY.md is unavailable.');
}

/** The library SHA-256 ID and runtime BLAKE3 digest serve different contracts. */
export function selectProjectCartography(
  db: Database.Database, projectId: string, fallback: CartographyBinding,
): CartographyBinding {
  const row = db.prepare(`SELECT d.id, d.source FROM cartography_documents d
    JOIN project_cartography p ON p.cartography_id = d.id WHERE p.project_id = ?`)
    .get(projectId) as { id: string; source: string } | undefined;
  if (!row) return fallback;
  if (createHash('sha256').update(row.source).digest('hex') !== row.id) {
    throw new TypeError('Cartography library content digest mismatch.');
  }
  const document = pinCartographyDocument(db, row.id, row.source);
  return { id: document.id, digest: document.digest };
}

/**
 * Upgrade active bindings only. Historical revision rows, reports, attestations,
 * content blobs, and idempotency receipts remain byte-for-byte unchanged.
 * Unknown/custom legacy digests fail closed instead of silently changing meaning.
 */
export function migrateLegacyCartographyBindings(db: Database.Database, fallback: CartographyBinding): number {
  const migrate = db.transaction(() => {
    const rows = db.prepare(`SELECT project_id AS projectId, design_system_digest AS digest,
      draft_revision AS revision, lifecycle_state AS lifecycle FROM map_design_projects WHERE design_system_id = ?`)
      .all(LEGACY_QUIET_WALKING_ID) as Array<{ projectId: string; digest: string; revision: number; lifecycle: string }>;
    for (const row of rows) {
      if (!loadLegacyDesignSystem(LEGACY_QUIET_WALKING_ID, row.digest)) {
        throw new TypeError('Unrecognized legacy design-system digest; an explicit document migration is required.');
      }
      const binding = selectProjectCartography(db, row.projectId, fallback);
      const document = loadPinnedCartography(db, binding);
      if (document.format !== 'cartography') throw new TypeError('Migration requires a standard CARTOGRAPHY.md.');
      const nextRevision = row.revision + (row.lifecycle === 'ready' ? 1 : 0);
      if (!Number.isSafeInteger(nextRevision)) throw new TypeError('Map draft revision overflow.');
      const now = new Date().toISOString();
      db.prepare(`INSERT OR IGNORE INTO map_design_cartography_migrations
        (project_id, previous_id, previous_digest, cartography_id, cartography_digest, previous_draft_revision, migrated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(row.projectId, LEGACY_QUIET_WALKING_ID, row.digest, binding.id, binding.digest, row.revision, now);
      db.prepare(`UPDATE map_design_projects SET design_system_id = ?, design_system_digest = ?,
        draft_revision = ?, initial_validation_status = NULL, initial_validation_digest = NULL, updated_at = ?
        WHERE project_id = ? AND design_system_id = ? AND design_system_digest = ?`)
        .run(binding.id, binding.digest, nextRevision, now, row.projectId, LEGACY_QUIET_WALKING_ID, row.digest);
      db.prepare("UPDATE map_design_previews SET status = 'expired', updated_at = ? WHERE project_id = ? AND status IN ('requested', 'rendering', 'passed')")
        .run(now, row.projectId);
    }
    return rows.length;
  });
  return migrate.immediate();
}
