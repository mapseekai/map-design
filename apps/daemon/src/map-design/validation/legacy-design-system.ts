import { blake3Digest } from '../storage/canonical-json.js';
import type { CartographicQualityPolicy } from './cartographic-quality-validator.js';

/** Exact historical bytes only; this is NOT a CARTOGRAPHY.md parser or preset. */
export const LEGACY_QUIET_WALKING_SOURCE = "# Quiet walking\n\nDesign calm, pedestrian-first maps with restrained land colours, clear walking\nroutes, and labels that remain legible without overwhelming the map. Keep the\nvisual hierarchy focused on orientation and place discovery.\n\n```mapdesign-rules\n{\"version\":1,\"requiredSemanticRoles\":[\"background\",\"park\",\"pedestrian-road\",\"place-label\"],\"maxLabelLayerCount\":80,\"minimumContrastRatio\":4.5}\n```\n";
export const LEGACY_QUIET_WALKING_ID = 'quiet-walking';
export const LEGACY_QUIET_WALKING_DIGEST = blake3Digest(new TextEncoder().encode(LEGACY_QUIET_WALKING_SOURCE));

export interface LegacyMapDesignSystem {
  format: 'legacy-mapdesign';
  id: typeof LEGACY_QUIET_WALKING_ID;
  digest: string;
  name: string;
  source: string;
  policy: CartographicQualityPolicy;
}

/** Preserve verifiable old attestations without accepting arbitrary old-format input. */
export function loadLegacyDesignSystem(id: string, digest: string): LegacyMapDesignSystem | null {
  if (id !== LEGACY_QUIET_WALKING_ID || digest !== LEGACY_QUIET_WALKING_DIGEST) return null;
  return {
    format: 'legacy-mapdesign', id: LEGACY_QUIET_WALKING_ID, digest,
    name: 'Quiet walking (legacy revision)', source: LEGACY_QUIET_WALKING_SOURCE,
    policy: { version: 1, requiredSemanticRoles: ['background', 'park', 'pedestrian-road', 'place-label'], maxLabelLayerCount: 80, minimumContrastRatio: 4.5 },
  };
}
