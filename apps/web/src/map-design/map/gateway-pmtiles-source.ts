import { EtagMismatch, type RangeResponse, type Source } from 'pmtiles';

import { assertMapDesignGatewayUrl } from './resource-protocol';

export interface GatewayPmtilesSourceOptions {
  origin?: string;
  fetch?: typeof globalThis.fetch;
}

export class GatewayPmtilesSource implements Source {
  readonly #url: URL;
  readonly #fetch: typeof globalThis.fetch;

  constructor(value: string, options: GatewayPmtilesSourceOptions = {}) {
    this.#url = assertMapDesignGatewayUrl(value, options.origin);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  getKey(): string {
    return this.#url.href;
  }

  async getBytes(offset: number, length: number, signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) {
      throw new TypeError('Invalid PMTiles byte range.');
    }
    const end = offset + length - 1;
    if (!Number.isSafeInteger(end)) throw new TypeError('Invalid PMTiles byte range.');
    const headers = new Headers({ Range: `bytes=${offset}-${end}` });
    if (etag) headers.set('If-Match', etag);
    const response = await this.#fetch(this.#url, {
      method: 'GET',
      headers,
      credentials: 'same-origin',
      signal,
    });
    if (response.status === 412 || response.status === 416) throw new EtagMismatch('PMTiles archive changed.');
    if (response.status !== 206) throw new TypeError(`PMTiles gateway requires a 206 response (${response.status}).`);
    const responseEtag = response.headers.get('etag') ?? undefined;
    if (etag && responseEtag && responseEtag !== etag) throw new EtagMismatch('PMTiles archive changed.');
    const contentRange = response.headers.get('content-range');
    const parsed = parseContentRange(contentRange);
    const data = await response.arrayBuffer();
    if (!parsed || parsed.start !== offset || parsed.end > end || parsed.end < parsed.start
      || parsed.total <= parsed.end || data.byteLength !== parsed.end - parsed.start + 1
      || (parsed.end !== end && parsed.end !== parsed.total - 1)) {
      throw new TypeError('PMTiles gateway returned an invalid Content-Range or body length.');
    }
    return {
      data,
      etag: responseEtag,
      cacheControl: response.headers.get('cache-control') ?? undefined,
      expires: response.headers.get('expires') ?? undefined,
    };
  }
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/u);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return [start, end, total].every(Number.isSafeInteger) ? { start, end, total } : null;
}
