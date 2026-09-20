import { useT } from '../../i18n';

export interface MapDesignStatusBarProps {
  projection: string;
  scale: string;
  draftRevision: number;
  synced: boolean;
  coordinates: string;
  keyboardNavigationActive?: boolean;
}

export function MapDesignStatusBar({
  projection,
  scale,
  draftRevision,
  synced,
  coordinates,
  keyboardNavigationActive = false,
}: MapDesignStatusBarProps) {
  const t = useT();
  return <div className="sr-only" role="status" aria-live="off">
    <span>{projection}</span>
    <span>{scale}</span>
    <span>{t('mapDesign.studio.draft')} {draftRevision}</span>
    <span data-synced={synced}>{synced ? t('mapDesign.studio.synced') : t('mapDesign.studio.draftOnly')}</span>
    <span className="tabular-nums" aria-live={keyboardNavigationActive ? 'polite' : 'off'}>{coordinates}</span>
  </div>;
}
