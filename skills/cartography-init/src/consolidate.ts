import type {
  CoreStyleProps,
  Dimension,
  ExtractedElement,
  ExtractedStyle,
  ExtractedType,
  Geometry,
  LayerRole,
  ScaleHint,
} from './ir.js';

/** consolidate 后元素样式: 原字面量值替换为 Token 名。 */
export type ConsolidatedStyle = Partial<Record<keyof CoreStyleProps, string | string[]>>;

/** consolidate 阶段与 ir.ts 的 ExtractedType 同形，但不保留抽取元数据。 */
export type TypographyToken = Pick<ExtractedType, 'fontFamily' | 'fontSize' | 'fontWeight' | 'lineHeight' | 'letterSpacing' | 'fontStyle' | 'textTransform' | 'fontFeature' | 'fontVariation'> & Record<string, unknown>;

export interface ConsolidatedElement {
  name: string;
  geometry: Geometry;
  family?: string;
  role?: 'primary' | 'secondary' | 'context';
  state?: string;
  layerRole?: LayerRole;
  style: ConsolidatedStyle;
  scaleHints: ScaleHint[];
}

export interface Consolidated {
  tokens: {
    colors: Record<string, string>;
    widths: Record<string, Dimension>;
    sizes: Record<string, Dimension>;
    spacing: Record<string, Dimension>;
    dashes: Record<string, Dimension[]>;
    opacities: Record<string, number>;
    typography: Record<string, TypographyToken>;
  };
  elements: ConsolidatedElement[];
  nameMap: Map<string, string>;
  notes: string[];
}

type TokenGroup = keyof Consolidated['tokens'];

const colorProperties = ['color', 'fillColor', 'strokeColor', 'outlineColor', 'casingColor', 'haloColor'];
const widthProperties = ['strokeWidth', 'outlineWidth', 'casingWidth', 'haloWidth'];
const opacityProperties = ['opacity', 'fillOpacity', 'strokeOpacity'];

export function slugify(raw: string): string {
  return raw.toLowerCase().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Compare all core and extension fields, independently of mapping insertion order. */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableKey).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => JSON.stringify(k) + ':' + stableKey(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

function typeToken(value: ExtractedType): TypographyToken {
  const { nameHint: _nameHint, usedBy: _usedBy, ...token } = value;
  return token;
}

export function consolidate(ir: ExtractedStyle): Consolidated {
  const tokens: Consolidated['tokens'] = { colors: {}, widths: {}, sizes: {}, spacing: {}, dashes: {}, opacities: {}, typography: {} };
  const notes: string[] = [];
  const registry = new Map<string, string>();
  const values = new Map<string, string>();
  const facts = {
    colors: ir.colors.map(f => ({ ...f })),
    widths: ir.widths, sizes: ir.sizes, spacing: ir.spacing,
    dashes: ir.dashes.map(f => ({ ...f, value: f.pattern })),
    opacities: ir.opacities,
    typography: ir.typography.map(f => ({ value: typeToken(f), nameHint: f.nameHint, usedBy: f.usedBy })),
  };
  const consumed = new Set<unknown>();
  const register = (group: TokenGroup, value: unknown, hint: string): string => {
    const scope = slugify(hint) || 'token';
    const valueKey = stableKey(value);
    const key = group + ':' + hint + ':' + valueKey;
    const existing = registry.get(key);
    if (existing) return existing;
    const target = tokens[group] as Record<string, unknown>;
    let name = scope;
    let suffix = 2;
    while (Object.hasOwn(target, name)) name = scope + '-' + suffix++;
    const candidate = values.get(group + ':' + valueKey);
    if (candidate) notes.push('Shared-value candidate: ' + group + '.' + candidate + ' and ' + group + '.' + name + '; confirm design semantics before merging.');
    else values.set(group + ':' + valueKey, name);
    target[name] = value;
    registry.set(key, name);
    return name;
  };
  const tokenFor = (group: TokenGroup, value: unknown, element: ExtractedElement, property: string, elementName: string): string => {
    const matches = facts[group].filter(f => f.usedBy.includes(element.name) && stableKey(f.value) === stableKey(value));
    for (const fact of matches) consumed.add(fact);
    // A name hint is extraction provenance, not evidence that unrelated elements share a design scale.
    return register(group, value, elementName + '-' + property);
  };
  const nameMap = new Map<string, string>();
  const elementNames = new Set<string>();
  const elements: ConsolidatedElement[] = ir.elements.map((element, index) => {
    const base = slugify(element.name) || 'element-' + (index + 1);
    let name = base;
    let suffix = 2;
    while (elementNames.has(name)) name = base + '-' + suffix++;
    elementNames.add(name);
    nameMap.set(element.name, name);
    const style: ConsolidatedStyle = {};
    for (const [property, value] of Object.entries(element.style)) {
      if (value === undefined) continue;
      const prop = property as keyof CoreStyleProps;
      if (property === 'offset') {
        const d = value as Dimension;
        style.offset = d.value + d.unit;
        continue;
      }
      const group: TokenGroup | undefined = colorProperties.includes(property) ? 'colors'
        : widthProperties.includes(property) ? 'widths'
        : property === 'size' ? 'sizes'
        : property === 'spacing' ? 'spacing'
        : opacityProperties.includes(property) ? 'opacities'
        : property === 'dash' ? 'dashes' : undefined;
      if (group) style[prop] = tokenFor(group, value, element, property, name);
      else if (typeof value === 'string') style[prop] = value;
    }
    if (element.rawTypography) style.typography = tokenFor('typography', typeToken(element.rawTypography), element, 'typography', name);
    return {
      name, geometry: element.geometry, style, scaleHints: element.scaleHints,
      ...(element.family === undefined ? {} : { family: element.family }),
      ...(element.roleHint === undefined ? {} : { role: element.roleHint }),
      ...(element.stateHint === undefined ? {} : { state: element.stateHint }),
      ...(element.layerRole === undefined ? {} : { layerRole: element.layerRole }),
    };
  });
  for (const group of Object.keys(facts) as TokenGroup[]) {
    for (const [index, fact] of facts[group].entries()) {
      if (!consumed.has(fact)) register(group, fact.value, (fact.nameHint ?? fact.usedBy.join('-')) || group + '-' + (index + 1));
    }
  }
  notes.push('Extracted ' + elements.length + ' elements. Unconfirmed roles and states omitted; equal values do not establish shared semantics.');
  return { tokens, elements, nameMap, notes };
}
