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

export interface MapCanvasError { error?: unknown; sourceId?: string; status?: number; retryAfter?: string }

export interface OwnedMap {
  remove(): void;
  resize(): void;
  on?(type: 'error' | 'idle' | 'load', listener: (event?: MapCanvasError) => void): { unsubscribe(): void };
}

export interface MapLibreCanvasProps {
  style: StyleSpecification | string;
  className?: string;
  maplibre?: MapLibreProtocolApi;
  protocolOptions?: MapDesignProtocolOptions;
  transformRequest?: MapOptions['transformRequest'];
  createMap?: (options: MapOptions) => OwnedMap;
  onMapError?: (event?: MapCanvasError) => void;
  onMapLoad?: () => void;
  resourceGateway?: boolean;
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
  onMapLoad,
  resourceGateway = true,
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
  const onMapLoadRef = useRef(onMapLoad);
  const onMapReadyRef = useRef(onMapReady);
  const onMapIdleRef = useRef(onMapIdle);
  styleRef.current = style;
  transformRequestRef.current = transformRequest;
  protocolOptionsRef.current = protocolOptions;
  createMapRef.current = createMap;
  onMapErrorRef.current = onMapError;
  onMapLoadRef.current = onMapLoad;
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
    const releaseProtocols = resourceGateway
      ? acquireMapDesignProtocols(maplibre, protocolOptionsRef.current)
      : () => undefined;
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
      if (resourceGateway || !onMapErrorRef.current) throw error;
      onMapErrorRef.current();
      return;
    }
    let idleReported = false;
    let active = true;
    const errorSubscription = map.on?.('error', (event) => {
      if (!active) return;
      idleReported = false;
      const raw = event?.error as { status?: unknown; retryAfter?: unknown } | undefined;
      const details: MapCanvasError = {};
      if (event?.sourceId) details.sourceId = event.sourceId;
      if (typeof raw?.status === 'number' && Number.isInteger(raw.status) && raw.status >= 100 && raw.status <= 599) details.status = raw.status;
      if (typeof raw?.retryAfter === 'string' && raw.retryAfter.length <= 128 && !/[\r\n]/u.test(raw.retryAfter)) details.retryAfter = raw.retryAfter;
      // Never send upstream URLs, credentials or arbitrary error text to application UI.
      if (Object.keys(details).length) onMapErrorRef.current?.(details);
      else onMapErrorRef.current?.();
    });
    const loadSubscription = onMapLoadRef.current
      ? map.on?.('load', () => { if (active) onMapLoadRef.current?.(); })
      : undefined;
    const idleSubscription = onMapIdleRef.current
      ? map.on?.('idle', () => {
          if (!active || idleReported) return;
          idleReported = true;
          onMapIdleRef.current?.();
        })
      : undefined;
    try {
      onMapReadyRef.current?.(map);
    } catch (error) {
      try {
        errorSubscription?.unsubscribe();
        loadSubscription?.unsubscribe();
        idleSubscription?.unsubscribe();
      } finally {
        try { map.remove(); } finally { releaseProtocols(); }
      }
      throw error;
    }
    mapRef.current = map;
    map.resize();
    return () => {
      active = false;
      if (mapRef.current === map) mapRef.current = null;
      try {
        errorSubscription?.unsubscribe();
        loadSubscription?.unsubscribe();
        idleSubscription?.unsubscribe();
      } finally {
        try { map.remove(); } finally { releaseProtocols(); }
      }
    };
  }, [maplibre, protocolFetch, protocolOptionsKey, resourceGateway]);

  return <div ref={containerRef} className={className} />;
}
