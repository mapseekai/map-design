import { parseCartography, resolveReferences } from '@mapseekai/cartography.md';
import { CartographyPreviewColorSchema, CartographyMapElementSchema, type CartographyPreview } from '@mapseekai/map-design-contracts';

/** Displays declared tokens only: no inferred map roles or default design values. */
export function cartographyPreview(source: string): CartographyPreview {
  const preview: CartographyPreview = { palette: [], typography: [] };
  try {
    const parsed = parseCartography(source);
    if (!parsed.config || parsed.findings.some((finding) => finding.severity === 'error')) return preview;
    const config = record(resolveReferences(parsed.config));
    preview.elements = [];
    for (const [name, raw] of Object.entries(record(config.elements)).slice(0, 256)) {
      const element = record(raw);
      if (element.state && element.state !== 'default') continue;
      const normalized: Record<string, unknown> = { name, geometry: element.geometry, unsupported: [] };
      // Optional standard fields must be absent, not undefined, in canonical receipts.
      for (const key of ['family', 'role']) if (element[key] !== undefined) normalized[key] = element[key];
      const unsupported = normalized.unsupported as string[];
      for (const key of ['color', 'fillColor', 'strokeColor', 'outlineColor', 'casingColor', 'haloColor']) {
        if (element[key] === undefined) continue;
        const color = CartographyPreviewColorSchema.safeParse(element[key]);
        if (color.success) normalized[key] = color.data; else unsupported.push(key);
      }
      for (const key of ['strokeWidth', 'outlineWidth', 'casingWidth', 'haloWidth', 'size']) {
        if (element[key] === undefined) continue;
        const value = absolutePixels(element[key]);
        const max = key === 'size' ? 128 : key === 'haloWidth' ? 16 : 64;
        if (value !== undefined && value <= max) normalized[key] = value; else unsupported.push(key);
      }
      for (const key of ['opacity', 'fillOpacity', 'strokeOpacity']) if (typeof element[key] === 'number') normalized[key] = element[key];
      if (Array.isArray(element.dash)) {
        const dash = element.dash.map(absolutePixels);
        if (dash.length >= 2 && dash.length <= 16 && dash.every((value) => value !== undefined && value > 0 && value <= 128)) normalized.dash = dash;
        else unsupported.push('dash');
      }
      const type = record(element.typography);
      const families = Array.isArray(type.fontFamily) ? type.fontFamily : [type.fontFamily];
      const safeFonts = families.filter((value): value is string => typeof value === 'string' && /^[\p{L}\p{N} _-]{1,80}$/u.test(value));
      if (safeFonts.length) normalized.fontFamily = safeFonts.slice(0, 8);
      const fontSize = absolutePixels(type.fontSize);
      if (fontSize && fontSize <= 96) normalized.fontSize = fontSize;
      else if (type.fontSize !== undefined) unsupported.push('fontSize');
      for (const key of ['fontWeight', 'letterSpacing', 'lineHeight', 'fontStyle']) if (type[key] !== undefined) unsupported.push(key);
      for (const key of ['pattern', 'offset', 'spacing']) if (element[key] !== undefined) unsupported.push(key);
      if (element.symbol && element.symbol !== 'circle') unsupported.push('symbol');
      const result = CartographyMapElementSchema.safeParse(normalized);
      if (result.success) preview.elements.push(result.data);
    }
    for (const [name, value] of Object.entries(record(config.colors))) {
      const color = CartographyPreviewColorSchema.safeParse(value);
      if (color.success && preview.palette.length < 1024) preview.palette.push({ name: name.slice(0, 128), color: color.data });
    }
    const typography = { ...record(config.typography) };
    // Inline element typography is also explicitly defined, and has no root token name.
    for (const [name, value] of Object.entries(record(parsed.config.elements))) {
      if (typeof record(value).typography === 'object') typography[`elements.${name}`] = record(record(config.elements)[name]).typography;
    }
    for (const [name, value] of Object.entries(typography).slice(0, 128)) {
      const token = record(value);
      const families = Array.isArray(token.fontFamily) ? token.fontFamily : [token.fontFamily];
      const safe = families.filter((item): item is string => typeof item === 'string' && /^[\p{L}\p{N} _-]{1,80}$/u.test(item));
      if (!safe.length) continue;
      const fontFamily = safe.map((family) => ['serif', 'sans-serif', 'monospace', 'system-ui'].includes(family) ? family : JSON.stringify(family)).join(', ');
      if (fontFamily.length > 512) continue;
      preview.typography!.push({ name: name.slice(0, 128), fontFamily,
        ...(typeof token.fontSize === 'string' ? { fontSize: token.fontSize } : {}),
        ...(typeof token.fontWeight === 'number' || token.fontWeight === 'normal' || token.fontWeight === 'bold' ? { fontWeight: token.fontWeight } : {}),
      });
    }
  } catch { /* Unsupported documents can still be read in the original document view. */ }
  return preview;
}

function absolutePixels(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)(px|pt|mm|cm|in)$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * ({ px: 1, pt: 96 / 72, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }[match[2]!] ?? 1);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
