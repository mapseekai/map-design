import { readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readPackageJson(): {
  exports?: Record<string, { default?: string; types?: string }>;
  files?: string[];
  main?: string;
  types?: string;
} {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
}

function packagePath(target: string): string {
  return join(packageRoot, target.replace(/^\.\//, ''));
}

describe('@mapseekai/contracts package runtime shape', () => {
  it('exports built JavaScript instead of TypeScript source files', () => {
    const pkg = readPackageJson();

    expect(pkg.main).toBe('./dist/index.mjs');
    expect(pkg.types).toBe('./dist/index.d.ts');
    expect(pkg.files).toEqual(['dist']);
    expect(pkg.exports?.['.']?.default).toBe('./dist/index.mjs');
    expect(pkg.exports?.['.']?.types).toBe('./dist/index.d.ts');
  });

  it('points every runtime export at generated files', async () => {
    const pkg = readPackageJson();
    const exports = Object.entries(pkg.exports ?? {});

    expect(exports.length).toBeGreaterThan(0);
    for (const [_name, target] of exports) {
      expect(target.default).toMatch(/^\.\/dist\/.+\.mjs$/);
      expect(target.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      await expect(access(packagePath(target.default!))).resolves.toBeUndefined();
      await expect(access(packagePath(target.types!))).resolves.toBeUndefined();
    }
  });

  it('makes the retained root export importable', async () => {
    const contracts = await import('@mapseekai/contracts');

    expect(contracts.createApiError).toEqual(expect.any(Function));
    expect(contracts.API_ERROR_CODES).toContain('BAD_REQUEST');
  });
});
