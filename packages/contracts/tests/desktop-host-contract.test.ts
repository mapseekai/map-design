import { describe, expect, it } from 'vitest';

import {
  MAP_DESIGN_HOST_GLOBAL,
  MAP_DESIGN_HOST_VERSION,
  type MapDesignHostBridge,
} from '../src/index.js';

describe('MapDesignHostBridge', () => {
  it('defines the versioned, narrow renderer surface', () => {
    const bridge: MapDesignHostBridge = {
      version: MAP_DESIGN_HOST_VERSION,
      client: { type: 'desktop', platform: 'linux' },
      appearance: { setTheme: () => {} },
      project: { pickWorkingDirectory: async () => ({ ok: false, cancelled: true }) },
      shell: { openExternal: async () => ({ ok: true }) },
    };

    expect(MAP_DESIGN_HOST_GLOBAL).toBe('__mapDesign__');
    expect(MAP_DESIGN_HOST_VERSION).toBe(1);
    expect(Object.keys(bridge).sort()).toEqual([
      'appearance',
      'client',
      'project',
      'shell',
      'version',
    ]);
    expect(Object.keys(bridge.project)).toEqual(['pickWorkingDirectory']);
    expect(bridge).not.toHaveProperty('browser');
    expect(bridge).not.toHaveProperty('capture');
    expect(bridge).not.toHaveProperty('pdf');
    expect(bridge.project).not.toHaveProperty('pickAndImport');
    expect(bridge.project).not.toHaveProperty('pickAndReplaceWorkingDir');
    expect(bridge.shell).not.toHaveProperty('openPath');
  });
});
