import { Button, cn } from '@mapseekai/components';
import type {
  MapDesignRunStatus,
  MapRunStage,
  PersistedMapAgentEvent,
} from '@mapseekai/contracts';
import { Ban, CheckCircle2, ChevronDown, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';

import { useT } from '../../i18n';
import { activateDisclosureFromKeyboard } from './disclosure-keyboard';
import { MapToolActivityCard, type MapToolActivity } from './MapToolActivityCard';
import { ThinkingBlock } from './ThinkingBlock';

export type MapDesignEventBlock =
  | { kind: 'status'; stage: MapRunStage }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; activity: MapToolActivity }
  | { kind: 'text'; text: string };

export type TaskActivityEntry =
  | Extract<MapDesignEventBlock, { kind: 'thinking' }>
  | Extract<MapDesignEventBlock, { kind: 'tool' }>;

export interface TaskActivity {
  stage?: MapRunStage;
  entries: TaskActivityEntry[];
}

export function buildMapDesignEventBlocks(
  events: readonly PersistedMapAgentEvent[],
): MapDesignEventBlock[] {
  const blocks: MapDesignEventBlock[] = [];
  const toolsById = new Map<string, Extract<MapDesignEventBlock, { kind: 'tool' }>>();
  const pendingResults = new Map<string, Extract<PersistedMapAgentEvent, { kind: 'tool_result' }>>();

  for (const event of events) {
    if (event.kind === 'status') {
      blocks.push({ kind: 'status', stage: event.label });
      continue;
    }
    if (event.kind === 'thinking' || event.kind === 'text') {
      const previous = blocks.at(-1);
      if (previous?.kind === event.kind) previous.text += event.text;
      else blocks.push({ kind: event.kind, text: event.text });
      continue;
    }
    if (event.kind === 'tool_use') {
      const known = toolsById.get(event.id);
      if (known) {
        known.activity.name = event.name;
        known.activity.summary = event.summary;
      } else {
        const block: Extract<MapDesignEventBlock, { kind: 'tool' }> = {
          kind: 'tool',
          activity: { id: event.id, name: event.name, summary: event.summary },
        };
        const pendingResult = pendingResults.get(event.id);
        if (pendingResult) {
          block.activity.result = { status: pendingResult.status, summary: pendingResult.summary };
          pendingResults.delete(event.id);
        }
        toolsById.set(event.id, block);
        blocks.push(block);
      }
      continue;
    }
    if (event.kind === 'tool_result') {
      const tool = toolsById.get(event.toolUseId);
      if (tool) tool.activity.result = { status: event.status, summary: event.summary };
      else pendingResults.set(event.toolUseId, event);
    }
  }

  return blocks;
}

export function splitTaskActivity(blocks: readonly MapDesignEventBlock[]): {
  contentBlocks: Array<Extract<MapDesignEventBlock, { kind: 'text' }>>;
  taskActivity: TaskActivity | null;
} {
  const contentBlocks: Array<Extract<MapDesignEventBlock, { kind: 'text' }>> = [];
  const entries: TaskActivityEntry[] = [];
  let stage: MapRunStage | undefined;

  for (const block of blocks) {
    if (block.kind === 'text') contentBlocks.push(block);
    else if (block.kind === 'status') stage = block.stage;
    else entries.push(block);
  }

  return {
    contentBlocks,
    taskActivity: stage || entries.length > 0 ? { ...(stage ? { stage } : {}), entries } : null,
  };
}

function isActiveRun(status: MapDesignRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'awaiting_input';
}

function stageLabel(stage: MapRunStage | undefined, t: ReturnType<typeof useT>): string {
  if (stage === 'preparing') return t('mapDesign.activity.stagePreparing');
  if (stage === 'analyzing') return t('mapDesign.activity.stageAnalyzing');
  if (stage === 'validating') return t('mapDesign.activity.stageValidating');
  if (stage === 'previewing') return t('mapDesign.activity.stagePreviewing');
  if (stage === 'committing') return t('mapDesign.activity.stageCommitting');
  return t('mapDesign.activity.statusFallback');
}

export function TaskActivityCard({
  activity,
  runStatus,
}: {
  activity: TaskActivity | null;
  runStatus: MapDesignRunStatus;
}) {
  const t = useT();
  const generatedId = useId();
  const regionId = `map-design-task-activity-${generatedId.replace(/:/gu, '')}`;
  const labelId = `${regionId}-label`;
  const running = isActiveRun(runStatus);
  const failed = runStatus === 'failed';
  const canceled = runStatus === 'canceled';
  const stateLabel = running
    ? t('mapDesign.activity.working')
    : failed
      ? t('mapDesign.activity.failed')
      : canceled
        ? t('mapDesign.activity.canceled')
        : t('mapDesign.activity.completed');
  const runState = running ? 'running' : runStatus;
  const [open, setOpen] = useState(running);
  const toggleLabel = t(open ? 'mapDesign.activity.collapse' : 'mapDesign.activity.expand');
  const currentEntryIndex = running && activity?.entries.length
    ? activity.entries.length - 1
    : -1;
  const currentLabel = activity?.stage ? stageLabel(activity.stage, t) : stateLabel;
  const accessibleLabel = currentLabel === stateLabel
    ? `${toggleLabel} — ${stateLabel}`
    : `${toggleLabel} — ${currentLabel} — ${stateLabel}`;
  const toggleOpen = () => setOpen((current) => !current);

  return <section className="group/task mb-2.5 text-xs text-muted-foreground" data-run-state={runState}>
    <div aria-live="off">
      <Button variant="ghost"
        type="button"
        className="group/toggle h-auto min-h-8 w-fit max-w-full justify-start"
        aria-label={accessibleLabel}
        aria-expanded={open}
        aria-controls={regionId}
        data-run-state={runState}
        data-testid="task-activity-toggle"
        onClick={toggleOpen}
        onKeyDown={(event) => activateDisclosureFromKeyboard(event, toggleOpen)}
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-background group-data-[run-state=running]/task:text-primary group-data-[run-state=failed]/task:text-destructive group-data-[run-state=running]/task:[&_svg]:animate-spin motion-reduce:[&_svg]:animate-none" aria-hidden="true">
          {running
            ? <LoaderCircle size={15} />
            : failed
              ? <TriangleAlert size={15} />
              : canceled
                ? <Ban size={15} />
                : <CheckCircle2 size={15} />}
        </span>
        <span id={labelId} className="min-w-0 truncate">
          {currentLabel}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{stateLabel}</span>
        <ChevronDown className="shrink-0 transition-transform group-aria-expanded/toggle:rotate-180 motion-reduce:transition-none" size={14} aria-hidden="true" />
      </Button>
      <div
        id={regionId}
        role="region"
        aria-labelledby={labelId}
        aria-hidden={!open}
        className={cn("grid transition-[grid-template-rows,opacity] motion-reduce:transition-none", open ? "visible grid-rows-[1fr] opacity-100" : "invisible grid-rows-[0fr] opacity-0")}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="ml-3 mt-0.5 grid gap-1 border-l py-1 pl-3">
            {activity?.entries.length
              ? activity.entries.map((entry, index) => entry.kind === 'thinking'
                ? <ThinkingBlock
                    key={`thinking-${index}`}
                    text={entry.text}
                    running={running && index === activity.entries.length - 1}
                  />
                : <MapToolActivityCard
                    key={entry.activity.id}
                    activity={entry.activity}
                    runStatus={runStatus}
                    current={index === currentEntryIndex && entry.activity.result === undefined}
                  />)
              : <span className="flex min-h-8 items-center px-1 text-muted-foreground">{stageLabel(activity?.stage, t)}</span>}
          </div>
        </div>
      </div>
    </div>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{stateLabel}</span>
  </section>;
}
