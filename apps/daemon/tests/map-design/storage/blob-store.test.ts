import fs from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { blake3Digest, canonicalJson } from '../../../src/map-design/storage/canonical-json.js';
import {
  createMapDesignBlobStore,
  type BlobStoreFileSystem,
} from '../../../src/map-design/storage/blob-store.js';
import { blobPath } from '../../../src/map-design/storage/paths.js';

const PROJECT_ID = 'map-project-1';
const nativePlatform = process.platform;

async function capturedFailure(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('expected storage operation to fail');
}

function expectPrimaryAndCleanupFailure(error: unknown, primary: Error, cleanup: Error): void {
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([primary, cleanup]);
}

describe('MapDesignBlobStore', () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), 'map-design-map-design-storage-'));
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: nativePlatform });
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('canonicalizes object keys, publishes one immutable JSON blob, and reuses it', async () => {
    const store = createMapDesignBlobStore(dataRoot);
    const first = await store.putJson(PROJECT_ID, 'styles', { z: [3, 2], a: { y: true, x: null } });
    const second = await store.putJson(PROJECT_ID, 'styles', { a: { x: null, y: true }, z: [3, 2] });

    expect(first).toEqual(second);
    expect(first.byteLength).toBe(Buffer.byteLength('{"a":{"x":null,"y":true},"z":[3,2]}'));
    const files = await readdir(path.dirname(blobPath(dataRoot, PROJECT_ID, 'styles', first.digest)));
    expect(files).toEqual([`${first.digest}.json`]);
    await expect(store.getJson(PROJECT_ID, 'styles', first.digest)).resolves.toEqual({
      a: { x: null, y: true }, z: [3, 2],
    });
  });

  it('rejects invalid JSON values before serialization or hashing', async () => {
    const store = createMapDesignBlobStore(dataRoot);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const invalid = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      () => undefined,
      Symbol('x'),
      1n,
      [undefined],
      { missing: undefined },
      new Date(),
      cyclic,
    ];

    for (const value of invalid) {
      await expect(store.putJson(PROJECT_ID, 'styles', value)).rejects.toThrow('invalid JSON value');
    }
    expect(() => canonicalJson({ x: undefined })).toThrow('invalid JSON value');
  });

  it('preserves an own __proto__ JSON key and rejects non-index array properties', () => {
    const withPrototypeKey = JSON.parse('{"__proto__":{"polluted":true},"constructor":2,"prototype":3,"a":1}');
    expect(canonicalJson(withPrototypeKey)).toBe('{"__proto__":{"polluted":true},"a":1,"constructor":2,"prototype":3}');
    expect(canonicalJson(withPrototypeKey)).not.toBe(canonicalJson({ a: 1 }));

    const array = [1];
    Object.defineProperty(array, '4294967295', { value: 'not an array index', enumerable: true });
    expect(() => canonicalJson(array)).toThrow('invalid JSON value');
  });

  it('rejects identity-colliding negative zero', () => {
    expect(() => canonicalJson(-0)).toThrow('invalid JSON value');
  });

  it('rejects array accessors without invoking them', () => {
    let accessorRead = false;
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get() {
        accessorRead = true;
        return 'must not run';
      },
    });
    accessorArray.length = 1;
    expect(() => canonicalJson(accessorArray)).toThrow('invalid JSON value');
    expect(accessorRead).toBe(false);
  });

  it('rejects non-enumerable array indexes', () => {
    const nonEnumerableIndex = [1];
    Object.defineProperty(nonEnumerableIndex, '0', { value: 1, enumerable: false });
    expect(() => canonicalJson(nonEnumerableIndex)).toThrow('invalid JSON value');
  });

  it('accepts shared non-cyclic references', () => {
    const shared = { value: 1 };
    expect(canonicalJson([shared, shared])).toBe('[{"value":1},{"value":1}]');
  });

  it('rejects tampered JSON blob content on every read', async () => {
    const store = createMapDesignBlobStore(dataRoot);
    const blob = await store.putJson(PROJECT_ID, 'reports', { valid: true });
    await writeFile(blobPath(dataRoot, PROJECT_ID, 'reports', blob.digest), '{"valid":false}');

    await expect(store.getJson(PROJECT_ID, 'reports', blob.digest)).rejects.toThrow('blob digest mismatch');
  });

  it('rejects invalid UTF-8 even when the JSON blob digest is correct', async () => {
    const store = createMapDesignBlobStore(dataRoot);
    const bytes = new Uint8Array([0x22, 0xff, 0x22]);
    const digest = blake3Digest(bytes);
    const destination = blobPath(dataRoot, PROJECT_ID, 'reports', digest);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);

    await expect(store.getJson(PROJECT_ID, 'reports', digest)).rejects.toThrow('invalid JSON blob');
  });

  it('round-trips preview bytes and rejects tampered binary content', async () => {
    const store = createMapDesignBlobStore(dataRoot);
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const blob = await store.putBytes(PROJECT_ID, 'previews', bytes, 'image/png');

    expect(blob.mediaType).toBe('image/png');
    expect(path.extname(blobPath(dataRoot, PROJECT_ID, 'previews', blob.digest))).toBe('.png');
    await expect(store.getBytes(PROJECT_ID, 'previews', blob.digest)).resolves.toEqual(bytes);
    await writeFile(blobPath(dataRoot, PROJECT_ID, 'previews', blob.digest), new Uint8Array([0]));
    await expect(store.getBytes(PROJECT_ID, 'previews', blob.digest)).rejects.toThrow('blob digest mismatch');
  });

  it('rejects traversal-shaped project ids, kinds, and digests before resolving paths', async () => {
    const store = createMapDesignBlobStore(dataRoot);
    const digest = 'a'.repeat(64);
    const unsafeProjectIds = ['', '.', '..', '../outside', 'a/b', 'a\\b', '/absolute', 'nul\u0000id'];
    for (const projectId of unsafeProjectIds) {
      await expect(store.putJson(projectId, 'styles', {})).rejects.toThrow('invalid project id');
    }
    expect(() => blobPath(dataRoot, PROJECT_ID, '../styles' as 'styles', digest)).toThrow('invalid blob kind');
    expect(() => blobPath(dataRoot, PROJECT_ID, 'styles', '../digest')).toThrow('invalid blob digest');
    await expect(store.putBytes(PROJECT_ID, 'previews', new Uint8Array([1]), 'application/octet-stream'))
      .rejects.toThrow('preview blobs must use image/png');
  });

  it('cleans temporary files and publishes no readable blob when a temporary write fails', async () => {
    const operations: BlobStoreFileSystem = {
      ...fs.promises,
      open: async (target, flags, mode) => {
        const handle = await fs.promises.open(target, flags, mode);
        if (typeof target === 'string' && path.basename(target).startsWith('.tmp-')) {
          return new Proxy(handle, {
            get(original, property, receiver) {
              if (property === 'writeFile') return async () => { throw new Error('write failed'); };
              return Reflect.get(original, property, receiver);
            },
          });
        }
        return handle;
      },
    };
    const store = createMapDesignBlobStore(dataRoot, { fileSystem: operations });

    await expect(store.putJson(PROJECT_ID, 'styles', { will: 'fail' })).rejects.toThrow('write failed');
    const blobDir = path.join(dataRoot, 'mapdesign', 'projects', PROJECT_ID, 'blobs', 'styles');
    expect(await readdir(blobDir)).toEqual([]);
  });

  it('cleans temporary files and publishes no readable blob when link fails', async () => {
    const writeStore = createMapDesignBlobStore(dataRoot);
    const digest = (await writeStore.putJson(PROJECT_ID, 'styles', { exists: 'first' })).digest;
    await rm(blobPath(dataRoot, PROJECT_ID, 'styles', digest));

    const linkFailure: BlobStoreFileSystem = {
      ...fs.promises,
      link: async () => { throw new Error('link failed'); },
    };
    await expect(createMapDesignBlobStore(dataRoot, { fileSystem: linkFailure })
      .putJson(PROJECT_ID, 'styles', { exists: 'first' })).rejects.toThrow('link failed');
    const blobDir = path.dirname(blobPath(dataRoot, PROJECT_ID, 'styles', digest));
    expect(await readdir(blobDir)).toEqual([]);
  });

  it.each(['win32', 'linux'] as const)('handles directory EPERM only on Windows when running as %s', async (platform) => {
    const blobDir = path.join(dataRoot, 'mapdesign', 'projects', PROJECT_ID, 'blobs', 'styles');
    const failure = Object.assign(new Error('directory sync denied'), { code: 'EPERM' });
    const operations: BlobStoreFileSystem = {
      ...fs.promises,
      open: async (target, flags, mode) => {
        const handle = await fs.promises.open(target, flags, mode);
        if (target !== blobDir) return handle;
        return new Proxy(handle, {
          get(original, property, receiver) {
            if (property === 'sync') return async () => { throw failure; };
            return Reflect.get(original, property, receiver);
          },
        });
      },
    };
    Object.defineProperty(process, 'platform', { value: platform });
    const store = createMapDesignBlobStore(dataRoot, { fileSystem: operations });

    const publication = store.putJson(PROJECT_ID, 'styles', { directory: 'unsupported sync' });

    if (platform === 'win32') {
      const blob = await publication;
      await expect(store.getJson(PROJECT_ID, 'styles', blob.digest)).resolves.toEqual({ directory: 'unsupported sync' });
      expect(await readdir(blobDir)).toEqual([`${blob.digest}.json`]);
    } else {
      await expect(publication).rejects.toBe(failure);
    }
  });

  it('rejects file EPERM and cleans unpublished bytes on Windows', async () => {
    const failure = Object.assign(new Error('file sync denied'), { code: 'EPERM' });
    const operations: BlobStoreFileSystem = {
      ...fs.promises,
      open: async (target, flags, mode) => {
        const handle = await fs.promises.open(target, flags, mode);
        return new Proxy(handle, {
          get(original, property, receiver) {
            if (property === 'sync') return async () => { throw failure; };
            return Reflect.get(original, property, receiver);
          },
        });
      },
    };
    Object.defineProperty(process, 'platform', { value: 'win32' });

    const publication = createMapDesignBlobStore(dataRoot, { fileSystem: operations })
      .putJson(PROJECT_ID, 'styles', { file: 'sync denied' });

    await expect(publication).rejects.toBe(failure);
    expect(await readdir(path.join(dataRoot, 'mapdesign', 'projects', PROJECT_ID, 'blobs', 'styles'))).toEqual([]);
  });

  it('preserves a published immutable blob when directory fsync fails', async () => {
    const blobDir = path.join(dataRoot, 'mapdesign', 'projects', PROJECT_ID, 'blobs', 'styles');
    const directoryFsyncFailure: BlobStoreFileSystem = {
      ...fs.promises,
      open: async (target, flags, mode) => {
        const handle = await fs.promises.open(target, flags, mode);
        if (target === blobDir) {
          return new Proxy(handle, {
            get(original, property, receiver) {
              if (property === 'sync') return async () => { throw new Error('directory fsync failed'); };
              return Reflect.get(original, property, receiver);
            },
          });
        }
        return handle;
      },
    };

    await expect(createMapDesignBlobStore(dataRoot, { fileSystem: directoryFsyncFailure })
      .putJson(PROJECT_ID, 'styles', { directory: 'fails' })).rejects.toThrow('directory fsync failed');
    const [file] = await readdir(blobDir);
    expect(file).toMatch(/^[a-f0-9]{64}\.json$/);
    if (!file) throw new Error('expected published blob');
    const digest = file.slice(0, -'.json'.length);
    await expect(createMapDesignBlobStore(dataRoot).getJson(PROJECT_ID, 'styles', digest))
      .resolves.toEqual({ directory: 'fails' });
  });

  it('cleans temporary files and publishes no readable blob when file fsync or temp creation fails', async () => {
    const fsyncFailure: BlobStoreFileSystem = {
      ...fs.promises,
      open: async (target, flags, mode) => {
        const handle = await fs.promises.open(target, flags, mode);
        if (typeof target === 'string' && path.basename(target).startsWith('.tmp-')) {
          return new Proxy(handle, {
            get(original, property, receiver) {
              if (property === 'sync') return async () => { throw new Error('fsync failed'); };
              return Reflect.get(original, property, receiver);
            },
          });
        }
        return handle;
      },
    };
    await expect(createMapDesignBlobStore(dataRoot, { fileSystem: fsyncFailure })
      .putJson(PROJECT_ID, 'styles', { fsync: 'fails' })).rejects.toThrow('fsync failed');
    const blobDir = path.join(dataRoot, 'mapdesign', 'projects', PROJECT_ID, 'blobs', 'styles');
    expect(await readdir(blobDir)).toEqual([]);

    const tempFailure: BlobStoreFileSystem = {
      ...fs.promises,
      open: async (target, flags, mode) => {
        if (typeof target === 'string' && path.basename(target).startsWith('.tmp-')) {
          throw new Error('temp create failed');
        }
        return fs.promises.open(target, flags, mode);
      },
    };
    await expect(createMapDesignBlobStore(dataRoot, { fileSystem: tempFailure })
      .putJson(PROJECT_ID, 'styles', { temp: 'fails' })).rejects.toThrow('temp create failed');
    expect(await readdir(blobDir)).toEqual([]);
  });

  it('never removes a blob another EEXIST writer has already returned', async () => {
    const blobDir = path.join(dataRoot, 'mapdesign', 'projects', PROJECT_ID, 'blobs', 'styles');
    let directorySyncStarted!: () => void;
    const started = new Promise<void>((resolve) => { directorySyncStarted = resolve; });
    let releaseDirectoryFailure!: () => void;
    const release = new Promise<void>((resolve) => { releaseDirectoryFailure = resolve; });
    const failingWriterFs: BlobStoreFileSystem = {
      ...fs.promises,
      open: async (target, flags, mode) => {
        const handle = await fs.promises.open(target, flags, mode);
        if (target === blobDir) {
          return new Proxy(handle, {
            get(original, property, receiver) {
              if (property === 'sync') return async () => {
                directorySyncStarted();
                await release;
                throw new Error('writer A directory fsync failed');
              };
              return Reflect.get(original, property, receiver);
            },
          });
        }
        return handle;
      },
    };
    const writerA = createMapDesignBlobStore(dataRoot, { fileSystem: failingWriterFs });
    const writerB = createMapDesignBlobStore(dataRoot);
    const writeA = writerA.putJson(PROJECT_ID, 'styles', { race: 'same' });
    await started;

    const fromB = await writerB.putJson(PROJECT_ID, 'styles', { race: 'same' });
    releaseDirectoryFailure();
    await expect(writeA).rejects.toThrow('writer A directory fsync failed');
    await expect(writerB.getJson(PROJECT_ID, 'styles', fromB.digest)).resolves.toEqual({ race: 'same' });
    await expect(fs.promises.access(blobPath(dataRoot, PROJECT_ID, 'styles', fromB.digest))).resolves.toBeUndefined();
  });

  it('snapshots binary bytes before awaiting filesystem work', async () => {
    let enteredMkdir!: () => void;
    const mkdirEntered = new Promise<void>((resolve) => { enteredMkdir = resolve; });
    let releaseMkdir!: () => void;
    const mkdirReleased = new Promise<void>((resolve) => { releaseMkdir = resolve; });
    const delayedMkdir: BlobStoreFileSystem = {
      ...fs.promises,
      mkdir: (async (target, options) => {
        enteredMkdir();
        await mkdirReleased;
        return fs.promises.mkdir(target, options);
      }) as typeof fs.promises.mkdir,
    };
    const store = createMapDesignBlobStore(dataRoot, { fileSystem: delayedMkdir });
    const bytes = new Uint8Array([1, 2, 3]);
    const write = store.putBytes(PROJECT_ID, 'resources', bytes, 'application/octet-stream');
    await mkdirEntered;
    bytes[0] = 9;
    releaseMkdir();

    const stored = await write;
    expect(stored.digest).toBe(blake3Digest(new Uint8Array([1, 2, 3])));
    await expect(store.getBytes(PROJECT_ID, 'resources', stored.digest)).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it('preserves a temporary write failure when file close also fails', async () => {
    const primary = new Error('primary write failure');
    const cleanup = new Error('secondary close failure');
    const failingFs: BlobStoreFileSystem = {
      ...fs.promises,
      open: async (target, flags, mode) => {
        const handle = await fs.promises.open(target, flags, mode);
        if (typeof target === 'string' && path.basename(target).startsWith('.tmp-')) {
          return new Proxy(handle, {
            get(original, property, receiver) {
              if (property === 'writeFile') return async () => { throw primary; };
              if (property === 'close') return async () => { throw cleanup; };
              return Reflect.get(original, property, receiver);
            },
          });
        }
        return handle;
      },
    };

    const error = await capturedFailure(() => createMapDesignBlobStore(dataRoot, { fileSystem: failingFs })
      .putJson(PROJECT_ID, 'styles', { close: 'fails' }));
    expectPrimaryAndCleanupFailure(error, primary, cleanup);
  });

  it('preserves a directory sync failure when directory close also fails', async () => {
    const primary = new Error('primary directory sync failure');
    const cleanup = new Error('secondary directory close failure');
    const blobDir = path.join(dataRoot, 'mapdesign', 'projects', PROJECT_ID, 'blobs', 'styles');
    const failingFs: BlobStoreFileSystem = {
      ...fs.promises,
      open: async (target, flags, mode) => {
        const handle = await fs.promises.open(target, flags, mode);
        if (target === blobDir) {
          return new Proxy(handle, {
            get(original, property, receiver) {
              if (property === 'sync') return async () => { throw primary; };
              if (property === 'close') return async () => { throw cleanup; };
              return Reflect.get(original, property, receiver);
            },
          });
        }
        return handle;
      },
    };

    const error = await capturedFailure(() => createMapDesignBlobStore(dataRoot, { fileSystem: failingFs })
      .putJson(PROJECT_ID, 'styles', { directory: 'close fails' }));
    expectPrimaryAndCleanupFailure(error, primary, cleanup);
  });

  it('preserves a publication failure when temporary cleanup also fails', async () => {
    const primary = new Error('primary link failure');
    const cleanup = new Error('secondary temporary unlink failure');
    const failingFs: BlobStoreFileSystem = {
      ...fs.promises,
      link: async () => { throw primary; },
      unlink: async (target) => {
        if (typeof target === 'string' && path.basename(target).startsWith('.tmp-')) throw cleanup;
        return fs.promises.unlink(target);
      },
    };

    const error = await capturedFailure(() => createMapDesignBlobStore(dataRoot, { fileSystem: failingFs })
      .putJson(PROJECT_ID, 'styles', { unlink: 'fails' }));
    expectPrimaryAndCleanupFailure(error, primary, cleanup);
  });
});
