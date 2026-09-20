import {
  Map,
  type MapOptions,
  type StyleSpecification,
} from 'maplibre-gl';
import { assertMapDesignResourceUrl } from '@mapseekai/map-design-contracts';

import { prepareMapStyleForRuntime } from './runtime-style';
import { MapLibreCanvas, type OwnedMap } from './MapLibreCanvas';
import type { MapDesignProtocolOptions, MapLibreProtocolApi } from './map-lifecycle';
import { PMTILES_PROTOCOL } from './pmtiles-protocol';
import { MAP_DESIGN_RESOURCE_PROTOCOL } from './resource-protocol';

export type { OwnedMap } from './MapLibreCanvas';

export interface MapCanvasProps {
  projectId: string;
  initialStyle: StyleSpecification;
  className?: string;
  maplibre?: MapLibreProtocolApi;
  protocolOptions?: MapDesignProtocolOptions;
  createMap?: (options: MapOptions) => OwnedMap;
  onMapError?: () => void;
  onMapIdle?: () => void;
  onMapReady?: (map: OwnedMap) => void;
  layoutRevision?: number;
}

export function MapCanvas({
  projectId,
  initialStyle,
  className,
  maplibre,
  protocolOptions,
  createMap = (options) => new Map(options),
  onMapError,
  onMapIdle,
  onMapReady,
  layoutRevision = 0,
}: MapCanvasProps) {
  const createProjectMap = (options: MapOptions): OwnedMap => {
    const origin = protocolOptions?.origin ?? window.location.origin;
    const style = prepareMapStyleForRuntime(initialStyle, projectId, { origin });
    return createMap({
      ...options,
      style,
      transformRequest: (url) => {
        if (url.startsWith(`${PMTILES_PROTOCOL}://`)) {
          assertMapDesignResourceUrl(url, projectId, { origin });
          return { url };
        }
        const resource = new URL(assertMapDesignResourceUrl(url, projectId, { origin }));
        return { url: `${MAP_DESIGN_RESOURCE_PROTOCOL}://${resource.pathname}` };
      },
    });
  };

  return (
    <MapLibreCanvas
      key={projectId}
      style={initialStyle}
      className={className}
      maplibre={maplibre}
      protocolOptions={protocolOptions}
      createMap={createProjectMap}
      onMapError={onMapError}
      onMapIdle={onMapIdle}
      onMapReady={onMapReady}
      layoutRevision={layoutRevision}
    />
  );
}
