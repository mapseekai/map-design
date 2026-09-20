import {
  Alert, AlertDescription, Badge, Button, ColorInput, PopoverHeader, PopoverTitle,
  Field, FieldGroup, FieldLabel, Input, Select, SelectContent, SelectGroup, SelectItem,
  SelectTrigger, SelectValue, Switch, ToggleGroup, ToggleGroupItem,
} from '@mapseekai/components';
import {
  buildMapStyleEditPatch,
  getMapStyleControls,
  canScopeMapStyleControl,
  isMapStyleEditValue,
  mapStyleControlFallback,
  type MapStyleEditChangeValue,
  type MapStyleEditLayer,
  MapStyleEditChangesSchema,
  type MapStyleEditInput,
  type MapStyleEditScope,
} from '@mapseekai/map-design-contracts';
import { ArrowLeft, ChevronRight, X } from 'lucide-react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { useI18n } from '../../i18n';
import { styleControlLabel, styleEditCopy } from '../../i18n/locales/style-edit';
import {
  buildCommentTarget, deduplicateFeatureCandidates, featureScopeAvailable, generatedSourceIds,
  normalizeAnchor, queryBox, type FeatureCandidate, type PickedFeature,
} from '../comments/feature-picking';
import { MapCommentPopover } from '../comments/MapCommentPopover';
import { useFeatureHighlight } from '../comments/feature-highlight';
import { saveMapStyleEdit } from './client';
import { createStylePreviewSession, type StylePreviewSession } from './preview';

export interface MapDesignStyleEditorProps {
  projectId: string;
  map: MapLibreMap | null;
  draftRevision: number;
  styleHash: string;
  active: boolean;
  disabled: boolean;
  onSaved(): void | Promise<void>;
}

type Control = ReturnType<typeof getMapStyleControls>[number];

export function MapDesignStyleEditor({
  projectId, map, draftRevision, styleHash, active, disabled, onSaved,
}: MapDesignStyleEditorProps) {
  const { locale } = useI18n();
  const copy = styleEditCopy[locale];
  const propertyId = useId();
  const returnFocus = useRef<HTMLButtonElement>(null);
  const [pickedCandidates, setPickedCandidates] = useState<FeatureCandidate[]>([]);
  const [candidates, setCandidates] = useState<FeatureCandidate[]>([]);
  const [candidate, setCandidate] = useState<FeatureCandidate | null>(null);
  const [hovered, setHovered] = useState<FeatureCandidate | null>(null);
  const [anchor, setAnchor] = useState<[number, number] | null>(null);
  const [pendingSnapshot, setPendingSnapshot] = useState<{ draftRevision: number; styleHash: string } | null>(null);
  const [snapshot, setSnapshot] = useState<{ draftRevision: number; styleHash: string } | null>(null);
  const [scope, setScope] = useState<MapStyleEditScope>('feature');
  const [matchProperty, setMatchProperty] = useState('');
  const [values, setValues] = useState<Record<string, MapStyleEditChangeValue>>({});
  const [changes, setChanges] = useState<Record<string, MapStyleEditChangeValue>>({});
  const [emptyHit, setEmptyHit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  useFeatureHighlight(map, active && !Object.keys(changes).length ? (hovered ?? candidate)?.feature ?? null : null);
  const preview = useRef<StylePreviewSession | null>(null);
  const saveController = useRef<AbortController | null>(null);
  const idempotencyKey = useRef(globalThis.crypto.randomUUID());
  const savingRef = useRef(false);
  const generation = useRef(0);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const layer = useMemo(() => {
    if (!candidate || !map) return null;
    return map.getStyle()?.layers?.find((item) => item.id === candidate.feature.layer.id) ?? null;
  }, [candidate, map]);
  const controls = useMemo(() => {
    if (!layer) return [];
    return getMapStyleControls(layer.type).filter(control => {
      if (layer.type !== 'symbol') return true;
      if (control.property.startsWith('text-')) return Boolean(layer.layout?.['text-field']);
      if (control.property.startsWith('icon-')) return Boolean(layer.layout?.['icon-image']);
      return true;
    });
  }, [layer]);
  const target = useMemo(() => candidate && anchor ? buildCommentTarget(candidate.feature, anchor) : null, [anchor, candidate]);
  const featureAvailable = candidate ? featureScopeAvailable(candidate.feature, generatedSourceIds(map?.getStyle()), map?.getStyle()) : false;
  const invalidScope = scope === 'feature' && !featureAvailable;
  const stale = Boolean(snapshot && (snapshot.draftRevision !== draftRevision || snapshot.styleHash !== styleHash));

  const patch = useMemo(() => {
    if (!layer || !target || invalidScope || !validChanges(changes)) return null;
    try {
      return buildMapStyleEditPatch(layer as unknown as Parameters<typeof buildMapStyleEditPatch>[0],
        makeInput(draftRevision, styleHash, idempotencyKey.current, target, scope, matchProperty, changes));
    } catch { return null; }
  }, [changes, draftRevision, invalidScope, layer, matchProperty, scope, styleHash, target]);
  const previewError = Boolean(layer && target && !invalidScope && validChanges(changes) && !patch);

  const clearSelection = useCallback((restore: boolean) => {
    if (restore) preview.current?.restore(); else preview.current?.discard();
    preview.current = null;
    setCandidate(null); setHovered(null); setCandidates([]); setPickedCandidates([]); setAnchor(null); setSnapshot(null);
    setPendingSnapshot(null); setValues({}); setChanges({}); setMatchProperty(''); setScope('feature'); setEmptyHit(false); setSaveError(false);
  }, []);

  const cancel = useCallback(() => {
    if (savingRef.current) return;
    clearSelection(true);
  }, [clearSelection]);

  const chooseCandidate = useCallback((next: FeatureCandidate, nextAnchor: [number, number]) => {
    preview.current?.restore(); preview.current = null;
    const nextTarget = buildCommentTarget(next.feature, normalizeAnchor(nextAnchor));
    setCandidate(next); setHovered(null); setCandidates([]); setAnchor(normalizeAnchor(nextAnchor)); setEmptyHit(false); setSaveError(false);
    idempotencyKey.current = globalThis.crypto.randomUUID();
    setSnapshot(pendingSnapshot ?? { draftRevision, styleHash }); setPendingSnapshot(null);
    setMatchProperty(Object.keys(nextTarget.properties)[0] ?? '');
    setScope('feature'); setValues({}); setChanges({});
  }, [draftRevision, pendingSnapshot, styleHash]);

  useEffect(() => {
    if (!active || disabled || !map) return;
    const canvas = map.getCanvas();
    const pick = (event: { point: { x: number; y: number }; lngLat: { lng: number; lat: number } }) => {
      const hits = deduplicateFeatureCandidates(map.queryRenderedFeatures(queryBox(event.point)) as PickedFeature[])
        .filter((item) => getMapStyleControls((map.getLayer(item.feature.layer.id) as { type?: string } | undefined)?.type ?? '').length > 0);
      preview.current?.restore(); preview.current = null;
      setCandidate(null); setValues({}); setChanges({}); setPickedCandidates(hits);
      setEmptyHit(hits.length === 0); setCandidates(hits.length > 1 ? hits : []);
      if (hits.length === 1) chooseCandidate(hits[0]!, [event.lngLat.lng, event.lngLat.lat]);
      else if (hits.length > 1) { setPendingSnapshot({ draftRevision, styleHash }); setAnchor(normalizeAnchor([event.lngLat.lng, event.lngLat.lat])); }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); cancel(); return; }
      if (event.key !== 'Enter') return;
      const rect = canvas.getBoundingClientRect();
      const point = { x: rect.width / 2, y: rect.height / 2 };
      pick({ point, lngLat: map.unproject([point.x, point.y]) }); event.preventDefault();
    };
    const previousCursor = canvas.style.cursor;
    const theme = getComputedStyle(canvas);
    const cursor = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="21" viewBox="0 0 24 28"><path d="M3 2L22 14L13 16L9 25Z" fill="${theme.getPropertyValue('--foreground').trim()}" stroke="${theme.getPropertyValue('--card').trim()}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
    canvas.style.cursor = `url("data:image/svg+xml,${encodeURIComponent(cursor)}") 2 2, default`;
    map.on('click', pick); canvas.addEventListener('keydown', keydown);
    return () => { map.off('click', pick); canvas.removeEventListener('keydown', keydown); canvas.style.cursor = previousCursor; };
  }, [active, cancel, chooseCandidate, disabled, draftRevision, map, styleHash]);

  useEffect(() => {
    if (!stale) return;
    clearSelection(false);
  }, [clearSelection, stale]);

  useEffect(() => {
    if (!active || disabled) {
      const uncertainSave = savingRef.current;
      generation.current += 1;
      saveController.current?.abort(); saveController.current = null;
      savingRef.current = false; setSaving(false);
      clearSelection(!uncertainSave);
      if (uncertainSave) void Promise.resolve(onSavedRef.current()).catch(() => undefined);
    }
  }, [active, clearSelection, disabled]);

  useEffect(() => {
    if (!map || !candidate || !layer || !controls.length) return;
    preview.current?.restore();
    preview.current = createStylePreviewSession(map, layer.id, controls.map((control) => ({
      property: control.property,
      section: control.section,
      transition: control.transition,
    })), candidate.feature.id === undefined ? undefined : {
      source: candidate.feature.source, sourceLayer: candidate.feature.sourceLayer, id: candidate.feature.id,
    });
    const initial = Object.fromEntries(controls.map((control) => [control.property, initialValue(map, layer as unknown as MapStyleEditLayer, control)]));
    setValues(initial); setChanges({});
    return () => { preview.current?.restore(); preview.current = null; };
  }, [candidate, controls, layer, map]);

  useEffect(() => {
    if (preview.current && (patch || !Object.keys(changes).length)) preview.current.apply(patch ?? { paint: {}, layout: {} });
  }, [patch, changes]);

  useEffect(() => () => { generation.current += 1; saveController.current?.abort(); preview.current?.restore(); }, []);

  const save = async () => {
    if (!target || !layer || savingRef.current || disabled || stale || invalidScope || !patch) return;
    const controller = new AbortController(); saveController.current = controller;
    const currentGeneration = generation.current;
    savingRef.current = true; setSaving(true); setSaveError(false);
    try {
      await saveMapStyleEdit(projectId, makeInput(draftRevision, styleHash, idempotencyKey.current, target, scope, matchProperty, changes), controller.signal);
      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      preview.current?.discard(); preview.current = null;
      await onSavedRef.current();
      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      clearSelection(false);
    } catch { if (!controller.signal.aborted && currentGeneration === generation.current) setSaveError(true); }
    finally { if (saveController.current === controller) { saveController.current = null; savingRef.current = false; if (currentGeneration === generation.current) setSaving(false); } }
  };

  if (!active || (!target && !candidates.length)) return null;
  return <MapCommentPopover map={map} anchor={anchor} open={active} onClose={cancel} finalFocus={returnFocus} label={copy.title}>
      <PopoverHeader>
        <div className="flex items-center justify-between gap-2">
          <PopoverTitle>{copy.title}</PopoverTitle>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={copy.close} disabled={saving} onClick={cancel}><X /></Button>
        </div>
      </PopoverHeader>
      <div className="flex max-h-[calc(var(--available-height)-5rem)] min-h-0 flex-col gap-4 overflow-hidden p-1">
        {emptyHit ? <Alert><AlertDescription>{copy.emptyHit}</AlertDescription></Alert> : null}
        {candidates.length ? <section className="flex min-h-0 flex-col gap-2 overflow-y-auto" aria-label={copy.chooseTarget}>
          <h3 className="text-sm font-medium">{copy.chooseTarget}</h3>
          {candidates.map((item) => <Button key={item.key} type="button" variant="outline" size="content" className="justify-between text-start"
            aria-label={`${item.label} ${item.keyAttributes.map(([key, value]) => `${key} ${String(value)}`).join(' ')}`}
            onPointerEnter={() => setHovered(item)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(item)} onBlur={() => setHovered(null)}
            onClick={() => chooseCandidate(item, anchor!)}><span className="min-w-0"><span className="block truncate">{item.label}</span><span className="block truncate text-xs text-muted-foreground">{item.keyAttributes.map(([key, value]) => `${key}: ${String(value)}`).join(' · ')}</span></span><ChevronRight /></Button>)}
        </section> : null}
        {target && layer ? <form className="flex min-h-0 flex-col" onSubmit={(event) => { event.preventDefault(); void save(); }}>

          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pb-4">
          <Badge variant="outline" className="w-fit max-w-full"><span className="truncate">{copy.selectedTarget}: {candidate?.label ?? target.layerId}{target.featureId !== undefined ? ` · #${String(target.featureId)}` : ''}</span></Badge>
          {!featureAvailable ? <p className="text-xs text-muted-foreground">{copy.featureUnavailable}</p> : null}
          {saveError || previewError ? <Alert variant="destructive"><AlertDescription>{copy.saveError}</AlertDescription></Alert> : null}
          <FieldGroup>
            <Field><FieldLabel>{copy.scope}</FieldLabel><ToggleGroup value={[scope]} onValueChange={(selected) => {
              const next = selected[0] as MapStyleEditScope | undefined;
              if (!next) return;
              setScope(next);
              if (next !== 'layer') setChanges(current => Object.fromEntries(Object.entries(current).filter(([property]) => {
                const control = controls.find(item => item.property === property);
                return control && canScopeMapStyleControl(layer as unknown as MapStyleEditLayer, control);
              })));
            }} variant="outline" size="sm" className="w-full flex-wrap justify-start">
              <ToggleGroupItem value="feature" disabled={!featureAvailable || disabled || saving}>{copy.feature}</ToggleGroupItem>
              <ToggleGroupItem value="similar" disabled={!Object.keys(target.properties).length || disabled || saving}>{copy.similar}</ToggleGroupItem>
              <ToggleGroupItem value="layer" disabled={disabled || saving}>{copy.layer}</ToggleGroupItem>
            </ToggleGroup></Field>
            {scope === 'similar' ? <Field><FieldLabel htmlFor={propertyId}>{copy.property}</FieldLabel><Select value={matchProperty} onValueChange={(value) => setMatchProperty(value ?? '')} items={Object.keys(target.properties).map((property) => ({ value: property, label: property }))}>
              <SelectTrigger id={propertyId}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{Object.keys(target.properties).map((property) => <SelectItem key={property} value={property}>{property}</SelectItem>)}</SelectGroup></SelectContent>
            </Select></Field> : null}
            {controls.map((control) => {
              const label = styleControlLabel(locale, control.property);
              const layerOnly = !canScopeMapStyleControl(layer as unknown as MapStyleEditLayer, control);
              const controlDisabled = disabled || saving || (scope !== 'layer' && layerOnly);
              const id = `${propertyId}-${control.property}`;
              const value = values[control.property];
              const update = (next: MapStyleEditChangeValue) => {
                setValues(current => ({ ...current, [control.property]: next }));
                setChanges(current => ({ ...current, [control.property]: next }));
              };
              const invalid = Object.hasOwn(changes, control.property) && !MapStyleEditChangesSchema.safeParse({ [control.property]: changes[control.property] }).success;
              return <Field key={control.property}>
                <div className="flex items-center justify-between gap-2">
                  <FieldLabel htmlFor={id}>{label}{control.units ? <span className="font-normal text-muted-foreground">({control.units})</span> : null}</FieldLabel>
                  {layerOnly ? <Badge variant="outline">{copy.layer}</Badge> : null}
                </div>
                <a href={`https://maplibre.org/maplibre-style-spec/layers/#${control.property}`} target="_blank" rel="noreferrer" className="w-fit font-mono text-xs text-muted-foreground underline-offset-2 hover:underline">{control.property}</a>
                {control.kind === 'color' ? <ColorInput
                id={`${propertyId}-${control.property}`}
                aria-label={label}
                swatchLabel={`${copy.edit}: ${label}`}
                value={String(values[control.property] ?? '')}
                defaultValue=""
                inputPlaceholder="—"
                aria-invalid={Object.hasOwn(changes, control.property) && !MapStyleEditChangesSchema.safeParse({ [control.property]: changes[control.property] }).success}
                disabled={controlDisabled}
                onTextChange={(value) => { setValues((current) => ({ ...current, [control.property]: value })); setChanges((current) => ({ ...current, [control.property]: value })); }}
                onPickerChange={(rgba) => {
                  if (!Array.isArray(rgba)) return;
                  const value = `#${rgba.slice(0, 3).map((channel) => Math.round(Number(channel)).toString(16).padStart(2, '0')).join('')}${Number(rgba[3]) < 1 ? Math.round(Number(rgba[3]) * 255).toString(16).padStart(2, '0') : ''}`;
                  setValues((current) => ({ ...current, [control.property]: value }));
                  setChanges((current) => ({ ...current, [control.property]: value }));
                }}
              /> : control.kind === 'boolean'
                  ? <Switch id={id} aria-label={label} checked={value === true} disabled={controlDisabled} onCheckedChange={update} />
                  : control.kind === 'enum'
                    ? <Select value={typeof value === 'string' && value ? value : null} items={(control.options ?? []).map(option => ({ value: option, label: option }))} onValueChange={next => { if (next !== null) update(next); }} disabled={controlDisabled}>
                      <SelectTrigger id={id} aria-label={label}><SelectValue placeholder="—" /></SelectTrigger>
                      <SelectContent><SelectGroup>{control.options?.map(option => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectGroup></SelectContent>
                    </Select>
                    : <Input id={id} aria-label={label} type={control.kind === 'array' ? 'text' : 'number'}
                      value={Array.isArray(value) ? value.join(', ') : typeof value === 'string' || typeof value === 'number' ? value : ''}
                      placeholder={control.kind === 'array' ? control.length ? Array(control.length).fill('0').join(', ') : '2, 4' : '—'}
                      aria-invalid={invalid} min={control.min} max={control.max} step="any" disabled={controlDisabled}
                      onChange={event => {
                        const raw = event.target.value;
                        if (control.kind === 'array') {
                          setValues(current => ({ ...current, [control.property]: raw }));
                          const next = raw.trim() ? raw.split(',').map(part => part.trim() ? Number(part) : NaN) : raw;
                          setChanges(current => ({ ...current, [control.property]: next }));
                        } else update(raw !== '' ? Number(raw) : '');
                      }} />}
              </Field>;
            })}
          </FieldGroup>
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-popover pt-3">          {pickedCandidates.length > 1 ? <Button type="button" variant="ghost" size="sm" className="me-auto h-8" disabled={saving} onClick={() => {
            preview.current?.restore(); preview.current = null;
            setPendingSnapshot(snapshot); setCandidate(null); setHovered(null); setCandidates(pickedCandidates);
            setValues({}); setChanges({}); setSaveError(false);
          }}><ArrowLeft aria-hidden="true" />{copy.chooseTarget}</Button> : null}<Button type="button" variant="outline" disabled={saving} onClick={cancel}>{copy.cancel}</Button><Button type="submit" disabled={disabled || saving || invalidScope || !patch}>{saving ? copy.saving : copy.save}</Button></div>
        </form> : null}
      </div>
  </MapCommentPopover>;
}

function initialValue(map: MapLibreMap, layer: MapStyleEditLayer, control: Control): MapStyleEditChangeValue {
  const current = control.section === 'layout' ? map.getLayoutProperty(layer.id, control.property as Parameters<MapLibreMap['getLayoutProperty']>[1]) : map.getPaintProperty(layer.id, control.property as Parameters<MapLibreMap['getPaintProperty']>[1]);
  const value = current ?? mapStyleControlFallback(layer, control);
  return isMapStyleEditValue(control, value) ? value : '';
}

function validChanges(changes: Record<string, MapStyleEditChangeValue>): boolean {
  return MapStyleEditChangesSchema.safeParse(changes).success;
}

function makeInput(
  draftRevision: number,
  styleHash: string,
  idempotencyKey: string,
  target: ReturnType<typeof buildCommentTarget>,
  scope: MapStyleEditScope,
  matchProperty: string,
  changes: Record<string, MapStyleEditChangeValue>,
): MapStyleEditInput {
  return {
    expectedRevision: draftRevision,
    styleHash,
    idempotencyKey,
    target,
    scope,
    ...(scope === 'similar' && matchProperty ? { match: { property: matchProperty, value: target.properties[matchProperty]! } } : {}),
    changes,
  };
}
