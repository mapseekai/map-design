import {mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {atomicWrite} from '../src/atomic-write.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, {recursive: true, force: true})),
  );
});

describe('atomicWrite', () => {
  it('preserves an existing destination and removes the sibling temp when rename fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cartography-atomic-write-'));
    temporaryDirectories.push(directory);
    const destination = join(directory, 'DATA_PROFILE.json');
    const missingParentTarget = join(directory, 'missing-parent', 'DATA_PROFILE.json');
    await writeFile(destination, 'existing bytes\n');
    let temporaryBytes: string | undefined;
    let renameCalls = 0;

    await expect(
      atomicWrite(destination, 'replacement bytes\n', {
        rename: async (temporary, target) => {
          renameCalls += 1;
          temporaryBytes = await readFile(temporary, 'utf8');
          expect(target).toBe(destination);
          await rename(temporary, missingParentTarget);
        },
      }),
    ).rejects.toMatchObject({code: 'ENOENT'});

    expect(renameCalls).toBe(1);
    expect(temporaryBytes).toBe('replacement bytes\n');
    expect(await readFile(destination, 'utf8')).toBe('existing bytes\n');
    expect(await readdir(directory)).toEqual(['DATA_PROFILE.json']);
  });
});
