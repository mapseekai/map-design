import { readFile } from 'node:fs/promises';

export const PUBLIC_MAP_SOURCE_KEYS = ['style', 'tilejson', 'geojson', 'pmtiles'] as const;
export type PublicMapSourceKey = typeof PUBLIC_MAP_SOURCE_KEYS[number];
export type PublicMapSources = Record<PublicMapSourceKey, string>;

export interface PublicMapSourcePreflightResult {
  source: PublicMapSourceKey;
  url: string;
  method: 'GET';
  requestedRange: string | null;
  finalUrl: string | null;
  status: number | null;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  contentRange: string | null;
  rangeSupported: boolean | null;
  available: boolean;
  failure: string | null;
}

const PUBLIC_SOURCE_RESOURCE = new URL(
  '../../resources/map-design/public-sources.json',
  import.meta.url,
);
const DEFAULT_TIMEOUT_MS = 15_000;
const PMTILES_RANGE = 'bytes=0-511';

export async function loadPublicMapSources(): Promise<PublicMapSources> {
  const raw = await readFile(PUBLIC_SOURCE_RESOURCE, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new TypeError('public-sources.json must contain valid JSON');
  }
  return parsePublicMapSources(value);
}

export function parsePublicMapSources(value: unknown): PublicMapSources {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('public-sources.json must be an object');
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...PUBLIC_MAP_SOURCE_KEYS].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new TypeError(`public-sources.json must contain exactly ${expectedKeys.join(', ')}`);
  }
  const parsed = {} as PublicMapSources;
  for (const key of PUBLIC_MAP_SOURCE_KEYS) {
    const rawUrl = record[key];
    if (typeof rawUrl !== 'string') throw new TypeError(`public source ${key} must be a URL string`);
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new TypeError(`public source ${key} must be a valid URL`);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new TypeError(`public source ${key} must be a credential-free HTTPS URL without a fragment`);
    }
    parsed[key] = url.toString();
  }
  return parsed;
}

export async function preflightPublicMapSources(
  sources: PublicMapSources,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<PublicMapSourcePreflightResult[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError('public source preflight timeout must be an integer from 1 to 30000 milliseconds');
  }
  const request = options.fetch ?? fetch;
  return await Promise.all(PUBLIC_MAP_SOURCE_KEYS.map(async (source) => {
    const url = sources[source];
    const requestedRange = source === 'pmtiles' ? PMTILES_RANGE : null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('public source preflight timed out')), timeoutMs);
    try {
      const response = await request(url, {
        method: 'GET',
        redirect: 'follow',
        ...(requestedRange ? { headers: { Range: requestedRange } } : {}),
        signal: controller.signal,
      });
      const contentRange = header(response, 'content-range');
      const rangeSupported = source === 'pmtiles'
        ? response.status === 206 && /^bytes 0-511\/\d+$/u.test(contentRange ?? '')
        : null;
      const available = response.ok && (source !== 'pmtiles' || rangeSupported === true);
      await response.body?.cancel().catch(() => undefined);
      return {
        source,
        url,
        method: 'GET',
        requestedRange,
        finalUrl: response.url || url,
        status: response.status,
        contentType: header(response, 'content-type'),
        etag: header(response, 'etag'),
        lastModified: header(response, 'last-modified'),
        contentRange,
        rangeSupported,
        available,
        failure: available
          ? null
          : source === 'pmtiles'
            ? 'PMTiles endpoint did not honor bytes=0-511 with a valid 206 Content-Range'
            : `public source returned HTTP ${response.status}`,
      } satisfies PublicMapSourcePreflightResult;
    } catch (error) {
      return {
        source,
        url,
        method: 'GET',
        requestedRange,
        finalUrl: null,
        status: null,
        contentType: null,
        etag: null,
        lastModified: null,
        contentRange: null,
        rangeSupported: source === 'pmtiles' ? false : null,
        available: false,
        failure: publicFailure(error),
      } satisfies PublicMapSourcePreflightResult;
    } finally {
      clearTimeout(timer);
    }
  }));
}

export function assertPublicMapSourcesAvailable(
  results: readonly PublicMapSourcePreflightResult[],
): void {
  const missing = results.filter((result) => !result.available);
  if (missing.length === 0 && results.length === PUBLIC_MAP_SOURCE_KEYS.length) return;
  const present = new Set(results.map((result) => result.source));
  const absent = PUBLIC_MAP_SOURCE_KEYS.filter((source) => !present.has(source));
  const failures = [
    ...missing.map((result) => `${result.source}: ${result.failure ?? 'unavailable'}`),
    ...absent.map((source) => `${source}: missing preflight result`),
  ];
  throw new Error(`public MapDesign source preflight blocked acceptance (${failures.join('; ')})`);
}

function header(response: Response, name: string): string | null {
  const value = response.headers.get(name)?.trim();
  return value ? value : null;
}

function publicFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'bounded preflight timed out';
  if (error instanceof Error && error.message.trim()) return error.message.replace(/[\r\n]+/gu, ' ').slice(0, 500);
  return 'public source request failed';
}
