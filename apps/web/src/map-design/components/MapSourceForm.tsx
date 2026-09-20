import { getMapDesignHost, pickMapDesignWorkingDirectory } from '../../platform/map-design-host';
import { Alert, AlertDescription, Button, Input, Textarea, Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem, Field, FieldGroup, FieldLabel, Card, CardContent } from '@mapseekai/components';
import type { LocalAgentInfo } from '@mapseekai/contracts';
import type { MapDesignProjectCreateInput, MapDesignProjectCreateOutput, MapSourcePreflightOutput } from '@mapseekai/map-design-contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useI18n } from '../../i18n';
import { sourceFormCopy } from '../../i18n/locales/source-form';
import { randomUUID } from '../../utils/uuid';
import { deleteMapSourcePreview, preflightMapSource } from '../client';
import { MapSourcePreflight } from './MapSourcePreflight';
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
  const [workingDirectory, setWorkingDirectory] = useState<{ path: string; token: string } | null>(null);
  const [preflight, setPreflight] = useState<MapSourcePreflightOutput | null>(null);
  const [preflightSource, setPreflightSource] = useState('');
  const [previewReadyId, setPreviewReadyId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const preflightController = useRef<AbortController | null>(null);
  const createController = useRef<AbortController | null>(null);
  const previewRef = useRef<MapSourcePreflightOutput['preview'] | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      preflightController.current?.abort();
      createController.current?.abort();
      const previewId = previewRef.current?.previewId;
      previewRef.current = null;
      if (previewId) void deleteMapSourcePreview(previewId).catch(() => undefined);
    };
  }, []);
  const selectedAgent = agents.find((agent) => agent.id === agentId && agent.available) ?? null;
  const selectedAgentSupportsMapEditing = selectedAgent?.mapDesign.nativeMapTools === true;
  const previewReady = Boolean(
    preflight
    && previewReadyId === preflight.preview.previewId
    && preflightSource === sourceUrl.trim()
    && !previewError,
  );
  const agentOptionLabel = (agent: LocalAgentInfo) => {
    if (!agent.available || agent.mapDesign.reason === 'agent-unavailable') return agent.label;
    if (!agent.mapDesign.nativeMapTools) return `${agent.label} — ${t('mapDesign.agent.mapEditingUnavailable')}`;
    return agent.mapDesign.publicReasoningSummary
      ? `${agent.label} — ${t('mapDesign.agent.publicReasoningSummaryAvailable')}`
      : agent.label;
  };
  const releasePreview = (previewId: string) => {
    void deleteMapSourcePreview(previewId).catch(() => undefined);
  };
  const invalidatePreflight = () => {
    preflightController.current?.abort();
    preflightController.current = null;
    setPreflightLoading(false);
    const previewId = previewRef.current?.previewId;
    previewRef.current = null;
    if (previewId) releasePreview(previewId);
    setPreflight(null);
    setPreflightSource('');
    setPreviewReadyId(null);
    setPreviewError(null);
  };

  async function checkSource() {
    if (!title.trim() || !sourceUrl.trim() || !designRequirement.trim() || !selectedAgentSupportsMapEditing) {
      setError(!selectedAgent ? copy.agentRequired : !selectedAgentSupportsMapEditing ? t('mapDesign.agent.mapEditingUnavailable') : copy.fieldsRequired);
      return;
    }
    preflightController.current?.abort();
    const previousPreviewId = previewRef.current?.previewId;
    previewRef.current = null;
    if (previousPreviewId) releasePreview(previousPreviewId);
    setPreflight(null);
    setPreflightSource('');
    setPreviewReadyId(null);
    setPreviewError(null);
    const requestedSource = sourceUrl.trim();
    const request = new AbortController();
    preflightController.current = request;
    setPreflightLoading(true);
    setError(null);
    try {
      const result = await preflightMapSource(requestedSource, request.signal);
      if (!request.signal.aborted && mounted.current) {
        previewRef.current = result.preview;
        setPreflight(result);
        setPreflightSource(requestedSource);
      }
    } catch {
      if (!request.signal.aborted && mounted.current) setError(copy.sourceError);
    } finally {
      if (preflightController.current === request && mounted.current) setPreflightLoading(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createLoading) return;
    if (!selectedAgent) { setError(copy.agentRequired); return; }
    if (!selectedAgentSupportsMapEditing) { setError(t('mapDesign.agent.mapEditingUnavailable')); return; }
    if (!previewReady) { setError(copy.checkRequired); return; }
    createController.current?.abort();
    const request = new AbortController();
    createController.current = request;
    const projectId = randomUUID();
    setCreateLoading(true);
    setError(null);
    try {
      await onCreate({ projectId, title: title.trim(), source: { url: sourceUrl.trim() }, designRequirement: designRequirement.trim(), runtime: { agentId: selectedAgent.id }, ...(cartographyId ? { cartographyId } : {}), ...(workingDirectory ? { workingDirectory } : {}), idempotencyKey: `map-create:${projectId}` }, request.signal);
    } catch {
      if (!request.signal.aborted && mounted.current) setError(copy.createError);
    } finally {
      if (createController.current === request && mounted.current) setCreateLoading(false);
    }
  }

  function handlePreviewReady(previewId: string) {
    if (previewRef.current?.previewId !== previewId) return;
    setPreviewReadyId(previewId);
    setPreviewError(null);
  }

  function handlePreviewError(previewId: string) {
    if (previewRef.current?.previewId !== previewId) return;
    setPreviewReadyId(null);
    setPreviewError(t('mapDesign.studio.loadError'));
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
    <form className="grid grid-cols-1 gap-6 min-[921px]:grid-cols-[minmax(0,1.1fr)_minmax(340px,.9fr)]" onSubmit={submit} noValidate aria-busy={preflightLoading || createLoading || Boolean(preflight && !previewReady && !previewError)}>
      <Card role="region" className="min-w-0" aria-label={t('mapDesign.form.sourceTitle')}>
        <CardContent><FieldGroup>
        <Field><FieldLabel htmlFor="mapsourceform-1"><span>{t('mapDesign.form.projectName')}</span></FieldLabel><Input id="mapsourceform-1" value={title} onChange={(event) => setTitle(event.target.value)} autoComplete="off" /></Field>
        <Field><FieldLabel htmlFor="mapsourceform-2"><span>{t('mapDesign.form.sourceUrl')}</span></FieldLabel><Input id="mapsourceform-2" type="url" value={sourceUrl} data-testid="home-hero-input" onChange={(event) => { setSourceUrl(event.target.value); invalidatePreflight(); }} autoComplete="url" /></Field>
        <Field><FieldLabel htmlFor="mapsourceform-3"><span>{t('mapDesign.form.designRequirement')}</span></FieldLabel><Textarea id="mapsourceform-3" value={designRequirement} onChange={(event) => setDesignRequirement(event.target.value)} rows={4} /></Field>
        <CartographyPicker value={cartographyId} onChange={setCartographyId} disabled={createLoading} />
        <Field><FieldLabel htmlFor="mapsourceform-4"><span>{copy.agent}</span></FieldLabel><Select items={[{ value: "__none__", label: copy.selectAgent }, ...agents.map((agent) => ({ value: agent.id, label: agentOptionLabel(agent) }))]} value={(agentId) || '__none__'} onValueChange={(selectedValue) => { setAgentId((selectedValue === '__none__' ? '' : selectedValue ?? '')); setError(null); }}><SelectTrigger id="mapsourceform-4"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem data-value="__none__" value="__none__">{copy.selectAgent}</SelectItem>{agents.map((agent) => <SelectItem key={agent.id} data-value={agent.id} value={agent.id} disabled={!agent.available}>{agentOptionLabel(agent)}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
        {selectedAgent && !selectedAgentSupportsMapEditing ? <p className="text-sm text-muted-foreground" role="status">{t('mapDesign.agent.mapEditingUnavailable')}</p> : null}
        {getMapDesignHost() ? <Button type="button" variant="outline" onClick={() => { void pickDirectory(); }} disabled={preflightLoading || createLoading}>{copy.chooseDirectory}</Button> : null}
        {workingDirectory ? <p className="text-sm text-muted-foreground" role="status">{copy.directorySelected}</p> : null}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="outline" className="min-w-32" onClick={() => { void checkSource(); }} disabled={preflightLoading || createLoading}>{preflightLoading ? t('mapDesign.form.checkingSource') : t('mapDesign.form.checkSource')}</Button>
          <Button type="submit" variant="default" className="min-w-32" disabled={preflightLoading || createLoading || !selectedAgentSupportsMapEditing || !previewReady}>{createLoading ? t('mapDesign.form.creating') : t('mapDesign.form.create')}</Button>
        </div>
        </FieldGroup></CardContent>
      </Card>
      <MapSourcePreflight
        result={preflight}
        loading={preflightLoading}
        ready={previewReady}
        error={previewError}
        onPreviewReady={handlePreviewReady}
        onPreviewError={handlePreviewError}
      />
    </form>
  );
}
