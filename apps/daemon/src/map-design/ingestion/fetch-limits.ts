export type FetchPurpose =
  | 'document'
  | 'pmtiles-range'
  | 'tile'
  | 'glyph'
  | 'sprite'
  | 'resource';

export interface FetchLimit {
  readonly maxBodyBytes: number;
  readonly connectTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly totalTimeoutMs: number;
}

const MIB = 1024 * 1024;
const COMMON = { connectTimeoutMs: 5_000, headersTimeoutMs: 10_000 } as const;

export const FETCH_LIMITS: Readonly<Record<FetchPurpose, FetchLimit>> = Object.freeze({
  document: { ...COMMON, maxBodyBytes: 5 * MIB, totalTimeoutMs: 30_000 },
  'pmtiles-range': { ...COMMON, maxBodyBytes: 1 * MIB, totalTimeoutMs: 15_000 },
  tile: { ...COMMON, maxBodyBytes: 20 * MIB, totalTimeoutMs: 15_000 },
  glyph: { ...COMMON, maxBodyBytes: 20 * MIB, totalTimeoutMs: 15_000 },
  sprite: { ...COMMON, maxBodyBytes: 20 * MIB, totalTimeoutMs: 15_000 },
  resource: { ...COMMON, maxBodyBytes: 20 * MIB, totalTimeoutMs: 15_000 },
});
