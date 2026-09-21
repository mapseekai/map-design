import { apiProfilesCopy } from '../../i18n/locales/api-profiles';
import { getMapDesignHost, pickMapDesignWorkingDirectory } from '../../platform/map-design-host';
import { Alert, AlertDescription, Button, Input, Textarea, Field, FieldGroup, FieldLabel, Card, CardContent } from '@mapseekai/components';
import type { LocalAgentInfo } from '@mapseekai/contracts';
import type { MapDesignProjectCreateInput, MapDesignProjectCreateOutput } from '@mapseekai/map-design-contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useI18n } from '../../i18n';
import { sourceFormCopy } from '../../i18n/locales/source-form';
import { randomUUID } from '../../utils/uuid';
import { parseMapSourceUrl } from '../map/source-url';
import { MapSourcePreview } from './MapSourcePreview';
import { AgentModelFields } from './AgentModelFields';
import { CartographyPicker } from './CartographyPicker';

interface MapSourceFormProps {
  agents: LocalAgentInfo[];
  onCreate(input: MapDesignProjectCreateInput, signal: AbortSignal): Promise<MapDesignProjectCreateOutput>;
}

export function MapSourceForm({ agents, onCreate }: MapSourceFormProps) {
  const { t, locale } = useI18n();
  const copy = sourceFormCopy[locale];
  const [title, setTitle] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [designRequirement, setDesignRequirement] = useState('');
  const [cartographyId, setCartographyId] = useState(() => {
    const id = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('cartography') ?? '';
    return /^[a-f0-9]{64}$/.test(id) ? id : '';
  });
  const [agentId, setAgentId] = useState('');
  const [apiModel, setApiModel] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState<{ path: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createLoading, setCreateLoading] = useState(false);
  const createController = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      createController.current?.abort();
    };
  }, []);
  const selectedAgent = agents.find((agent) => agent.id === agentId && agent.available) ?? null;
  const apiModels = selectedAgent?.id === 'api' ? selectedAgent.models?.filter((model) => model.enabled) ?? [] : [];
  const selectedApiModel = apiModel ? apiModels.find((model) => model.id === apiModel) : apiModels.find((model) => model.default);
  const selectedAgentSupportsMapEditing = selectedAgent?.mapDesign.nativeMapTools === true;
  const parsedSourceUrl = parseMapSourceUrl(sourceUrl);
  const fieldsComplete = Boolean(title.trim() && title.trim().length <= 256
    && parsedSourceUrl && designRequirement.trim() && designRequirement.trim().length <= 16_384);
  const canCreate = fieldsComplete && selectedAgentSupportsMapEditing && !createLoading && (selectedAgent?.id !== 'api' || !!selectedApiModel);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createController.current) return;
    if (!selectedAgent) { setError(copy.agentRequired); return; }
    if (!selectedAgentSupportsMapEditing) { setError(t('mapDesign.agent.mapEditingUnavailable')); return; }
    if (selectedAgent.id === 'api' && !selectedApiModel) { setError(apiModels.length ? apiProfilesCopy[locale].selectModel : apiProfilesCopy[locale].empty); return; }
    if (!parsedSourceUrl) { setError(t('mapDesign.preview.invalidUrl')); return; }
    if (!fieldsComplete) { setError(copy.fieldsRequired); return; }
    const request = new AbortController();
    createController.current = request;
    const projectId = randomUUID();
    setCreateLoading(true);
    setError(null);
    try {
      await onCreate({ projectId, title: title.trim(), source: { url: parsedSourceUrl }, designRequirement: designRequirement.trim(), runtime: { agentId: selectedAgent.id, ...(selectedAgent.id === 'api' && selectedApiModel ? { model: selectedApiModel.id } : {}) }, ...(cartographyId ? { cartographyId } : {}), ...(workingDirectory ? { workingDirectory } : {}), idempotencyKey: `map-create:${projectId}` }, request.signal);
    } catch {
      if (!request.signal.aborted && mounted.current) setError(copy.createError);
    } finally {
      if (createController.current === request) {
        createController.current = null;
        if (mounted.current) setCreateLoading(false);
      }
    }
  }

  async function pickDirectory() {
    const result = await pickMapDesignWorkingDirectory();
    if (result?.kind === 'selected') {
      setWorkingDirectory(result.directory);
      setError(null);
      return;
    }
    if (result?.kind === 'failed') setError(copy.directoryError);
  }

  return (
    <form className="grid grid-cols-1 gap-6 min-[921px]:grid-cols-[minmax(0,1.1fr)_minmax(340px,.9fr)]" onSubmit={submit} noValidate aria-busy={createLoading}>
      <Card role="region" className="min-w-0" aria-label={t('mapDesign.form.sourceTitle')}>
        <CardContent><FieldGroup>
        <Field><FieldLabel htmlFor="mapsourceform-1"><span>{t('mapDesign.form.projectName')}</span></FieldLabel><Input id="mapsourceform-1" value={title} maxLength={256} onChange={(event) => { setTitle(event.target.value); setError(null); }} autoComplete="off" /></Field>
        <Field><FieldLabel htmlFor="mapsourceform-2"><span>{t('mapDesign.form.sourceUrl')}</span></FieldLabel><Input id="mapsourceform-2" type="url" value={sourceUrl} maxLength={4096} aria-invalid={Boolean(sourceUrl.trim() && !parsedSourceUrl)} data-testid="home-hero-input" onChange={(event) => { setSourceUrl(event.target.value); setError(null); }} autoComplete="url" /></Field>
        <Field><FieldLabel htmlFor="mapsourceform-3"><span>{t('mapDesign.form.designRequirement')}</span></FieldLabel><Textarea id="mapsourceform-3" value={designRequirement} maxLength={16_384} onChange={(event) => { setDesignRequirement(event.target.value); setError(null); }} rows={4} /></Field>
        <CartographyPicker value={cartographyId} onChange={setCartographyId} disabled={createLoading} />
        <AgentModelFields id="mapsourceform-4" agents={agents} agentId={agentId} model={apiModel} disabled={createLoading}
          onAgentChange={(value) => { setAgentId(value); setError(null); }}
          onModelChange={(value) => { setApiModel(value); setError(null); }} />
        {selectedAgent && !selectedAgentSupportsMapEditing ? <p className="text-sm text-muted-foreground" role="status">{t('mapDesign.agent.mapEditingUnavailable')}</p> : null}
        {getMapDesignHost() ? <Button type="button" variant="outline" onClick={() => { void pickDirectory(); }} disabled={createLoading}>{copy.chooseDirectory}</Button> : null}
        {workingDirectory ? <p className="text-sm text-muted-foreground" role="status">{copy.directorySelected}</p> : null}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="submit" variant="default" className="min-w-32" disabled={!canCreate}>{createLoading ? t('mapDesign.form.creating') : t('mapDesign.form.create')}</Button>
        </div>
        </FieldGroup></CardContent>
      </Card>
      <MapSourcePreview sourceUrl={sourceUrl} />
    </form>
  );
}
