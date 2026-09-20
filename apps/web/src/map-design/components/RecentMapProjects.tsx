import { mapThumbnailUrl } from '@mapseekai/contracts';
import { Map as MapIcon, Ellipsis, FolderOpen, RotateCcw, Trash2 } from 'lucide-react';
import type { MapDesignProjectSummary } from '@mapseekai/map-design-contracts';
import { MapLoading, Alert, AlertDescription, Button, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem, Card, CardContent, CardFooter, Popover, PopoverTrigger, PopoverContent, Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter, Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@mapseekai/components';
import { useI18n } from '../../i18n';
import { useState, useRef } from 'react';
import { projectFiltersCopy } from '../../i18n/locales/project-filters';
interface RecentMapProjectsProps { showHeading?: boolean; projects: MapDesignProjectSummary[]; loading: boolean; error: string | null; projectErrors: Record<string, string>; pendingProjectIds: ReadonlySet<string>; onOpenProject(id: string): void; onRetryProject(id: string): void; onDeleteProject(id: string): void; }
export function RecentMapProjects({ showHeading = true, projects, loading, error, projectErrors, pendingProjectIds, onOpenProject, onRetryProject, onDeleteProject }: RecentMapProjectsProps) {
 const { t, locale } = useI18n();
 const copy = projectFiltersCopy[locale];
 const [query, setQuery] = useState('');
 const [status, setStatus] = useState('all');
 const [actionProjectId, setActionProjectId] = useState<string | null>(null);
 const [deleteProject, setDeleteProject] = useState<MapDesignProjectSummary | null>(null);
 const cancelDeleteRef = useRef<HTMLButtonElement>(null);
 const actionTriggerRef = useRef<HTMLButtonElement | null>(null);
 const statuses = [{ value: 'all', label: copy.all }, { value: 'ready', label: t('mapDesign.lifecycle.ready') }, { value: 'importing', label: t('mapDesign.lifecycle.importing') }, { value: 'failed', label: t('mapDesign.lifecycle.failed') }];
 const sorted = projects.filter(p => p.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (status === 'all' || p.lifecycle === status)).sort((a,b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
 return <section className="flex flex-col gap-3" aria-labelledby={showHeading ? 'recent-map-projects-heading' : undefined} aria-label={showHeading ? undefined : t('mapDesign.recent.title')}>
 {showHeading ? <h2 className="text-lg font-medium" id="recent-map-projects-heading">{t('mapDesign.recent.title')}</h2> : null}
 {projects.length ? <div className="flex items-center gap-2">
   <Input type="search" style={{ maxWidth: 'calc(var(--spacing) * 64)' }} className="h-8 min-w-0 flex-1" aria-label={copy.search} placeholder={copy.search} value={query} onChange={event => setQuery(event.target.value)} />
   <Select items={statuses} value={status} onValueChange={value => setStatus(value ?? 'all')}><SelectTrigger className="h-8 w-40 shrink-0" aria-label={copy.status}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{statuses.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent></Select>
   {query || status !== 'all' ? <Button size="sm" variant="ghost" onClick={() => { setQuery(''); setStatus('all'); }}>{copy.clear}</Button> : null}
 </div> : null}
 {loading ? <MapLoading variant="inline" label={t('common.loading')} /> : null}
 {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
 {!loading && !error && !projects.length ? <Empty variant="outline"><EmptyHeader><EmptyTitle>{t('mapDesign.recent.empty')}</EmptyTitle><EmptyDescription>{t('mapDesign.recent.emptyDetail')}</EmptyDescription></EmptyHeader></Empty> : null}
 {!loading && !error && projects.length > 0 && !sorted.length ? <p role="status" className="text-sm text-muted-foreground">{copy.empty}</p> : null}
 {sorted.length ? <ul className="flex list-none flex-wrap gap-3 p-0" aria-label={t('mapDesign.recent.title')}>
 {sorted.map(p => <li key={p.projectId} className="min-w-0" style={{ width: '18rem', maxWidth: '100%' }}><Card size="sm" variant="media" className="h-full cursor-pointer" onClick={() => onOpenProject(p.projectId)}>
 <div className="relative aspect-video w-full overflow-hidden bg-muted">
   <MapIcon aria-hidden="true" className="absolute inset-0 m-auto size-8 text-muted-foreground/40" />
   <img src={mapThumbnailUrl(p.projectId)} alt={p.title} loading="lazy" className="absolute inset-0 h-full w-full object-cover" onError={event => { event.currentTarget.hidden = true; }} />
   <div className="absolute right-2 top-2" onClick={event => event.stopPropagation()}>
     <Popover open={actionProjectId === p.projectId} onOpenChange={open => setActionProjectId(current => open ? p.projectId : current === p.projectId ? null : current)}>
       <PopoverTrigger render={<Button type="button" variant="outline" size="icon-sm" onClick={event => { actionTriggerRef.current = event.currentTarget; }} aria-label={`${copy.more}: ${p.title}`}><Ellipsis aria-hidden="true" /></Button>} />
       <PopoverContent align="end" size="sm" className="w-36" aria-label={`${copy.more}: ${p.title}`}>
         <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => { setActionProjectId(null); onOpenProject(p.projectId); }}><FolderOpen aria-hidden="true" data-icon="inline-start" />{t('mapDesign.recent.open')}</Button>
         {p.lifecycle === 'failed' ? <Button size="sm" variant="ghost" className="w-full justify-start" disabled={pendingProjectIds.has(p.projectId)} onClick={() => { setActionProjectId(null); onRetryProject(p.projectId); }}><RotateCcw aria-hidden="true" data-icon="inline-start" />{t('mapDesign.recent.retry')}</Button> : null}
         <Button size="sm" variant="destructive" className="w-full justify-start" disabled={pendingProjectIds.has(p.projectId)} onClick={() => { setActionProjectId(null); setDeleteProject(p); }}><Trash2 aria-hidden="true" data-icon="inline-start" />{t('common.delete')}</Button>
       </PopoverContent>
     </Popover>
   </div>
 </div>
 {projectErrors[p.projectId] ? <CardContent><div className="py-2"><Alert variant="destructive"><AlertDescription>{projectErrors[p.projectId]}</AlertDescription></Alert></div></CardContent> : null}
 <CardFooter className="mt-auto"><div className="flex min-w-0 w-full flex-col items-start gap-1">
   <Button type="button" variant="ghost" size="sm" className="w-full justify-start" title={p.title}><span className="truncate">{p.title}</span></Button>
   <span className="text-xs text-muted-foreground">{copy.updated}: <time dateTime={p.updatedAt}>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(p.updatedAt))}</time></span>
 </div></CardFooter>
 </Card></li>)}</ul> : null}
 {deleteProject ? <Dialog role="alertdialog" onClose={() => setDeleteProject(null)} closeOnEscape initialFocus={cancelDeleteRef} finalFocus={actionTriggerRef}>
   <DialogHeader><DialogTitle>{t('common.delete')} “{deleteProject.title}”?</DialogTitle><DialogDescription>{copy.deleteWarning}</DialogDescription></DialogHeader>
   <DialogFooter>
     <Button ref={cancelDeleteRef} variant="outline" onClick={() => setDeleteProject(null)}>{t('mapDesign.revision.cancel')}</Button>
     <Button variant="destructive" disabled={pendingProjectIds.has(deleteProject.projectId)} onClick={() => { const id = deleteProject.projectId; setDeleteProject(null); onDeleteProject(id); }}><Trash2 aria-hidden="true" data-icon="inline-start" />{t('common.delete')}</Button>
   </DialogFooter>
 </Dialog> : null}
 </section>;
}
