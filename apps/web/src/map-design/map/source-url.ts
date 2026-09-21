import { MapSourceReferenceSchema } from '@mapseekai/map-design-contracts';

/** Syntax only. Import-time DNS, network policy and document checks remain in the daemon. */
export function parseMapSourceUrl(value: string): string | null {
  const url = value.trim();
  if (!MapSourceReferenceSchema.safeParse({ url }).success) return null;
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) return null;
  return url;
}
