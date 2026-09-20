import {
  assertMapDesignResourceUrl,
  assertMapDesignStyleResourceUrls,
} from '@mapseekai/map-design-contracts';
import type { StyleDocument } from 'maplibre-style-tools/core';
import { hashStyle } from 'maplibre-style-tools/maplibre';

export async function hashMapDesignStyle(
  style: StyleDocument,
  projectId: string,
  options: { origin?: string } = {},
): Promise<string> {
  assertMapDesignStyleResourceUrls(style, projectId, options);
  const normalized = structuredClone(style) as StyleDocument;
  const root = normalized as unknown as Record<string, unknown>;
  delete root.id;
  normalizeField(root, 'glyphs', projectId, options);
  normalizeField(root, 'sprite', projectId, options);
  normalizeSprite(root.sprite, projectId, options);
  normalizeImports(root.imports, projectId, options);
  normalizeSources(root.sources, projectId, options);
  normalizeInertBackgroundFilters(root.layers);
  return await hashStyle(normalized);
}

function normalizeInertBackgroundFilters(value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const layer of value) {
    if (!isRecord(layer) || layer.type !== 'background') continue;
    const filter = layer.filter;
    if (Array.isArray(filter) && filter.length === 1 && filter[0] === 'all') delete layer.filter;
  }
}

function normalizeResource(
  value: string,
  projectId: string,
  options: { origin?: string },
): string {
  assertMapDesignResourceUrl(value, projectId, options);
  const origin = options.origin;
  if (origin && value.startsWith(`${origin}/`)) return value.slice(origin.length);
  return value;
}

function normalizeField(
  target: Record<string, unknown>,
  key: string,
  projectId: string,
  options: { origin?: string },
): void {
  if (typeof target[key] === 'string') {
    target[key] = normalizeResource(target[key], projectId, options);
  }
}

function normalizeArray(
  target: Record<string, unknown>,
  key: string,
  projectId: string,
  options: { origin?: string },
): void {
  if (!Array.isArray(target[key])) return;
  target[key] = target[key].map((value) => typeof value === 'string'
    ? normalizeResource(value, projectId, options)
    : value);
}

function normalizeSprite(value: unknown, projectId: string, options: { origin?: string }): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (isRecord(entry)) normalizeField(entry, 'url', projectId, options);
  }
}

function normalizeImports(value: unknown, projectId: string, options: { origin?: string }): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (isRecord(entry)) normalizeField(entry, 'url', projectId, options);
  }
}

function normalizeSources(value: unknown, projectId: string, options: { origin?: string }): void {
  if (!isRecord(value)) return;
  for (const source of Object.values(value)) {
    if (!isRecord(source)) continue;
    normalizeField(source, 'url', projectId, options);
    normalizeField(source, 'data', projectId, options);
    normalizeArray(source, 'tiles', projectId, options);
    normalizeArray(source, 'urls', projectId, options);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
