import {
  MapDigestSchema,
  MapIdentifierSchema,
  MapSafeRevisionSchema,
  MapShortIdentifierSchema,
  MapTimestampSchema,
  StyleHashSchema,
} from '@mapseekai/map-design-contracts';

import { canonicalJson } from '../storage/canonical-json.js';

/** Immutable, secret-free evidence bound to one committed MapDesign revision. */
export interface MapRevisionAttestation {
  schemaVersion: 1;
  kind: 'runtime';
  projectId: string;
  revision: number;
  draftRevision: number;
  style: { digest: string; hash: string };
  semantics: { digest: string };
  source: { manifestDigest: string };
  designSystem: { id: string; digest: string };
  preview: { id: string; pngDigest: string; reportDigest: string; validationDigest: string };
  runtime: { id: string; version: string; adapter: string };
  run: { id: string };
  model: { id: string; provider: string };
  committedAt: string;
}

export interface MapImportAttestation {
  version: 1;
  kind: 'import';
  projectId: string;
  revision: 0;
  sourceManifestDigest: string;
  styleDigest: string;
  styleHash: string;
  semanticDigest: string;
  designSystemId: string;
  designSystemDigest: string;
  importedAt: string;
}

export interface MapRevisionProvenance {
  runtime: { id: string; version: string; adapter: string };
  model: { id: string; provider: string };
}

export const MapRevisionAttestationSchema = {
  parse(input: unknown): MapRevisionAttestation {
    const value = exactObject(input, [
      'schemaVersion', 'kind', 'projectId', 'revision', 'draftRevision', 'style', 'semantics',
      'source', 'designSystem', 'preview', 'runtime', 'run', 'model', 'committedAt',
    ]);
    if (value.schemaVersion !== 1) invalidAttestation();
    if (value.kind !== 'runtime') invalidAttestation();
    const revision = MapSafeRevisionSchema.parse(value.revision);
    if (revision === 0) invalidAttestation();
    const style = exactObject(value.style, ['digest', 'hash']);
    const semantics = exactObject(value.semantics, ['digest']);
    const source = exactObject(value.source, ['manifestDigest']);
    const designSystem = exactObject(value.designSystem, ['id', 'digest']);
    const preview = exactObject(value.preview, ['id', 'pngDigest', 'reportDigest', 'validationDigest']);
    const run = exactObject(value.run, ['id']);
    const provenance = parseMapRevisionProvenance({ runtime: value.runtime, model: value.model });
    return {
      schemaVersion: 1,
      kind: 'runtime',
      projectId: MapIdentifierSchema.parse(value.projectId),
      revision,
      draftRevision: MapSafeRevisionSchema.parse(value.draftRevision),
      style: {
        digest: MapDigestSchema.parse(style.digest),
        hash: StyleHashSchema.parse(style.hash),
      },
      semantics: { digest: MapDigestSchema.parse(semantics.digest) },
      source: { manifestDigest: MapDigestSchema.parse(source.manifestDigest) },
      designSystem: {
        id: MapIdentifierSchema.parse(designSystem.id),
        digest: MapDigestSchema.parse(designSystem.digest),
      },
      preview: {
        id: MapIdentifierSchema.parse(preview.id),
        pngDigest: MapDigestSchema.parse(preview.pngDigest),
        reportDigest: MapDigestSchema.parse(preview.reportDigest),
        validationDigest: MapDigestSchema.parse(preview.validationDigest),
      },
      runtime: provenance.runtime,
      run: { id: MapIdentifierSchema.parse(run.id) },
      model: provenance.model,
      committedAt: MapTimestampSchema.parse(value.committedAt),
    };
  },
};

export const MapImportAttestationSchema = {
  parse(input: unknown): MapImportAttestation {
    const value = exactObject(input, [
      'version', 'kind', 'projectId', 'revision', 'sourceManifestDigest', 'styleDigest',
      'styleHash', 'semanticDigest', 'designSystemId', 'designSystemDigest', 'importedAt',
    ]);
    if (value.version !== 1 || value.kind !== 'import' || value.revision !== 0) invalidAttestation();
    return {
      version: 1,
      kind: 'import',
      projectId: MapIdentifierSchema.parse(value.projectId),
      revision: 0,
      sourceManifestDigest: MapDigestSchema.parse(value.sourceManifestDigest),
      styleDigest: MapDigestSchema.parse(value.styleDigest),
      styleHash: StyleHashSchema.parse(value.styleHash),
      semanticDigest: MapDigestSchema.parse(value.semanticDigest),
      designSystemId: MapIdentifierSchema.parse(value.designSystemId),
      designSystemDigest: MapDigestSchema.parse(value.designSystemDigest),
      importedAt: MapTimestampSchema.parse(value.importedAt),
    };
  },
};

export const MapAttestationSchema = {
  parse(input: unknown): MapRevisionAttestation | MapImportAttestation {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) invalidAttestation();
    return (input as { kind?: unknown }).kind === 'import'
      ? MapImportAttestationSchema.parse(input)
      : MapRevisionAttestationSchema.parse(input);
  },
};

export function createMapRevisionAttestation(input: unknown): MapRevisionAttestation {
  return MapRevisionAttestationSchema.parse(input);
}

export function createMapImportAttestation(input: unknown): MapImportAttestation {
  return MapImportAttestationSchema.parse(input);
}

/** Shared field-specific parser for both trusted-run authorization and immutable attestation parsing. */
export function parseMapRevisionProvenance(input: unknown): MapRevisionProvenance {
  const value = exactObject(input, ['runtime', 'model']);
  const runtime = exactObject(value.runtime, ['id', 'version', 'adapter']);
  const model = exactObject(value.model, ['id', 'provider']);
  return {
    runtime: {
      id: controlledIdentifier(runtime.id),
      version: controlledVersion(runtime.version),
      adapter: controlledAdapter(runtime.adapter),
    },
    model: {
      id: controlledModelId(model.id),
      provider: controlledIdentifier(model.provider),
    },
  };
}

/** Canonical serialization used to demonstrate stable byte identity independently of object key order. */
export function serializeMapRevisionAttestation(input: unknown): string {
  return canonicalJson(createMapRevisionAttestation(input));
}

function exactObject(input: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalidAttestation();
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) invalidAttestation();
  return value;
}

function controlledIdentifier(input: unknown): string {
  const value = shortProvenance(input);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) invalidAttestation();
  return value;
}

function controlledAdapter(input: unknown): string {
  const value = shortProvenance(input);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,127}$/u.test(value)) invalidAttestation();
  return value;
}

function controlledVersion(input: unknown): string {
  const value = shortProvenance(input);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._+\-:@()/]{0,127}$/u.test(value)
    || !/[A-Za-z0-9)]$/u.test(value)
    || /[._+\-:@/]{2}/u.test(value)
    || !hasSimpleBalancedParentheses(value)) {
    invalidAttestation();
  }
  return value;
}

function hasSimpleBalancedParentheses(value: string): boolean {
  let depth = 0;
  let pairs = 0;
  for (const character of value) {
    if (character === '(') {
      depth += 1;
      pairs += 1;
      if (depth > 1 || pairs > 1) return false;
    } else if (character === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !value.includes('()');
}

function controlledModelId(input: unknown): string {
  if (typeof input !== 'string' || input.trim() !== input || input.length === 0 || input.length > 257) {
    invalidAttestation();
  }
  rejectUnsafeProvenance(input);
  const segments = input.split('/');
  if (segments.length > 8 || segments.some((segment) => segment === '.' || segment === '..'
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/u.test(segment))) {
    invalidAttestation();
  }
  return input;
}

function shortProvenance(input: unknown): string {
  const value = MapShortIdentifierSchema.parse(input);
  if (value !== input) invalidAttestation();
  rejectUnsafeProvenance(value);
  return value;
}

function rejectUnsafeProvenance(value: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(value)
    || /(?:https?:\/\/|file:\/\/|www\.)/iu.test(value)
    || /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/u.test(value)
    || /\\\\[^\\\s]+[\\/]/u.test(value)
    || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value)
    || /(?:^|[\s(])\/(?:Users|home|root|private|tmp|var|etc|opt|usr|Volumes|mnt|srv)(?:[\/\s]|$)/u.test(value)
    || /\bbearer\s+\S+/iu.test(value)
    || /\b(?:api(?:[\s_-]+)?key|(?:(?:access|auth)[\s_-]+)?token|secret|password|credential)\s*[:=]\s*\S+/iu.test(value)
    || /\bsk-[A-Za-z0-9_-]{8,}\b/u.test(value)
    || /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/u.test(value)) {
    invalidAttestation();
  }
}

function invalidAttestation(): never {
  throw new TypeError('invalid map revision attestation');
}
