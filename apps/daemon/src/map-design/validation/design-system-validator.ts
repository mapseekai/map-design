import type { MapValidationFinding, SemanticDocument } from '@mapseekai/map-design-contracts';
import type { StyleDocument } from 'maplibre-style-tools/core';

import type { LoadedMapDesignSystem } from './design-system-loader.js';

export interface DesignSystemValidationInput {
  style: StyleDocument;
  semantics: SemanticDocument;
  designSystem: LoadedMapDesignSystem;
}

export function validateDesignSystemRules(input: DesignSystemValidationInput): MapValidationFinding[] {
  const { designSystem, semantics, style } = input;
  const findings: MapValidationFinding[] = [];
  const scope = { kind: 'design-system' as const, id: designSystem.id };
  const roles = new Set(semantics.groups.map((group) => group.role));
  designSystem.rules.requiredSemanticRoles.forEach((role, index) => {
    if (!roles.has(role)) {
      findings.push(violation(`Required semantic role "${role}" is not mapped.`, scope, `/rules/requiredSemanticRoles/${index}`));
    }
  });
  const labelLayers = style.layers.filter((layer) => layer.type === 'symbol'
    && isPlainObject(layer.layout) && Object.hasOwn(layer.layout, 'text-field'));
  if (labelLayers.length > designSystem.rules.maxLabelLayerCount) {
    findings.push(violation(
      `Label layer count ${labelLayers.length} exceeds maximum ${designSystem.rules.maxLabelLayerCount}.`,
      scope,
      '/rules/maxLabelLayerCount',
    ));
  }
  if (labelLayers.length === 0) return findings;
  const surface = cartographicSurface(style);
  if (!surface.ok) {
    findings.push(unverifiable(surface.reason, scope));
    return findings;
  }
  labelLayers.forEach((layer) => {
    const paint = isPlainObject(layer.paint) ? layer.paint : {};
    const textColor = parseColorLiteral(Object.hasOwn(paint, 'text-color') ? paint['text-color'] : '#000000');
    const textOpacity = literalOpacity(Object.hasOwn(paint, 'text-opacity') ? paint['text-opacity'] : 1);
    if (!textColor || textOpacity === null) {
      findings.push(unverifiable(`label layer "${layer.id}" uses a non-literal text color or opacity`, scope));
      return;
    }
    const renderedText = composite(textColor, textOpacity, surface.color);
    if (contrastRatio(renderedText, surface.color) < designSystem.rules.minimumContrastRatio) {
      findings.push(violation(
        `Label color contrast is below ${designSystem.rules.minimumContrastRatio}.`,
        scope,
        '/rules/minimumContrastRatio',
      ));
    }
  });
  return findings;
}

function violation(message: string, scope: MapValidationFinding['scope'], jsonPointer: string): MapValidationFinding {
  return { severity: 'warning', code: 'DESIGN_SYSTEM_VIOLATION', message, scope, jsonPointer };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];

type CartographicSurface =
  | { ok: true; color: Rgb }
  | { ok: false; reason: string };

function cartographicSurface(style: StyleDocument): CartographicSurface {
  const visibleBackgrounds = style.layers.filter((layer) => layer.type === 'background' && isVisible(layer));
  const layer = visibleBackgrounds.at(-1)
    ?? style.layers.find((candidate) => candidate.type === 'fill' && isVisible(candidate));
  if (!layer) return { ok: false, reason: 'no visible background or fill surface exists' };

  const paint = isPlainObject(layer.paint) ? layer.paint : {};
  const isBackground = layer.type === 'background';
  const colorKey = isBackground ? 'background-color' : 'fill-color';
  const opacityKey = isBackground ? 'background-opacity' : 'fill-opacity';
  const patternKey = isBackground ? 'background-pattern' : 'fill-pattern';
  if (Object.hasOwn(paint, patternKey)) {
    return { ok: false, reason: `surface layer "${layer.id}" uses a pattern` };
  }
  const color = parseColorLiteral(Object.hasOwn(paint, colorKey) ? paint[colorKey] : '#000000');
  const opacity = literalOpacity(Object.hasOwn(paint, opacityKey) ? paint[opacityKey] : 1);
  if (!color || opacity === null) {
    return { ok: false, reason: `surface layer "${layer.id}" uses a non-literal color or opacity` };
  }
  if (color[3] * opacity < 1) {
    return { ok: false, reason: `surface layer "${layer.id}" is translucent over an unknown underlying surface` };
  }
  return { ok: true, color: [color[0], color[1], color[2]] };
}

function isVisible(layer: StyleDocument['layers'][number]): boolean {
  return !isPlainObject(layer.layout) || layer.layout.visibility !== 'none';
}

function unverifiable(reason: string, scope: MapValidationFinding['scope']): MapValidationFinding {
  return violation(
    `Minimum contrast could not be verified: ${reason}.`,
    scope,
    '/rules/minimumContrastRatio',
  );
}

function literalOpacity(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function parseColorLiteral(value: unknown): Rgba | null {
  if (typeof value !== 'string') return null;
  const color = value.trim();
  const hex = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u.exec(color)?.[1];
  if (hex) {
    const normalized = hex.length <= 4
      ? [...hex].map((part) => `${part}${part}`).join('')
      : hex;
    const alpha = normalized.length === 8
      ? Number.parseInt(normalized.slice(6, 8), 16) / 255
      : 1;
    return [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
      alpha,
    ];
  }

  const rgb = /^rgb\(\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*\)$/iu.exec(color);
  if (rgb) return parsedFunctionalColor(rgb, 1);
  const rgba = /^rgba\(\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*(0(?:\.[0-9]+)?|1(?:\.0+)?)\s*\)$/iu.exec(color);
  return rgba ? parsedFunctionalColor(rgba, Number(rgba[4])) : null;
}

function parsedFunctionalColor(match: RegExpExecArray, alpha: number): Rgba | null {
  const channels = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) return null;
  return [channels[0]!, channels[1]!, channels[2]!, alpha];
}

function composite(foreground: Rgba, opacity: number, background: Rgb): Rgb {
  const alpha = foreground[3] * opacity;
  return [
    foreground[0] * alpha + background[0] * (1 - alpha),
    foreground[1] * alpha + background[1] * (1 - alpha),
    foreground[2] * alpha + background[2] * (1 - alpha),
  ];
}

function contrastRatio(left: Rgb, right: Rgb): number {
  const luminance = (color: Rgb) => 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
  const leftLuminance = luminance(left);
  const rightLuminance = luminance(right);
  const lighter = Math.max(leftLuminance, rightLuminance);
  const darker = Math.min(leftLuminance, rightLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function linear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}
