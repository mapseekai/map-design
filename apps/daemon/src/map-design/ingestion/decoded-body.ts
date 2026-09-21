import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/** Decode HTTP encoding, never archive-internal compression. Both byte sizes are bounded. */
export async function decodeResponseBody(
  body: Uint8Array, encoding: string | undefined, maximum: number, signal: AbortSignal, range: boolean,
): Promise<Uint8Array> {
  const name = encoding?.trim().toLowerCase();
  if (!name || name === 'identity' || body.byteLength === 0) return body;
  if (range) throw new TypeError('Encoded HTTP byte ranges require identity encoding.');
  const decoder = name === 'gzip' || name === 'x-gzip' ? createGunzip()
    : name === 'deflate' ? createInflate() : name === 'br' ? createBrotliDecompress() : null;
  if (!decoder) throw new TypeError('Unsupported HTTP content encoding.');
  const abort = () => decoder.destroy(signal.reason instanceof Error ? signal.reason : new Error('Canceled'));
  const chunks: Uint8Array[] = [];
  let length = 0;
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    decoder.end(body);
    for await (const value of decoder) {
      signal.throwIfAborted();
      const chunk = value as Uint8Array;
      if (chunk.byteLength > maximum - length) throw new RangeError('Decoded response exceeds the byte size limit.');
      length += chunk.byteLength;
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, length);
  } finally {
    signal.removeEventListener('abort', abort);
    decoder.destroy();
  }
}
