import type { MapDesignProjectRead, MapDesignProjectSummary } from '@mapseekai/map-design-contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listMapDesignProjects, retryMapDesignImport, renameMapDesignProject } from '../client';
import { randomUUID } from '../../utils/uuid';
function message(e: unknown, fallback: string) { return e instanceof Error && e.message.trim() ? e.message : fallback; }
function summary(project: MapDesignProjectRead, current?: MapDesignProjectSummary): MapDesignProjectSummary { return { projectId: project.projectId, title: current?.title ?? '', lifecycle: project.lifecycle, sourceKind: project.sourceKind, draftRevision: project.draftRevision, committedRevision: project.committedRevision, validationStatus: current?.validationStatus ?? 'unknown', updatedAt: project.updatedAt }; }
export function useMapDesignProjects() {
 const [projects,setProjects]=useState<MapDesignProjectSummary[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null),[projectErrors,setProjectErrors]=useState<Record<string,string>>({}),[pendingProjectIds,setPending]=useState<ReadonlySet<string>>(new Set()); const mounted=useRef(true),pending=useRef(new Set<string>());
 const begin=(id:string)=>{if(pending.current.has(id))return false;pending.current.add(id);setPending(s=>new Set(s).add(id));setProjectErrors(e=>{const n={...e};delete n[id];return n;});return true;}; const finish=(id:string)=>{pending.current.delete(id);if(mounted.current)setPending(s=>{const n=new Set(s);n.delete(id);return n;});};
 useEffect(()=>{mounted.current=true;const c=new AbortController();void listMapDesignProjects(c.signal).then(r=>{if(!c.signal.aborted)setProjects(r.projects);},e=>{if(!c.signal.aborted)setError(message(e,'Unable to load projects.'));}).finally(()=>{if(!c.signal.aborted)setLoading(false);});return()=>{mounted.current=false;c.abort();};},[]);
 const add=useCallback((p:MapDesignProjectRead)=>{if(mounted.current)setProjects(c=>[summary(p),...c.filter(x=>x.projectId!==p.projectId)]);},[]);
 const retry=useCallback(async(id:string)=>{if(!begin(id))return;try{const p=await retryMapDesignImport(id,`map-retry:${id}:${randomUUID()}`);if(mounted.current)setProjects(c=>c.map(x=>x.projectId===id?summary(p,x):x));}catch(e){if(mounted.current)setProjectErrors(x=>({...x,[id]:message(e,'Unable to retry import.')}));}finally{finish(id);}},[]);
 const remove=useCallback(async(id:string)=>{if(!begin(id))return;try{const r=await fetch(`/api/map-design/projects/${encodeURIComponent(id)}`,{method:'DELETE'});if(!r.ok)throw new Error('Unable to delete project.');if(mounted.current)setProjects(c=>c.filter(x=>x.projectId!==id));}catch(e){if(mounted.current)setProjectErrors(x=>({...x,[id]:message(e,'Unable to delete project.')}));}finally{finish(id);}},[]);
 const rename = useCallback(async (id: string, title: string) => {
   if (!begin(id)) return false;
   try {
     const updated = await renameMapDesignProject(id, title);
     if (mounted.current) setProjects(current => current.map(project => project.projectId === id ? { ...project, ...updated } : project));
     return true;
   } catch { return false; }
   finally { finish(id); }
 }, []);
 return {projects,loading,error,projectErrors,pendingProjectIds,add,retry,remove,rename};
}
