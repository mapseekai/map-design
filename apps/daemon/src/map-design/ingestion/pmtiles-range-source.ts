import { EtagMismatch, type RangeResponse, type Source } from 'pmtiles';

import type { PinnedTransport } from './pinned-transport.js';

const MAX_RANGE_BYTES = 1024 * 1024;

export class PmtilesRangeSource implements Source {
  readonly #url: URL;
  readonly #transport: PinnedTransport;
  readonly #approvedEtag: string | undefined;

  constructor(url: URL, transport: PinnedTransport, approvedEtag?: string | null) {
    this.#url = new URL(url.href);
    this.#transport = transport;
    this.#approvedEtag = approvedEtag ?? undefined;
  }

  getKey(): string {
    return this.#url.href;
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string,
  ): Promise<RangeResponse> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length)
      || length <= 0 || length > MAX_RANGE_BYTES) {
      throw new RangeError('Invalid PMTiles byte range');
    }
    const response = await this.#transport.fetch({
      url: this.#url,
      purpose: 'pmtiles-range',
      range: { start: offset, endInclusive: offset + length - 1 },
      ...(signal ? { signal } : {}),
    });
    if (response.finalUrl.href !== this.#url.href || response.redirects.length > 0) {
      throw new Error('PMTiles archive range redirected after approval');
    }
    const responseEtag = response.headers.etag;
    if ((this.#approvedEtag && responseEtag !== this.#approvedEtag)
      || (etag && responseEtag !== etag)) {
      throw new EtagMismatch('PMTiles archive ETag changed or is missing');
    }
    if (response.status !== 206) throw new Error('PMTiles archive did not return partial content');
    const contentRange = parseContentRange(response.headers['content-range']);
    if (!contentRange || contentRange.start !== offset || contentRange.end < contentRange.start
      || contentRange.end > offset + length - 1
      || response.body.byteLength !== contentRange.end - contentRange.start + 1
      || (contentRange.end !== offset + length - 1 && contentRange.end !== contentRange.total - 1)) {
      throw new Error('PMTiles archive returned an inexact byte range');
    }
    const data = new Uint8Array(response.body).buffer;
    return {
      data,
      ...(responseEtag ? { etag: responseEtag } : {}),
      ...(response.headers.expires ? { expires: response.headers.expires } : {}),
      ...(response.headers['cache-control'] ? { cacheControl: response.headers['cache-control'] } : {}),
    };
  }
}
function parseContentRange(value: string | undefined): { start: number; end: number; total: number } | null {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/u);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return [start, end, total].every(Number.isSafeInteger) && total > 0
    ? { start, end, total }
    : null;
}
