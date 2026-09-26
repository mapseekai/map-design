import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { BookOpen, House, Map, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Search, Settings, Languages, ArrowLeft } from 'lucide-react';
import {
  Button, InputGroup, InputGroupInput, InputGroupAddon, Sidebar, SidebarContent, SidebarGroup, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, useSidebar,
} from '@mapseekai/components';
import { getLocaleDirection, useI18n } from '../i18n';
import { navigationCopy } from '../i18n/locales/navigation';
import { sidebarCopy } from '../i18n/locales/sidebar';
import { settingsNavigationCopy } from '../i18n/locales/settings-navigation';
import { buildPath, navigate, useRoute } from '../router';
import { getMapDesignHost } from '../platform/map-design-host';
import { MapDesignTitlebarContext, TitlebarControl } from './components/MapDesignTitlebar';

const sidebarPreferenceKey = 'mapdesign.sidebar.open';
const navigationItems = [
  { kind: 'home', icon: House },
  { kind: 'projects', icon: Map },
  { kind: 'cartographies', icon: BookOpen },
  { kind: 'settings', icon: Settings },
] as const;

function ShellNavigation() {
  const { locale } = useI18n();
  const route = useRoute();
  const { open, isMobile, toggleSidebar, setOpenMobile, setOpen } = useSidebar();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const copy = navigationCopy[locale];
  const labels = sidebarCopy[locale];
  const direction = getLocaleDirection(locale);
  const CollapseIcon = direction === 'rtl' ? PanelRightClose : PanelLeftClose;
  const ExpandIcon = direction === 'rtl' ? PanelRightOpen : PanelLeftOpen;
  return <>
    <Sidebar side={direction === 'rtl' ? 'right' : 'left'} dir={direction} variant="floating" collapsible="icon" mobileTitle={labels.navigation} mobileDescription={labels.open}
      style={{ top: 'var(--app-titlebar-height, 0px)', height: 'calc(100dvh - var(--app-titlebar-height, 0px))' }}
      className="top-(--app-titlebar-height) h-[calc(100svh-var(--app-titlebar-height))]">
      <SidebarHeader className="flex-row items-center group-data-[collapsible=icon]:flex-col" style={{ paddingBottom: 4 }}>
        <InputGroup className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <InputGroupInput ref={searchRef} type="search" aria-label={labels.search} placeholder={labels.search}
            value={query} onChange={(event) => setQuery(event.target.value)} />
          <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
        </InputGroup>
        <SidebarMenuButton tooltip={labels.search} aria-label={labels.search}
          className="hidden group-data-[collapsible=icon]:inline-flex"
          onClick={() => { setOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); }}>
          <Search aria-hidden="true" />
        </SidebarMenuButton>
        <TitlebarControl><Button variant="ghost" size="icon-sm" aria-label={open ? labels.collapse : labels.expand}
          aria-expanded={isMobile ? true : open} onClick={toggleSidebar}>
          {open ? <CollapseIcon aria-hidden="true" /> : <ExpandIcon aria-hidden="true" />}
        </Button></TitlebarControl>
      </SidebarHeader>
      <nav aria-label={labels.navigation} className="flex min-h-0 flex-1 flex-col">
      <SidebarContent>
        <SidebarGroup>
            <SidebarMenu>
              {route.kind === 'settings' ? <>
                <SidebarMenuItem><SidebarMenuButton tooltip={copy.backHome} aria-label={copy.backHome} onClick={() => { navigate({ kind: 'home' }); setOpenMobile(false); setQuery(''); }}><ArrowLeft aria-hidden="true" className="rtl:rotate-180" /><span>{copy.backHome}</span></SidebarMenuButton></SidebarMenuItem>
                {(['models', 'appearance'] as const).filter(section => settingsNavigationCopy[locale][section].toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(section => <SidebarMenuItem key={section}>
                  <SidebarMenuButton tooltip={settingsNavigationCopy[locale][section]} aria-label={settingsNavigationCopy[locale][section]} isActive={(route.section ?? 'models') === section} aria-current={(route.section ?? 'models') === section ? 'page' : undefined} onClick={() => { navigate({ kind: 'settings', section }); setOpenMobile(false); setQuery(''); }}>
                    {section === 'models' ? <Settings aria-hidden="true" /> : <Languages aria-hidden="true" />}<span>{settingsNavigationCopy[locale][section]}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>)}
              </> : navigationItems.filter(({ kind }) => copy[kind].toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(({ kind, icon: Icon }) =>
                <SidebarMenuItem key={kind}>
                  <SidebarMenuButton isActive={route.kind === kind} tooltip={copy[kind]} aria-label={copy[kind]}
                    aria-current={route.kind === kind ? 'page' : undefined}
                    onClick={() => { navigate({ kind }); setOpenMobile(false); setQuery(''); }}>
                    <Icon aria-hidden="true" /><span>{copy[kind]}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>)}
            </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      </nav>
    </Sidebar>
    <div className="fixed start-3 top-3 md:hidden">
      <Button variant="outline" size="icon" aria-label={labels.open} onClick={toggleSidebar}>
        <ExpandIcon aria-hidden="true" />
      </Button>
    </div>
  </>;
}

export function MapDesignShell({ children, tabs }: { children: ReactNode; tabs?: ReactNode }) {
  const route = useRoute();
  const { locale } = useI18n();
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  const [title, setTitle] = useState<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const update = () => setWide(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const titlebar = useMemo(() => wide ? { controls, title } : null, [wide, controls, title]);
  const macDesktop = getMapDesignHost()?.client.platform === 'darwin';
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(sidebarPreferenceKey) !== 'false'; }
    catch { return true; }
  });
  return <MapDesignTitlebarContext.Provider value={titlebar}><div className="min-h-dvh bg-background text-foreground"
    style={{ '--app-titlebar-height': wide ? '52px' : '0px', paddingTop: wide ? 52 : 0 } as CSSProperties}>
    <div data-app-titlebar className="fixed inset-x-0 top-0 z-30 hidden h-(--app-titlebar-height) select-none items-center gap-2 bg-muted/60 px-3 md:flex"
      style={{ WebkitAppRegion: 'drag', position: 'fixed', inset: '0 0 auto', height: wide ? 52 : 0,
        display: wide ? 'flex' : 'none', alignItems: 'center', background: 'var(--muted)', paddingLeft: macDesktop ? 'var(--app-titlebar-inset-left, 88px)' : 12 } as CSSProperties}>
      <div ref={setControls} className="flex shrink-0 items-center gap-1" />
      {route.kind === 'project' || route.kind === 'cartography-editor' ? <Button variant="ghost" size="icon-sm" aria-label={navigationCopy[locale].backHome} title={navigationCopy[locale].backHome}
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties} onClick={() => navigate({ kind: 'home' })}><House aria-hidden="true" /></Button> : null}
      <div className="min-w-0 flex-1">{tabs ?? <div ref={setTitle} />}</div>
    </div>
    {route.kind === 'project' || route.kind === 'cartography-editor' ? <main className="flex min-h-0 flex-col overflow-hidden" style={{ height: 'calc(100dvh - var(--app-titlebar-height))' }}><div id="workspace-panel" role={tabs ? 'tabpanel' : undefined} aria-labelledby={tabs ? `workspace-tab-${buildPath(route)}` : undefined} className="flex min-h-0 flex-1 flex-col">{children}</div></main>
    : <SidebarProvider dir={getLocaleDirection(locale)} open={open} onOpenChange={(value) => {
    setOpen(value);
    try { localStorage.setItem(sidebarPreferenceKey, String(value)); } catch { /* Storage may be unavailable. */ }
  }} className="min-h-[calc(100svh-var(--app-titlebar-height))]"
    style={{ '--sidebar-width': '14rem', '--sidebar-width-icon': '3rem', minHeight: 'calc(100dvh - var(--app-titlebar-height))' } as CSSProperties}>
    <ShellNavigation />
    <main className="flex min-h-0 min-w-0 flex-1 flex-col pt-14 md:pt-0">{children}</main>
  </SidebarProvider>}
  </div></MapDesignTitlebarContext.Provider>;
}
