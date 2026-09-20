import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadMapDesignSystem } from '../../../src/map-design/validation/design-system-loader.js';

describe('production MapDesign rules package', () => {
  it('loads quiet-walking as one strict runtime MAP_DESIGN package', async () => {
    const projectRoot = path.resolve(import.meta.dirname, '../../../../..');
    await expect(loadMapDesignSystem({ projectRoot, designSystemId: 'quiet-walking' })).resolves.toMatchObject({
      id: 'quiet-walking',
      rules: {
        version: 1,
        requiredSemanticRoles: ['background', 'park', 'pedestrian-road', 'place-label'],
        maxLabelLayerCount: 80,
        minimumContrastRatio: 4.5,
      },
    });
  });
});
