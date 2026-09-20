import { Button, cn } from '@mapseekai/components';
import { Brain, ChevronDown, LoaderCircle } from 'lucide-react';
import { useId, useState } from 'react';

import { useT } from '../../i18n';
import { activateDisclosureFromKeyboard } from './disclosure-keyboard';

export function ThinkingBlock({ text, running = false }: { text: string; running?: boolean }) {
  const t = useT();
  const generatedId = useId();
  const regionId = `map-design-thinking-${generatedId.replace(/:/gu, '')}`;
  const [open, setOpen] = useState(running);
  const label = running
    ? t('mapDesign.activity.thinking')
    : t('mapDesign.activity.summaryFallback');
  const toggleOpen = () => setOpen((current) => !current);

  return <section className="group/thinking min-w-0" data-running={running} aria-live="off">
    <Button variant="ghost"
      type="button"
      className="group/toggle h-auto min-h-8 w-full justify-start"
      aria-label={label}
      aria-expanded={open}
      aria-controls={regionId}
      onClick={toggleOpen}
      onKeyDown={(event) => activateDisclosureFromKeyboard(event, toggleOpen)}
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-background group-data-[running=true]/thinking:text-primary group-data-[status=failed]/tool:text-destructive group-data-[running=true]/thinking:[&_svg]:animate-spin group-data-[status=running]/tool:[&_svg]:animate-spin motion-reduce:[&_svg]:animate-none" aria-hidden="true">
        {running ? <LoaderCircle size={14} /> : <Brain size={14} />}
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <ChevronDown className="shrink-0 transition-transform group-aria-expanded/toggle:rotate-180 motion-reduce:transition-none" size={13} aria-hidden="true" />
    </Button>
    <div
      id={regionId}
      className={cn("grid transition-[grid-template-rows,opacity] motion-reduce:transition-none", open ? "visible grid-rows-[1fr] opacity-100" : "invisible grid-rows-[0fr] opacity-0")}
      aria-hidden={!open}
    >
      <div className="min-h-0 overflow-hidden">
        <p className="m-0 max-h-[min(36dvh,280px)] overflow-auto whitespace-pre-wrap break-words py-2 pl-8 pr-2 text-xs leading-relaxed text-muted-foreground">{text}</p>
      </div>
    </div>
  </section>;
}
