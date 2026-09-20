import {access, readFile} from 'node:fs/promises';

import {describe, expect, it} from 'vitest';

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as {scripts?: Record<string, string>};

describe('data-profile package boundary', () => {
  it('exposes the real profile entrypoint atomically with its package script', async () => {
    expect(packageJson.scripts).toMatchObject({
      test: 'vitest run',
      typecheck: 'tsc --noEmit -p tsconfig.json',
      profile: 'tsx scripts/generate-profile.ts',
    });
    expect(Object.values(packageJson.scripts ?? {})).not.toContain('tsx src/profile.ts');
    await expect(access(new URL('../scripts/generate-profile.ts', import.meta.url))).resolves.toBeUndefined();
  });
});
