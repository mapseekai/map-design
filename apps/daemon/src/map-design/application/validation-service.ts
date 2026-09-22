import {
  MapValidateInputSchema,
  MapValidateOutputSchema,
  type MapValidateInput,
  type MapValidateOutput,
} from '@mapseekai/map-design-contracts';
import type { MapDesignBlobStore, MapDesignProjectRepository } from '../storage/types.js';
import type { LoadedMapDesignSystem } from '../validation/design-system-loader.js';
import { MapDraftError, invalidInput } from './errors.js';
import { assertCurrentMapSnapshot, loadReadyMapSnapshot, readyMapProject, type ReadyMapSnapshot } from './map-ready-snapshot.js';
import { validateMapSnapshot } from './map-validation-cache.js';

export interface MapDesignValidationServiceDependencies {
  repository: MapDesignProjectRepository;
  blobStore: MapDesignBlobStore;
  loadDesignSystem(input: { id: string; digest: string }): Promise<LoadedMapDesignSystem>;
}

export class MapDesignValidationService {
  constructor(private readonly deps: MapDesignValidationServiceDependencies) {}

  async validate(projectId: string, input: unknown | MapValidateInput): Promise<MapValidateOutput> {
    let parsed: MapValidateInput;
    try {
      parsed = MapValidateInputSchema.parse(input);
    } catch {
      throw invalidInput();
    }

    const project = readyMapProject(this.deps.repository, projectId);
    if (project.draftRevision !== parsed.expectedRevision) {
      throw new MapDraftError('REVISION_CONFLICT', 'The map draft revision has changed.', {
        retryable: true,
        details: { currentRevision: project.draftRevision },
      });
    }

    return this.validateSnapshot(await loadReadyMapSnapshot(this.deps, project));
  }

  validateSnapshot(snapshot: ReadyMapSnapshot): MapValidateOutput {
    assertCurrentMapSnapshot(this.deps.repository, snapshot.project);
    try {
      const result = validateMapSnapshot(snapshot.project.projectId, snapshot);
      return MapValidateOutputSchema.parse({
        draftRevision: snapshot.project.draftRevision,
        styleHash: snapshot.project.draftStyleHash,
        validationDigest: result.validationDigest,
        summary: result.summary,
        findings: result.findings,
      });
    } catch {
      throw new MapDraftError('INTERNAL', 'The map validation result is invalid.');
    }
  }

}
