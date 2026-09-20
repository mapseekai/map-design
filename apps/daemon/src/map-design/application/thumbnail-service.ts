import type Database from 'better-sqlite3';
import { MapThumbnailInputSchema } from '@mapseekai/contracts';
import { MapIdentifierSchema } from '@mapseekai/map-design-contracts';
import { invalidInput, MapDraftError } from './errors.js';
import { isValidCanvasPng } from './screenshot-service.js';

export class MapThumbnailService {
  constructor(private readonly db: Database.Database) {}

  save(projectId: string, value: unknown): void {
    this.requireProject(projectId);
    const parsed = MapThumbnailInputSchema.safeParse(value);
    if (!parsed.success || parsed.data.capturedAt > Date.now() + 60_000) throw invalidInput();
    const input = parsed.data;
    const png = Buffer.from(input.pngBase64, 'base64');
    if (!isValidCanvasPng(png, input.width, input.height)) throw invalidInput();
    this.db.prepare(`INSERT INTO map_design_thumbnails (project_id, png, captured_at) VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET png=excluded.png, captured_at=excluded.captured_at
      WHERE excluded.captured_at >= map_design_thumbnails.captured_at`).run(projectId, png, input.capturedAt);
  }

  read(projectId: string): Buffer | null {
    this.requireProject(projectId);
    return (this.db.prepare('SELECT png FROM map_design_thumbnails WHERE project_id=?')
      .get(projectId) as { png: Buffer } | undefined)?.png ?? null;
  }

  private requireProject(projectId: string): void {
    if (!MapIdentifierSchema.safeParse(projectId).success) throw invalidInput();
    if (!this.db.prepare('SELECT 1 FROM map_design_projects WHERE project_id=?').get(projectId)) {
      throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
    }
  }
}
