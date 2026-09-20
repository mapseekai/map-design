import {
  MapSourceManifestSchema,
  MapValidateOutputSchema,
  MapRevisionSchema,
  SemanticDocumentSchema,
  assertMapDesignStyleResourceUrls,
  type MapRevision,
  type MapSourceManifest,
  type MapValidateOutput,
} from '@mapseekai/map-design-contracts';
import { sha256CanonicalJson } from 'maplibre-style-tools/bridge';
import { validateStyleDocument, type StyleDocument } from 'maplibre-style-tools/core';

import type {
  MapDesignBlobStore,
  MapDesignProjectRepository,
  MapDesignRevisionRecord,
} from '../storage/types.js';
import type { LoadedMapDesignSystem } from '../validation/design-system-loader.js';
import type { MapValidationResult } from '../validation/map-validator.js';
import {
  MapAttestationSchema,
  type MapImportAttestation,
  type MapRevisionAttestation,
} from './attestation.js';
import { MapDraftError, isMapDraftError } from './errors.js';

export interface VerifiedRevisionEvidence {
  revision: MapDesignRevisionRecord;
  style: StyleDocument;
  semantics: ReturnType<typeof SemanticDocumentSchema.parse>;
  sourceManifest: MapSourceManifest;
  designSystem: LoadedMapDesignSystem;
  attestation: MapRevisionAttestation | MapImportAttestation;
}

export interface RevisionEvidenceDependencies {
  repository: Pick<MapDesignProjectRepository, 'getRevision'>;
  blobStore: MapDesignBlobStore;
  loadDesignSystem(input: { id: string; digest: string }): Promise<LoadedMapDesignSystem>;
}

export async function loadRevisionEvidence(
  projectId: string,
  revisionNumber: number,
  dependencies: RevisionEvidenceDependencies,
): Promise<VerifiedRevisionEvidence> {
  const revision = dependencies.repository.getRevision(projectId, revisionNumber);
  if (!revision) throw new MapDraftError('NOT_FOUND', 'The map revision was not found.');

  try {
    const [styleValue, semanticValue, sourceValue, attestationValue] = await Promise.all([
      dependencies.blobStore.getJson<unknown>(projectId, 'styles', revision.styleDigest),
      dependencies.blobStore.getJson<unknown>(projectId, 'semantics', revision.semanticDigest),
      dependencies.blobStore.getJson<unknown>(projectId, 'sources', revision.sourceManifestDigest),
      dependencies.blobStore.getJson<unknown>(projectId, 'attestations', revision.attestationDigest),
    ]);
    const styleResult = validateStyleDocument(styleValue);
    if (!styleResult.ok) throw new TypeError('invalid historical style');
    const style = styleResult.style;
    try {
      assertMapDesignStyleResourceUrls(style, projectId);
    } catch {
      throw new MapDraftError(
        'STYLE_INVALID',
        'The historical map style contains an unsafe resource URL.',
      );
    }
    const semantics = SemanticDocumentSchema.parse(semanticValue);
    const sourceManifest = MapSourceManifestSchema.parse(sourceValue);
    const attestation = MapAttestationSchema.parse(attestationValue);
    if (await sha256CanonicalJson(style) !== revision.styleHash) {
      throw new TypeError('historical style hash mismatch');
    }
    const designSystemBinding = verifyAttestation(revision, attestation);
    const designSystem = await dependencies.loadDesignSystem(designSystemBinding);
    if (designSystem.id !== designSystemBinding.id || designSystem.digest !== designSystemBinding.digest) {
      throw new TypeError('historical design system binding mismatch');
    }
    return { revision, style, semantics, sourceManifest, designSystem, attestation };
  } catch (error) {
    if (isMapDraftError(error)) throw error;
    throw new MapDraftError(
      'SOURCE_UNAVAILABLE',
      'The historical map revision evidence is unavailable.',
    );
  }
}

export function publicRevisionFromRecord(record: MapDesignRevisionRecord): MapRevision {
  return MapRevisionSchema.parse({
    revision: record.revision,
    draftRevision: record.draftRevision,
    styleHash: record.styleHash,
    sourceDigest: record.sourceManifestDigest,
    semanticDigest: record.semanticDigest,
    designSystemDigest: record.designSystemDigest,
    previewId: record.previewId,
    attestationDigest: record.attestationDigest,
    committedAt: record.createdAt,
  });
}

export function validationOutputForRevision(
  evidence: VerifiedRevisionEvidence,
  validation: MapValidationResult,
): MapValidateOutput {
  return MapValidateOutputSchema.parse({
    draftRevision: evidence.revision.draftRevision,
    styleHash: evidence.revision.styleHash,
    validationDigest: validation.validationDigest,
    summary: validation.summary,
    findings: validation.findings,
  });
}

function verifyAttestation(
  revision: MapDesignRevisionRecord,
  attestation: MapRevisionAttestation | MapImportAttestation,
): { id: string; digest: string } {
  if (revision.revision === 0) {
    if (attestation.kind !== 'import'
      || revision.previewId !== null
      || revision.runId !== null
      || attestation.projectId !== revision.projectId
      || attestation.revision !== revision.revision
      || attestation.sourceManifestDigest !== revision.sourceManifestDigest
      || attestation.styleDigest !== revision.styleDigest
      || attestation.styleHash !== revision.styleHash
      || attestation.semanticDigest !== revision.semanticDigest
      || attestation.designSystemDigest !== revision.designSystemDigest
      || attestation.importedAt !== revision.createdAt) {
      throw new TypeError('historical import attestation mismatch');
    }
    return { id: attestation.designSystemId, digest: attestation.designSystemDigest };
  }
  if (attestation.kind !== 'runtime'
    || attestation.projectId !== revision.projectId
    || attestation.revision !== revision.revision
    || attestation.draftRevision !== revision.draftRevision
    || attestation.style.digest !== revision.styleDigest
    || attestation.style.hash !== revision.styleHash
    || attestation.semantics.digest !== revision.semanticDigest
    || attestation.source.manifestDigest !== revision.sourceManifestDigest
    || attestation.designSystem.digest !== revision.designSystemDigest
    || attestation.preview.id !== revision.previewId
    || attestation.run.id !== revision.runId
    || attestation.committedAt !== revision.createdAt) {
    throw new TypeError('historical runtime attestation mismatch');
  }
  return { id: attestation.designSystem.id, digest: attestation.designSystem.digest };
}
