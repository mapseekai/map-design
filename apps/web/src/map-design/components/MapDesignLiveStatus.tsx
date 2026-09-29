import type { Map as MapLibreMap } from 'maplibre-gl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { MapDesignStatusBar } from './MapDesignStatusBar';

interface MapStatus {
  scaleDenominator: number;
  coordinates: { lat: number; lng: number } | null;
}

const MAP_KEYBOARD_NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', '-', '+', '=']);

export function mapScaleDenominator(latitude: number, zoom: number): number {
  const metresPerCssPixel = 40075016.68557849 * Math.cos(latitude * Math.PI / 180) / 512 / 2 ** zoom;
  return Math.max(1, Math.round(metresPerCssPixel * 96 * 39.37));
}

export function MapDesignLiveStatus({ map, draftRevision, synced, onCameraChange }: {
  readonly map: MapLibreMap | null;
  readonly draftRevision: number;
  readonly synced: boolean;
  readonly onCameraChange: (map: MapLibreMap) => void;
}) {
  const { locale, t } = useI18n();
  const [keyboardNavigationActive, setKeyboardNavigationActive] = useState(false);
  const keyboardNavigationRef = useRef(false);
  const liveRegionClearTimerRef = useRef<number | null>(null);
  const [mapStatus, setMapStatus] = useState<MapStatus>({ scaleDenominator: 25000, coordinates: null });
  const clearKeyboardNavigation = useCallback(() => {
    keyboardNavigationRef.current = false;
    if (liveRegionClearTimerRef.current !== null) window.clearTimeout(liveRegionClearTimerRef.current);
    liveRegionClearTimerRef.current = null;
    setKeyboardNavigationActive(false);
  }, []);
  const scheduleKeyboardNavigationClear = useCallback(() => {
    if (liveRegionClearTimerRef.current !== null) window.clearTimeout(liveRegionClearTimerRef.current);
    liveRegionClearTimerRef.current = window.setTimeout(() => {
      keyboardNavigationRef.current = false;
      liveRegionClearTimerRef.current = null;
      setKeyboardNavigationActive(false);
    }, 300);
  }, []);
  const updateMapScale = useCallback((nextMap: MapLibreMap) => {
    onCameraChange(nextMap);
    const scaleDenominator = mapScaleDenominator(nextMap.getCenter().lat, nextMap.getZoom());
    setMapStatus(current => current.scaleDenominator === scaleDenominator ? current : { ...current, scaleDenominator });
  }, [onCameraChange]);
  const updateCoordinates = useCallback((coordinates: { lat: number; lng: number }) => {
    setMapStatus(current => ({ ...current, coordinates }));
  }, []);
  useEffect(() => {
    if (!map) return;
    updateMapScale(map);
    const onMove = () => updateMapScale(map);
    const onPointerMove = (event: { lngLat?: { lat: number; lng: number } }) => {
      if (!event.lngLat) return;
      clearKeyboardNavigation();
      updateCoordinates(event.lngLat);
    };
    const onMoveEnd = () => {
      if (!keyboardNavigationRef.current) return;
      updateCoordinates(map.getCenter());
      scheduleKeyboardNavigationClear();
    };
    const onCanvasKeyDown = (event: KeyboardEvent) => {
      if (!MAP_KEYBOARD_NAVIGATION_KEYS.has(event.key)) return;
      if (liveRegionClearTimerRef.current !== null) window.clearTimeout(liveRegionClearTimerRef.current);
      liveRegionClearTimerRef.current = null;
      keyboardNavigationRef.current = true;
      setKeyboardNavigationActive(true);
    };
    const onCanvasBlur = () => clearKeyboardNavigation();
    const canvas = map.getCanvas();
    map.on('move', onMove);
    map.on('mousemove', onPointerMove);
    map.on('moveend', onMoveEnd);
    canvas.addEventListener('keydown', onCanvasKeyDown);
    canvas.addEventListener('blur', onCanvasBlur);
    return () => {
      map.off('move', onMove);
      map.off('mousemove', onPointerMove);
      map.off('moveend', onMoveEnd);
      canvas.removeEventListener('keydown', onCanvasKeyDown);
      canvas.removeEventListener('blur', onCanvasBlur);
      keyboardNavigationRef.current = false;
      if (liveRegionClearTimerRef.current !== null) window.clearTimeout(liveRegionClearTimerRef.current);
      liveRegionClearTimerRef.current = null;
    };
  }, [clearKeyboardNavigation, map, scheduleKeyboardNavigationClear, updateCoordinates, updateMapScale]);
  return <MapDesignStatusBar projection="EPSG:3857" scale={`1:${new Intl.NumberFormat(locale).format(mapStatus.scaleDenominator)}`}
    draftRevision={draftRevision} synced={synced}
    coordinates={formatMapCoordinates(mapStatus.coordinates, t)}
    keyboardNavigationActive={keyboardNavigationActive} />;
}

function formatMapCoordinates(coordinates: MapStatus['coordinates'], t: ReturnType<typeof useI18n>['t']): string {
  if (!coordinates) return '—';
  const formatCoordinate = (value: number, positive: 'north' | 'east', negative: 'south' | 'west') => {
    const direction = value >= 0
      ? positive === 'north' ? t('mapDesign.studio.north') : t('mapDesign.studio.east')
      : negative === 'south' ? t('mapDesign.studio.south') : t('mapDesign.studio.west');
    return `${Math.abs(value).toFixed(3)}°${direction}`;
  };
  return `${formatCoordinate(coordinates.lat, 'north', 'south')}, ${formatCoordinate(coordinates.lng, 'east', 'west')}`;
}
