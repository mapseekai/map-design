import { profilesFromConfig } from './api-profiles-client';
import { refreshLocalRuntimes } from './local-runtimes-client';
import type { LocalAgentInfo, MapApiProfilesResponse, MapDesignAppConfig, MapDesignApiExecutionSettings } from '@mapseekai/contracts';
import { resolveMapApiExecutionSettings } from '@mapseekai/contracts';
import { ApiProfileManager } from './components/ApiProfileManager';
import { LocalRuntimeManager } from './components/LocalRuntimeManager';
import { ApiExecutionFields } from './components/ApiExecutionFields';
import { apiProfilesCopy } from '../i18n/locales/api-profiles';
import { modelProvidersTabCopy, runtimeSettingsCopy } from '../i18n/locales/runtime-settings';
import { settingsCopy } from '../i18n/locales/settings';
import { navigationCopy } from '../i18n/locales/navigation';
import { Alert, AlertDescription, Button, MapLoading, Tabs, TabsList, TabsTrigger, TabsContent, Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem, Textarea, Field, FieldGroup, FieldLabel } from '@mapseekai/components';
import { useEffect, useRef, useState } from 'react';
import { getLocalAgents, getMapDesignConfig } from '../api/client';
import { getMapDesignHost } from '../platform/map-design-host';
import { LOCALES, LOCALE_LABEL, useI18n } from '../i18n';

const appearanceKey = 'map-design.appearance';
interface Draft { apiExecution: Required<MapDesignApiExecutionSettings>; customInstructions: string }
const makeDraft = (config: MapDesignAppConfig): Draft => ({ apiExecution: resolveMapApiExecutionSettings(config.apiExecution), customInstructions: config.customInstructions ?? '' });

export function MapDesignSettings() {
  const { t, locale, setLocale } = useI18n();
  const labels = settingsCopy[locale];
  const [agents, setAgents] = useState<readonly LocalAgentInfo[]>([]);
  const [profileConfig, setProfileConfig] = useState<MapDesignAppConfig>({});
  const [profileData, setProfileData] = useState<MapApiProfilesResponse | undefined>();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [error, setError] = useState<'loadError' | 'saveError' | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveConfirmed, setSaveConfirmed] = useState(false);
  const [tab, setTab] = useState('local');
  const [apiProfileDirty, setApiProfileDirty] = useState(false);
  const [appearance, setAppearance] = useState(() => localStorage.getItem(appearanceKey) ?? 'light');
  const saveController = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let catalogController: AbortController | null = null;
    let loaded = false;
    const syncCatalog = (discover = false) => {
      if (!loaded) return;
      catalogController?.abort();
      const request = new AbortController(); catalogController = request;
      const result = discover ? refreshLocalRuntimes(request.signal)
        : getLocalAgents(request.signal).then(response => response.agents);
      void result.then(next => {
        if (!request.signal.aborted) setAgents(next);
      }).catch(() => {
        // Keep the last usable catalog; the manual refresh action reports errors.
      });
    };
    const onFocus = () => syncCatalog();
    window.addEventListener('focus', onFocus);
    void Promise.all([getLocalAgents(controller.signal), getMapDesignConfig(controller.signal)]).then(([agentResponse, configResponse]) => {
      if (controller.signal.aborted) return;
      setAgents(agentResponse.agents); setProfileConfig(configResponse.config); setProfileData(profilesFromConfig(configResponse.config));
      const next = makeDraft(configResponse.config); setDraft(next); setSaved(next);
      loaded = true;
      // Startup discovery runs asynchronously. Resolve placeholder/cached catalogs
      // before leaving settings on a snapshot that may contain only "default".
      if (agentResponse.agents.some(agent => agent.available && agent.id !== 'api' && agent.modelCatalogSource !== 'live')) syncCatalog(true);
    }).catch(() => { if (!controller.signal.aborted) setError('loadError'); });
    return () => {
      controller.abort(); catalogController?.abort(); saveController.current?.abort();
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  function update(change: Partial<Draft>) { setSaveConfirmed(false); setDraft(current => current ? { ...current, ...change } : current); }
  function setLocalPreference(key: string, value: string) {
    localStorage.setItem(key, value);
    if (key === appearanceKey && (value === 'light' || value === 'dark' || value === 'system')) getMapDesignHost()?.appearance.setTheme(value);
  }
  async function save() {
    if (!draft || !saved || saveController.current || apiProfileDirty) return;
    const snapshot = draft;
    try { resolveMapApiExecutionSettings(snapshot.apiExecution); } catch { setError('saveError'); return; }
    const patch: Partial<MapDesignAppConfig> = {};
    if (JSON.stringify(snapshot.apiExecution) !== JSON.stringify(saved.apiExecution)) patch.apiExecution = snapshot.apiExecution;
    if (snapshot.customInstructions !== saved.customInstructions) patch.customInstructions = snapshot.customInstructions || null;
    if (!Object.keys(patch).length) { setSaveConfirmed(true); return; }
    const controller = new AbortController(); saveController.current = controller; setSaving(true); setSaveConfirmed(false);
    try {
      const response = await fetch('/api/config', { method: 'PUT', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      if (!response.ok) throw new Error();
      const result = await response.json() as { config: MapDesignAppConfig };
      if (!controller.signal.aborted) { setProfileConfig(result.config); setProfileData(profilesFromConfig(result.config)); setSaved(snapshot); setError(null); setSaveConfirmed(true); }
    } catch { if (!controller.signal.aborted) setError('saveError'); }
    finally { if (saveController.current === controller) { saveController.current = null; if (!controller.signal.aborted) setSaving(false); } }
  }
  if (!draft) return <div>{error ? <p role="alert">{labels[error]}</p> : <MapLoading label={labels.loading} />}</div>;
  return <section className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10 [&_h1]:font-serif [&_h1]:text-4xl" aria-labelledby="map-design-settings-title" aria-busy={saving}>
    <header><h1 id="map-design-settings-title">{navigationCopy[locale].settings}</h1></header>
    <Tabs value={tab} onValueChange={value => { if (value && !apiProfileDirty) setTab(value); }}>
      <TabsList aria-label={navigationCopy[locale].settings}>
        <TabsTrigger value="local" disabled={apiProfileDirty}>{runtimeSettingsCopy[locale].title}</TabsTrigger>
        <TabsTrigger value="api">{modelProvidersTabCopy[locale]}</TabsTrigger>
      </TabsList>
      <TabsContent value="local" keepMounted>
        <LocalRuntimeManager agents={agents} config={profileConfig} onAgentsChange={setAgents} onConfigChange={setProfileConfig} disabled={saving} />
      </TabsContent>
      <TabsContent value="api"><div className="grid gap-4">
        <ApiProfileManager initialConfig={profileConfig} {...(profileData ? { initialData: profileData } : {})} onChange={setProfileData} onDirtyChange={setApiProfileDirty} disabled={saving} />
        <ApiExecutionFields value={draft.apiExecution} onChange={apiExecution => update({ apiExecution })} disabled={saving} />
      </div></TabsContent>
    </Tabs>
    <FieldGroup>
      <Field><FieldLabel htmlFor="mapdesignsettings-8">{labels.customInstructions}</FieldLabel><Textarea id="mapdesignsettings-8" aria-label={labels.customInstructions} disabled={saving} rows={4} value={draft.customInstructions} onChange={(event) => update({ customInstructions: event.target.value })} /></Field>
      <Field><FieldLabel htmlFor="mapdesignsettings-9">{labels.language}</FieldLabel><Select items={LOCALES.map((candidate) => ({ value: candidate, label: LOCALE_LABEL[candidate] }))} disabled={saving} value={locale} onValueChange={(nextValue) => nextValue && setLocale(nextValue as typeof locale)}><SelectTrigger id="mapdesignsettings-9" aria-label={labels.language}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{LOCALES.map((candidate) => <SelectItem key={candidate} data-value={candidate} value={candidate}>{LOCALE_LABEL[candidate]}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
      <Field><FieldLabel htmlFor="mapdesignsettings-10">{labels.appearance}</FieldLabel><Select items={[{ value: "light", label: labels.light }]} disabled={saving} value={appearance} onValueChange={(nextValue) => { if (nextValue === null) return; setAppearance(nextValue); setLocalPreference(appearanceKey, nextValue); }}><SelectTrigger id="mapdesignsettings-10" aria-label={labels.appearance}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem data-value="light" value="light">{labels.light}</SelectItem></SelectGroup></SelectContent></Select></Field>
    </FieldGroup>
    {error ? <Alert variant="destructive"><AlertDescription>{labels[error]}</AlertDescription></Alert> : null}
    {saveConfirmed && !apiProfileDirty ? <p role="status" aria-live="polite" className="text-sm">{apiProfilesCopy[locale].settingsSaved}</p> : null}
    {saving ? <p role="status" aria-live="polite" className="text-sm">{t('common.loading')}</p> : null}
    {apiProfileDirty ? <p className="text-sm text-muted-foreground">{apiProfilesCopy[locale].saveFirst}</p> : null}
    <Button type="button" disabled={saving || apiProfileDirty} onClick={() => { void save(); }}>{labels.save}</Button>
  </section>;
}
