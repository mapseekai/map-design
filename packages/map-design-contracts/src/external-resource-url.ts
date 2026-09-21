/** Browser-only remote resources: never daemon credentials, local schemes or local addresses. */
export function assertExternalMapResourceUrl(value: string, origin?: string): string {
  if (typeof value !== 'string' || value.length > 8192) throw new TypeError('Invalid external map resource URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
    || (origin && url.origin === origin)) throw new TypeError('External map resources require HTTP(S) without URL credentials');
  const host = url.hostname.toLowerCase().replace(/\.$/u, '').replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || /(?:^|\.)(?:localhost|local|internal|lan|home)$/u.test(host)
    || (!host.includes('.') && !host.includes(':'))) throw new TypeError('Local map addresses require the resource gateway');
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(host)) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))) {
      throw new TypeError('Local map addresses require the resource gateway');
    }
  }
  if (host.includes(':') && /^(?:::|fc|fd|fe[89ab]|ff)/iu.test(host)) {
    throw new TypeError('Local map addresses require the resource gateway');
  }
  return url.href.replace(/%7b/giu, '{').replace(/%7d/giu, '}');
}
