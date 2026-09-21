import type { ReactNode, Ref, UIEventHandler } from 'react';
import { useT } from '../../i18n';

/** Shared conversation presentation; project and document controllers supply their own state. */
export function MapDesignChatSurface({ messages, composer, status, busy = false, selected = true, messagesRef, contentRef, onScroll }: {
  messages: ReactNode; composer: ReactNode; status?: ReactNode;
  busy?: boolean; selected?: boolean;
  messagesRef?: Ref<HTMLDivElement>; contentRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
}) {
  const t = useT();
  return <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 p-3 [&[hidden]]:hidden max-md:pb-[calc(12px+env(safe-area-inset-bottom,0px))]" hidden={!selected} aria-busy={busy}>
    <div ref={messagesRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto p-1" aria-busy={busy} role="log" aria-label={t('mapDesign.conversation.chatRegion')}>
      <div ref={contentRef} className="flex flex-col gap-2">{messages}</div>
    </div>
    {status}
    {composer}
  </div>;
}
