export type EvidenceKind = 'style-inferred' | 'tilejson-declared' | 'tile-sampled';

export type FieldType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null'
  | 'json'
  | 'unknown';

export type GeometryType = 'point' | 'line' | 'polygon' | 'unknown';

export interface Evidence {
  kind: EvidenceKind;
  input: string;
  location: string;
  observedAt?: string;
}

export interface FieldFact {
  types: FieldType[];
  categories: Array<string | number | boolean | null>;
  minimum?: number;
  maximum?: number;
  missingObserved: boolean;
  nullObserved: boolean;
  evidence: Evidence[];
}

export interface LayerFact {
  geometries: GeometryType[];
  minzoom?: number;
  maxzoom?: number;
  stableIdObserved: boolean;
  fields: Record<string, FieldFact>;
  evidence: Evidence[];
}

export interface SourceFact {
  type: string;
  tileTemplates: string[];
  bounds?: [number, number, number, number];
  center?: [number, number, number];
  minzoom?: number;
  maxzoom?: number;
  layers: Record<string, LayerFact>;
  evidence: Evidence[];
}

export interface GeneratedProfile {
  format: 'cartography-data-profile/1';
  generatedAt: string;
  inputs: string[];
  sources: Record<string, SourceFact>;
  sampling?: SamplingSummary;
  unresolved: UnresolvedItem[];
}

export interface SamplingSummary {
  requested: number;
  decoded: number;
  empty: number;
  failed: number;
  bytes: number;
  coordinates: Array<{z: number; x: number; y: number}>;
  stopReason:
    | 'budget-exhausted'
    | 'non-empty-limit'
    | 'structure-stable'
    | 'candidates-exhausted';
}

export interface UnresolvedItem {
  code: string;
  location: string;
  message: string;
  evidence: Evidence[];
}

export interface ProfileFragment {
  inputs: string[];
  sources: Record<string, SourceFact>;
  sampling?: SamplingSummary;
  unresolved: UnresolvedItem[];
}
