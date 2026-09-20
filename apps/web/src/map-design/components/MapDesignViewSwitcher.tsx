import { Tabs, TabsList, TabsTrigger } from '@mapseekai/components';
import { useRef, type KeyboardEvent } from 'react';
import { useT } from '../../i18n';

export type MapDesignMobileView = 'chat' | 'map';

export interface MapDesignViewSwitcherProps {
  view: MapDesignMobileView;
  chatPanelId: string;
  mapPanelId: string;
  mapLabel?: string;
  onViewChange(view: MapDesignMobileView): void;
}

export function MapDesignViewSwitcher({ view, chatPanelId, mapPanelId, mapLabel, onViewChange }: MapDesignViewSwitcherProps) {
  const t = useT();
  const tabRefs = useRef(new Map<MapDesignMobileView, HTMLElement>());
  const selectFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'End' ? 'map'
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'Home' ? 'chat'
        : null;
    if (!next) return;
    event.preventDefault();
    onViewChange(next);
    tabRefs.current.get(next)?.focus();
  };
  return <div className="col-start-1 row-start-1 border-b bg-muted md:hidden group-data-[fullscreen=true]/workspace:hidden"><Tabs value={view} onValueChange={(value) => { if (value !== null) onViewChange(value as MapDesignMobileView); }} className="grid" ><TabsList tabIndex={-1} className="grid w-full grid-cols-2" aria-label={t('mapDesign.studio.modeTabs')}>
    <TabsTrigger value="chat" id="map-design-mobile-chat-tab" aria-controls={chatPanelId}
      ref={(node) => { if (node) tabRefs.current.set('chat', node); else tabRefs.current.delete('chat'); }}
      aria-selected={view === 'chat'} tabIndex={view === 'chat' ? 0 : -1} onKeyDown={selectFromKeyboard}
      onClick={() => onViewChange('chat')}>
      {t('mapDesign.studio.modeChat')}
    </TabsTrigger>
    <TabsTrigger value="map" id="map-design-mobile-map-tab" aria-controls={mapPanelId}
      ref={(node) => { if (node) tabRefs.current.set('map', node); else tabRefs.current.delete('map'); }}
      aria-selected={view === 'map'} tabIndex={view === 'map' ? 0 : -1} onKeyDown={selectFromKeyboard}
      onClick={() => onViewChange('map')}>
      {mapLabel ?? t('mapDesign.studio.modeMap')}
    </TabsTrigger>
  </TabsList></Tabs></div>;
}
