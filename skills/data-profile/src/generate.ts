import {readFile} from 'node:fs/promises';

import {mergeFragments} from './merge.js';
import {sanitizeReference} from './sanitize.js';
import type {FieldFact, GeneratedProfile, LayerFact, ProfileFragment, SourceFact, UnresolvedItem} from './types.js';
import {DEFAULT_SAMPLER_OPTIONS, sampleTiles, type SamplingResult, type TileFetcher} from './sampling.js';
import {discoverStyle} from './style.js';
import {discoverTileJson} from './tilejson.js';

export interface GenerateOptions {
  stylePath?: string;
  tileJsonPath?: string;
  sourceId?: string;
  tileTemplate?: string;
  bounds?: [number, number, number, number];
  zooms?: number[];
  maxRequests?: number;
  allowPrivateNetwork?: boolean;
  observedAt: string;
}

export interface GenerateDependencies {
  readText(path: string): Promise<string>;
  fetchTile?: TileFetcher;
  now(): Date;
}

const defaultDependencies: GenerateDependencies = {
  readText: (path) => readFile(path, 'utf8'),
  now: () => new Date(),
};

function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function discoveryFailure(
  input: string,
  kind: 'style-inferred' | 'tilejson-declared',
  code: string,
  message: string,
): ProfileFragment {
  const sanitized = sanitizeReference(input).value;
  return {
    inputs: [sanitized],
    sources: record<SourceFact>(),
    unresolved: [{
      code,
      location: '#',
      message,
      evidence: [{kind, input: sanitized, location: '#'}],
    }],
  };
}

function hasUsableEvidence(fragment: ProfileFragment): boolean {
  return Object.keys(fragment.sources).length > 0 || (fragment.sampling?.decoded ?? 0) > 0;
}

function sampledFragment(
  sourceId: string,
  template: string,
  observedAt: string,
  sampling: SamplingResult,
): ProfileFragment[] {
  const sanitizedTemplate = sanitizeReference(template);
  const input = sanitizedTemplate.value;
  const fragments: ProfileFragment[] = sampling.observations.map(({coordinate, observation}) => {
    const evidence = {
      kind: 'tile-sampled' as const,
      input,
      location: `#/tiles/${coordinate.z}/${coordinate.x}/${coordinate.y}`,
      observedAt,
    };
    const layers = record<LayerFact>();
    const unresolved: UnresolvedItem[] = [];
    for (const [layerId, observedLayer] of Object.entries(observation.layers)) {
      const fields = record<FieldFact>();
      for (const [fieldId, observedField] of Object.entries(observedLayer.fields)) {
        const fieldLocation =
          `#/sources/${pointer(sourceId)}/layers/${pointer(layerId)}/fields/${pointer(fieldId)}`;
        const field: FieldFact = {
          types: [...observedField.types],
          categories: [...observedField.categories],
          missingObserved: observedField.missingObserved,
          nullObserved: observedField.nullObserved,
          evidence: [evidence],
        };
        if (observedField.minimum !== undefined) field.minimum = observedField.minimum;
        if (observedField.maximum !== undefined) field.maximum = observedField.maximum;
        fields[fieldId] = field;
        if (observedField.sensitiveValuesRedacted === true) {
          unresolved.push({
            code: 'sensitive-values-redacted',
            location: fieldLocation,
            message: 'Sensitive sampled values were redacted before category or range capture.',
            evidence: [evidence],
          });
        }
        if (observedField.categoriesTruncated === true) {
          unresolved.push({
            code: 'categories-truncated',
            location: fieldLocation,
            message: 'Observed categories exceeded the deterministic 256-value profile limit.',
            evidence: [evidence],
          });
        }
      }
      layers[layerId] = {
        geometries: [...observedLayer.geometries],
        stableIdObserved: observedLayer.stableIdObserved,
        fields,
        evidence: [evidence],
      };
    }
    const source: SourceFact = {
      type: 'vector',
      tileTemplates: [input],
      layers,
      evidence: [evidence],
    };
    const sources = record<SourceFact>();
    sources[sourceId] = source;
    return {inputs: [input], sources, unresolved};
  });

  const unresolved = sampling.unresolved.map((item) => ({
    ...item,
    evidence: item.evidence.map((evidence) => ({...evidence, observedAt})),
  }));
  if (sanitizedTemplate.credentialRedacted) {
    unresolved.push({
      code: 'credential-redacted',
      location: '#/tiles',
      message: 'Credentials or sensitive URL data was redacted before this tile template was retained.',
      evidence: [{kind: 'tile-sampled', input, location: '#/tiles', observedAt}],
    });
  }
  fragments.push({
    inputs: [input],
    sources: record<SourceFact>(),
    sampling: sampling.summary,
    unresolved,
  });
  return fragments;
}

function sourceIdForAttachment(
  fragments: ProfileFragment[],
  requested?: string,
): string | undefined {
  if (requested !== undefined) return requested;
  const sourceIds = [...new Set(fragments.flatMap((fragment) => Object.keys(fragment.sources)))];
  if (sourceIds.length === 0) return 'default';
  return sourceIds.length === 1 ? sourceIds[0]! : undefined;
}

function ambiguousSourceFragment(
  input: string,
  kind: 'tilejson-declared' | 'tile-sampled',
): ProfileFragment {
  const sanitized = sanitizeReference(input).value;
  return {
    inputs: [sanitized],
    sources: record<SourceFact>(),
    unresolved: [{
      code: 'source-id-ambiguous',
      location: '#/sourceId',
      message: 'Multiple candidate sources exist; provide an explicit sourceId before attaching this input.',
      evidence: [{kind, input: sanitized, location: '#/sourceId'}],
    }],
  };
}

function sourceHints(fragments: ProfileFragment[], sourceId: string): SourceFact[] {
  return fragments.flatMap((fragment) => {
    const source = fragment.sources[sourceId];
    return source === undefined ? [] : [source];
  });
}

function samplingBounds(options: GenerateOptions, sources: SourceFact[]): [number, number, number, number] {
  if (options.bounds !== undefined) return options.bounds;
  return sources.find((source) => source.bounds !== undefined)?.bounds ?? [-180, -85.05112878, 180, 85.05112878];
}

function samplingZooms(options: GenerateOptions, sources: SourceFact[]): number[] {
  if (options.zooms !== undefined) return options.zooms;
  const source = sources.find((candidate) => candidate.minzoom !== undefined || candidate.maxzoom !== undefined);
  if (!source) return [0];
  return [...new Set([source.minzoom ?? 0, source.maxzoom ?? source.minzoom ?? 0])].sort((left, right) => left - right);
}

function pointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function coverageUnresolved(sources: Record<string, SourceFact>): UnresolvedItem[] {
  const unresolved: UnresolvedItem[] = [];
  for (const [sourceId, source] of Object.entries(sources)) {
    if (!source.evidence.some((evidence) => evidence.kind === 'tile-sampled')) {
      unresolved.push({
        code: 'tile-contents-unobserved',
        location: `#/sources/${pointer(sourceId)}`,
        message: 'No actual tile contents were observed for this source.',
        evidence: source.evidence,
      });
    }
    for (const [layerId, layer] of Object.entries(source.layers)) {
      for (const [fieldId, field] of Object.entries(layer.fields)) {
        if (field.evidence.some((evidence) => evidence.kind === 'tile-sampled')) continue;
        unresolved.push({
          code: 'field-domain-unobserved',
          location: `#/sources/${pointer(sourceId)}/layers/${pointer(layerId)}/fields/${pointer(fieldId)}`,
          message: 'No sampled values were observed for this field, so its data domain remains unresolved.',
          evidence: field.evidence,
        });
      }
    }
  }
  return unresolved;
}

/** Discovers, samples, and evidence-preservingly merges one deterministic profile run. */
export async function generateProfile(
  options: GenerateOptions,
  dependencies: GenerateDependencies = defaultDependencies,
): Promise<GeneratedProfile> {
  if (options.stylePath === undefined && options.tileJsonPath === undefined && options.tileTemplate === undefined) {
    throw new Error('Profile generation requires at least one discovery input.');
  }
  if (!Number.isFinite(new Date(options.observedAt).getTime())) {
    throw new Error('Profile generation requires a valid observedAt timestamp.');
  }

  const fragments: ProfileFragment[] = [];
  let usableEvidence = false;
  if (options.stylePath !== undefined) {
    const sanitizedInput = sanitizeReference(options.stylePath);
    let text: string | undefined;
    try {
      text = await dependencies.readText(options.stylePath);
    } catch {
      fragments.push(discoveryFailure(
        options.stylePath,
        'style-inferred',
        'style-read-failed',
        'The style input could not be read.',
      ));
    }
    if (text !== undefined) {
      let style: unknown;
      try {
        style = JSON.parse(text) as unknown;
      } catch {
        fragments.push(discoveryFailure(
          options.stylePath,
          'style-inferred',
          'style-parse-failed',
          'The style input could not be parsed as JSON.',
        ));
      }
      if (style !== undefined) {
        try {
          const fragment = discoverStyle(style, sanitizedInput.value);
          if (sanitizedInput.credentialRedacted) {
            fragment.unresolved.push({
              code: 'credential-redacted',
              location: '#',
              message: 'Credentials or sensitive URL data was redacted before this input was retained.',
              evidence: [{kind: 'style-inferred', input: sanitizedInput.value, location: '#'}],
            });
          }
          fragments.push(fragment);
          usableEvidence ||= hasUsableEvidence(fragment);
        } catch {
          fragments.push(discoveryFailure(
            options.stylePath,
            'style-inferred',
            'style-discovery-failed',
            'The style input could not be inspected safely.',
          ));
        }
      }
    }
  }

  if (options.tileJsonPath !== undefined) {
    let text: string | undefined;
    try {
      text = await dependencies.readText(options.tileJsonPath);
    } catch {
      fragments.push(discoveryFailure(
        options.tileJsonPath,
        'tilejson-declared',
        'tilejson-read-failed',
        'The TileJSON input could not be read.',
      ));
    }
    if (text !== undefined) {
      let tileJson: unknown;
      try {
        tileJson = JSON.parse(text) as unknown;
      } catch {
        fragments.push(discoveryFailure(
          options.tileJsonPath,
          'tilejson-declared',
          'tilejson-parse-failed',
          'The TileJSON input could not be parsed as JSON.',
        ));
      }
      if (tileJson !== undefined) {
        try {
          const sourceId = sourceIdForAttachment(fragments, options.sourceId);
          if (sourceId === undefined) {
            fragments.push(ambiguousSourceFragment(options.tileJsonPath, 'tilejson-declared'));
          } else {
            const fragment = discoverTileJson(tileJson, sourceId, options.tileJsonPath);
            fragments.push(fragment);
            usableEvidence ||= hasUsableEvidence(fragment);
          }
        } catch {
          fragments.push(discoveryFailure(
            options.tileJsonPath,
            'tilejson-declared',
            'tilejson-discovery-failed',
            'The TileJSON input could not be inspected safely.',
          ));
        }
      }
    }
  }

  if (options.tileTemplate !== undefined) {
    const sourceId = sourceIdForAttachment(fragments, options.sourceId);
    if (sourceId === undefined) {
      fragments.push(ambiguousSourceFragment(options.tileTemplate, 'tile-sampled'));
    } else {
      const hints = sourceHints(fragments, sourceId);
      const sampling = await sampleTiles(
        {
          template: options.tileTemplate,
          bounds: samplingBounds(options, hints),
          zooms: samplingZooms(options, hints),
          concurrency: Math.min(DEFAULT_SAMPLER_OPTIONS.concurrency, options.maxRequests ?? DEFAULT_SAMPLER_OPTIONS.maxRequests),
          maxRequests: options.maxRequests ?? DEFAULT_SAMPLER_OPTIONS.maxRequests,
          maxNonEmpty: DEFAULT_SAMPLER_OPTIONS.maxNonEmpty,
          stableStop: DEFAULT_SAMPLER_OPTIONS.stableStop,
          timeoutMs: DEFAULT_SAMPLER_OPTIONS.timeoutMs,
          retries: DEFAULT_SAMPLER_OPTIONS.retries,
          maxResponseBytes: DEFAULT_SAMPLER_OPTIONS.maxResponseBytes,
          maxTotalBytes: DEFAULT_SAMPLER_OPTIONS.maxTotalBytes,
          allowPrivateNetwork: options.allowPrivateNetwork === true,
        },
        dependencies.fetchTile,
      );
      const sampled = sampledFragment(sourceId, options.tileTemplate, options.observedAt, sampling);
      fragments.push(...sampled);
      usableEvidence ||= sampling.summary.decoded > 0;
    }
  }

  if (!usableEvidence) throw new Error('No supplied input yielded usable profile evidence.');

  const discovered = mergeFragments(fragments);
  const merged = mergeFragments([
    ...fragments,
    {
      inputs: [],
      sources: record<SourceFact>(),
      unresolved: coverageUnresolved(discovered.sources),
    },
  ]);
  return {
    format: 'cartography-data-profile/1',
    generatedAt: options.observedAt,
    ...merged,
  };
}
