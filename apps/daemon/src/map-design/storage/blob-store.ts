import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { blake3Digest, canonicalJson, canonicalJsonBytes } from './canonical-json.js';
import { assertBlobDigest, blobDirectory, blobPath } from './paths.js';
import type { BinaryBlobKind, JsonBlobKind, MapDesignBlobStore, StoredBlob } from './types.js';

export interface BlobStoreFileSystem extends Pick<typeof fs.promises, 'mkdir' | 'open' | 'readFile' | 'link' | 'unlink'> {}

export interface CreateMapDesignBlobStoreOptions {
  fileSystem?: BlobStoreFileSystem;
}

export function createMapDesignBlobStore(dataRoot: string, options: CreateMapDesignBlobStoreOptions = {}): MapDesignBlobStore {
  return new FileMapDesignBlobStore(dataRoot, options.fileSystem ?? fs.promises);
}

class FileMapDesignBlobStore implements MapDesignBlobStore {
  constructor(private readonly dataRoot: string, private readonly fileSystem: BlobStoreFileSystem) {}

  async putJson(projectId: string, kind: JsonBlobKind, value: unknown): Promise<StoredBlob> {
    const bytes = canonicalJsonBytes(value);
    return this.put(projectId, kind, bytes, 'application/json');
  }

  async putBytes(projectId: string, kind: BinaryBlobKind, bytes: Uint8Array, mediaType: string): Promise<StoredBlob> {
    if (kind === 'previews' && mediaType !== 'image/png') throw new TypeError('preview blobs must use image/png');
    if (typeof mediaType !== 'string' || mediaType.length === 0 || /[\r\n\0]/.test(mediaType)) {
      throw new TypeError('invalid blob media type');
    }
    return this.put(projectId, kind, bytes, mediaType);
  }

  async getJson<T>(projectId: string, kind: JsonBlobKind, digest: string): Promise<T> {
    const bytes = await this.get(projectId, kind, digest);
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const value: unknown = JSON.parse(text);
      if (canonicalJson(value) !== text) throw new SyntaxError();
      return value as T;
    } catch {
      throw new TypeError('invalid JSON blob');
    }
  }

  async getBytes(projectId: string, kind: BinaryBlobKind, digest: string): Promise<Uint8Array> {
    return this.get(projectId, kind, digest);
  }

  private async put(projectId: string, kind: JsonBlobKind | BinaryBlobKind, bytes: Uint8Array, mediaType: string): Promise<StoredBlob> {
    const snapshot = new Uint8Array(bytes);
    const digest = blake3Digest(snapshot);
    const directory = blobDirectory(this.dataRoot, projectId, kind);
    const destination = blobPath(this.dataRoot, projectId, kind, digest);
    await this.fileSystem.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.tmp-${randomUUID()}`);
    return preserveOperationFailure(async () => {
      const file = await this.fileSystem.open(temporary, 'wx', 0o600);
      await preserveOperationFailure(
        async () => {
        await file.writeFile(snapshot);
        await file.sync();
        },
        async () => file.close(),
      );
      try {
        await this.fileSystem.link(temporary, destination);
      } catch (error: unknown) {
        if (!isCode(error, 'EEXIST')) throw error;
        const existing = await this.fileSystem.readFile(destination);
        if (!sameBytes(existing, snapshot)) throw new Error('existing blob contents differ');
      }
      await this.syncDirectory(directory);
      return { digest, byteLength: snapshot.byteLength, kind, mediaType };
    }, async () => this.removeIfPresent(temporary));
  }

  private async get(projectId: string, kind: JsonBlobKind | BinaryBlobKind, digest: string): Promise<Uint8Array> {
    assertBlobDigest(digest);
    const bytes = await this.fileSystem.readFile(blobPath(this.dataRoot, projectId, kind, digest));
    if (blake3Digest(bytes) !== digest) throw new Error('blob digest mismatch');
    return new Uint8Array(bytes);
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await this.fileSystem.open(directory, 'r');
    await preserveOperationFailure(async () => {
      try {
        await handle.sync();
      } catch (error: unknown) {
        // Windows cannot fsync a directory opened for reading; file contents are already synced.
        if (process.platform !== 'win32' || !isCode(error, 'EPERM')) throw error;
      }
    }, async () => handle.close());
  }

  private async removeIfPresent(target: string): Promise<void> {
    try {
      await this.fileSystem.unlink(target);
    } catch (error: unknown) {
      if (!isCode(error, 'ENOENT')) throw error;
    }
  }
}

async function preserveOperationFailure<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let failed = false;
  let primary: unknown;
  let result!: T;
  try {
    result = await operation();
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    await cleanup();
  } catch (error) {
    if (failed) throw new AggregateError([primary, error], 'MapDesign storage operation and cleanup failed');
    throw error;
  }
  if (failed) throw primary;
  return result;
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
