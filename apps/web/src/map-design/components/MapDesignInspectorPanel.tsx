import { History, Layers as LayersIcon, MessageSquare, Pin, PinOff, X } from 'lucide-react';
import { Badge, Button, Card, CardHeader, CardTitle, CardDescription, Empty, EmptyDescription, Sheet, SheetContent, SheetTitle, Tabs, TabsContent, TabsList, TabsTrigger } from '@mapseekai/components';
import type { MapInspectOutput, MapRenderPreviewOutput, MapRevisionHistoryOutput } from '@mapseekai/map-design-contracts';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useI18n, useT } from '../../i18n';
import { commentsCopy } from '../../i18n/locales/comments';
import type { MapDesignProjectView } from '../hooks/useMapDesignProject';
import { MapDesignRevisionPanel } from './MapDesignRevisionPanel';

export type MapDesignInspectorTab = 'layers' | 'revisions' | 'comments';
export type MapDesignInspectorPlacement = 'closed' | 'floating' | 'docked' | 'drawer';

export interface MapDesignInspectorLayoutProps {
  placement: MapDesignInspectorPlacement;
  closing?: boolean;
  width: number;
  onPinChange(pinned: boolean): void;
  onWidthChange(width: number): void;
  onClose(): void;
}

const INSPECTOR_MIN_WIDTH = 280;
const INSPECTOR_MAX_WIDTH = 420;

function clamp(value: number): number {
  return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, value));
}

function topmostVisibleModal(): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
    .filter((element) => !element.closest('[hidden], [inert], [aria-hidden="true"]'))
    .at(-1) ?? null;
}

export function MapDesignInspectorPanel({ id, placement, closing = false, width, tab, commentCount = 0, inspect, revisions, preview, canCommit, committing, currentCommittedRevision, view, onTabChange, onCommit, onViewRevision,
  onPinChange, onClose, onCommentsHost }: {
  id: string; commentCount?: number; inspect: MapInspectOutput;
  tab: MapDesignInspectorTab; revisions: MapRevisionHistoryOutput; preview: MapRenderPreviewOutput | null; canCommit: boolean; committing: boolean;
  currentCommittedRevision: number | null; view: MapDesignProjectView;
  onTabChange(tab: MapDesignInspectorTab): void;
  onCommit(): void;
  onViewRevision(revision: number): void;
  onCommentsHost?(element: HTMLDivElement | null): void;
} & MapDesignInspectorLayoutProps) {
  const t = useT();
  const { locale } = useI18n();
  const tabRefs = useRef(new Map<MapDesignInspectorTab, HTMLElement>());
  const panelRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const open = placement !== 'closed' && !closing;
  const drawer = placement === 'drawer';
  const [mobileDrawer, setMobileDrawer] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 767px)').matches);
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 767px)');
    if (!media) return;
    const update = () => setMobileDrawer(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  const tabs: Array<[MapDesignInspectorTab, string]> = [
    ['layers', t('mapDesign.studio.layers')], ['revisions', t('mapDesign.studio.revisions')],
    ['comments', `${commentsCopy[locale].comment} (${new Intl.NumberFormat(locale).format(commentCount)})`],
  ];
  const selectFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, current: MapDesignInspectorTab) => {
    const index = tabs.findIndex(([value]) => value === current);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex]![0];
    onTabChange(next);
    tabRefs.current.get(next)?.focus();
  };
  const tabId = (value: MapDesignInspectorTab) => `${id}-tab-${value}`;
  const panelId = (value: MapDesignInspectorTab) => `${id}-panel-${value}`;
  useLayoutEffect(() => {
    for (const value of ['layers', 'revisions', 'comments'] as const) {
      const panel = document.getElementById(`${id}-panel-${value}`);
      if (value === tab) panel?.removeAttribute('inert');
      else panel?.setAttribute('inert', '');
    }
  }, [id, tab, placement]);
  useEffect(() => {
    if (!open || drawer) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape') return;
      const modal = topmostVisibleModal();
      if (modal && modal !== panelRef.current) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawer, onClose, open]);
  const content = <Tabs value={tab} onValueChange={(value) => { if (value !== null) onTabChange(value as MapDesignInspectorTab); }} spacing="none" className="min-w-0">
    <div className="sticky top-0 z-10 flex flex-col gap-3 border-b bg-background p-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="text-sm font-medium">{t('mapDesign.studio.inspector')}</span>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="icon-sm"
            aria-label={placement === 'docked' ? t('mapDesign.studio.inspectorFloat') : t('mapDesign.studio.inspectorDock')}
            onClick={() => onPinChange(placement !== 'docked')}>
            {placement === 'docked' ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
          </Button>
          <Button ref={closeButtonRef} type="button" variant="ghost" size="icon-sm" aria-label={t('mapDesign.studio.inspectorClose')} onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
      </div>
      <TabsList tabIndex={-1} aria-label={t('mapDesign.studio.inspector')} className="grid w-full min-w-0 grid-cols-3">
        {tabs.map(([value, label]) => <TabsTrigger value={value} key={value} id={tabId(value)} size="sm" className="min-w-0"
          ref={(node) => { if (node) tabRefs.current.set(value, node); else tabRefs.current.delete(value); }}
          aria-selected={tab === value} aria-controls={panelId(value)} tabIndex={tab === value ? 0 : -1}
          onKeyDown={(event) => selectFromKeyboard(event, value)} onClick={() => onTabChange(value)}>{value === 'layers' ? <LayersIcon aria-hidden="true" /> : value === 'revisions' ? <History aria-hidden="true" /> : <MessageSquare aria-hidden="true" />}<span className="truncate">{label}</span></TabsTrigger>)}
      </TabsList>
    </div>
    {tabs.map(([value]) => <TabsContent keepMounted value={value} key={value} id={panelId(value)} aria-labelledby={tabId(value)}
      tabIndex={tab === value ? 0 : -1} hidden={tab !== value}>
      {value === 'layers' ? <Layers inspect={inspect} /> : null}
      {value === 'comments' ? <div ref={onCommentsHost} className="p-3" /> : null}
      {value === 'revisions' ? <MapDesignRevisionPanel revisions={revisions} canCommit={canCommit}
        committing={committing} currentCommittedRevision={currentCommittedRevision}
        selectedRevision={view.kind === 'historical' ? view.revision : null}
        onCommit={onCommit} onViewRevision={onViewRevision} /> : null}
    </TabsContent>)}
  </Tabs>;
  if (placement === 'docked') return     <aside id={id} ref={panelRef} className="h-full min-h-0 min-w-0 overflow-auto border-s bg-background group-data-[fullscreen=true]/studio:hidden" data-placement={placement}
      style={{ '--map-inspector-width': `${clamp(width)}px` } as CSSProperties} aria-label={t('mapDesign.studio.inspector')}>
      {content}
    </aside>
  ;
  if (drawer) return <Sheet open={!closing} onOpenChange={(nextOpen, details) => { if (closing) details.cancel(); else if (!nextOpen) onClose(); }}>
    <SheetContent id={id}
      side={mobileDrawer ? 'bottom' : document.documentElement.dir === 'rtl' ? 'left' : 'right'}
      showCloseButton={false} keepMountedPopup aria-modal="true" aria-describedby={undefined} data-placement={placement} data-closing={closing || undefined}
      variant="panel" className="overflow-auto data-[side=bottom]:max-h-[min(78dvh,680px)]"
      initialFocus={closeButtonRef} finalFocus={false}>
      <SheetTitle className="sr-only">{t('mapDesign.studio.inspector')}</SheetTitle>
      {content}
    </SheetContent>
  </Sheet>;
  return <aside id={id} ref={panelRef}
    style={{ top: 'calc(var(--chat-header-height, var(--studio-header-height)) + var(--spacing) * 3)', maxHeight: 'calc(100% - var(--chat-header-height, var(--studio-header-height)) - var(--spacing) * 7 - env(safe-area-inset-bottom, 0px))' }}
    className="absolute end-4 z-8 min-h-0 w-[clamp(286px,var(--map-inspector-width,320px),320px)] overflow-auto rounded-xl border bg-background shadow-xl backdrop-blur-md data-[placement=closed]:invisible data-[placement=closed]:pointer-events-none data-[placement=closed]:opacity-0 group-data-[fullscreen=true]/studio:hidden"
    data-placement={placement} aria-label={t('mapDesign.studio.inspector')}>
    {content}
  </aside>;
}

function Layers({ inspect }: { inspect: MapInspectOutput }) {
  const t = useT();
  if (inspect.view.kind !== 'root') return <Empty><EmptyDescription>{t('mapDesign.studio.layersEmpty')}</EmptyDescription></Empty>;
  return <section className="p-3.5" aria-label={t('mapDesign.studio.layers')}>
    <div className="flex justify-between font-mono text-[10px] font-semibold uppercase text-muted-foreground">
      <span>{inspect.view.style.layerCount} {t('mapDesign.studio.layers')}</span>
      <span>{inspect.view.style.sourceCount} {t('mapDesign.studio.sources')}</span>
    </div>
    <ol className="mt-3.5 grid list-none gap-2 p-0">
      {inspect.view.layers.length === 0 ? <li><Empty><EmptyDescription>{t('mapDesign.studio.layersEmpty')}</EmptyDescription></Empty></li>
        : inspect.view.layers.map((layer) => <li key={layer.id} className="min-w-0">
          <Card size="sm">
            <CardHeader><div className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5">
              <Badge variant="outline" className="col-start-1 row-start-1 self-start">{layer.type}</Badge>
              <CardTitle className="col-start-2 row-start-1 min-w-0" title={layer.title ?? layer.id}><span className="block truncate">{layer.title ?? layer.id}</span></CardTitle>
              {layer.sourceId ? <CardDescription className="col-start-2 row-start-2 min-w-0 break-words [overflow-wrap:anywhere]">
                {layer.sourceId}{layer.sourceLayer ? ` / ${layer.sourceLayer}` : ''}
              </CardDescription> : null}
            </div></CardHeader>
          </Card>
        </li>)}
    </ol>
  </section>;
}
