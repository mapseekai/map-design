import path from 'node:path';

function configuredResourceRoot(): string | undefined {
  const root = process.env.MAP_DESIGN_RESOURCE_ROOT?.trim();
  if (!root) return undefined;
  if (!path.isAbsolute(root)) {
    throw new TypeError('MAP_DESIGN_RESOURCE_ROOT must be an absolute path');
  }
  return path.resolve(root);
}

export function resolveProjectRoot(moduleDir: string): string {
  const resourceRoot = configuredResourceRoot();
  if (resourceRoot) return resourceRoot;
  const base = path.basename(moduleDir);
  const daemonDir =
    base === 'dist' || base === 'src' ? path.dirname(moduleDir) : moduleDir;
  return path.resolve(daemonDir, '../..');
}

export function resolveProjectRootFromNestedModule(moduleDir: string): string {
  const resourceRoot = configuredResourceRoot();
  if (resourceRoot) return resourceRoot;
  let current = path.resolve(moduleDir);
  while (true) {
    const base = path.basename(current);
    if (base === 'dist' || base === 'src') {
      return resolveProjectRoot(current);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return resolveProjectRoot(moduleDir);
    }
    current = parent;
  }
}
