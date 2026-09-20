import {readFileSync} from 'node:fs';
import {parseCartographyDesignSystem, type CartographyDesignSystem} from '../../../src/map-design/validation/design-system-loader.js';

export const TEST_CARTOGRAPHY_SOURCE = readFileSync(new URL('./design-systems/quiet-atlas/CARTOGRAPHY.md', import.meta.url), 'utf8');

/** Test-only overrides allow deterministic digest stubs; real storage verifies digests. */
export function testDesignSystem(overrides: Partial<Pick<CartographyDesignSystem, 'id' | 'digest' | 'name' | 'source'>> = {}): CartographyDesignSystem {
  const document = parseCartographyDesignSystem(overrides.id ?? 'quiet-atlas', overrides.source ?? TEST_CARTOGRAPHY_SOURCE);
  return {...document, ...overrides};
}
