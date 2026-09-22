import { mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { resolveDeepSeekProfileHome, stageDeepSeekProfileBundle } from '../../../src/map-design/agents/deepseek-profile-bundle.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

const roots: string[] = [];

afterEach(async () => {
  vi.mocked(rename).mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function dataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'map-design-profile-staging-'));
  roots.push(root);
  return root;
}

it.each(['EPERM', 'EBUSY', 'EACCES'])('recovers a transient Windows %s while publishing the exact staged profile', async (code) => {
  const root = await dataRoot();
  const failure = Object.assign(new Error('Profile directory is locked.'), { code });
  vi.mocked(rename).mockRejectedValueOnce(failure);
  const staging = stageDeepSeekProfileBundle(root);
  if (process.platform !== 'win32') {
    await expect(staging).rejects.toBe(failure);
    expect(rename).toHaveBeenCalledOnce();
    return;
  }
  const bundle = await staging;
  expect(rename).toHaveBeenCalledTimes(2);
  expect(vi.mocked(rename).mock.calls[1]).toEqual(vi.mocked(rename).mock.calls[0]);
  expect(bundle.profileDirectory).toBe(join(resolveDeepSeekProfileHome(root), 'profiles', 'map-design'));
  expect(await readdir(join(resolveDeepSeekProfileHome(root), 'profiles'))).toEqual(['map-design']);
});

it('bounds persistent Windows sharing failures and cleans the unpublished profile', async () => {
  const root = await dataRoot();
  const failure = Object.assign(new Error('Profile directory remains locked.'), { code: 'EPERM' });
  vi.mocked(rename).mockRejectedValue(failure);
  await expect(stageDeepSeekProfileBundle(root)).rejects.toBe(failure);
  expect(rename).toHaveBeenCalledTimes(process.platform === 'win32' ? 5 : 1);
  expect(await readdir(join(resolveDeepSeekProfileHome(root), 'profiles'))).toEqual([]);
});

it('propagates other publication errors without retrying', async () => {
  const root = await dataRoot();
  const failure = Object.assign(new Error('Profile device failed.'), { code: 'EIO' });
  vi.mocked(rename).mockRejectedValue(failure);
  await expect(stageDeepSeekProfileBundle(root)).rejects.toBe(failure);
  expect(rename).toHaveBeenCalledOnce();
  expect(await readdir(join(resolveDeepSeekProfileHome(root), 'profiles'))).toEqual([]);
});
