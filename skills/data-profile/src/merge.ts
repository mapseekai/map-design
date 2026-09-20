import type {
  Evidence,
  FieldFact,
  FieldType,
  GeometryType,
  LayerFact,
  ProfileFragment,
  SamplingSummary,
  SourceFact,
  UnresolvedItem,
} from './types.js';

type Category = string | number | boolean | null;
const MAX_CATEGORIES = 256;
const CATEGORY_TRUNCATION_MESSAGE =
  'Observed categories exceeded the deterministic 256-value profile limit.';

export interface MergeResult {
  inputs: string[];
  sources: Record<string, SourceFact>;
  sampling?: SamplingSummary;
  unresolved: UnresolvedItem[];
}

function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function evidenceKey(value: Evidence): string {
  return JSON.stringify([value.kind, value.input, value.location, value.observedAt ?? null]);
}

function compareEvidence(left: Evidence, right: Evidence): number {
  return (
    compareText(left.kind, right.kind) ||
    compareText(left.input, right.input) ||
    compareText(left.location, right.location) ||
    compareText(left.observedAt ?? '', right.observedAt ?? '')
  );
}

function mergeEvidence(groups: Evidence[][]): Evidence[] {
  const values = new Map<string, Evidence>();
  for (const evidence of groups.flat()) values.set(evidenceKey(evidence), {...evidence});
  return [...values.values()].sort(compareEvidence);
}

function categoryKey(value: Category): string {
  return value === null ? 'null' : `${typeof value}:${JSON.stringify(value)}`;
}

function categoryRank(value: Category): number {
  if (value === null) return 0;
  if (typeof value === 'number') return 1;
  if (typeof value === 'string') return 2;
  return 3;
}

function compareCategories(left: Category, right: Category): number {
  return categoryRank(left) - categoryRank(right) || compareText(JSON.stringify(left), JSON.stringify(right));
}

function mergeCategories(groups: Category[][]): {categories: Category[]; truncated: boolean} {
  const categories = new Map<string, Category>();
  for (const category of groups.flat()) categories.set(categoryKey(category), category);
  const ordered = [...categories.values()].sort(compareCategories);
  return {
    categories: ordered.slice(0, MAX_CATEGORIES),
    truncated: ordered.length > MAX_CATEGORIES,
  };
}

function minimum(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : Math.min(...present);
}

function maximum(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : Math.max(...present);
}

function pointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function hasFieldTypeConflict(types: FieldType[]): boolean {
  const concrete = new Set(
    types
      .filter((type) => type !== 'unknown' && type !== 'null')
      .map((type) => (type === 'integer' ? 'number' : type)),
  );
  return concrete.size > 1;
}

function mergeFields(
  sourceId: string,
  layerId: string,
  fields: Array<[string, FieldFact]>,
  generatedUnresolved: UnresolvedItem[],
): Record<string, FieldFact> {
  const grouped = new Map<string, FieldFact[]>();
  for (const [fieldId, field] of fields) {
    const group = grouped.get(fieldId) ?? [];
    group.push(field);
    grouped.set(fieldId, group);
  }

  const merged = record<FieldFact>();
  for (const fieldId of [...grouped.keys()].sort(compareText)) {
    const facts = grouped.get(fieldId)!;
    const types = [...new Set(facts.flatMap((fact) => fact.types))].sort(compareText);
    const evidence = mergeEvidence(facts.map((fact) => fact.evidence));
    const mergedCategories = mergeCategories(facts.map((fact) => fact.categories));
    const location =
      `#/sources/${pointer(sourceId)}/layers/${pointer(layerId)}/fields/${pointer(fieldId)}`;
    const field: FieldFact = {
      types,
      categories: mergedCategories.categories,
      missingObserved: facts.some((fact) => fact.missingObserved),
      nullObserved: facts.some((fact) => fact.nullObserved),
      evidence,
    };
    const fieldMinimum = minimum(facts.map((fact) => fact.minimum));
    const fieldMaximum = maximum(facts.map((fact) => fact.maximum));
    if (fieldMinimum !== undefined) field.minimum = fieldMinimum;
    if (fieldMaximum !== undefined) field.maximum = fieldMaximum;
    merged[fieldId] = field;

    if (mergedCategories.truncated) {
      generatedUnresolved.push({
        code: 'categories-truncated',
        location,
        message: CATEGORY_TRUNCATION_MESSAGE,
        evidence: mergeEvidence(
          facts.filter((fact) => fact.categories.length > 0).map((fact) => fact.evidence),
        ),
      });
    }

    if (hasFieldTypeConflict(types)) {
      generatedUnresolved.push({
        code: 'field-type-conflict',
        location,
        message: 'Independent evidence records report incompatible concrete types for this field.',
        evidence,
      });
    }
  }
  return merged;
}

function mergeLayers(
  sourceId: string,
  layers: Array<[string, LayerFact]>,
  generatedUnresolved: UnresolvedItem[],
): Record<string, LayerFact> {
  const grouped = new Map<string, LayerFact[]>();
  for (const [layerId, layer] of layers) {
    const group = grouped.get(layerId) ?? [];
    group.push(layer);
    grouped.set(layerId, group);
  }

  const merged = record<LayerFact>();
  for (const layerId of [...grouped.keys()].sort(compareText)) {
    const facts = grouped.get(layerId)!;
    const fields = facts.flatMap((fact) => Object.entries(fact.fields));
    const layer: LayerFact = {
      geometries: [...new Set(facts.flatMap((fact) => fact.geometries))].sort(compareText) as GeometryType[],
      stableIdObserved: facts.some((fact) => fact.stableIdObserved),
      fields: mergeFields(sourceId, layerId, fields, generatedUnresolved),
      evidence: mergeEvidence(facts.map((fact) => fact.evidence)),
    };
    const minzoom = minimum(facts.map((fact) => fact.minzoom));
    const maxzoom = maximum(facts.map((fact) => fact.maxzoom));
    if (minzoom !== undefined) layer.minzoom = minzoom;
    if (maxzoom !== undefined) layer.maxzoom = maxzoom;
    merged[layerId] = layer;
  }
  return merged;
}

function equalTuple(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function mergeSources(
  fragments: ProfileFragment[],
  generatedUnresolved: UnresolvedItem[],
): Record<string, SourceFact> {
  const grouped = new Map<string, SourceFact[]>();
  for (const fragment of fragments) {
    for (const [sourceId, source] of Object.entries(fragment.sources)) {
      const group = grouped.get(sourceId) ?? [];
      group.push(source);
      grouped.set(sourceId, group);
    }
  }

  const merged = record<SourceFact>();
  for (const sourceId of [...grouped.keys()].sort(compareText)) {
    const facts = grouped.get(sourceId)!;
    const concreteTypes = [...new Set(facts.map((fact) => fact.type).filter((type) => type !== 'unknown'))].sort(compareText);
    const evidence = mergeEvidence(facts.map((fact) => fact.evidence));
    const source: SourceFact = {
      type: concreteTypes.length === 1 ? concreteTypes[0]! : 'unknown',
      tileTemplates: [...new Set(facts.flatMap((fact) => fact.tileTemplates))].sort(compareText),
      layers: mergeLayers(
        sourceId,
        facts.flatMap((fact) => Object.entries(fact.layers)),
        generatedUnresolved,
      ),
      evidence,
    };

    const bounds = facts.flatMap((fact) => (fact.bounds === undefined ? [] : [fact.bounds]));
    if (bounds.length > 0) {
      source.bounds = [
        Math.min(...bounds.map((value) => value[0])),
        Math.min(...bounds.map((value) => value[1])),
        Math.max(...bounds.map((value) => value[2])),
        Math.max(...bounds.map((value) => value[3])),
      ];
    }
    const centers = facts.flatMap((fact) => (fact.center === undefined ? [] : [fact.center]));
    const distinctCenters = centers.filter(
      (center, index) => centers.findIndex((candidate) => equalTuple(candidate, center)) === index,
    );
    if (distinctCenters.length === 1) source.center = [...distinctCenters[0]!] as [number, number, number];
    if (distinctCenters.length > 1) {
      generatedUnresolved.push({
        code: 'source-center-conflict',
        location: `#/sources/${pointer(sourceId)}/center`,
        message: 'Independent evidence records declare different centers for this source.',
        evidence,
      });
    }
    const minzoom = minimum(facts.map((fact) => fact.minzoom));
    const maxzoom = maximum(facts.map((fact) => fact.maxzoom));
    if (minzoom !== undefined) source.minzoom = minzoom;
    if (maxzoom !== undefined) source.maxzoom = maxzoom;
    merged[sourceId] = source;

    if (concreteTypes.length > 1) {
      generatedUnresolved.push({
        code: 'source-type-conflict',
        location: `#/sources/${pointer(sourceId)}/type`,
        message: 'Independent evidence records report incompatible source types.',
        evidence,
      });
    }
  }
  return merged;
}

function coordinateKey(coordinate: {z: number; x: number; y: number}): string {
  return `${coordinate.z}/${coordinate.x}/${coordinate.y}`;
}

function mergeSampling(summaries: SamplingSummary[]): SamplingSummary | undefined {
  if (summaries.length === 0) return undefined;
  const coordinates = new Map<string, {z: number; x: number; y: number}>();
  for (const coordinate of summaries.flatMap((summary) => summary.coordinates)) {
    coordinates.set(coordinateKey(coordinate), {...coordinate});
  }
  const stopReasonPriority: SamplingSummary['stopReason'][] = [
    'candidates-exhausted',
    'structure-stable',
    'non-empty-limit',
    'budget-exhausted',
  ];
  return {
    requested: summaries.reduce((sum, summary) => sum + summary.requested, 0),
    decoded: summaries.reduce((sum, summary) => sum + summary.decoded, 0),
    empty: summaries.reduce((sum, summary) => sum + summary.empty, 0),
    failed: summaries.reduce((sum, summary) => sum + summary.failed, 0),
    bytes: summaries.reduce((sum, summary) => sum + summary.bytes, 0),
    coordinates: [...coordinates.values()].sort(
      (left, right) => left.z - right.z || left.x - right.x || left.y - right.y,
    ),
    stopReason: [...stopReasonPriority]
      .reverse()
      .find((reason) => summaries.some((summary) => summary.stopReason === reason))!,
  };
}

function mergeUnresolved(items: UnresolvedItem[]): UnresolvedItem[] {
  const grouped = new Map<string, UnresolvedItem[]>();
  for (const item of items) {
    const key = JSON.stringify([item.code, item.location, item.message]);
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .map((group) => ({
      code: group[0]!.code,
      location: group[0]!.location,
      message: group[0]!.message,
      evidence: mergeEvidence(group.map((item) => item.evidence)),
    }))
    .sort(
      (left, right) =>
        compareText(left.code, right.code) ||
        compareText(left.location, right.location) ||
        compareText(left.message, right.message),
    );
}

/** Combines independently discovered facts without discarding contradictory evidence. */
export function mergeFragments(fragments: ProfileFragment[]): MergeResult {
  const generatedUnresolved: UnresolvedItem[] = [];
  const sources = mergeSources(fragments, generatedUnresolved);
  const sampling = mergeSampling(
    fragments.flatMap((fragment) => (fragment.sampling === undefined ? [] : [fragment.sampling])),
  );
  const result: MergeResult = {
    inputs: [...new Set(fragments.flatMap((fragment) => fragment.inputs))].sort(compareText),
    sources,
    unresolved: mergeUnresolved([
      ...fragments.flatMap((fragment) => fragment.unresolved),
      ...generatedUnresolved,
    ]),
  };
  if (sampling !== undefined) result.sampling = sampling;
  return result;
}
