import type { MapDesignHostBridge } from '@mapseekai/contracts';

const MAP_DESIGN_HOST_GLOBAL = '__mapDesign__' as const;
const MAP_DESIGN_HOST_VERSION = 1;

export type MapDesignWorkingDirectoryPick =
  | { kind: 'selected'; directory: { path: string; token: string } }
  | { kind: 'cancelled' }
  | { kind: 'failed' };

function isMapDesignHost(value: unknown): value is MapDesignHostBridge {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const host = value as {
    version?: unknown;
    client?: { type?: unknown; platform?: unknown };
    appearance?: { setTheme?: unknown };
    project?: { pickWorkingDirectory?: unknown };
    shell?: { openExternal?: unknown };
  };
  return host.version === MAP_DESIGN_HOST_VERSION
    && host.client?.type === 'desktop'
    && typeof host.client.platform === 'string'
    && typeof host.appearance?.setTheme === 'function'
    && typeof host.project?.pickWorkingDirectory === 'function'
    && typeof host.shell?.openExternal === 'function';
}

export function getMapDesignHost(): MapDesignHostBridge | null {
  const candidate = (globalThis as typeof globalThis & Record<typeof MAP_DESIGN_HOST_GLOBAL, unknown>)[MAP_DESIGN_HOST_GLOBAL];
  return isMapDesignHost(candidate) ? candidate : null;
}

export async function pickMapDesignWorkingDirectory(): Promise<MapDesignWorkingDirectoryPick | null> {
  const host = getMapDesignHost();
  if (!host) return null;
  try {
    const result = await host.project.pickWorkingDirectory();
    if (result.ok) return { kind: 'selected', directory: { path: result.path, token: result.token } };
    return 'cancelled' in result && result.cancelled ? { kind: 'cancelled' } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}
