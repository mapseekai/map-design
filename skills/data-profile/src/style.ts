import type {
  Evidence,
  FieldFact,
  LayerFact,
  ProfileFragment,
  SourceFact,
  UnresolvedItem,
} from './types.js';
import {sanitizeReference, type SanitizedReference} from './sanitize.js';

const legacyFieldOperators = new Set(['==', '!=', '>', '>=', '<', '<=', 'in', '!in', '!has']);
const templateFieldPattern = /\{([^{}]+)\}/g;

interface FieldReferences {
  fields: string[];
  dynamic: boolean;
}

interface CollectorContext {
  legacyFilter: boolean;
  textField: boolean;
}

type CollectorMode = 'legacy-filter' | 'expression';

interface SourceTemplate extends SanitizedReference {
  location: 'url' | `tiles/${number}`;
}

function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function ownValue<T>(values: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function styleEvidence(input: string, location: string): Evidence {
  return {kind: 'style-inferred', input, location};
}

function addFieldReference(references: FieldReferences, field: string): void {
  if (!references.fields.includes(field)) {
    references.fields.push(field);
  }
}

function collectReferences(
  value: unknown,
  references: FieldReferences,
  context: CollectorContext,
): void {
  if (Array.isArray(value)) {
    const [operator, field] = value;

    if (operator === 'literal') {
      return;
    }

    if (operator === 'get' || operator === 'has') {
      if (typeof field === 'string') {
        addFieldReference(references, field);
      } else {
        references.dynamic = true;
      }
    } else if (
      context.legacyFilter &&
      typeof operator === 'string' &&
      legacyFieldOperators.has(operator)
    ) {
      if (typeof field === 'string') {
        addFieldReference(references, field);
      }
    }

    for (const item of value) {
      collectReferences(item, references, {...context, textField: false});
    }
    return;
  }

  if (isPlainObject(value)) {
    for (const [key, property] of Object.entries(value)) {
      collectReferences(property, references, {
        ...context,
        textField: context.textField || key === 'text-field',
      });
    }
    return;
  }

  if (context.textField && typeof value === 'string') {
    for (const match of value.matchAll(templateFieldPattern)) {
      const field = match[1]?.trim();
      if (field) {
        addFieldReference(references, field);
      }
    }
  }
}

function referencesFor(value: unknown, mode: CollectorMode): FieldReferences {
  const references: FieldReferences = {fields: [], dynamic: false};
  collectReferences(value, references, {legacyFilter: mode === 'legacy-filter', textField: false});
  return references;
}

function layerReferences(layer: Record<string, unknown>): FieldReferences {
  const references: FieldReferences = {fields: [], dynamic: false};
  collectReferences(layer.filter, references, {legacyFilter: true, textField: false});
  collectReferences(layer.layout, references, {legacyFilter: false, textField: false});
  collectReferences(layer.paint, references, {legacyFilter: false, textField: false});
  return references;
}

/**
 * Collects field names used by supported MapLibre expressions and legacy filters.
 * Arbitrary string literals are intentionally ignored.
 */
export function collectReferencedFields(value: unknown): string[] {
  return referencesFor(value, 'legacy-filter').fields;
}

function emptyLayerFact(evidence: Evidence): LayerFact {
  return {
    geometries: ['unknown'],
    stableIdObserved: false,
    fields: record<FieldFact>(),
    evidence: [evidence],
  };
}

function fieldFact(evidence: Evidence): FieldFact {
  return {
    types: ['unknown'],
    categories: [],
    missingObserved: false,
    nullObserved: false,
    evidence: [evidence],
  };
}

function sourceFact(type: string, tileTemplates: string[], evidence: Evidence): SourceFact {
  return {type, tileTemplates, layers: record<LayerFact>(), evidence: [evidence]};
}

function addUnresolved(
  unresolved: UnresolvedItem[],
  code: string,
  input: string,
  location: string,
  message: string,
): void {
  unresolved.push({code, location, message, evidence: [styleEvidence(input, location)]});
}

function appendEvidence(evidence: Evidence[], candidate: Evidence): void {
  if (
    evidence.some((item) =>
      item.kind === candidate.kind &&
      item.input === candidate.input &&
      item.location === candidate.location &&
      item.observedAt === candidate.observedAt
    )
  ) {
    return;
  }
  evidence.push(candidate);
}

function mergeMinzoom(layer: LayerFact, minzoom: unknown): void {
  if (typeof minzoom !== 'number' || !Number.isFinite(minzoom)) {
    return;
  }
  layer.minzoom = layer.minzoom === undefined ? minzoom : Math.min(layer.minzoom, minzoom);
}

function mergeMaxzoom(layer: LayerFact, maxzoom: unknown): void {
  if (typeof maxzoom !== 'number' || !Number.isFinite(maxzoom)) {
    return;
  }
  layer.maxzoom = layer.maxzoom === undefined ? maxzoom : Math.max(layer.maxzoom, maxzoom);
}

function sourceTemplates(source: Record<string, unknown>): SourceTemplate[] {
  const templates: SourceTemplate[] = [];
  if (typeof source.url === 'string') {
    templates.push({
      location: 'url',
      ...sanitizeReference(source.url),
    });
  }
  if (Array.isArray(source.tiles)) {
    for (const [index, tile] of source.tiles.entries()) {
      if (typeof tile === 'string') {
        templates.push({
          location: `tiles/${index}`,
          ...sanitizeReference(tile),
        });
      }
    }
  }
  return templates;
}

/**
 * Discovers only evidence available in a style document. It never fetches a
 * source and deliberately does not derive field values, categories, or types.
 */
export function discoverStyle(style: unknown, input: string): ProfileFragment {
  const fragment: ProfileFragment = {
    inputs: [input],
    sources: record<SourceFact>(),
    unresolved: [],
  };

  if (!isPlainObject(style)) {
    addUnresolved(
      fragment.unresolved,
      'style-not-plain-object',
      input,
      '#',
      'The style document is not a plain object and cannot be inspected.',
    );
    return fragment;
  }

  if (isPlainObject(style.sources)) {
    for (const [sourceId, source] of Object.entries(style.sources)) {
      if (!isPlainObject(source)) {
        continue;
      }

      const location = `#/sources/${sourceId}`;
      const type = typeof source.type === 'string' ? source.type : 'unknown';
      const templates = sourceTemplates(source);
      fragment.sources[sourceId] = sourceFact(
        type,
        templates.map((template) => template.value),
        styleEvidence(input, location),
      );

      for (const template of templates) {
        const templateLocation = `${location}/${template.location}`;
        if (template.credentialRedacted) {
          addUnresolved(
            fragment.unresolved,
            'credential-redacted',
            input,
            templateLocation,
            'Credentials or sensitive URL data was redacted before this source template was retained.',
          );
        }
        if (template.location === 'url' && !template.validHttpUrl) {
          addUnresolved(
            fragment.unresolved,
            'source-url-not-inspectable',
            input,
            templateLocation,
            'The non-HTTP source URL cannot be inspected without a provider-specific fetcher.',
          );
        }
        if (
          template.location.startsWith('tiles/') &&
          !template.validHttpUrl &&
          !template.explicitLocalTemplate
        ) {
          addUnresolved(
            fragment.unresolved,
            'tile-template-not-inspectable',
            input,
            templateLocation,
            'The tile template is neither HTTP(S) nor an explicit local path and cannot be inspected.',
          );
        }
      }
    }
  }

  if (!Array.isArray(style.layers)) {
    return fragment;
  }

  for (const [index, candidate] of style.layers.entries()) {
    if (!isPlainObject(candidate) || typeof candidate.source !== 'string') {
      continue;
    }

    const location = `#/layers/${index}`;
    const sourceId = candidate.source;
    const source =
      ownValue(fragment.sources, sourceId) ??
      sourceFact('unknown', [], styleEvidence(input, `${location}/source`));
    fragment.sources[sourceId] = source;

    const sourceLayer = typeof candidate['source-layer'] === 'string' ? candidate['source-layer'] : 'default';
    if (source.type === 'vector' && typeof candidate['source-layer'] !== 'string') {
      addUnresolved(
        fragment.unresolved,
        'vector-layer-missing-source-layer',
        input,
        location,
        'A vector style layer has no string source-layer, so its data layer remains unresolved.',
      );
    }

    const contributionEvidence = styleEvidence(input, location);
    const layer =
      ownValue(source.layers, sourceLayer) ?? emptyLayerFact(contributionEvidence);
    source.layers[sourceLayer] = layer;
    const references = layerReferences(candidate);
    if (
      (typeof candidate.minzoom === 'number' && Number.isFinite(candidate.minzoom)) ||
      (typeof candidate.maxzoom === 'number' && Number.isFinite(candidate.maxzoom)) ||
      references.fields.length > 0
    ) {
      appendEvidence(layer.evidence, contributionEvidence);
    }
    mergeMinzoom(layer, candidate.minzoom);
    mergeMaxzoom(layer, candidate.maxzoom);

    for (const field of references.fields) {
      if (!Object.hasOwn(layer.fields, field)) {
        layer.fields[field] = fieldFact(contributionEvidence);
      } else {
        appendEvidence(layer.fields[field]!.evidence, contributionEvidence);
      }
    }
    if (references.dynamic) {
      addUnresolved(
        fragment.unresolved,
        'dynamic-field-reference',
        input,
        location,
        'A get or has expression uses a dynamic field position that cannot be profiled.',
      );
    }
  }

  return fragment;
}
