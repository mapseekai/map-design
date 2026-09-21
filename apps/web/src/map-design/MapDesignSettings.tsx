import { profilesFromConfig } from './api-profiles-client';
import type { MapApiProfilesResponse } from '@mapseekai/contracts';
import { ApiProfileManager } from './components/ApiProfileManager';
import { apiProfilesCopy } from '../i18n/locales/api-profiles';
import { resolveMapApiExecutionSettings, type MapDesignApiExecutionSettings } from '@mapseekai/contracts';
import { ApiExecutionFields } from './components/ApiExecutionFields';
import { MapLoading } from '@mapseekai/components';
import { settingsCopy } from '../i18n/locales/settings';
import { navigationCopy } from '../i18n/locales/navigation';
import { apiModelCopy } from '../i18n/locales/api-model';
import { Alert, AlertDescription, Button, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem, Textarea, Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@mapseekai/components';
import type { ByokProtocol, LocalAgentInfo, MapDesignAppConfig } from '@mapseekai/contracts';
import { useEffect, useState } from 'react';
import { getLocalAgents, getMapDesignConfig } from '../api/client';
import { getMapDesignHost } from '../platform/map-design-host';
import { LOCALES, LOCALE_LABEL, useI18n, useT } from '../i18n';

const appearanceKey = 'map-design.appearance';
const protocols: readonly ByokProtocol[] = ['anthropic', 'openai', 'azure', 'google', 'ollama', 'aihubmix'];

interface Draft {
  apiExecution: Required<MapDesignApiExecutionSettings>;
  agentId: string;
  model: string;
  protocol: ByokProtocol;
  apiFormat: 'chat-completions' | 'responses';
  apiKey: string;
  baseUrl: string;
  byokModel: string;
  customInstructions: string;
}

function makeDraft(config: MapDesignAppConfig): Draft {
  const agentId = config.agentId ?? '';
  const provider = config.byokProviders?.default;
  return {
    agentId,
    apiExecution: resolveMapApiExecutionSettings(config.apiExecution),
    model: config.agentModels?.[agentId]?.model === 'default' ? '' : config.agentModels?.[agentId]?.model ?? '',
    protocol: provider?.protocol ?? 'anthropic', apiFormat: provider?.apiFormat ?? 'chat-completions', apiKey: '',
    baseUrl: provider?.baseUrl ?? '', byokModel: provider?.model ?? '',
    customInstructions: config.customInstructions ?? '',
  };
}

export function MapDesignSettings() {
  const t = useT();
  const [agents, setAgents] = useState<readonly LocalAgentInfo[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [error, setError] = useState<'loadError' | 'saveError' | null>(null);
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [profileData, setProfileData] = useState<MapApiProfilesResponse | undefined>(undefined);
  const [profileConfig, setProfileConfig] = useState<MapDesignAppConfig>({});
  const [saveConfirmed, setSaveConfirmed] = useState(false);
  const [apiProfileDirty, setApiProfileDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const { locale, setLocale } = useI18n();
  const labels = settingsCopy[locale];
  const [appearance, setAppearance] = useState(() => localStorage.getItem(appearanceKey) ?? 'light');

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([getLocalAgents(controller.signal), getMapDesignConfig(controller.signal)]).then(([agentResponse, configResponse]) => {
      if (controller.signal.aborted) return;
      const next = makeDraft(configResponse.config);
      setProfileConfig(configResponse.config); setProfileData(profilesFromConfig(configResponse.config));
      setAgents(agentResponse.agents);
      setDraft(next); setSaved(next); setApiKeyDirty(false);
    }).catch(() => { if (!controller.signal.aborted) setError('loadError'); });
    return () => controller.abort();
  }, []);

  const copy = apiModelCopy[locale];
  const selectedAgent = agents.find((agent) => agent.id === draft?.agentId);
  const agentOptionLabel = (agent: LocalAgentInfo) => {
    if (!agent.available || agent.mapDesign.reason === 'agent-unavailable') return agent.label;
    if (!agent.mapDesign.nativeMapTools) return `${agent.label} — ${t('mapDesign.agent.mapEditingUnavailable')}`;
    return agent.mapDesign.publicReasoningSummary
      ? `${agent.label} — ${t('mapDesign.agent.publicReasoningSummaryAvailable')}`
      : agent.label;
  };
  function update(change: Partial<Draft>): void { setSaveConfirmed(false); setDraft((current) => current ? { ...current, ...change } : current); }
  function setLocalPreference(key: string, value: string): void {
    localStorage.setItem(key, value);
    if (key === appearanceKey && (value === 'light' || value === 'dark' || value === 'system')) {
      getMapDesignHost()?.appearance.setTheme(value);
    }
  }
  async function save(): Promise<void> {
    if (!draft || !saved || saving || (draft.agentId === 'api' && apiProfileDirty)) return;
    const snapshot = draft;
    try { resolveMapApiExecutionSettings(snapshot.apiExecution); } catch { setError('saveError'); return; }
    const update: Record<string, unknown> = {};
    if (JSON.stringify(snapshot.apiExecution) !== JSON.stringify(saved.apiExecution)) update.apiExecution = snapshot.apiExecution;
    if (snapshot.agentId !== saved.agentId) update.agentId = snapshot.agentId || null;
    if (snapshot.model !== saved.model && snapshot.agentId) {
      const preferences = { ...profileConfig.agentModels };
      if (snapshot.model) preferences[snapshot.agentId] = { ...preferences[snapshot.agentId], model: snapshot.model };
      else delete preferences[snapshot.agentId];
      update.agentModels = preferences;
    }
    if (snapshot.customInstructions !== saved.customInstructions) update.customInstructions = snapshot.customInstructions || null;
    if (snapshot.agentId !== 'api' && (snapshot.apiFormat !== saved.apiFormat || snapshot.protocol !== saved.protocol || apiKeyDirty || snapshot.baseUrl !== saved.baseUrl || snapshot.byokModel !== saved.byokModel)) {
      update.byokProviders = {
        default: {
          protocol: snapshot.protocol,
          ...(snapshot.apiFormat !== saved.apiFormat ? { apiFormat: snapshot.apiFormat } : {}),
          ...(apiKeyDirty ? { apiKey: snapshot.apiKey } : {}),
          ...(snapshot.baseUrl !== saved.baseUrl ? { baseUrl: snapshot.baseUrl } : {}),
          ...(snapshot.byokModel !== saved.byokModel ? { model: snapshot.byokModel } : {}),
        },
      };
    }
    if (Object.keys(update).length === 0) { setSaveConfirmed(true); return; }
    setSaving(true); setSaveConfirmed(false);
    try {
      const response = await fetch('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) });
      if (!response.ok) throw new Error();
      const result = await response.json() as { config: MapDesignAppConfig };
      setProfileConfig(result.config); setProfileData(profilesFromConfig(result.config));
      const nextSaved = { ...snapshot, apiKey: '' };
      setDraft(nextSaved); setSaved(nextSaved); setApiKeyDirty(false); setError(null); setSaveConfirmed(true);
    } catch { setError('saveError'); } finally { setSaving(false); }
  }
  if (!draft) return <div>{error ? <p role="alert">{labels[error]}</p> : <MapLoading label={labels.loading} />}</div>;
  return <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10 [&_h1]:font-serif [&_h1]:text-4xl" aria-labelledby="map-design-settings-title" aria-busy={saving}>
    <header><h1 id="map-design-settings-title">{navigationCopy[locale].settings}</h1><p>{labels.description}</p></header>
    <FieldGroup>
      <Field><FieldLabel htmlFor="mapdesignsettings-1">{copy.runtime}</FieldLabel><Select items={[{ value: "__none__", label: labels.selectAgent }, ...agents.filter((agent) => agent.available).map((agent) => ({ value: agent.id, label: agentOptionLabel(agent) }))]} disabled={saving || apiProfileDirty} value={(draft.agentId) || '__none__'} onValueChange={(selectedValue) => update({ agentId: (selectedValue === '__none__' ? '' : selectedValue ?? ''), model: '' })}><SelectTrigger id="mapdesignsettings-1" aria-label={labels.agent}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem data-value="__none__" value="__none__">{labels.selectAgent}</SelectItem>{agents.filter((agent) => agent.available).map((agent) => <SelectItem key={agent.id} data-value={agent.id} value={agent.id}>{agentOptionLabel(agent)}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
      {draft.agentId !== 'api' ? <Field><FieldLabel htmlFor="mapdesignsettings-2">{labels.model}</FieldLabel><Select items={[{ value: "__none__", label: labels.defaultModel }, ...(selectedAgent?.models?.filter((model) => model.id !== "" && model.id !== "default").map((model) => ({ value: model.id, label: model.label })) ?? [])]} disabled={saving} value={(draft.model) || '__none__'} onValueChange={(selectedValue) => update({ model: (selectedValue === '__none__' ? '' : selectedValue ?? '') })}><SelectTrigger id="mapdesignsettings-2" aria-label={labels.model}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem data-value="__none__" value="__none__">{labels.defaultModel}</SelectItem>{selectedAgent?.models?.filter((model) => model.id !== '' && model.id !== 'default').map((model) => <SelectItem key={model.id} data-value={model.id} value={model.id}>{model.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field> : null}
      {draft.agentId === 'api' ? <ApiProfileManager initialConfig={profileConfig} {...(profileData ? { initialData: profileData } : {})} onChange={setProfileData} onDirtyChange={setApiProfileDirty} disabled={saving} /> : <FieldSet disabled={saving}><FieldLegend>{draft.agentId === 'api' ? copy.settings : labels.byok}</FieldLegend>
        {draft.agentId === 'api' ? <p>{copy.hint}</p> : null}
        <Field><FieldLabel htmlFor="mapdesignsettings-3">{labels.protocol}</FieldLabel><Select items={(draft.agentId === "api" ? ["openai", "anthropic"] : protocols).map((protocol) => ({ value: protocol, label: protocol }))} disabled={saving} value={draft.protocol} onValueChange={(nextValue) => nextValue && update({ protocol: nextValue as ByokProtocol })}><SelectTrigger id="mapdesignsettings-3" aria-label={labels.protocol}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{(draft.agentId === 'api' ? ['openai', 'anthropic'] : protocols).map((protocol) => <SelectItem key={protocol} data-value={protocol} value={protocol}>{protocol}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
        {draft.protocol === 'openai' ? <Field><FieldLabel htmlFor="mapdesignsettings-4">{copy.format}</FieldLabel><Select items={[{ value: "chat-completions", label: "Chat Completions" }, { value: "responses", label: "Responses" }]} disabled={saving} value={draft.apiFormat} onValueChange={(nextValue) => nextValue && update({ apiFormat: nextValue as Draft['apiFormat'] })}><SelectTrigger id="mapdesignsettings-4" aria-label={copy.format}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem data-value="chat-completions" value="chat-completions">Chat Completions</SelectItem><SelectItem data-value="responses" value="responses">Responses</SelectItem></SelectGroup></SelectContent></Select></Field> : null}
        <Field><FieldLabel htmlFor="mapdesignsettings-5">{labels.apiKey}</FieldLabel><Input id="mapdesignsettings-5" aria-label={labels.apiKey} type="password" autoComplete="off" value={draft.apiKey} onChange={(event) => { setApiKeyDirty(true); update({ apiKey: event.target.value }); }} /></Field>
        <Field><FieldLabel htmlFor="mapdesignsettings-6">{labels.baseUrl}</FieldLabel><Input id="mapdesignsettings-6" aria-label={labels.baseUrl} type="url" value={draft.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} /></Field>
        <Field><FieldLabel htmlFor="mapdesignsettings-7">{draft.agentId === 'api' ? copy.model : labels.byokModel}</FieldLabel><Input id="mapdesignsettings-7" aria-label={labels.byokModel} value={draft.byokModel} onChange={(event) => update({ byokModel: event.target.value })} /></Field>
      </FieldSet>}
      {draft.agentId === 'api' ? <ApiExecutionFields value={draft.apiExecution} onChange={(apiExecution) => update({ apiExecution })} disabled={saving} /> : null}
      <Field><FieldLabel htmlFor="mapdesignsettings-8">{labels.customInstructions}</FieldLabel><Textarea id="mapdesignsettings-8" aria-label={labels.customInstructions} disabled={saving} rows={4} value={draft.customInstructions} onChange={(event) => update({ customInstructions: event.target.value })} /></Field>
      <Field><FieldLabel htmlFor="mapdesignsettings-9">{labels.language}</FieldLabel><Select items={LOCALES.map((candidate) => ({ value: candidate, label: LOCALE_LABEL[candidate] }))} disabled={saving} value={locale} onValueChange={(nextValue) => nextValue && setLocale(nextValue as typeof locale)}><SelectTrigger id="mapdesignsettings-9" aria-label={labels.language}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{LOCALES.map((candidate) => <SelectItem key={candidate} data-value={candidate} value={candidate}>{LOCALE_LABEL[candidate]}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
      <Field><FieldLabel htmlFor="mapdesignsettings-10">{labels.appearance}</FieldLabel><Select items={[{ value: "light", label: labels.light }]} disabled={saving} value={appearance} onValueChange={(nextValue) => { if (nextValue === null) return; setAppearance(nextValue); setLocalPreference(appearanceKey, nextValue); }}><SelectTrigger id="mapdesignsettings-10" aria-label={labels.appearance}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem data-value="light" value="light">{labels.light}</SelectItem></SelectGroup></SelectContent></Select></Field>
    </FieldGroup>
    {error ? <Alert variant="destructive"><AlertDescription>{labels[error]}</AlertDescription></Alert> : null}
    {saveConfirmed && !apiProfileDirty ? <p role="status" aria-live="polite" className="text-sm">{apiProfilesCopy[locale].settingsSaved}</p> : null}
    {saving ? <p role="status" aria-live="polite" className="text-sm">{t('common.loading')}</p> : null}
    {draft.agentId === 'api' && apiProfileDirty ? <p className="text-sm text-muted-foreground">{apiProfilesCopy[locale].saveFirst}</p> : null}
    <Button type="button" disabled={saving || (draft.agentId === 'api' && apiProfileDirty)} onClick={() => { void save(); }}>{labels.save}</Button>
  </section>;
}
