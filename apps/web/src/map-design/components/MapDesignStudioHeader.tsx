import { MapDesignTitlebarContext } from './MapDesignTitlebar';
import { Button, ToggleGroup, ToggleGroupItem } from '@mapseekai/components';
import { ArrowLeft, Layers, History, MessageSquare, Maximize2, Minimize2, Eye, Code2 } from 'lucide-react';
import { useContext, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useI18n } from '../../i18n';
import { commentsCopy } from '../../i18n/locales/comments';
import { navigationCopy } from '../../i18n/locales/navigation';
import { styleCodeCopy } from '../../i18n/locales/style-code';
import { navigate } from '../../router';

export type MapDesignStudioMode = 'map' | 'style' | 'comments';
const modes: MapDesignStudioMode[] = ['map', 'style', 'comments'];

export function MapDesignStudioHeader({
  title, draftRevision, commentCount = 0, mode, fullscreen, inspectorOpen, inspectorId,
  inspectorTriggerRef, onModeChange, onToggleFullscreen, actions, onHeightChange,
  viewMode = 'preview', onViewModeChange,
}: {
  onHeightChange?(height: number): void;
  viewMode?: 'preview' | 'code';
  onViewModeChange?(mode: 'preview' | 'code'): void;
  title: string; draftRevision: number; commentCount?: number; fullscreen: boolean;
  mode: MapDesignStudioMode; inspectorOpen: boolean; inspectorId: string; onModeChange(mode: MapDesignStudioMode): void;
  inspectorTriggerRef?: RefObject<HTMLButtonElement>;
  actions?: ReactNode;
  onToggleFullscreen(): void;
}) {
  const { t, locale } = useI18n();
  const titlebar = useContext(MapDesignTitlebarContext);
  const headerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header || !onHeightChange) return;
    const update = () => { const height = header.getBoundingClientRect().height; if (height > 0) onHeightChange(height); };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, [onHeightChange]);
  const modeLabel: Record<MapDesignStudioMode, string> = {
    map: t('mapDesign.studio.layers'),
    style: t('mapDesign.studio.revisions'),
    comments: `${commentsCopy[locale].comment} (${new Intl.NumberFormat(locale).format(commentCount)})`,
  };
  return <header ref={headerRef} className="flex min-h-[var(--studio-header-height)] min-w-0 flex-wrap items-center gap-2 border-b bg-background/95 px-3 py-2">
    {!titlebar ? <Button type="button" variant="ghost" size="icon-sm" aria-label={navigationCopy[locale].backHome}
      title={navigationCopy[locale].backHome} onClick={() => navigate({ kind: 'home' })}>
      <ArrowLeft aria-hidden="true" className="rtl:rotate-180" />
    </Button> : null}
    <div className="flex min-w-16 max-w-48 shrink flex-col justify-center [&>h1]:font-serif [&>h1]:text-lg [&>h1]:font-medium [&>h1]:tracking-tight">
      <h1 className="truncate" title={title}>{title}</h1>
      <span className="whitespace-nowrap font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t('mapDesign.studio.revision')} {draftRevision}</span>
    </div>
    {onViewModeChange ? <ToggleGroup size="sm" value={[viewMode]} aria-label={styleCodeCopy[locale].view} className="shrink-0"
      onValueChange={(values) => { const value = values[0]; if (value === 'preview' || value === 'code') onViewModeChange(value); }}>
      {(['preview', 'code'] as const).map(value => <ToggleGroupItem key={value} value={value} type="button">
        {value === 'preview' ? <Eye data-icon="inline-start" aria-hidden="true" /> : <Code2 data-icon="inline-start" aria-hidden="true" />}{styleCodeCopy[locale][value]}
      </ToggleGroupItem>)}
    </ToggleGroup> : null}
    {actions ? <div className="relative z-20 ms-auto flex min-w-0 max-w-full flex-wrap items-center gap-1">{actions}</div> : null}
    <div role="group" className={`flex min-w-0 max-w-full flex-wrap items-center gap-1 ${actions ? '' : 'ms-auto'}`} aria-label={t('mapDesign.studio.modeTabs')}>
      {modes.map((value) => <Button type="button" size="sm" variant={inspectorOpen && mode === value ? 'secondary' : 'ghost'} key={value} ref={mode === value ? inspectorTriggerRef : undefined} aria-controls={inspectorId} aria-expanded={mode === value && inspectorOpen} aria-pressed={inspectorOpen && mode === value} aria-label={modeLabel[value]} onClick={() => onModeChange(value)}>
        {value === 'map' ? <Layers aria-hidden="true" /> : value === 'style' ? <History aria-hidden="true" /> : <MessageSquare aria-hidden="true" />}
        {modeLabel[value]}
      </Button>)}
    </div>
    <div className="flex shrink-0 items-center gap-1">
      <Button type="button" variant="ghost" size="icon-sm"
        aria-label={fullscreen ? t('mapDesign.studio.fullscreenExit') : t('mapDesign.studio.fullscreenEnter')}
        onClick={onToggleFullscreen}>
        {fullscreen ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
      </Button>
    </div>
  </header>;
}
