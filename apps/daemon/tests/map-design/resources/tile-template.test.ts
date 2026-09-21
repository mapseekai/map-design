import { describe, it, expect } from 'vitest';
import { gatewayTileSuffix, expandTileTemplate } from '../../../src/map-design/resources/tile-template.js';

const root = 'https://tiles.example.test';
const expand = (template: string, suffix: string) => expandTileTemplate(template, suffix.split('/')).href;

describe('gateway tile template compatibility', () => {
  it('preserves XYZ and TMS coordinates already expanded by MapLibre', () => {
    expect(expand(`${root}/{z}/{x}/{y}.pbf`, 'tiles/2/1/3.pbf')).toBe(`${root}/2/1/3.pbf`);
  });
  it('preserves both pixel ratios with legacy and explicit suffixes', () => {
    const template = `${root}/{z}/{x}/{y}{ratio}.png`;
    expect(gatewayTileSuffix(template)).toBe('{z}/{x}/{y}.png/r{ratio}');
    expect(expand(template, 'tiles/1/0/0.png/r@2x')).toBe(`${root}/1/0/0@2x.png`);
    expect(expand(template, 'tiles/1/0/0.png/r')).toBe(`${root}/1/0/0.png`);
    expect(expand(template, 'tiles/1/0/0@2x.png')).toBe(`${root}/1/0/0@2x.png`);
  });
  it('expands quadkey and prefix including zoom zero', () => {
    expect(expand(`${root}/{prefix}/{quadkey}.png`, 'tiles/2/2/3.png/p23/q32')).toBe(`${root}/23/32.png`);
    expect(expand(`${root}/{quadkey}.png`, 'tiles/0/0/0.png/q')).toBe(`${root}/.png`);
  });
  it('expands legacy WMS bbox and carries the canonical bbox with TMS', () => {
    const template = `${root}/wms?bbox={bbox-epsg-3857}`;
    expect(new URL(expand(template, 'tiles/1/0/0')).searchParams.get('bbox')).toBe('-20037508.342789244,0,0,20037508.342789244');
    expect(new URL(expand(template, 'tiles/1/0/1/b-20037508.342789244,0,0,20037508.342789244')).searchParams.get('bbox')).toBe('-20037508.342789244,0,0,20037508.342789244');
  });
  it.each(['tiles/25/0/0', 'tiles/1/2/0', 'tiles/1/0/0/r@8x', 'tiles/1/0/0/q99', 'tiles/1/0/0/b1,2,0,1', 'tiles/1/0/0/r/r'])('rejects malformed expansion %s', (suffix) => {
    expect(() => expand(`${root}/{z}/{x}/{y}{ratio}.png`, suffix)).toThrow();
  });
});
