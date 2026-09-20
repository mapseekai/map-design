import type { ComponentProps, ReactNode } from 'react';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@mapseekai/components';
import { useT } from '../../i18n';

/** The project workspace's split panes, also used when the studio is a specification document. */
export function MapDesignWorkspacePanels({ chat, studio, groupProps, chatPanelProps, showHandle = true }: {
  chat: ReactNode;
  studio: ReactNode;
  groupProps?: Partial<Omit<ComponentProps<typeof ResizablePanelGroup>, 'children'>>;
  chatPanelProps?: Partial<Omit<ComponentProps<typeof ResizablePanel>, 'children'>>;
  showHandle?: boolean;
}) {
  const t = useT();
  return <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0" {...groupProps}>
    <ResizablePanel id="chat" defaultSize={380} minSize={320} maxSize={520} groupResizeBehavior="preserve-pixel-size" className="min-h-0" {...chatPanelProps}>{chat}</ResizablePanel>
    {showHandle ? <ResizableHandle withHandle aria-label={t('mapDesign.conversation.resize')} variant="subtle" /> : null}
    <ResizablePanel id="map" minSize={0} className="min-h-0">{studio}</ResizablePanel>
  </ResizablePanelGroup>;
}
