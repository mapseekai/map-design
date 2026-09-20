import { describe, expect, it } from 'vitest';

import {
  MapRevisionAttestationSchema,
  createMapImportAttestation,
  parseMapRevisionProvenance,
} from '../../../src/map-design/application/attestation.js';

const digest = 'a'.repeat(64);

describe('MapDesign attestation union', () => {
  // Mutation caught: accepting the legacy untagged runtime shape makes import and runtime evidence ambiguous.
  it('requires runtime attestations to carry kind runtime', () => {
    expect(() => MapRevisionAttestationSchema.parse({
      schemaVersion: 1,
      kind: 'runtime',
      projectId: 'project-1',
      revision: 1,
      draftRevision: 2,
      style: { digest, hash: digest },
      semantics: { digest },
      source: { manifestDigest: digest },
      designSystem: { id: 'quiet-walking', digest },
      preview: { id: 'preview-1', pngDigest: digest, reportDigest: digest, validationDigest: digest },
      runtime: { id: 'codex', version: '1.0.0', adapter: 'cli' },
      run: { id: 'run-1' },
      model: { id: 'openai/gpt-5', provider: 'openai' },
      committedAt: '2026-08-14T00:00:00.000Z',
    })).not.toThrow();
  });

  it('accepts a bounded slash-delimited CLI version without accepting path-like provenance', () => {
    expect(parseMapRevisionProvenance({
      runtime: { id: 'oh-my-pi', version: 'omp/18.1.6', adapter: 'omp-rpc' },
      model: { id: 'default', provider: 'oh-my-pi' },
    })).toEqual({
      runtime: { id: 'oh-my-pi', version: 'omp/18.1.6', adapter: 'omp-rpc' },
      model: { id: 'default', provider: 'oh-my-pi' },
    });

    for (const version of [
      'omp//18.1.6',
      'omp/../18.1.6',
      'omp/18.1.6/',
      'https://example.com/omp/18.1.6',
    ]) {
      expect(() => parseMapRevisionProvenance({
        runtime: { id: 'oh-my-pi', version, adapter: 'omp-rpc' },
        model: { id: 'default', provider: 'oh-my-pi' },
      })).toThrow('invalid map revision attestation');
    }
  });

  // Mutation caught: allowing runtime provenance on Revision 0 weakens its source-import evidence binding.
  it('creates strict Revision 0 import evidence and rejects extra runtime fields', () => {
    expect(createMapImportAttestation({
      version: 1,
      kind: 'import',
      projectId: 'project-1',
      revision: 0,
      sourceManifestDigest: digest,
      styleDigest: digest,
      styleHash: digest,
      semanticDigest: digest,
      designSystemId: 'quiet-walking',
      designSystemDigest: digest,
      importedAt: '2026-08-14T00:00:00.000Z',
    })).toMatchObject({ kind: 'import', revision: 0 });
    expect(() => createMapImportAttestation({
      version: 1,
      kind: 'import',
      projectId: 'project-1',
      revision: 0,
      sourceManifestDigest: digest,
      styleDigest: digest,
      styleHash: digest,
      semanticDigest: digest,
      designSystemId: 'quiet-walking',
      designSystemDigest: digest,
      importedAt: '2026-08-14T00:00:00.000Z',
      runtime: { id: 'codex' },
    })).toThrow('invalid map revision attestation');
  });
});
