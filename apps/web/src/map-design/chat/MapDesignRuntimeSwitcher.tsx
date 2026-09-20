import { Badge, Button, Field, FieldGroup, FieldLabel, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem, DialogRoot, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogClose } from '@mapseekai/components';
import type {
  LocalAgentInfo,
  LocalAgentModelOption,
  MapDesignConversationRuntimeChoice,
  MapDesignRuntimeSelectionInput,
} from '@mapseekai/contracts';
import { ChevronDown, Sparkles, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import { useI18n } from '../../i18n';

export interface MapDesignRuntimeSwitcherProps {
  agents: readonly LocalAgentInfo[];
  runtime: MapDesignConversationRuntimeChoice;
  disabled: boolean;
  disabledReason: string | null;
  saving: boolean;
  notice: string | null;
  onChange(next: MapDesignRuntimeSelectionInput): Promise<void>;
}

function isSupported(agent: LocalAgentInfo): boolean {
  return agent.available && agent.mapDesign.nativeMapTools && agent.mapDesign.reason === undefined;
}

function defaultModel(agent: LocalAgentInfo | undefined): LocalAgentModelOption | undefined {
  return agent?.models?.find((model) => model.enabled && model.default)
    ?? agent?.models?.find((model) => model.enabled);
}

function runtimeSelection(
  agent: LocalAgentInfo,
  model: LocalAgentModelOption | undefined,
  current: MapDesignConversationRuntimeChoice,
  rememberedReasoning?: string,
): MapDesignRuntimeSelectionInput {
  const reasoning = rememberedReasoning !== undefined && (rememberedReasoning === '' || model?.reasoningOptions.includes(rememberedReasoning))
    ? rememberedReasoning
    : current.reasoning && model?.reasoningOptions.includes(current.reasoning)
    ? current.reasoning
    : model?.defaultReasoning;
  const serviceTier = current.serviceTier && model?.serviceTierOptions.includes(current.serviceTier)
    ? current.serviceTier
    : model?.defaultServiceTier;
  return {
    agentId: agent.id,
    ...(model ? { model: model.id, modelOrigin: 'catalog' as const } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

const CUSTOM_MODEL_IDENTIFIER = /^(?!-)[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

const REASONING_PREFERENCES_KEY = 'map-design.runtime-reasoning.v1';
const DEFAULT_OPTION = '__runtime_default__';

function reasoningPreferenceKey(agentId: string, modelId: string): string {
  return JSON.stringify([agentId, modelId]);
}

function readReasoningPreferences(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(REASONING_PREFERENCES_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

function rememberedReasoning(preferences: Record<string, string>, agentId: string, model: LocalAgentModelOption): string | undefined {
  const value = preferences[reasoningPreferenceKey(agentId, model.id)];
  return value === '' || (value !== undefined && model.reasoningOptions.includes(value)) ? value : undefined;
}

export function MapDesignRuntimeSwitcher({
  agents,
  runtime,
  disabled,
  disabledReason,
  saving,
  notice,
  onChange,
}: MapDesignRuntimeSwitcherProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [reasoningPreferences, setReasoningPreferences] = useState(readReasoningPreferences);
  const [customModel, setCustomModel] = useState(
    runtime.modelOrigin === 'custom' ? runtime.model ?? '' : '',
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const fieldId = useId();
  const disabledDescriptionId = `map-runtime-disabled-${useId().replace(/:/gu, '')}`;
  const restoreFocusPendingRef = useRef(false);
  const orderedAgents = useMemo(() => [...agents]
    .map((agent, index) => ({ agent, index }))
    .sort((left, right) => Number(isSupported(right.agent)) - Number(isSupported(left.agent)) || left.index - right.index)
    .map(({ agent }) => agent), [agents]);
  const activeAgent = agents.find((agent) => agent.id === runtime.agentId);
  const catalogActiveModel = activeAgent?.models?.find((model) => model.id === runtime.model);
  const activeModel = catalogActiveModel
    ?? (runtime.modelOrigin === 'custom' ? undefined : defaultModel(activeAgent));
  useEffect(() => {
    // The runtime prop is daemon-confirmed state. Never remember an in-flight choice.
    if (saving || !catalogActiveModel || runtime.modelOrigin === 'custom') return;
    if (runtime.reasoning && !catalogActiveModel.reasoningOptions.includes(runtime.reasoning)) return;
    const next = readReasoningPreferences();
    next[reasoningPreferenceKey(runtime.agentId, catalogActiveModel.id)] = runtime.reasoning ?? '';
    setReasoningPreferences((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    try { localStorage.setItem(REASONING_PREFERENCES_KEY, JSON.stringify(next)); } catch { /* Storage is optional. */ }
  }, [saving, runtime.agentId, runtime.model, runtime.modelOrigin, runtime.reasoning, catalogActiveModel]);
  const chipParts = [activeAgent?.label ?? runtime.agentId, activeModel?.label ?? runtime.model, runtime.reasoning]
    .filter((value): value is string => Boolean(value));
  const modelQuery = query.trim().toLocaleLowerCase();
  const models = (activeAgent?.models ?? []).filter((model) => !modelQuery
    || model.label.toLocaleLowerCase().includes(modelQuery)
    || model.id.toLocaleLowerCase().includes(modelQuery));
  const catalogMessage = activeAgent?.modelCatalogSource === 'fallback'
    ? [t('mapDesign.runtime.fallbackCatalog'), activeAgent.modelCatalogWarning].filter(Boolean).join(' — ')
    : activeAgent?.modelCatalogSource === 'remembered'
      ? [t('mapDesign.runtime.rememberedCatalog'), activeAgent.modelCatalogWarning].filter(Boolean).join(' — ')
      : null;
  const customModelIdentifier = customModel.trim();
  const customModelValid = activeAgent?.supportsCustomModel === true
    && CUSTOM_MODEL_IDENTIFIER.test(customModelIdentifier);
  const disabledReasonFor = useCallback((agent: LocalAgentInfo): string | null => {
    if (!agent.available || agent.mapDesign.reason === 'agent-unavailable') {
      return t('mapDesign.runtime.agentUnavailable');
    }
    if (agent.mapDesign.reason === 'map-tools-policy-unsupported') {
      return t(agent.id === 'claude'
        ? 'mapDesign.runtime.claudePolicyUnsupported'
        : 'mapDesign.runtime.policyUnsupported');
    }
    if (agent.mapDesign.reason === 'model-catalog-unavailable') {
      return t('mapDesign.runtime.catalogUnavailable');
    }
    if (!agent.mapDesign.nativeMapTools) return t('mapDesign.runtime.nativeToolsUnavailable');
    return null;
  }, [t]);

  const restoreTriggerFocus = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || trigger.disabled) {
      restoreFocusPendingRef.current = true;
      return;
    }
    restoreFocusPendingRef.current = false;
    trigger.focus();
  }, []);

  const close = useCallback(() => {
    restoreFocusPendingRef.current = true;
    setOpen(false);
    setQuery('');
  }, []);

  useEffect(() => {
    if (disabled && open) close();
  }, [close, disabled, open]);

  useEffect(() => {
    setCustomModel(runtime.modelOrigin === 'custom' ? runtime.model ?? '' : '');
  }, [runtime.agentId, runtime.model, runtime.modelOrigin]);

  useEffect(() => {
    if (!open && !disabled && !saving && restoreFocusPendingRef.current) restoreTriggerFocus();
  }, [disabled, open, restoreTriggerFocus, saving]);

  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' && (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)) {
      if (event.target instanceof HTMLInputElement && event.target.dataset.runtimeCustomModel !== undefined) {
        event.preventDefault();
        chooseCustomModel();
        return;
      }
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && event.target instanceof HTMLButtonElement && event.target.dataset.runtimeOption) {
      event.preventDefault();
      event.target.click();
      return;
    }
    if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('[role=combobox], [data-slot=select-content]'))) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const optionKind = event.target instanceof HTMLButtonElement
      ? event.target.dataset.runtimeOption
      : event.target instanceof HTMLInputElement ? 'model' : undefined;
    const selector = optionKind
      ? `[data-runtime-option="${optionKind}"]:not(:disabled)`
      : '[data-runtime-option]:not(:disabled)';
    const options = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>(selector) ?? []);
    if (options.length === 0) return;
    event.preventDefault();
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const next = current < 0 ? 0 : (current + direction + options.length) % options.length;
    options[next]?.focus();
  };

  const chooseAgent = (agent: LocalAgentInfo) => {
    if (disabled || saving || disabledReasonFor(agent)) return;
    if (agent.id === runtime.agentId) return;
    setQuery('');
    setCustomModel('');
    const model = defaultModel(agent);
    void onChange(runtimeSelection(agent, model, runtime, model ? rememberedReasoning(reasoningPreferences, agent.id, model) : undefined));
  };

  const chooseModel = (model: LocalAgentModelOption) => {
    if (disabled || saving || !activeAgent || !model.enabled) return;
    if (model.id === runtime.model && runtime.modelOrigin === 'catalog') return;
    setCustomModel('');
    void onChange(runtimeSelection(activeAgent, model, runtime, rememberedReasoning(reasoningPreferences, activeAgent.id, model)));
  };

  const chooseCustomModel = () => {
    if (disabled || saving || !activeAgent || !customModelValid) return;
    if (runtime.model === customModelIdentifier && runtime.modelOrigin === 'custom') return;
    void onChange({
      agentId: activeAgent.id,
      model: customModelIdentifier,
      modelOrigin: 'custom',
    });
  };

  const updateOption = (key: 'reasoning' | 'serviceTier', value: string) => {
    if (disabled || saving) return;
    void onChange({
      agentId: runtime.agentId,
      ...(runtime.model ? { model: runtime.model } : {}),
      ...(runtime.model && runtime.modelOrigin ? { modelOrigin: runtime.modelOrigin } : {}),
      ...(key === 'reasoning'
        ? value ? { reasoning: value } : {}
        : runtime.reasoning ? { reasoning: runtime.reasoning } : {}),
      ...(key === 'serviceTier'
        ? value ? { serviceTier: value } : {}
        : runtime.serviceTier ? { serviceTier: runtime.serviceTier } : {}),
    });
  };

  const runtimeStatus = saving || notice || (open && catalogMessage) ? <div className="mt-1 grid gap-0.5 text-xs text-muted-foreground" role={saving || notice || (open && catalogMessage) ? 'status' : undefined}
      aria-live="polite" aria-atomic="true">
      {saving ? <span>{t('mapDesign.runtime.saving')}</span> : null}
      {notice ? <span>{notice}</span> : null}
      {open && catalogMessage ? <span>{catalogMessage}</span> : null}
    </div> : null;

  return <DialogRoot open={open} onOpenChange={(next) => { if (next && !disabled && !saving) setOpen(true); else if (!next) close(); }}><div className="flex min-w-0 flex-col">
    <DialogTrigger render={<Button variant="outline" size="sm" className="max-w-full justify-start" />}
      ref={triggerRef}
      type="button"
      aria-label={`${t('mapDesign.runtime.change')}: ${chipParts.join(' · ')}`}
      aria-describedby={disabledReason ? disabledDescriptionId : undefined}
      aria-haspopup="dialog"
      aria-expanded={open}
      disabled={disabled || saving}
      title={disabledReason ?? undefined}
    >
      <Sparkles data-icon="inline-start" aria-hidden="true" />
      <span className="truncate">{chipParts.join(' · ')}</span>
      <ChevronDown data-icon="inline-end" aria-hidden="true" />
    </DialogTrigger>
    {disabledReason ? <p id={disabledDescriptionId} className="sr-only">{disabledReason}</p> : null}
    <DialogContent
      ref={panelRef}
      className="top-3 max-h-[calc(100dvh-24px)] w-[calc(100vw-24px)] max-w-4xl translate-y-0 sm:max-w-4xl overflow-auto"
      aria-label={t('mapDesign.runtime.settings')}
      tabIndex={-1}
      onKeyDown={keyDown}
      initialFocus={() => panelRef.current?.querySelector<HTMLButtonElement>('[data-runtime-option]:not(:disabled)') ?? false}
      finalFocus={() => triggerRef.current?.disabled ? false : triggerRef.current}
      showCloseButton={false}
    >
      <div className="flex items-start justify-between gap-2">
        <DialogHeader><DialogTitle>{t('mapDesign.runtime.settings')}</DialogTitle>
          <DialogDescription>{t('mapDesign.runtime.settingsHint')}</DialogDescription></DialogHeader>
        <DialogClose aria-label={t('common.close')} render={<Button variant="ghost" size="icon-sm" type="button" />}><X data-icon="inline-start" aria-hidden="true" /></DialogClose>
      </div>
      <div className="grid min-h-0 grid-cols-1 gap-3 md:grid-cols-[minmax(150px,.75fr)_minmax(210px,1.25fr)]">
        <section className="grid min-w-0 content-start gap-2 [&_h3]:text-xs [&_h3]:text-muted-foreground">
          <h3>{t('mapDesign.runtime.agents')}</h3>
          <div className="grid max-h-[30dvh] min-h-0 gap-1 overflow-auto md:max-h-[45dvh]" role="listbox" aria-label={t('mapDesign.runtime.agents')}>
            {orderedAgents.map((agent) => {
              const reason = disabledReasonFor(agent);
              return <Button variant={agent.id === runtime.agentId ? "secondary" : "ghost"}
                key={agent.id}
                type="button"
                role="option"
                aria-selected={agent.id === runtime.agentId}
                disabled={disabled || saving || Boolean(reason)}
                data-runtime-option="agent"
                size="content" className="w-full min-w-0 justify-start"
                onClick={() => chooseAgent(agent)}
              >
                <span className="flex min-w-0 flex-col items-start gap-0.5 text-left whitespace-normal">
                <span className="max-w-full truncate">{agent.label}</span>
                {reason ? <small className="max-w-full text-xs text-muted-foreground">{reason}</small> : <small className="max-w-full text-xs text-muted-foreground">{agent.modelCatalogSource === 'live'
                  ? t('mapDesign.runtime.liveCatalog')
                  : agent.modelCatalogSource === 'remembered'
                    ? t('mapDesign.runtime.rememberedCatalog')
                    : t('mapDesign.runtime.fallbackCatalog')}</small>}
                </span>
              </Button>;
            })}
          </div>
        </section>
        <section className="grid min-w-0 content-start gap-2 [&_h3]:text-xs [&_h3]:text-muted-foreground">
          <h3>{t('mapDesign.runtime.models')}</h3>
          <Field>
            <FieldLabel htmlFor={`${fieldId}-search`} className="sr-only">{t('mapDesign.runtime.searchModels')}</FieldLabel>
            <Input id={`${fieldId}-search`} type="search" aria-label={t('mapDesign.runtime.searchModels')} value={query} onChange={(event) => setQuery(event.target.value)} />
          </Field>
          <div className="grid max-h-[30dvh] min-h-0 gap-1 overflow-auto md:max-h-[45dvh]" role="listbox" aria-label={t('mapDesign.runtime.models')}>
            {models.map((model) => <Button variant={model.id === activeModel?.id ? "secondary" : "ghost"}
              key={model.id}
              type="button"
              role="option"
              aria-selected={model.id === activeModel?.id}
              disabled={disabled || saving || !model.enabled}
              data-runtime-option="model"
              size="content" className="w-full min-w-0 justify-start"
              onClick={() => chooseModel(model)}
            >
              <span className="flex min-w-0 flex-col items-start gap-0.5 text-left whitespace-normal">
              <span className="max-w-full truncate">{model.label}</span>
              {!model.enabled ? <small className="max-w-full text-xs text-muted-foreground">{t('mapDesign.runtime.modelUnavailable')}</small> : model.description && ![model.id, model.label].some((value) => value.trim().toLocaleLowerCase() === model.description?.trim().toLocaleLowerCase()) ? <small className="max-w-full text-xs text-muted-foreground">{model.description}</small> : null}
              {activeAgent && rememberedReasoning(reasoningPreferences, activeAgent.id, model) !== undefined && model.reasoningOptions.length > 0 ? <Badge variant="outline">{t('mapDesign.runtime.reasoning')}: {rememberedReasoning(reasoningPreferences, activeAgent.id, model) || t('mapDesign.runtime.default')}</Badge> : null}
              </span>
            </Button>)}
          </div>
          {activeAgent?.supportsCustomModel ? <FieldGroup><div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
            <Field>
              <FieldLabel htmlFor={`${fieldId}-custom`}>{t('mapDesign.runtime.customModel')}</FieldLabel>
              <Input
                id={`${fieldId}-custom`}
                type="text"
                aria-label={t('mapDesign.runtime.customModel')}
                placeholder={t('mapDesign.runtime.customModelPlaceholder')}
                value={customModel}
                data-runtime-custom-model=""
                onChange={(event) => setCustomModel(event.target.value)}
              />
            </Field>
            <Button variant="ghost" type="button" disabled={disabled || saving || !customModelValid} onClick={chooseCustomModel}>
              {t('mapDesign.runtime.useCustomModel')}
            </Button>
          </div></FieldGroup> : null}
        </section>
      </div>
      {activeModel?.reasoningOptions.length ? <Field orientation="horizontal">
        <FieldLabel className="min-w-28 shrink-0 whitespace-nowrap" htmlFor={`${fieldId}-reasoning`}>{t('mapDesign.runtime.reasoning')}</FieldLabel>
        <Select key={`${runtime.agentId}:${runtime.model}:reasoning`} disabled={disabled || saving}
          items={[{ value: DEFAULT_OPTION, label: t('mapDesign.runtime.default') }, ...activeModel.reasoningOptions.map((value) => ({ value, label: value }))]}
          value={runtime.reasoning && activeModel.reasoningOptions.includes(runtime.reasoning) ? runtime.reasoning : DEFAULT_OPTION}
          onValueChange={(value) => updateOption('reasoning', value === DEFAULT_OPTION || value === null ? '' : value)}>
          <SelectTrigger id={`${fieldId}-reasoning`} className="min-w-0 flex-1" aria-label={t('mapDesign.runtime.reasoning')}><SelectValue /></SelectTrigger>
          <SelectContent alignItemWithTrigger={false}><SelectGroup>
            <SelectItem value={DEFAULT_OPTION}>{t('mapDesign.runtime.default')}</SelectItem>
            {activeModel.reasoningOptions.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
          </SelectGroup></SelectContent>
        </Select>
      </Field> : null}
      {activeModel?.serviceTierOptions.length ? <Field orientation="horizontal">
        <FieldLabel className="min-w-28 shrink-0 whitespace-nowrap" htmlFor={`${fieldId}-serviceTier`}>{t('mapDesign.runtime.serviceTier')}</FieldLabel>
        <Select key={`${runtime.agentId}:${runtime.model}:serviceTier`} disabled={disabled || saving}
          items={[{ value: DEFAULT_OPTION, label: t('mapDesign.runtime.default') }, ...activeModel.serviceTierOptions.map((value) => ({ value, label: value }))]}
          value={runtime.serviceTier && activeModel.serviceTierOptions.includes(runtime.serviceTier) ? runtime.serviceTier : DEFAULT_OPTION}
          onValueChange={(value) => updateOption('serviceTier', value === DEFAULT_OPTION || value === null ? '' : value)}>
          <SelectTrigger id={`${fieldId}-serviceTier`} className="min-w-0 flex-1" aria-label={t('mapDesign.runtime.serviceTier')}><SelectValue /></SelectTrigger>
          <SelectContent alignItemWithTrigger={false}><SelectGroup>
            <SelectItem value={DEFAULT_OPTION}>{t('mapDesign.runtime.default')}</SelectItem>
            {activeModel.serviceTierOptions.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
          </SelectGroup></SelectContent>
        </Select>
      </Field> : null}
      {runtimeStatus}
    </DialogContent>
    {!open ? runtimeStatus : null}
  </div></DialogRoot>;
}
