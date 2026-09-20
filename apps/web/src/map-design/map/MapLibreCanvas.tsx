import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  Map,
  addProtocol,
  removeProtocol,
  setWorkerUrl,
  type MapOptions,
  type StyleSpecification,
} from 'maplibre-gl';

import {
  acquireMapDesignProtocols,
  type MapDesignProtocolOptions,
  type MapLibreProtocolApi,
} from './map-lifecycle';

const defaultMapLibre: MapLibreProtocolApi = { addProtocol, removeProtocol, setWorkerUrl };
const mapLibreWorkerUrl = '/maplibre/maplibre-gl-worker.mjs';

export interface OwnedMap {
  remove(): void;
  resize(): void;
  on?(type: 'error' | 'idle', listener: () => void): { unsubscribe(): void };
}

export interface MapLibreCanvasProps {
  style: StyleSpecification | string;
  className?: string;
  maplibre?: MapLibreProtocolApi;
  protocolOptions?: MapDesignProtocolOptions;
  transformRequest?: MapOptions['transformRequest'];
  createMap?: (options: MapOptions) => OwnedMap;
  onMapError?: () => void;
  onMapReady?: (map: OwnedMap) => void;
  onMapIdle?: () => void;
  layoutRevision?: number;
}

export function MapLibreCanvas({
  style,
  className,
  maplibre = defaultMapLibre,
  protocolOptions,
  transformRequest,
  createMap = (options) => new Map(options),
  onMapError,
  onMapReady,
  onMapIdle,
  layoutRevision = 0,
}: MapLibreCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<OwnedMap | null>(null);
  const layoutResizeFrameRef = useRef<number | null>(null);
  const hasReceivedInitialLayoutRevisionRef = useRef(false);
  const styleRef = useRef(style);
  const transformRequestRef = useRef(transformRequest);
  const protocolOptionsRef = useRef(protocolOptions);
  const createMapRef = useRef(createMap);
  const onMapErrorRef = useRef(onMapError);
  const onMapReadyRef = useRef(onMapReady);
  const onMapIdleRef = useRef(onMapIdle);
  styleRef.current = style;
  transformRequestRef.current = transformRequest;
  protocolOptionsRef.current = protocolOptions;
  createMapRef.current = createMap;
  onMapErrorRef.current = onMapError;
  onMapReadyRef.current = onMapReady;
  onMapIdleRef.current = onMapIdle;

  const protocolOptionsKey = JSON.stringify({
    origin: protocolOptions?.origin ?? null,
    headers: [...new Headers(protocolOptions?.headers).entries()].sort(([left], [right]) => left.localeCompare(right)),
  });
  const protocolFetch = protocolOptions?.fetch;

  useLayoutEffect(() => {
    if (!hasReceivedInitialLayoutRevisionRef.current) {
      hasReceivedInitialLayoutRevisionRef.current = true;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (layoutResizeFrameRef.current === frame) layoutResizeFrameRef.current = null;
      mapRef.current?.resize();
    });
    layoutResizeFrameRef.current = frame;
    return () => {
      window.cancelAnimationFrame(frame);
      if (layoutResizeFrameRef.current === frame) layoutResizeFrameRef.current = null;
    };
  }, [layoutRevision]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    maplibre.setWorkerUrl?.(mapLibreWorkerUrl);
    const releaseProtocols = acquireMapDesignProtocols(maplibre, protocolOptionsRef.current);
    const mapStyle = typeof styleRef.current === 'string'
      ? styleRef.current
      : JSON.parse(JSON.stringify(styleRef.current)) as StyleSpecification;
    let map: OwnedMap;
    try {
      map = createMapRef.current({
        container,
        style: mapStyle,
        attributionControl: { customAttribution: [] },
        maplibreLogo: false,
        ...(transformRequestRef.current ? { transformRequest: transformRequestRef.current } : {}),
      });
    } catch (error) {
      releaseProtocols();
      throw error;
    }
    let idleReported = false;
    const errorSubscription = map.on?.('error', () => {
      idleReported = false;
      onMapErrorRef.current?.();
    });
    const idleSubscription = onMapIdleRef.current
      ? map.on?.('idle', () => {
          if (idleReported) return;
          idleReported = true;
          onMapIdleRef.current?.();
        })
      : undefined;
    try {
      onMapReadyRef.current?.(map);
    } catch (error) {
      try {
        errorSubscription?.unsubscribe();
        idleSubscription?.unsubscribe();
      } finally {
        try { map.remove(); } finally { releaseProtocols(); }
      }
      throw error;
    }
    mapRef.current = map;
    map.resize();
    return () => {
      if (mapRef.current === map) mapRef.current = null;
      try {
        errorSubscription?.unsubscribe();
        idleSubscription?.unsubscribe();
      } finally {
        try { map.remove(); } finally { releaseProtocols(); }
      }
    };
  }, [maplibre, protocolFetch, protocolOptionsKey]);

  return <div ref={containerRef} className={className} />;
}
