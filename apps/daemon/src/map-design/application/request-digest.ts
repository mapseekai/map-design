import { blake3Digest, canonicalJsonBytes } from '../storage/canonical-json.js';

/** BLAKE3 identity for a parsed MapDesign request; object insertion order is irrelevant. */
export function requestDigest(input: unknown): string {
  return blake3Digest(canonicalJsonBytes(input));
}
