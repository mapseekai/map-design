import {
  Alert, AlertDescription, Badge, Button, Card, CardContent, Checkbox, PopoverHeader, PopoverTitle,
  Empty, EmptyDescription, EmptyHeader, Field, FieldGroup, FieldLabel, Select, SelectContent,
  SelectGroup, SelectItem, SelectTrigger, SelectValue, Textarea, ToggleGroup, ToggleGroupItem, Tooltip, TooltipTrigger, TooltipContent, TooltipProvider,
} from '@mapseekai/components';
import type { MapComment, MapCommentInput, MapCommentTarget } from '@mapseekai/map-design-contracts';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, MessageSquarePlus, Send, Trash2, X } from 'lucide-react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { useI18n } from '../../i18n';
import { commentsCopy, commentSaveChangesCopy } from '../../i18n/locales/comments';
import { deleteMapComment, listMapComments, saveMapComment } from './client';
import { useFeatureHighlight } from './feature-highlight';
import { useCommentMarkers } from './comment-markers';
import { MapCommentPopover } from './MapCommentPopover';
import { commentCursor } from './comment-icon';
import {
  buildCommentTarget, deduplicateFeatureCandidates, featureScopeAvailable, generatedSourceIds,
  isCommentMarkerFeature, normalizeAnchor, queryBox, type FeatureCandidate, type PickedFeature,
} from './feature-picking';

export interface MapDesignCommentsProps {
  projectId: string;
  map: MapLibreMap | null;
  draftRevision: number;
  styleHash: string;
  readOnly: boolean;
  submissionDisabled: boolean;
  onSubmit(comments: MapComment[]): Promise<boolean>;
  suspended?: boolean;
  onActivate?(): void;
  onOpenList?(): void;
  onCountChange?(count: number): void;
  toolbarHost?: HTMLElement | null;
  listHost?: HTMLElement | null;
}

type Scope = MapCommentInput['scope'];
type ErrorKind = 'load' | 'save' | 'delete' | 'submit' | 'stale' | 'staleBatch' | 'batchLimit' | 'projectLimit' | null;

export function MapDesignComments({ projectId, map, draftRevision, styleHash, readOnly, submissionDisabled, onSubmit, suspended = false, onActivate, onOpenList, onCountChange, toolbarHost, listHost }: MapDesignCommentsProps) {
  const { locale } = useI18n();
  const copy = commentsCopy[locale];
  const textId = useId();
  const propertyId = useId();
  const [hoveredComment, setHoveredComment] = useState<MapComment | null>(null);
  const [comments, setComments] = useState<MapComment[]>([]);
  useEffect(() => { onCountChange?.(comments.length); }, [comments.length, onCountChange]);
  const [open, setOpen] = useState(false);
  const [toolActive, setToolActive] = useState(false);
  useEffect(() => { if (suspended || readOnly) setToolActive(false); }, [readOnly, suspended]);
  const [loading, setLoading] = useState(true);
  const [listReady, setListReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorKind>(null);
  const [emptyHit, setEmptyHit] = useState(false);
  const [candidates, setCandidates] = useState<FeatureCandidate[]>([]);
  const [candidate, setCandidate] = useState<FeatureCandidate | null>(null);
  const [hoveredCandidate, setHoveredCandidate] = useState<FeatureCandidate | null>(null);
  const [pickedSnapshot, setPickedSnapshot] = useState<{ draftRevision: number; styleHash: string } | null>(null);
  const [pendingSnapshot, setPendingSnapshot] = useState<{ draftRevision: number; styleHash: string } | null>(null);
  const [anchor, setAnchor] = useState<[number, number] | null>(null);
  const [savedTarget, setSavedTarget] = useState<MapCommentTarget | null>(null);
  const [text, setText] = useState('');
  const [scope, setScope] = useState<Scope>('feature');
  const [property, setProperty] = useState('');
  const [viewingSaved, setViewingSaved] = useState(false);
  const [editing, setEditing] = useState<MapComment | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const lifecycleGeneration = useRef(0);
  const loadSequence = useRef(0);
  const inFlight = useRef(false);
  const mutationController = useRef<AbortController | null>(null);
  const latestContext = useRef({ readOnly, submissionDisabled, projectId });
  latestContext.current = { readOnly, submissionDisabled, projectId };
  const triggerRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hoveredFeature = useMemo<PickedFeature | null>(() => {
    if (!hoveredComment || suspended) return null;
    const target = hoveredComment.target;
    return { id: target.featureId, source: target.sourceId, sourceLayer: target.sourceLayer,
      layer: { id: target.layerId }, properties: target.properties,
      geometry: { type: target.geometryType, coordinates: [] } as PickedFeature['geometry'] };
  }, [hoveredComment, suspended, styleHash]);
  useFeatureHighlight(map, hoveredFeature);
  useFeatureHighlight(map, open && !suspended && (!pickedSnapshot || (pickedSnapshot.draftRevision === draftRevision && pickedSnapshot.styleHash === styleHash))
    ? (hoveredCandidate ?? candidate)?.feature ?? null : null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const lifecycle = lifecycleGeneration.current;
    const sequence = ++loadSequence.current;
    try {
      const next = (await listMapComments(projectId, signal)).filter((comment) => comment.status !== 'succeeded' && !comment.transient);
      if (!signal?.aborted && lifecycle === lifecycleGeneration.current && sequence === loadSequence.current) {
        setComments(next);
        setChecked((current) => new Set([...current].filter((id) => next.some((comment) => comment.id === id && editable(comment)))));
        setError(null); setLoading(false); setListReady(true);
      }
      return next;
    } catch {
      if (!signal?.aborted && lifecycle === lifecycleGeneration.current && sequence === loadSequence.current) { setError('load'); setLoading(false); }
    }
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    setComments([]); setChecked(new Set()); setLoading(true); setListReady(false); setError(null); setEditing(null); setViewingSaved(false);
    void reload(controller.signal);
    return () => { controller.abort(); mutationController.current?.abort(); inFlight.current = false; lifecycleGeneration.current += 1; loadSequence.current += 1; };
  }, [projectId, reload]);

  const hasSubmittedComments = comments.some((comment) => comment.status === 'submitted');
  useEffect(() => {
    if (!hasSubmittedComments) return;
    const controller = new AbortController();
    let polling = false;
    const timer = window.setInterval(async () => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      try { await reload(controller.signal); } finally { polling = false; }
    }, 1500);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [hasSubmittedComments, reload]);

  const chooseCandidate = useCallback((next: FeatureCandidate, nextAnchor: [number, number], snapshot = { draftRevision, styleHash }) => {
    const normalizedAnchor = normalizeAnchor(nextAnchor);
    const retainedProperties = buildCommentTarget(next.feature, normalizedAnchor).properties;
    setCandidate(next); setHoveredCandidate(null); setSavedTarget(null); setAnchor(normalizedAnchor); setCandidates([]); setEmptyHit(false);
    setPickedSnapshot(snapshot); setPendingSnapshot(null);
    setScope('feature');
    const firstProperty = Object.keys(retainedProperties)[0] ?? '';
    setProperty((current) => Object.hasOwn(retainedProperties, current) ? current : firstProperty);
    setOpen(true);
  }, [draftRevision, styleHash]);

  useEffect(() => {
    if (!map || !toolActive || readOnly || suspended) return;
    const pick = (event: { point: { x: number; y: number }; lngLat: { lng: number; lat: number }; originalEvent?: { target?: EventTarget | null } }) => {
      if (latestContext.current.readOnly || inFlight.current) return;
      if ((event.originalEvent?.target as Element | null)?.closest?.('[data-comment-editor]')) return;
      const rendered = map.queryRenderedFeatures(queryBox(event.point)) as PickedFeature[];
      if (rendered.some(isCommentMarkerFeature)) return;
      if (viewingSaved || (editing && !editable(editing))) {
        setEditing(null); setViewingSaved(false); setText(''); setSavedTarget(null); setCandidate(null); setPickedSnapshot(null); setPendingSnapshot(null);
      }
      const hits = deduplicateFeatureCandidates(rendered);
      setEmptyHit(hits.length === 0); setCandidates(hits.length > 1 ? hits : []);
      if (!hits.length) { setOpen(false); setAnchor(null); }
      if (hits.length !== 1) { setCandidate(null); setSavedTarget(null); setPickedSnapshot(null); }
      if (hits.length === 1) chooseCandidate(hits[0]!, [event.lngLat.lng, event.lngLat.lat]);
      else if (hits.length > 1) { setPendingSnapshot({ draftRevision, styleHash }); setAnchor(normalizeAnchor([event.lngLat.lng, event.lngLat.lat])); setOpen(true); }
    };
    const canvas = map.getCanvas();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setToolActive(false); setCandidates([]); triggerRef.current?.focus(); return; }
      if (event.key !== 'Enter') return;
      const rect = canvas.getBoundingClientRect();
      const point = { x: rect.width / 2, y: rect.height / 2 };
      const lngLat = map.unproject([point.x, point.y]);
      map.fire('click', { point, lngLat, originalEvent: event });
      event.preventDefault();
    };
    map.on('click', pick); canvas.addEventListener('keydown', keydown);
    const previousCursor = canvas.style.cursor; canvas.style.cursor = commentCursor(canvas);
    return () => { map.off('click', pick); canvas.removeEventListener('keydown', keydown); canvas.style.cursor = previousCursor; };
  }, [chooseCandidate, draftRevision, editing, map, readOnly, styleHash, toolActive, suspended, viewingSaved]);

  useEffect(() => {
    if (pendingSnapshot && (pendingSnapshot.draftRevision !== draftRevision || pendingSnapshot.styleHash !== styleHash)) {
      setCandidates([]); setHoveredCandidate(null); setPendingSnapshot(null);
    }
  }, [draftRevision, pendingSnapshot, styleHash]);

  const target = useMemo(() => candidate && anchor ? buildCommentTarget(candidate.feature, anchor) : savedTarget, [anchor, candidate, savedTarget]);
  const generated = generatedSourceIds(map?.getStyle());
  const featureAvailable = candidate ? featureScopeAvailable(candidate.feature, generated, map?.getStyle())
    : target ? featureScopeAvailable({ id: target.featureId, source: target.sourceId }, generated, map?.getStyle()) : false;
  const properties = Object.entries(target?.properties ?? {});
  const invalidScope = scope === 'feature' && !featureAvailable;
  const stale = pickedSnapshot
    ? pickedSnapshot.draftRevision !== draftRevision || pickedSnapshot.styleHash !== styleHash
    : Boolean(editing && (editing.draftRevision !== draftRevision || editing.styleHash !== styleHash));

  const resetForm = useCallback(() => {
    setOpen(false); setText(''); setCandidate(null); setHoveredCandidate(null); setPickedSnapshot(null); setPendingSnapshot(null); setSavedTarget(null); setAnchor(null); setCandidates([]); setEditing(null); setViewingSaved(false);
    setScope('feature'); setProperty(''); setError(null);
  }, []);

  useEffect(() => {
    if (hoveredComment && !comments.some((comment) => comment.id === hoveredComment.id)) setHoveredComment(null);
    if (editing && !editing.transient && listReady && !loading) {
      const current = comments.find((comment) => comment.id === editing.id);
      if (!current) resetForm();
      else if (current.status !== editing.status) setEditing(current);
    }
  }, [comments, editing, hoveredComment, listReady, loading, resetForm]);

  const persist = async (submit: boolean) => {
    if (!listReady || latestContext.current.readOnly || latestContext.current.projectId !== projectId || busy || inFlight.current || candidates.length || !target || !text.trim() || stale || invalidScope || !editable(editing)) return;
    if (!submit && comments.length >= 500 && (!editing || editing.transient)) { setError('projectLimit'); return; }
    inFlight.current = true; setBusy(true); setError(null);
    const controller = new AbortController();
    mutationController.current = controller;
    const current = lifecycleGeneration.current;
    const input: MapCommentInput = {
      id: editing?.id ?? globalThis.crypto.randomUUID(), version: editing?.version ?? 0, text: text.trim(), target,
      scope, draftRevision, styleHash,
      ...(submit ? { transient: true } : {}),
      ...(scope === 'similar' && property ? { match: { property, value: target.properties[property]! } } : {}),
    };
    try {
      const saved = await saveMapComment(projectId, input, controller.signal);
      if (controller.signal.aborted || current !== lifecycleGeneration.current) return;
      loadSequence.current += 1;
      setLoading(false);
      if (submit) setEditing(saved);
      setComments((items) => submit ? items.filter(item => item.id !== saved.id) : stableComments(items.some((item) => item.id === saved.id)
        ? items.map((item) => item.id === saved.id ? saved : item)
        : [...items, saved]));
      if (submit) {
        let accepted = false;
        try { accepted = await onSubmit([saved]); } catch { /* retain and reconcile below */ }
        if (current !== lifecycleGeneration.current) return;
        const refreshed = await reload();
        if (current !== lifecycleGeneration.current) return;
        if (!accepted) { setEditing(refreshed?.find((item) => item.id === saved.id) ?? saved); setError('submit'); return; }
      }
      resetForm();
    } catch { if (!controller.signal.aborted && current === lifecycleGeneration.current) setError('save'); }
    finally { if (mutationController.current === controller) { inFlight.current = false; mutationController.current = null; if (current === lifecycleGeneration.current) setBusy(false); } }
  };

  const editComment = (comment: MapComment) => {
    if (busy || inFlight.current) return;
    setViewingSaved(true); setEditing(comment); setText(comment.text); setSavedTarget(comment.target); setCandidate(null); setHoveredCandidate(null); setPickedSnapshot(null); setPendingSnapshot(null); setAnchor(comment.target.anchor);
    setScope(comment.scope); setProperty(comment.match?.property ?? Object.keys(comment.target.properties)[0] ?? ''); setOpen(true);
  };
  useCommentMarkers(map, comments, !suspended, (comment) => {
    onActivate?.(); setOpen(true); editComment(comment); map?.flyTo({ center: comment.target.anchor });
  }, open && !editing ? anchor : null, setHoveredComment);

  const removeComment = async (comment: MapComment) => {
    if (latestContext.current.readOnly || latestContext.current.projectId !== projectId || busy || inFlight.current || !deletable(comment)) return;
    inFlight.current = true; setBusy(true); setError(null);
    const controller = new AbortController(); mutationController.current = controller;
    const current = lifecycleGeneration.current;
    try { await deleteMapComment(projectId, comment.id, comment.version, controller.signal); if (!controller.signal.aborted && current === lifecycleGeneration.current) { loadSequence.current += 1; setLoading(false); setComments((items) => items.filter((item) => item.id !== comment.id)); setChecked((items) => { const next = new Set(items); next.delete(comment.id); return next; }); if (editing?.id === comment.id) resetForm(); } }
    catch { if (!controller.signal.aborted && current === lifecycleGeneration.current) setError('delete'); }
    finally { if (mutationController.current === controller) { inFlight.current = false; mutationController.current = null; if (current === lifecycleGeneration.current) setBusy(false); } }
  };

  const submitChecked = async () => {
    if (latestContext.current.readOnly || latestContext.current.submissionDisabled || latestContext.current.projectId !== projectId || busy || inFlight.current) return;
    const selected = comments.filter((item) => checked.has(item.id) && editable(item));
    if (!selected.length) return;
    if (selected.some((item) => item.draftRevision !== draftRevision || item.styleHash !== styleHash)) { setError('staleBatch'); return; }
    inFlight.current = true; setBusy(true); setError(null);
    const lifecycle = lifecycleGeneration.current;
    let accepted = false;
    try { accepted = await onSubmit(selected); }
    catch { accepted = false; }
    if (lifecycle === lifecycleGeneration.current) {
      await reload();
      if (lifecycle === lifecycleGeneration.current) {
        if (accepted) setChecked(new Set()); else setError('submit');
        inFlight.current = false; setBusy(false);
      }
    }
  };

  const errorText = error === 'load' ? copy.loadError : error === 'save' ? copy.saveError : error === 'delete' ? copy.deleteError : error === 'submit' ? copy.submitError : error === 'stale' ? copy.stale : error === 'staleBatch' ? copy.staleBatch : error === 'batchLimit' ? copy.batchLimit : error === 'projectLimit' ? copy.projectLimit : null;
  const dismiss = () => { setOpen(false); setToolActive(false); setCandidates([]); triggerRef.current?.focus(); };
  const toolbar = <Button ref={triggerRef} type="button" variant={toolActive ? 'default' : 'ghost'} size="sm" disabled={!map}
    aria-pressed={toolActive && !suspended} title={copy.pickHint} onClick={() => {
      if (readOnly) { onOpenList?.(); return; }
      onActivate?.();
      if (toolActive) dismiss(); else { resetForm(); setToolActive(true); }
    }}><MessageSquarePlus data-icon="inline-start" />{copy.toggle}</Button>;
  const list = <section className="flex min-w-0 flex-col gap-3" aria-label={copy.title}>
      <Button type="button" size="sm" variant="outline" disabled={busy || readOnly} onClick={() => { onActivate?.(); resetForm(); setToolActive(true); }}><MessageSquarePlus data-icon="inline-start" />{copy.newComment}</Button>
      {emptyHit ? <Alert><AlertDescription>{copy.emptyHit}</AlertDescription></Alert> : null}
            {!open && errorText && error !== 'load' ? <Alert variant="destructive"><AlertDescription>{errorText}</AlertDescription></Alert> : null}
            {!loading && !comments.length ? <Empty size="sm"><EmptyHeader><EmptyDescription>{copy.none}</EmptyDescription></EmptyHeader></Empty> : null}
            {loading ? <p role="status" className="text-sm text-muted-foreground">{copy.loading}</p> : null}
            {error === 'load' ? <Alert variant="destructive"><AlertDescription>{copy.loadError}</AlertDescription><Button type="button" size="sm" variant="outline" onClick={() => void reload()}>{copy.retry}</Button></Alert> : null}
            {comments.map((comment, index) => <Card key={comment.id} size="sm" role="article"><CardContent><div className="flex items-start gap-2">
              {!readOnly && editable(comment) ? <Checkbox aria-label={copy.selectComment.replace('{number}', String(index + 1))} checked={checked.has(comment.id)} onCheckedChange={(value) => setChecked((current) => { const next = new Set(current); if (value && !next.has(comment.id) && next.size >= 20) { setError('batchLimit'); return next; } value ? next.add(comment.id) : next.delete(comment.id); return next; })} /> : null}
              <Button type="button" variant="ghost" size="content" className="min-w-0 flex-1 justify-start text-start whitespace-normal" onClick={() => { onActivate?.(); map?.flyTo({ center: comment.target.anchor }); editComment(comment); }}><span className="flex min-w-0 flex-col items-start gap-1"><span className="block text-sm font-medium">{index + 1}. {comment.target.layerId}{comment.target.featureId !== undefined ? ` · #${String(comment.target.featureId)}` : ''}</span><span className="block truncate text-xs text-muted-foreground">{scopeLabel(comment.scope, copy)}{comment.match ? ` · ${comment.match.property} = ${JSON.stringify(comment.match.value)}` : ''}</span><span className="line-clamp-2 text-xs text-muted-foreground">{comment.text}</span><Badge variant="secondary" className="mt-1">{{ draft: copy.statusDraft, submitted: copy.statusSubmitted, succeeded: copy.statusSucceeded, failed: copy.statusFailed, canceled: copy.statusCanceled }[comment.status]}</Badge></span></Button>
              {!readOnly && deletable(comment) ? <Button type="button" variant="ghost" size="icon-sm" aria-label={copy.delete} disabled={busy} onClick={() => void removeComment(comment)}><Trash2 /></Button> : null}
            </div></CardContent></Card>)}
            {!readOnly ? <Button type="button" size="sm" disabled={busy || submissionDisabled || !comments.some((item) => checked.has(item.id))} onClick={() => void submitChecked()}><Check data-icon="inline-start" />{copy.sendSelected}</Button> : null}
          </section>;
  const targetLabel = target ? `${copy.selectedTarget}: ${candidate?.label ?? target.layerId}${target.featureId !== undefined ? ` · #${String(target.featureId)}` : ''} · ${scopeLabel(scope, copy)}${scope === 'similar' && property ? ` · ${property} = ${JSON.stringify(target.properties[property])}` : ''}` : '';
  const editor = <MapCommentPopover map={map} anchor={anchor} open={open && !suspended} onClose={dismiss}
    initialFocus={textareaRef} finalFocus={triggerRef} label={copy.title}>
    <PopoverHeader className="shrink-0 flex-row items-center justify-between">
      <PopoverTitle>{copy.comment}</PopoverTitle>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={copy.close} onClick={dismiss}><X /></Button>
    </PopoverHeader>
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto" style={{ margin: -4, padding: 4 }}>
          {readOnly ? <Alert><AlertDescription>{copy.readOnly}</AlertDescription></Alert> : null}
          {emptyHit ? <Alert><AlertDescription>{copy.emptyHit}</AlertDescription></Alert> : null}
          {candidates.length ? <section className="flex flex-col gap-2" aria-label={copy.chooseTarget}>
            <h3 className="text-sm font-medium">{copy.chooseTarget}</h3>
            {candidates.map((item) => <Button key={item.key} type="button" variant="outline" size="content" className="justify-between text-start"
              aria-label={`${item.label} ${item.keyAttributes.map(([key, value]) => `${key} ${String(value)}`).join(' ')}`}
              onPointerEnter={() => setHoveredCandidate(item)} onPointerLeave={() => setHoveredCandidate(null)} onFocus={() => setHoveredCandidate(item)} onBlur={() => setHoveredCandidate(null)}
              onClick={() => chooseCandidate(item, anchor!, pendingSnapshot ?? undefined)}><span className="min-w-0"><span className="block truncate">{item.label}</span><span className="block truncate text-xs text-muted-foreground">{item.keyAttributes.map(([key, value]) => `${key}: ${String(value)}`).join(' · ')}</span></span><ChevronRight /></Button>)}
          </section> : null}

          {target ? <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void persist(false); }}>
            <TooltipProvider><Tooltip>
              <Badge variant="outline" className="w-fit max-w-full" render={<TooltipTrigger render={<span />} tabIndex={0} />}>
                <span className="block min-w-0 truncate">{targetLabel}</span>
              </Badge>
              <TooltipContent role="tooltip" className="max-w-xs break-words">{targetLabel}</TooltipContent>
            </Tooltip></TooltipProvider>
            {stale ? <Alert variant="destructive"><AlertDescription>{copy.stale}</AlertDescription></Alert> : null}
            <FieldGroup>
              <Field><FieldLabel htmlFor={textId}>{copy.comment}</FieldLabel><Textarea ref={textareaRef} autoFocus id={textId} value={text} maxLength={4000} rows={4} disabled={readOnly || busy || !editable(editing)} placeholder={copy.commentPlaceholder} onChange={(event) => setText(event.target.value)} /></Field>
              <Field><FieldLabel>{copy.scope}</FieldLabel><ToggleGroup aria-label={copy.scope} value={[scope]} onValueChange={(values) => values[0] && setScope(values[0] as Scope)} variant="outline" size="sm" className="w-full flex-wrap justify-start">
                <ToggleGroupItem value="feature" disabled={readOnly || busy || !editable(editing) || !featureAvailable}>{copy.feature}</ToggleGroupItem>
                <ToggleGroupItem value="similar" disabled={readOnly || busy || !editable(editing) || !properties.length}>{copy.similar}</ToggleGroupItem>
                <ToggleGroupItem value="layer" disabled={readOnly || busy || !editable(editing)}>{copy.layer}</ToggleGroupItem>
              </ToggleGroup>{!featureAvailable ? <p className="text-xs text-muted-foreground">{copy.featureUnavailable}</p> : null}</Field>
              {scope === 'similar' ? <Field><FieldLabel htmlFor={propertyId}>{copy.property}</FieldLabel><Select disabled={readOnly || busy || !editable(editing)} items={properties.map(([key]) => ({ value: key, label: key }))} value={property || '__none__'} onValueChange={(value) => value && value !== '__none__' && setProperty(value)}><SelectTrigger id={propertyId}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{properties.map(([key, value]) => <SelectItem key={key} value={key}>{key}: {String(value)}</SelectItem>)}</SelectGroup></SelectContent></Select></Field> : null}
            </FieldGroup>
            {errorText ? <Alert variant="destructive"><AlertDescription>{errorText}</AlertDescription></Alert> : null}
            {!readOnly ? <div className="flex flex-wrap justify-end gap-2">{editing && deletable(editing) ? <Button type="button" size="sm" className="h-8" variant="ghost" disabled={busy} onClick={() => void removeComment(editing)}><Trash2 data-icon="inline-start" />{copy.delete}</Button> : null}<Button type="button" size="sm" className="h-8" variant="ghost" disabled={busy} onClick={resetForm}>{copy.cancel}</Button>{editable(editing) ? <><Button type="submit" size="sm" className="h-8" variant="secondary" disabled={!listReady || busy || stale || invalidScope || !text.trim()}>{busy ? copy.saving : editing ? commentSaveChangesCopy[locale] : copy.save}</Button><Button type="button" size="sm" className="h-8" disabled={!listReady || busy || stale || invalidScope || submissionDisabled || !text.trim()} onClick={() => void persist(true)}><Send data-icon="inline-start" />{copy.sendNow}</Button></> : null}</div> : null}
          </form> : null}

    </div>
  </MapCommentPopover>;
  return <>
    {toolbarHost === undefined ? toolbar : toolbarHost ? createPortal(toolbar, toolbarHost) : null}
    {listHost === undefined ? list : listHost ? createPortal(list, listHost) : null}
    {editor}
  </>;
}

function editable(comment: MapComment | null): boolean {
  return !comment || comment.status === 'draft' || comment.status === 'failed' || comment.status === 'canceled';
}

function deletable(comment: MapComment): boolean {
  return comment.status !== 'submitted';
}

function stableComments(comments: MapComment[]): MapComment[] {
  return [...comments].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function scopeLabel(scope: Scope, copy: typeof commentsCopy.en): string {
  return scope === 'feature' ? copy.feature : scope === 'similar' ? copy.similar : copy.layer;
}
