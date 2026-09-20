import { Alert, Button } from '@mapseekai/components';
import { MAP_SCREENSHOT_MAX_COUNT, type MapScreenshot } from '@mapseekai/contracts';
import { Camera, LoaderCircle } from 'lucide-react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { screenshotCopy } from '../../i18n/locales/screenshots';
import { captureMapScreenshot } from './capture';
import { saveMapScreenshot } from './client';

export function MapScreenshotButton({ projectId, targetKey, map, draftRevision, styleHash, disabled, count = 0, onCapture }: {
  projectId: string; targetKey?: string; map: MapLibreMap | null; draftRevision: number; styleHash: string;
  disabled: boolean; count?: number; onCapture?(screenshot: MapScreenshot): boolean;
}) {
  const { locale } = useI18n(); const copy = screenshotCopy[locale];
  const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    setBusy(false); setFailed(false);
    return () => { pending.current?.abort(); pending.current = null; };
  }, [projectId, targetKey, map, draftRevision, styleHash, disabled]);
  const capture = async () => {
    if (!map || disabled || !onCapture || pending.current || count >= MAP_SCREENSHOT_MAX_COUNT) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setFailed(false);
    try {
      const input = await captureMapScreenshot(map, { draftRevision, styleHash }, controller.signal);
      const screenshot = await saveMapScreenshot(projectId, input, controller.signal);
      if (!controller.signal.aborted && !onCapture(screenshot)) setFailed(true);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  };
  return <>
    <Button type="button" variant="ghost" size="sm" aria-label={busy ? copy.capturing : copy.capture}
      title={count >= MAP_SCREENSHOT_MAX_COUNT ? copy.limit : copy.capture}
      disabled={disabled || !map || !onCapture || busy || count >= MAP_SCREENSHOT_MAX_COUNT} onClick={() => void capture()}>
      {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Camera data-icon="inline-start" />}
      {busy ? copy.capturing : copy.capture}
    </Button>
    {failed ? <Alert variant="destructive" className="absolute end-0 top-11 w-64 max-w-[calc(100vw-2rem)]">{copy.failed}</Alert> : null}
  </>;
}
