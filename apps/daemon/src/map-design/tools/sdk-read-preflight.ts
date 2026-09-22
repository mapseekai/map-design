import {
  MapGetContextInputSchema,
  MapInspectInputSchema,
  MapRenderPreviewInputSchema,
  MapSearchLayersInputSchema,
  MapValidateInputSchema,
  type MapInspectInput,
  type MapToolName,
} from '@mapseekai/map-design-contracts';
import type { InspectStyleInput } from 'maplibre-style-tools/capabilities';

export function sdkInspectionInput(name: MapToolName, input: unknown): InspectStyleInput | null {
  switch (name) {
    case 'map_get_context':
      MapGetContextInputSchema.parse(input);
      return { action: 'getContext' };
    case 'map_inspect':
      return mapInspectInput(MapInspectInputSchema.parse(input));
    case 'map_search_layers': {
      const request = MapSearchLayersInputSchema.parse(input);
      if (Array.isArray(request.query) || request.limit > 100) return { action: 'getRoot' };
      return {
        action: 'listLayers',
        ...(request.query === undefined ? {} : { query: request.query }),
        ...(request.types?.length === 1 ? { type: request.types[0] } : {}),
        ...(request.sourceId === undefined ? {} : { source: request.sourceId }),
        ...(request.sourceLayer === undefined ? {} : { sourceLayer: request.sourceLayer }),
        limit: request.limit,
      };
    }
    case 'map_validate':
      MapValidateInputSchema.parse(input);
      return { action: 'validateCurrentMap' };
    case 'map_render_preview':
      MapRenderPreviewInputSchema.parse(input);
      return { action: 'validateCurrentMap' };
    case 'map_apply_transaction':
    case 'map_update_semantics':
    case 'map_commit_revision':
    case 'map_discard_draft':
      return null;
  }
}

function mapInspectInput(input: MapInspectInput): InspectStyleInput {
  switch (input.target.kind) {
    case 'root':
    case 'layers':
      // Preflight validates the style; the query service owns the 200-layer bounded projection.
      return { action: 'getRoot' };
    case 'layer':
      return { action: 'getLayer', layerId: input.target.layerId, ...(input.fields ? { fields: input.fields } : {}) };
    case 'source':
      return { action: 'getSource', sourceId: input.target.sourceId };
    case 'source-layer':
      return { action: 'listSourceLayers', sourceId: input.target.sourceId };
  }
}
