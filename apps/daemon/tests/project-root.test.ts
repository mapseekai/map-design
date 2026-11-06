import { DEFAULT_MAP_DESIGN_SYSTEM_ID } from '@mapseekai/map-design-contracts';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveProjectRoot, resolveProjectRootFromNestedModule } from '../src/project-root.js';
import { loadMapDesignSystem } from '../src/map-design/validation/design-system-loader.js';

afterEach(() => vi.unstubAllEnvs());

describe('daemon resource root', () => {
  it.each(['src', 'dist'])('preserves the %s development layout', (directory) => {
    vi.stubEnv('MAP_DESIGN_RESOURCE_ROOT', '');
    const root = path.resolve('fixture-workspace');
    expect(resolveProjectRoot(path.join(root, 'apps', 'daemon', directory))).toBe(root);
    expect(resolveProjectRootFromNestedModule(path.join(root, 'apps', 'daemon', directory, 'sidecar'))).toBe(root);
  });

  it('rejects a relative resource override instead of depending on the launch directory', () => {
    vi.stubEnv('MAP_DESIGN_RESOURCE_ROOT', 'resources/map-design');
    expect(() => resolveProjectRoot(path.resolve('chunks'))).toThrow('must be an absolute path');
    expect(() => resolveProjectRootFromNestedModule(path.resolve('chunks'))).toThrow('must be an absolute path');
  });

  it('loads the shipped preset from resources, not the prebundled daemon chunks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'map-design-packaged-root-'));
    try {
      const resources = path.join(root, 'resources', 'map-design');
      const chunks = path.join(root, 'resources', 'app', 'prebundled', 'daemon', 'chunks');
      await mkdir(chunks, { recursive: true });
      await cp(path.resolve(import.meta.dirname, '../../../design-systems'), path.join(resources, 'design-systems'), { recursive: true });
      vi.stubEnv('MAP_DESIGN_RESOURCE_ROOT', resources);
      for (const resolveRoot of [resolveProjectRoot, resolveProjectRootFromNestedModule]) {
        expect(resolveRoot(chunks)).toBe(resources);
        await expect(loadMapDesignSystem({ projectRoot: resolveRoot(chunks), designSystemId: DEFAULT_MAP_DESIGN_SYSTEM_ID }))
          .resolves.toMatchObject({ id: 'monet', name: '莫奈风格' });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
