import type { MapToolName } from '@mapseekai/map-design-contracts';

import {
  MAP_DESIGN_TOOL_ENDPOINTS,
  MAP_DESIGN_TOOL_OPERATIONS,
  type ToolEndpoint,
  type ToolOperation,
} from '../tool-tokens.js';
type MapDesignProjectKind = 'map';

export const MAP_DESIGN_WRAPPER_SEQUENCE = [
  'map_get_context',
  'map_apply_transaction',
  'map_validate',
  'map_render_preview',
  'map_commit_revision',
] as const satisfies readonly MapToolName[];

export interface MapDesignToolGrantScope {
  readonly allowedEndpoints: readonly ToolEndpoint[];
  readonly allowedOperations: readonly ToolOperation[];
}

const EMPTY_MAP_DESIGN_TOOL_GRANT_SCOPE: MapDesignToolGrantScope = Object.freeze({
  allowedEndpoints: Object.freeze([]),
  allowedOperations: Object.freeze([]),
});

const MAP_PROJECT_TOOL_GRANT_SCOPE: MapDesignToolGrantScope = Object.freeze({
  allowedEndpoints: MAP_DESIGN_TOOL_ENDPOINTS,
  allowedOperations: MAP_DESIGN_TOOL_OPERATIONS,
});

/** Capability set for a local MapDesign run; it is deliberately not inherited from chat defaults. */
export const MAP_DESIGN_RUN_TOOL_GRANT_SCOPE = MAP_PROJECT_TOOL_GRANT_SCOPE;

export function mapDesignToolGrantScope(projectKind: MapDesignProjectKind | null): MapDesignToolGrantScope {
  return projectKind === 'map'
    ? MAP_PROJECT_TOOL_GRANT_SCOPE
    : EMPTY_MAP_DESIGN_TOOL_GRANT_SCOPE;
}
