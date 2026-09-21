import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { decodeResponseBody } from '../../../src/map-design/ingestion/decoded-body.js';
import { createPinnedTransport } from '../../../src/map-design/ingestion/pinned-transport.js';

const plain = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [] }));
const signal = () => new AbortController().signal;

describe('bounded HTTP decoding', () => {
  it.each([['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]] as const)('decodes %s within the byte budget', async (name, encode) => {
    expect(Buffer.from(await decodeResponseBody(encode(plain), name, 1024, signal(), false))).toEqual(plain);
  });
  it('limits decoded bytes, not only compressed bytes', async () => {
    await expect(decodeResponseBody(gzipSync(Buffer.alloc(50_000)), 'gzip', 1024, signal(), false)).rejects.toThrow('size limit');
  });
  it('rejects corrupt compression and unsupported encodings', async () => {
    await expect(decodeResponseBody(plain, 'gzip', 1024, signal(), false)).rejects.toThrow();
    await expect(decodeResponseBody(plain, 'unknown', 1024, signal(), false)).rejects.toThrow('Unsupported');
  });
  it('never decompresses HTTP byte ranges or confuses archive compression with HTTP encoding', async () => {
    const bytes = gzipSync(plain);
    await expect(decodeResponseBody(bytes, 'gzip', 1024, signal(), true)).rejects.toThrow('identity');
    expect(await decodeResponseBody(bytes, undefined, 1024, signal(), true)).toBe(bytes);
  });
  it('responds to cancellation before and during decoding', async () => {
    const controller = new AbortController(); controller.abort(new Error('Canceled test'));
    await expect(decodeResponseBody(gzipSync(plain), 'gzip', 1024, controller.signal, false)).rejects.toThrow('Canceled');
    const current = new AbortController();
    const pending = decodeResponseBody(gzipSync(Buffer.alloc(8_000_000)), 'gzip', 10_000_000, current.signal, false);
    const assertion = expect(pending).rejects.toThrow('Canceled'); current.abort(new Error('Canceled'));
    await assertion;
  });
  it('returns decoded transport bytes and removes encoded representation headers', async () => {
    const wire = gzipSync(plain);
    const transport = createPinnedTransport({ resolver: async () => [{ address: '93.184.216.34', family: 4 }], dispatcher: {
      async request() { return { statusCode: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', etag: '"encoded"' },
        body: { destroy() {}, async *[Symbol.asyncIterator]() { yield wire; } } }; },
    } });
    const response = await transport.fetch({ url: new URL('https://maps.example.com/style.json'), purpose: 'document' });
    expect(JSON.parse(Buffer.from(response.body).toString())).toEqual(JSON.parse(plain.toString()));
    expect(response.headers['content-encoding']).toBeUndefined(); expect(response.headers.etag).toBeUndefined();
    expect(response.headers['content-length']).toBe(String(plain.length));
  });
});
