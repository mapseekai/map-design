const EXTRA_TOKENS = [
  ['prefix', 'p'], ['ratio', 'r'], ['quadkey', 'q'], ['bbox-epsg-3857', 'b'],
] as const;

/** Carry MapLibre's native expansions, including ratio and canonical bbox under TMS. */
export function gatewayTileSuffix(template: string): string {
  const extension = template.match(/\.(pbf|mvt|mlt|png|jpe?g|webp|avif)(?=[?#]|$)/iu)?.[0] ?? '';
  const extras = EXTRA_TOKENS.filter(([name]) => template.includes(`{${name}}`))
    .map(([name, prefix]) => `${prefix}{${name}}`);
  return [`{z}/{x}/{y}${extension}`, ...extras].join('/');
}

export function parseTileCoordinates(suffix: readonly string[]): { z: number; x: number; y: number } {
  if (suffix.length < 4 || suffix.length > 8 || suffix[0] !== 'tiles'
    || !/^\d+$/u.test(suffix[1] ?? '') || !/^\d+$/u.test(suffix[2] ?? '')
    || !/^\d+(?:@2x)?(?:\.[A-Za-z0-9]+)?$/u.test(suffix[3] ?? '')) {
    throw new TypeError('Map tile suffix is invalid');
  }
  const z = Number(suffix[1]); const x = Number(suffix[2]);
  const y = Number(suffix[3]!.replace(/(?:@2x)?(?:\.[A-Za-z0-9]+)?$/u, ''));
  if (![z, x, y].every(Number.isSafeInteger) || z < 0 || z > 24
    || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw new TypeError('Map tile coordinates are invalid');
  return { z, x, y };
}

export function expandTileTemplate(template: string, suffix: readonly string[]): URL {
  const { z, x, y } = parseTileCoordinates(suffix);
  const extent = 20037508.342789244; const size = extent * 2 / 2 ** z;
  let quadkey = '';
  for (let shift = z - 1; shift >= 0; shift--) quadkey += String(((x >> shift) & 1) + 2 * ((y >> shift) & 1));
  const values: Record<string, string> = { z: String(z), x: String(x), y: String(y),
    prefix: (x % 16).toString(16) + (y % 16).toString(16), quadkey,
    ratio: suffix[3]!.includes('@2x') ? '@2x' : '',
    'bbox-epsg-3857': [-extent + x * size, extent - (y + 1) * size, -extent + (x + 1) * size, extent - y * size].join(','),
  };
  const seen = new Set<string>();
  for (const segment of suffix.slice(4)) {
    const token = EXTRA_TOKENS.find(([, prefix]) => segment.startsWith(prefix));
    if (!token || seen.has(token[0])) throw new TypeError('Map tile parameters are invalid');
    const value = segment.slice(1); seen.add(token[0]);
    if (token[0] === 'ratio' && value !== '' && value !== '@2x') throw new TypeError('Invalid pixel ratio');
    if (token[0] === 'prefix' && !/^[0-9a-f]{2}$/u.test(value)) throw new TypeError('Invalid prefix');
    if (token[0] === 'quadkey' && (!/^[0-3]*$/u.test(value) || value.length !== z)) throw new TypeError('Invalid quadkey');
    if (token[0] === 'bbox-epsg-3857') {
      const coordinates = value.split(',').map(Number);
      if (!/^[-+0-9.eE,]+$/u.test(value) || coordinates.length !== 4
        || coordinates.some((n) => !Number.isFinite(n) || Math.abs(n) > extent + 1)
        || coordinates[0]! >= coordinates[2]! || coordinates[1]! >= coordinates[3]!) throw new TypeError('Invalid bbox');
    }
    values[token[0]] = value;
  }
  let url = template;
  for (const [key, value] of Object.entries(values)) url = url.replaceAll(`{${key}}`, value);
  if (/\{[^}]+\}/u.test(url)) throw new TypeError('Map resource template is invalid');
  return new URL(url);
}
