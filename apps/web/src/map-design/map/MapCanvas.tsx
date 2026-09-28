import {
  type MapOptions,
  type StyleSpecification,
} from 'maplibre-gl';
import { MapDesignMap } from './map-design-map';
import { createMapResourceTransform } from './resource-request';

import { prepareMapStyleForRuntime } from './runtime-style';
import { MapLibreCanvas, type OwnedMap, type MapCanvasError } from './MapLibreCanvas';
import type { MapDesignProtocolOptions, MapLibreProtocolApi } from './map-lifecycle';

export type { OwnedMap } from './MapLibreCanvas';

export interface MapCanvasProps {
  projectId: string;
  initialStyle: StyleSpecification;
  className?: string;
  maplibre?: MapLibreProtocolApi;
  protocolOptions?: MapDesignProtocolOptions;
  createMap?: (options: MapOptions) => OwnedMap;
  onMapError?: (event?: MapCanvasError) => void;
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
  createMap = (options) => new MapDesignMap(options),
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
      transformRequest: createMapResourceTransform({ projectId, origin }),
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
