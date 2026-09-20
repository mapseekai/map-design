import { Button, cn } from '@mapseekai/components';
import type { MapDesignRunStatus, SafeToolSummary } from '@mapseekai/contracts';
import { Ban, Check, ChevronDown, LoaderCircle, TriangleAlert, Wrench } from 'lucide-react';
import { useId, useState } from 'react';

import { useT } from '../../i18n';
import { activateDisclosureFromKeyboard } from './disclosure-keyboard';

export interface MapToolActivity {
  id: string;
  name: string;
  summary: SafeToolSummary;
  result?: {
    status: 'succeeded' | 'failed' | 'canceled';
    summary: SafeToolSummary;
  };
}

type NativeToolLabelKey =
  | 'mapDesign.activity.toolGetContext'
  | 'mapDesign.activity.toolInspect'
  | 'mapDesign.activity.toolSearchLayers'
  | 'mapDesign.activity.toolApplyTransaction'
  | 'mapDesign.activity.toolUpdateSemantics'
  | 'mapDesign.activity.toolValidate'
  | 'mapDesign.activity.toolRenderPreview'
  | 'mapDesign.activity.toolCommitRevision'
  | 'mapDesign.activity.toolDiscardDraft';

const TOOL_LABEL_KEYS: Readonly<Record<string, NativeToolLabelKey>> = {
  map_get_context: 'mapDesign.activity.toolGetContext',
  map_inspect: 'mapDesign.activity.toolInspect',
  map_search_layers: 'mapDesign.activity.toolSearchLayers',
  map_apply_transaction: 'mapDesign.activity.toolApplyTransaction',
  map_update_semantics: 'mapDesign.activity.toolUpdateSemantics',
  map_validate: 'mapDesign.activity.toolValidate',
  map_render_preview: 'mapDesign.activity.toolRenderPreview',
  map_commit_revision: 'mapDesign.activity.toolCommitRevision',
  map_discard_draft: 'mapDesign.activity.toolDiscardDraft',
};

function isActiveRun(status: MapDesignRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'awaiting_input';
}

type ToolPresentationStatus = 'running' | 'succeeded' | 'failed' | 'canceled';

function toolPresentationStatus(
  activity: MapToolActivity,
  runStatus: MapDesignRunStatus,
  current: boolean,
): ToolPresentationStatus {
  if (activity.result) return activity.result.status;
  if (current && isActiveRun(runStatus)) return 'running';
  if (runStatus === 'canceled') return 'canceled';
  return 'failed';
}

function summaryValue(value: SafeToolSummary[string]): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function summaryCount(activity: MapToolActivity, key: string): number {
  const value = activity.result?.summary[key] ?? activity.summary[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function SafeSummary({ summary }: { summary: SafeToolSummary }) {
  const entries = Object.entries(summary);
  if (entries.length === 0) return null;
  return <dl className="m-0 grid gap-1">
    {entries.map(([key, value]) => <div key={key} className="grid grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)] gap-2 [&_dt]:truncate [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:break-words">
      <dt>{key}</dt>
      <dd>{summaryValue(value)}</dd>
    </div>)}
  </dl>;
}

export function MapToolActivityCard({
  activity,
  runStatus,
  current = false,
}: {
  activity: MapToolActivity;
  runStatus: MapDesignRunStatus;
  current?: boolean;
}) {
  const t = useT();
  const generatedId = useId();
  const regionId = `map-design-tool-${generatedId.replace(/:/gu, '')}`;
  const labelKey = TOOL_LABEL_KEYS[activity.name];
  const label = labelKey ? t(labelKey) : t('mapDesign.activity.toolGeneric');
  const presentationStatus = toolPresentationStatus(activity, runStatus, current);
  const statusLabel = presentationStatus === 'running'
    ? t('mapDesign.activity.working')
    : presentationStatus === 'failed'
      ? t('mapDesign.activity.failed')
      : presentationStatus === 'canceled'
        ? t('mapDesign.activity.canceled')
        : t('mapDesign.activity.completed');
  const [open, setOpen] = useState(presentationStatus === 'running');
  const toggleOpen = () => setOpen((value) => !value);

  if (activity.name === 'map_tools' || activity.id === 'tools-omitted') {
    const omitted = summaryCount(activity, 'omitted');
    const failures = summaryCount(activity, 'failures');
    return <div className="grid min-h-8 grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 p-1 text-muted-foreground [&>span:nth-child(2)]:truncate" data-supported="aggregate" data-status={presentationStatus}>
      {presentationStatus === 'failed'
        ? <TriangleAlert size={14} aria-hidden="true" />
        : presentationStatus === 'canceled'
          ? <Ban size={14} aria-hidden="true" />
          : <Wrench size={14} aria-hidden="true" />}
      <span>{t('mapDesign.activity.toolsOmitted')}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        <span>{t('mapDesign.activity.toolsOmittedCount', { count: omitted })}</span>
        {failures > 0 ? <span>{t('mapDesign.activity.toolsOmittedFailures', { count: failures })}</span> : null}
      </span>
    </div>;
  }

  if (!labelKey) {
    return <div className="grid min-h-8 grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 p-1 text-muted-foreground [&>span:nth-child(2)]:truncate" data-supported="false" data-status={presentationStatus}>
      {presentationStatus === 'running'
        ? <LoaderCircle size={14} aria-hidden="true" />
        : presentationStatus === 'failed'
          ? <TriangleAlert size={14} aria-hidden="true" />
          : presentationStatus === 'canceled'
            ? <Ban size={14} aria-hidden="true" />
            : <Check size={14} aria-hidden="true" />}
      <span>{label}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{statusLabel}</span>
    </div>;
  }

  return <section className="group/tool min-w-0" data-status={presentationStatus} aria-live="off">
    <Button variant="ghost"
      type="button"
      className="group/toggle h-auto min-h-8 w-full justify-start"
      aria-label={`${label} — ${statusLabel}`}
      aria-expanded={open}
      aria-controls={regionId}
      onClick={toggleOpen}
      onKeyDown={(event) => activateDisclosureFromKeyboard(event, toggleOpen)}
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-md border bg-background group-data-[running=true]/thinking:text-primary group-data-[status=failed]/tool:text-destructive group-data-[running=true]/thinking:[&_svg]:animate-spin group-data-[status=running]/tool:[&_svg]:animate-spin motion-reduce:[&_svg]:animate-none" aria-hidden="true">
        {presentationStatus === 'running'
          ? <LoaderCircle size={14} />
          : presentationStatus === 'failed'
            ? <TriangleAlert size={14} />
            : presentationStatus === 'canceled'
              ? <Ban size={14} />
              : <Check size={14} />}
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{statusLabel}</span>
      <ChevronDown className="shrink-0 transition-transform group-aria-expanded/toggle:rotate-180 motion-reduce:transition-none" size={13} aria-hidden="true" />
    </Button>
    <div
      id={regionId}
      className={cn("grid transition-[grid-template-rows,opacity] motion-reduce:transition-none", open ? "visible grid-rows-[1fr] opacity-100" : "invisible grid-rows-[0fr] opacity-0")}
      aria-hidden={!open}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="grid max-h-[min(36dvh,280px)] gap-2 overflow-y-auto py-2 pl-8 pr-2 [&_section]:grid [&_section]:gap-1 [&_h4]:text-xs [&_h4]:text-muted-foreground">
          {Object.keys(activity.summary).length > 0 ? <section>
            <h4>{t('mapDesign.activity.requestSummary')}</h4>
            <SafeSummary summary={activity.summary} />
          </section> : null}
          {activity.result && Object.keys(activity.result.summary).length > 0 ? <section>
            <h4>{t('mapDesign.activity.resultSummary')}</h4>
            <SafeSummary summary={activity.result.summary} />
          </section> : null}
        </div>
      </div>
    </div>
  </section>;
}
