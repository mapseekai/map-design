import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, FieldLabel, Input, Switch } from '@mapseekai/components';
import type { LocalAgentInfo, MapApiConnectionTest, MapDesignAppConfig } from '@mapseekai/contracts';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { runtimeSettingsCopy } from '../../i18n/locales/runtime-settings';
import { apiProfilesCopy } from '../../i18n/locales/api-profiles';
import { apiProfileFailureText } from '../../i18n/locales/api-profile-errors';
import { refreshLocalRuntimes, saveRuntimePreference, testLocalModel } from '../local-runtimes-client';

export function LocalRuntimeManager({ agents, config, onAgentsChange, onConfigChange, disabled = false }: {
  agents: readonly LocalAgentInfo[]; config: MapDesignAppConfig; disabled?: boolean;
  onAgentsChange(agents: readonly LocalAgentInfo[]): void; onConfigChange(config: MapDesignAppConfig): void;
}) {
  const { t, locale } = useI18n();
  const copy = runtimeSettingsCopy[locale];
  const api = apiProfilesCopy[locale];
  const installed = agents.filter(agent => agent.id !== 'api' && agent.available);
  const [selected, setSelected] = useState<string | null>(null);
  const active = installed.find(agent => agent.id === selected) ?? installed[0];
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [checks, setChecks] = useState<Record<string, MapApiConnectionTest>>({});
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const locked = disabled || busy !== null;
  const preference = (id: string) => config.runtimePreferences?.[id] ?? {};
  async function perform(key: string, action: (signal: AbortSignal) => Promise<void>) {
    if (disabled || controller.current) return;
    const request = new AbortController(); controller.current = request;
    setBusy(key); setError(null); setSaved(false);
    try { await action(request.signal); }
    catch (reason) { if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : 'RUNTIME_TEST_FAILED'); }
    finally { if (controller.current === request) { controller.current = null; if (!request.signal.aborted) setBusy(null); } }
  }
  function save(id: string, next: NonNullable<MapDesignAppConfig['runtimePreferences']>[string]) {
    void perform(`save:${id}`, async signal => {
      const result = await saveRuntimePreference(id, next, signal);
      if (!signal.aborted) { onConfigChange(result); setSaved(true); }
    });
  }
  const models = (active?.models ?? []).filter(model => `${model.id} ${model.label}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <section className="grid min-w-0 gap-4" aria-label={copy.title}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="grid gap-1">
      <h2 className="text-lg font-semibold">{copy.title}</h2>
      <p className="max-w-xl text-sm text-muted-foreground">{copy.hint}</p></div>
      <Button type="button" variant="outline" disabled={locked} onClick={() => { void perform('refresh', async signal => {
        const result = await refreshLocalRuntimes(signal); if (!signal.aborted) { onAgentsChange(result); setChecks({}); }
      }); }}>{busy === 'refresh' ? t('common.loading') : copy.refresh}</Button>
    </div>
    {!installed.length ? <p>{copy.empty}</p> : <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(160px,0.7fr)_minmax(0,1.3fr)]">
      <div className="grid min-w-0 content-start gap-2">
        {installed.map(agent => <Button key={agent.id} type="button" variant={active?.id === agent.id ? 'secondary' : 'outline'} size="content" className="w-full min-w-0 justify-start"
              aria-pressed={active?.id === agent.id} onClick={() => { setSelected(agent.id); setSearch(''); }}>
              <span className="grid min-w-0 text-left"><span className="truncate">{agent.label}</span><span className="truncate text-xs text-muted-foreground">{agent.version}</span></span>
            </Button>)}
      </div>
      {active ? <Card className="min-w-0">
        <CardHeader className="min-w-0"><div className="flex min-w-0 items-center justify-between gap-3">
          <CardTitle className="min-w-0"><span className="[overflow-wrap:anywhere]">{active.label} · {t('mapDesign.runtime.models')}</span></CardTitle>
          <Switch aria-label={`${copy.enabled}: ${active.label}`} checked={preference(active.id).enabled !== false} disabled={locked}
            onCheckedChange={enabled => save(active.id, { ...preference(active.id), enabled })} />
          </div>
          <div className="flex flex-wrap gap-2"><Badge variant="secondary">{preference(active.id).enabled === false ? copy.disabled : copy.enabled}</Badge>
            <Badge variant="outline">{t(active.modelCatalogSource === 'live' ? 'mapDesign.runtime.liveCatalog'
              : active.modelCatalogSource === 'remembered' ? 'mapDesign.runtime.rememberedCatalog' : 'mapDesign.runtime.fallbackCatalog')}</Badge></div></CardHeader>
        <CardContent className="min-w-0"><div className="grid min-w-0 gap-3">
          {!active.mapDesign.nativeMapTools ? <p className="text-sm text-muted-foreground">{t('mapDesign.runtime.nativeToolsUnavailable')}</p> : null}
          <Field><FieldLabel htmlFor="runtime-model-search">{t('mapDesign.runtime.searchModels')}</FieldLabel>
            <Input id="runtime-model-search" type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field>
          <p className="text-xs text-muted-foreground">{api.cost}</p>
          <div className="grid max-h-[32rem] min-w-0 grid-cols-[minmax(0,1fr)] gap-3 overflow-x-hidden overflow-y-auto">
            {models.map(model => {
              const enabled = !preference(active.id).disabledModels?.includes(model.id);
              const key = JSON.stringify([active.id, model.id]);
              const check = checks[key];
              return <div key={model.id} className="grid min-w-0 gap-2 border-b border-border pb-3">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0 flex-1"><p className="text-sm font-medium [overflow-wrap:anywhere]">{model.label}</p>
                    {model.id !== model.label ? <p className="break-all text-xs text-muted-foreground">{model.id}</p> : null}</div>
                  <Switch aria-label={`${copy.enabled}: ${model.id}`} checked={enabled} disabled={locked}
                    onCheckedChange={checked => save(active.id, { ...preference(active.id), disabledModels: checked
                      ? (preference(active.id).disabledModels ?? []).filter(id => id !== model.id)
                      : [...new Set([...(preference(active.id).disabledModels ?? []), model.id])] })} />
                </div>
                {model.id === 'default' ? <p className="text-xs text-muted-foreground">{copy.defaultHint}</p> : null}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground" role="status">{check ? `${check.status === 'passed' ? api.passed : api.failed} · ${check.latencyMs} ms` : api.untested}</span>
                  <Button type="button" size="sm" variant="outline" disabled={locked || !active.mapDesign.nativeMapTools}
                    aria-label={`${api.test}: ${model.id}`} onClick={() => { void perform(key, async signal => {
                      const result = await testLocalModel(active.id, model.id, signal);
                      if (!signal.aborted) setChecks(current => ({ ...current, [key]: result }));
                    }); }}>{busy === key ? api.testing : api.test}</Button>
                </div>
                {check?.status === 'failed' ? <p className="text-xs text-destructive">{apiProfileFailureText(locale, check.code ?? 'API_REQUEST_FAILED')}</p> : null}
              </div>;
            })}
            {!models.length ? <p className="text-sm text-muted-foreground">{t('mapDesign.runtime.catalogUnavailable')}</p> : null}
          </div>
        </div></CardContent>
      </Card> : null}
    </div>}
    {error ? <Alert variant="destructive"><AlertDescription>{api.error}</AlertDescription></Alert> : null}
    {saved ? <p role="status" className="text-sm">{api.settingsSaved}</p> : null}
  </section>;
}
