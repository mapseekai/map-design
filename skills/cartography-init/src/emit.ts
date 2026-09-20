import type { Consolidated, ConsolidatedElement, TypographyToken } from './consolidate.js';
import type { ExtractedStyle } from './ir.js';

type YamlScalar = string | number | boolean | null;
const dimensionMarker = Symbol('dimension');
interface YamlDimension {
  [dimensionMarker]: true;
  value: string;
}
type YamlValue = YamlScalar | YamlDimension | YamlValue[] | { [key: string]: YamlValue };

function formatDimension({ value, unit }: { value: number; unit: string }): YamlDimension {
  return { [dimensionMarker]: true, value: `${value}${unit}` };
}

function isDimension(value: YamlValue): value is YamlDimension {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && dimensionMarker in value;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function scalar(value: YamlScalar, inArray = false): string {
  return JSON.stringify(value);
}

/** Emits the intentionally small YAML subset used by CARTOGRAPHY.md front matter. */
function emitYaml(value: YamlValue, indent = 0): string[] {
  if (isDimension(value)) return [quoted(value.value)];
  if (Array.isArray(value)) return [`[${value.map(item => {
    if (isDimension(item)) return quoted(item.value);
    if (typeof item === 'object' && item !== null) return JSON.stringify(item);
    return scalar(item as YamlScalar, true);
  }).join(', ')}]`];
  if (typeof value !== 'object' || value === null) return [scalar(value)];

  const lines: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const prefix = `${' '.repeat(indent)}${/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) && !/^(true|false|null)$/i.test(key) ? key : quoted(key)}:`;
    if (typeof child === 'object' && child !== null && !Array.isArray(child) && !isDimension(child)) {
      if (Object.keys(child).length === 0) lines.push(`${prefix} {}`);
      else lines.push(prefix, ...emitYaml(child, indent + 2));
    } else {
      lines.push(`${prefix} ${emitYaml(child, indent)[0]}`);
    }
  }
  return lines;
}

function typographyYaml(token: TypographyToken): YamlValue {
  return {
    ...token as Record<string, YamlValue>,
    fontFamily: token.fontFamily,
    fontSize: formatDimension(token.fontSize),
    ...(token.fontWeight === undefined ? {} : { fontWeight: token.fontWeight }),
    ...(token.letterSpacing === undefined ? {} : { letterSpacing: formatDimension(token.letterSpacing) }),
    ...(token.lineHeight === undefined
      ? {}
      : { lineHeight: typeof token.lineHeight === 'number' ? token.lineHeight : formatDimension(token.lineHeight) }),
    ...(token.textTransform === undefined ? {} : { textTransform: token.textTransform }),
  };
}

function elementYaml(element: ConsolidatedElement): YamlValue {
  const style: Record<string, YamlValue> = {};
  for (const [property, token] of Object.entries(element.style)) {
    if (Array.isArray(token)) style[property] = token;
    else if (token) {
      const group = property === 'typography' ? 'typography'
        : property === 'dash' ? 'dashes'
          : ['color', 'fillColor', 'strokeColor', 'outlineColor', 'casingColor', 'haloColor'].includes(property) ? 'colors'
            : ['strokeWidth', 'outlineWidth', 'casingWidth', 'haloWidth'].includes(property) ? 'widths'
              : property === 'size' ? 'sizes'
                : property === 'spacing' ? 'spacing'
              : ['opacity', 'fillOpacity', 'strokeOpacity'].includes(property) ? 'opacities'
                : undefined;
      style[property] = group ? `{${group}.${token}}` : token;
    }
  }

  return {
    geometry: element.geometry,
    ...(element.family === undefined ? {} : { family: element.family }),
    ...(element.role === undefined ? {} : { role: element.role }),
    ...(element.state === undefined ? {} : { state: element.state }),
    ...(element.layerRole === undefined ? {} : { layerRole: element.layerRole }),
    ...style,
  };
}

function section(title: string, body: string[]): string {
  return `## ${title}\n\n${body.join('\n')}`;
}

/**
 * Produces a self-contained CARTOGRAPHY.md draft from consolidated visual facts.
 * Runtime bindings and datasource identities deliberately remain out of the document.
 */
export function emitDocument(c: Consolidated, ir: ExtractedStyle, opts: { name: string; sourceFile: string }): string {
  const tokens: Record<string, YamlValue> = {};
  if (Object.keys(c.tokens.colors).length) tokens.colors = c.tokens.colors;
  if (Object.keys(c.tokens.widths).length) {
    tokens.widths = Object.fromEntries(Object.entries(c.tokens.widths).map(([name, value]) => [name, formatDimension(value)]));
  }
  for (const group of ['sizes', 'spacing'] as const) {
    if (Object.keys(c.tokens[group]).length) tokens[group] = Object.fromEntries(Object.entries(c.tokens[group]).map(([name, value]) => [name, formatDimension(value)]));
  }
  if (Object.keys(c.tokens.dashes).length) {
    tokens.dashes = Object.fromEntries(Object.entries(c.tokens.dashes).map(([name, values]) => [name, values.map(formatDimension)]));
  }
  if (Object.keys(c.tokens.opacities).length) tokens.opacities = c.tokens.opacities;
  if (Object.keys(c.tokens.typography).length) {
    tokens.typography = Object.fromEntries(Object.entries(c.tokens.typography).map(([name, value]) => [name, typographyYaml(value)]));
  }

  const frontMatter: YamlValue = {
    version: '0.4.0',
    name: opts.name,
    ...tokens,
    elements: Object.fromEntries(c.elements.map(element => [element.name, elementYaml(element)])),
  };
  const sections = [
    section('Overview', ['> TODO(agent): 说明稳定视觉身份、主题和适用边界。']),
    section('Colors', ['> TODO(agent): 说明颜色的稳定语义、禁用组合与冗余视觉通道。']),
    section('Typography & Labels', ['> TODO(agent): 说明标注层级、拥挤时的保留与舍弃顺序。']),
    section('Composition & Density', ['> TODO(agent): 说明主体、上下文、留白与密度取舍。']),
    section('Layering & Depth', ['> TODO(agent): 说明概念视觉层级与遮挡原则。']),
    section('Geometry & Symbols', ['> TODO(agent): 说明符号家族；size 为旋转前主体长边。为非零 offset 定义参照、方向和正负含义，为 spacing 定义间距类型。']),
    section('Scale & Generalization', ['> TODO(agent): 指定基础表达所在阶段、overview / regional / local / detail 的 Token 替换与显隐、可变化属性及不变量。']),
    section('Map Elements', [
      ...c.elements.map(element => `### ${element.name}\n\n> TODO(agent): 确认用途、使用边界、family/role、状态冲突与尺度不变量。`),
      '> TODO(agent): 只有明确证据才能填写角色与状态；不按名称、颜色或排列推断。',
    ]),
    section("Do's and Don'ts", ['> TODO(agent): 说明最容易破坏视觉身份的错误；语义状态优先于操作反馈和装饰。']),
  ];
  return `---\n${emitYaml(frontMatter).join('\n')}\n---\n\n${sections.join('\n\n')}\n`;
}
