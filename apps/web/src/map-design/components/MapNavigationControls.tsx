import { Alert, AlertDescription, Button } from '@mapseekai/components';
import { Compass, Crosshair, LoaderCircle, Minus, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { AnimationOptions, FlyToOptions } from 'maplibre-gl';

import { useT } from '../../i18n';

export interface MapNavigationControlMap {
  flyTo(options: FlyToOptions): unknown;
  getZoom(): number;
  resetNorth(options?: AnimationOptions): unknown;
  zoomIn(options?: AnimationOptions): unknown;
  zoomOut(options?: AnimationOptions): unknown;
}

export interface MapNavigationControlsProps {
  map: MapNavigationControlMap | null;
}

type LocationStatus = 'error' | 'pending' | 'success' | null;

const LOCAL_ZOOM = 14;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function getGeolocation(): Geolocation | null {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.geolocation?.getCurrentPosition !== 'function') return null;
    return navigator.geolocation;
  } catch {
    return null;
  }
}

function cameraAnimationOptions(): AnimationOptions {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.(REDUCED_MOTION_QUERY).matches;
  return reduced ? { duration: 0, essential: false } : { essential: false };
}

export function MapNavigationControls({ map }: MapNavigationControlsProps) {
  const t = useT();
  const explanationId = `map-location-explanation-${useId().replace(/:/gu, '')}`;
  const [geolocationAvailable, setGeolocationAvailable] = useState<boolean | null>(null);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>(null);
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    setGeolocationAvailable(getGeolocation() !== null);
  }, []);

  useEffect(() => () => {
    requestGenerationRef.current += 1;
  }, [map]);

  const locate = useCallback(() => {
    const geolocation = getGeolocation();
    if (!map || !geolocation) return;
    const requestGeneration = ++requestGenerationRef.current;
    setLocationStatus('pending');
    try {
      geolocation.getCurrentPosition((position) => {
        if (requestGenerationRef.current !== requestGeneration) return;
        const currentZoom = map.getZoom();
        map.flyTo({
          center: [position.coords.longitude, position.coords.latitude],
          zoom: Number.isFinite(currentZoom) ? Math.max(currentZoom, LOCAL_ZOOM) : LOCAL_ZOOM,
          ...cameraAnimationOptions(),
        });
        setLocationStatus('success');
      }, () => {
        if (requestGenerationRef.current !== requestGeneration) return;
        setLocationStatus('error');
      }, {
        enableHighAccuracy: false,
        maximumAge: 60_000,
        timeout: 10_000,
      });
    } catch {
      if (requestGenerationRef.current === requestGeneration) setLocationStatus('error');
    }
  }, [map]);

  const status = locationStatus === 'pending'
    ? t('mapDesign.studio.locationPending')
    : locationStatus === 'success'
      ? t('mapDesign.studio.locationSuccess')
      : locationStatus === 'error'
        ? t('mapDesign.studio.locationError')
        : '';
  const locateUnavailable = geolocationAvailable === false;

  return <>
    <div className="absolute start-[max(12px,env(safe-area-inset-left,0px),env(safe-area-inset-right,0px))] bottom-[calc(12px+env(safe-area-inset-bottom,0px))] z-5 grid overflow-hidden rounded-lg border bg-background/95 shadow-lg backdrop-blur-md" role="group" aria-label={t('mapDesign.studio.mapNavigation')}>
      <Button variant="ghost" size="icon" type="button" disabled={!map} aria-label={t('mapDesign.studio.zoomIn')}
        onClick={() => map?.zoomIn(cameraAnimationOptions())}>
        <Plus aria-hidden="true" size={18} strokeWidth={1.8} />
      </Button>
      <Button variant="ghost" size="icon" type="button" disabled={!map} aria-label={t('mapDesign.studio.zoomOut')}
        onClick={() => map?.zoomOut(cameraAnimationOptions())}>
        <Minus aria-hidden="true" size={18} strokeWidth={1.8} />
      </Button>
      <Button variant="ghost" size="icon" type="button" disabled={!map || geolocationAvailable !== true || locationStatus === 'pending'}
        aria-label={t('mapDesign.studio.locate')}
        aria-describedby={locateUnavailable ? explanationId : undefined}
        onClick={locate}>
        {locationStatus === 'pending' ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Crosshair aria-hidden="true" size={18} strokeWidth={1.8} />}
      </Button>
      <Button variant="ghost" size="icon" type="button" disabled={!map} aria-label={t('mapDesign.studio.resetNorth')}
        onClick={() => map?.resetNorth(cameraAnimationOptions())}>
        <Compass aria-hidden="true" size={18} strokeWidth={1.8} />
      </Button>
    </div>
    {locationStatus === 'error' ? <Alert variant="destructive" className="absolute z-10" style={{ insetInlineStart: 12, bottom: 'calc(180px + env(safe-area-inset-bottom, 0px))', width: 280, maxWidth: 'calc(100% - 24px)' }}>
      <AlertDescription><div className="flex items-center justify-between gap-2">{status}
        <Button type="button" size="icon-sm" variant="ghost" aria-label={t('common.close')} onClick={() => setLocationStatus(null)}><X /></Button>
      </div></AlertDescription>
    </Alert> : null}
    <span id={explanationId} className="sr-only">
      {locateUnavailable ? t('mapDesign.studio.locationUnavailable') : ''}
    </span>
    <span className="sr-only" aria-live="polite" aria-atomic="true">{locationStatus === 'error' ? '' : status}</span>
  </>;
}
