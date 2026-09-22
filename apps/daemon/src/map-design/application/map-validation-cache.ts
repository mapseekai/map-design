import { blake3Digest, canonicalJsonBytes } from '../storage/canonical-json.js';
import { validateMapDesign, type MapValidationInput, type MapValidationResult } from '../validation/map-validator.js';

interface CachedValidation {
  readonly result: MapValidationResult;
  readonly byteLength: number;
}

const MAX_ENTRIES = 64;
const MAX_BYTES = 4 * 1024 * 1024;
const results = new Map<string, CachedValidation>();
let bytes = 0;
let hits = 0;
let misses = 0;

/** Callers still load authoritative blobs and check the current revision before reusing validation. */
export function validateMapSnapshot(projectId: string, input: MapValidationInput): MapValidationResult {
  const key = blake3Digest(canonicalJsonBytes({ projectId, style: input.style, semantics: input.semantics,
    sourceManifest: input.sourceManifest, designSystem: input.designSystem,
    ...(input.runtimePolicy ? { runtimePolicy: input.runtimePolicy } : {}) }));
  const cached = results.get(key);
  if (cached) {
    hits += 1;
    results.delete(key);
    results.set(key, cached);
    return structuredClone(cached.result);
  }
  misses += 1;
  const result = validateMapDesign(input);
  const byteLength = canonicalJsonBytes(result).byteLength;
  if (byteLength <= MAX_BYTES) {
    while (results.size >= MAX_ENTRIES || bytes + byteLength > MAX_BYTES) {
      const oldest = results.entries().next().value;
      if (!oldest) break;
      results.delete(oldest[0]);
      bytes -= oldest[1].byteLength;
    }
    results.set(key, { result: structuredClone(result), byteLength });
    bytes += byteLength;
  }
  return result;
}

export function getMapValidationCacheStats(): Readonly<{ hits: number; misses: number; entries: number; bytes: number }> {
  return { hits, misses, entries: results.size, bytes };
}
