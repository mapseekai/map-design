import {
  MapSourceManifestSchema,
  MapValidateInputSchema,
  MapValidateOutputSchema,
  SemanticDocumentSchema,
  type MapValidateInput,
  type MapValidateOutput,
} from '@mapseekai/map-design-contracts';
import type { StyleDocument } from 'maplibre-style-tools/core';

import type { MapDesignBlobStore, MapDesignProjectRecord, MapDesignProjectRepository } from '../storage/types.js';
import type { LoadedMapDesignSystem } from '../validation/design-system-loader.js';
import { validateMapDesign } from '../validation/map-validator.js';
import { MapDraftError, invalidInput, isMapDraftError } from './errors.js';

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

    const project = this.readyProject(projectId);
    if (project.draftRevision !== parsed.expectedRevision) {
      throw new MapDraftError('REVISION_CONFLICT', 'The map draft revision has changed.', {
        retryable: true,
        details: { currentRevision: project.draftRevision },
      });
    }

    let validationInput: Parameters<typeof validateMapDesign>[0];
    try {
      const [style, semanticsValue, manifestValue, designSystem] = await Promise.all([
        this.deps.blobStore.getJson<StyleDocument>(projectId, 'styles', project.draftStyleDigest!),
        this.deps.blobStore.getJson<unknown>(projectId, 'semantics', project.draftSemanticDigest!),
        this.deps.blobStore.getJson<unknown>(projectId, 'sources', project.sourceManifestDigest!),
        this.deps.loadDesignSystem({ id: project.designSystemId, digest: project.designSystemDigest }),
      ]);
      if (designSystem.id !== project.designSystemId || designSystem.digest !== project.designSystemDigest) {
        throw new MapDraftError('DESIGN_SYSTEM_VIOLATION', 'The project design system is unavailable.');
      }
      validationInput = {
        style,
        semantics: SemanticDocumentSchema.parse(semanticsValue),
        sourceManifest: MapSourceManifestSchema.parse(manifestValue),
        designSystem,
      };
    } catch (error) {
      if (isMapDraftError(error)) throw error;
      throw new MapDraftError('SOURCE_UNAVAILABLE', 'The current map draft could not be loaded.');
    }

    try {
      const result = validateMapDesign(validationInput);
      return MapValidateOutputSchema.parse({
        draftRevision: project.draftRevision,
        styleHash: project.draftStyleHash,
        validationDigest: result.validationDigest,
        summary: result.summary,
        findings: result.findings,
      });
    } catch {
      throw new MapDraftError('INTERNAL', 'The map validation result is invalid.');
    }
  }

  private readyProject(projectId: string): MapDesignProjectRecord {
    const project = this.deps.repository.get(projectId);
    if (!project) throw new MapDraftError('NOT_FOUND', 'The map project was not found.');
    if (project.lifecycleState !== 'ready' || !project.sourceManifestDigest || !project.draftStyleDigest
      || !project.draftStyleHash || !project.draftSemanticDigest) {
      throw new MapDraftError('PROJECT_NOT_READY', 'The map project is not ready.');
    }
    return project;
  }
}
