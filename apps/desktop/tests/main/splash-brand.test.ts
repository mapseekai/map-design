import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const splashMarkSource = read('../../src/main/splash-mark.ts');
const standardMark = read('../../../../assets/brand/map-design.svg').replace(/\r\n/g, '\n');

describe('desktop splash branding', () => {
  it('embeds the standard MapDesign mark instead of the retired video splash', () => {
    expect(splashMarkSource).toContain('SPLASH_MARK_DATA_URL');
    expect(splashMarkSource).not.toContain('SPLASH_VIDEO_DATA_URL');
    expect(splashMarkSource).toContain('alt="MapDesign"');
    expect(splashMarkSource).toContain(
      `data:image/svg+xml;base64,${Buffer.from(standardMark).toString('base64')}`,
    );
  });
});
