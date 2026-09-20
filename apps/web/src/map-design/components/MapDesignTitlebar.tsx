import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Folder } from 'lucide-react';

export const MapDesignTitlebarContext = createContext<{ controls: HTMLElement | null; title: HTMLElement | null } | null>(null);

export function TitlebarControl({ children }: { children: ReactNode }) {
  const host = useContext(MapDesignTitlebarContext)?.controls;
  return host ? createPortal(<div className="flex items-center [&>button]:size-8" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>{children}</div>, host) : children;
}

export function TitlebarProject({ title }: { title: string }) {
  const host = useContext(MapDesignTitlebarContext)?.title;
  return host ? createPortal(<div className="flex h-8 max-w-64 items-center gap-2 rounded-xl border border-border/60 bg-background px-3 text-sm font-medium shadow-sm" title={title}>
    <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate">{title}</span>
  </div>, host) : null;
}
