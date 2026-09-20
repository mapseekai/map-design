import type { MapAgentCapability } from '@mapseekai/contracts';

import type { RuntimeAgentDef } from '../../runtimes/types.js';
import type { MapAgentAdapter } from './types.js';

export type MapAgentAdapterKind = NonNullable<
  NonNullable<RuntimeAgentDef['mapDesign']>['nativeToolAdapter']
>;

export type MapAgentAdapterFactory = (
  definition: RuntimeAgentDef,
) => MapAgentAdapter | null;

export type MapAgentAdapterFactories = Partial<
  Record<MapAgentAdapterKind, MapAgentAdapterFactory>
>;

export interface MapAgentAdapterRegistry {
  get(definition: RuntimeAgentDef): MapAgentAdapter | null;
  capability(definition: RuntimeAgentDef, available: boolean): MapAgentCapability;
}

export function createMapAgentAdapterRegistry(
  factories: MapAgentAdapterFactories = {},
): MapAgentAdapterRegistry {
  const get = (definition: RuntimeAgentDef): MapAgentAdapter | null => {
    const kind = definition.mapDesign?.nativeToolAdapter;
    if (!kind) return null;
    const adapter = factories[kind]?.(definition) ?? null;
    return adapter?.id === definition.id ? adapter : null;
  };

  return {
    get,
    capability(definition, available) {
      const publicReasoningSummary = definition.mapDesign?.publicReasoningSummary === true;
      if (!available) {
        return {
          nativeMapTools: false,
          publicReasoningSummary,
          reason: 'agent-unavailable',
        };
      }
      const adapter = get(definition);
      if (!adapter?.capabilities.nativeMapTools) {
        return {
          nativeMapTools: false,
          publicReasoningSummary,
          reason: 'native-tools-unavailable',
        };
      }
      return {
        nativeMapTools: true,
        publicReasoningSummary:
          publicReasoningSummary && adapter.capabilities.publicReasoningSummary,
      };
    },
  };
}
