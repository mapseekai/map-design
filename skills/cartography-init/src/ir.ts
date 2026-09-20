/** 规范允许的长度单位(spec §7.2)。不可表示的单位不进 IR,由适配器写入 skipped。 */
export type DimensionUnit = 'px' | 'pt' | 'mm' | 'cm' | 'in';

export interface Dimension {
  value: number;
  unit: DimensionUnit;
}

export type SourceKind = 'style' | 'qgis' | 'lyrx' | 'stylx' | 'sld';

/** 规范 §9.2 geometry 枚举 */
export type Geometry = 'point' | 'line' | 'polygon' | 'label' | 'background' | 'raster' | 'mixed';

export type LayerRole = 'background' | 'context' | 'subject' | 'overlay' | 'annotation' | 'control';

/** 一个去重后的颜色事实。value 为 CSS 颜色字符串(hex 或 rgba())。 */
export interface ExtractedColor {
  value: string;
  /** 语义名提示(来源图层/规则名 slug 化结果),可为空 */
  nameHint?: string;
  usedBy: string[];
}

export interface ExtractedWidth {
  value: Dimension;
  nameHint?: string;
  usedBy: string[];
}

export interface ExtractedDash {
  pattern: Dimension[]; // 非空、同单位(适配器保证)
  nameHint?: string;
  usedBy: string[];
}

export interface ExtractedOpacity {
  value: number; // 0..1
  nameHint?: string;
  usedBy: string[];
}

export interface ExtractedType {
  [extension: string]: unknown;
  fontFamily: string[]; // 非空
  fontSize: Dimension;
  fontWeight?: number | 'normal' | 'bold';
  letterSpacing?: { value: number; unit: DimensionUnit | 'em' };
  lineHeight?: number | { value: number; unit: DimensionUnit | 'em' };
  fontStyle?: string;
  fontFeature?: string;
  fontVariation?: string;
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  nameHint?: string;
  usedBy: string[];
}

/** 元素级样式属性;全部值保持抽取原样(引用在 emit 阶段替换)。 */
export interface CoreStyleProps {
  color?: string;
  fillColor?: string;
  strokeColor?: string;
  outlineColor?: string;
  casingColor?: string;
  haloColor?: string;
  strokeWidth?: Dimension;
  outlineWidth?: Dimension;
  casingWidth?: Dimension;
  haloWidth?: Dimension;
  size?: Dimension;
  opacity?: number;
  fillOpacity?: number;
  strokeOpacity?: number;
  typography?: string; // 指向 consolidate 产出的 typography Token 名;适配器阶段由 ExtractedElement.rawTypography 携带
  symbol?: string;
  dash?: Dimension[];
  offset?: Dimension;
  spacing?: Dimension;
}

export interface ExtractedElement {
  name: string; // 来源名 slug 化前的原始名;TokenIdentifier 合规化由 consolidate 统一执行
  geometry: Geometry;
  family?: string;
  roleHint?: 'primary' | 'secondary' | 'context'; // consolidate 决定最终 role/state
  stateHint?: string;
  layerRole?: LayerRole;
  style: CoreStyleProps;
  rawTypography?: ExtractedType; // 标注元素携带,consolidate 转 Token
  scaleHints: ScaleHint[];
}

export interface ScaleHint {
  /** 机器来源的事实,如 "zoom 8–12 可见"、"scaleDenominator 50000"、"0–10 仅高速" */
  fact: string;
  /** 可解析时给出语义尺度建议 */
  stage?: 'overview' | 'regional' | 'local' | 'detail';
}

export interface SkippedItem {
  source: SourceKind;
  layer?: string; // 原始图层/规则名(未 slug)
  reason: string; // 人类可读原因
  detail?: string; // 原始片段摘要(截断 200 字符)
}

export interface DatasourceItem {
  source: SourceKind;
  layer: string;
  /** 如 "ogr:/data/roads.shp"、"postgres:dbname=gis"、"vector:https://tiles.example.com/{z}/{x}/{y}.pbf" */
  identity: string;
  providerType?: string; // ogr / postgres / wfs / vector / raster / ...
}

export interface BindingItem {
  source: SourceKind;
  layer: string;
  family?: string;
  kind: 'filter' | 'source-layer' | 'field-ref' | 'field-override';
  expression: string; // 原始表达式/字段名
  /** 指回 consolidate 后 elements 中的元素名(emit 前填充) */
  symbolRef?: string;
  /** 补写阶段由 Agent 填写;生成时缺省 */
  triage?: BindingTriage;
}

export interface BindingTriage {
  decision: 'prose' | 'runtime' | 'discard';
  note?: string;
}

export interface UnresolvedItem {
  topic: string; // 如 "target tile source url/type"、"glyphs"、"sprites"、"layer order"、"crs/tiling"
  detail: string;
}

export interface ExtractedStyle {
  source: { kind: SourceKind; name?: string };
  colors: ExtractedColor[];
  widths: ExtractedWidth[];
  sizes: ExtractedWidth[];
  spacing: ExtractedWidth[];
  dashes: ExtractedDash[];
  opacities: ExtractedOpacity[];
  typography: ExtractedType[];
  elements: ExtractedElement[];
  scaleHints: ScaleHint[];
  skipped: SkippedItem[];
  datasources: DatasourceItem[];
  bindings: BindingItem[];
  unresolved: UnresolvedItem[];
}

export function emptyExtracted(source: ExtractedStyle['source']): ExtractedStyle {
  return {
    source,
    colors: [], widths: [], sizes: [], spacing: [], dashes: [], opacities: [], typography: [],
    elements: [], scaleHints: [], skipped: [], datasources: [], bindings: [], unresolved: [],
  };
}
