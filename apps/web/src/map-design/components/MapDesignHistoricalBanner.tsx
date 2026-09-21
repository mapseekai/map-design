import { Alert, AlertDescription, Button } from '@mapseekai/components';
import { useLayoutEffect, useRef, type RefObject } from 'react';

import { useT } from '../../i18n';

export function MapDesignHistoricalBanner({ revision, restoreTriggerRef, onReturnCurrent, onRequestRestore, onHeightChange }: {
  revision: number;
  restoreTriggerRef: RefObject<HTMLButtonElement>;
  onReturnCurrent(): void;
  onRequestRestore(): void;
  onHeightChange?(height: number): void;
}) {
  const t = useT();
  const bannerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const banner = bannerRef.current;
    if (!banner || !onHeightChange) return;
    const update = () => onHeightChange(banner.getBoundingClientRect().height);
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(banner);
    return () => { observer?.disconnect(); onHeightChange(0); };
  }, [onHeightChange]);
  return <Alert ref={bannerRef} appearance="banner" className="relative z-5" aria-label={t('mapDesign.revision.banner', { revision })}><div className="flex items-center justify-between gap-3 max-md:flex-col max-md:items-start">
    <AlertDescription>{t('mapDesign.revision.banner', { revision })}</AlertDescription>
    <div className="flex shrink-0 flex-wrap justify-end gap-1.5 max-md:w-full max-md:[&>button]:flex-1">
      <Button type="button" variant="secondary" onClick={onReturnCurrent}>{t('mapDesign.revision.returnCurrent')}</Button>
      <Button ref={restoreTriggerRef} type="button" variant="default" onClick={onRequestRestore}>{t('mapDesign.revision.restore')}</Button>
    </div>
  </div></Alert>;
}
