import { MapLoading } from '@mapseekai/components';
import { Alert, AlertDescription } from '@mapseekai/components';
import { useEffect, useRef } from 'react';

import { useT } from '../i18n';
import { createMapDesignProject } from './client';
import { MapSourceForm } from './components/MapSourceForm';
import { RecentMapProjects } from './components/RecentMapProjects';
import { useLocalAgents } from './hooks/useLocalAgents';
import { useMapDesignProjects } from './hooks/useMapDesignProjects';

export interface MapDesignHomeCreateInput {
  name: string;
  sourceUrl: string;
  designRequirement: string;
  runtime: { agentId: string; model?: string; reasoning?: string; serviceTier?: string };
  workingDirectory: { path: string; token: string | null; linkedDirs: readonly string[] } | null;
}

export interface MapDesignHomeCreateOutcome { projectId: string; conversationId: string; }
export interface MapDesignHomeProps { onOpenProject(projectId: string): void; }

export function MapDesignHome({ onOpenProject }: MapDesignHomeProps) {
  const t = useT();
  const { agents, loading: agentsLoading, error: agentsError } = useLocalAgents();
  const { projects, loading: projectsLoading, error, projectErrors, pendingProjectIds, add, retry, remove, rename } = useMapDesignProjects();
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; controller.current?.abort(); };
  }, []);

  async function create(input: Parameters<typeof createMapDesignProject>[0], signal: AbortSignal) {
    controller.current?.abort();
    const request = new AbortController();
    const current = ++generation.current;
    controller.current = request;
    signal.addEventListener('abort', () => request.abort(), { once: true });
    const result = await createMapDesignProject(input, request.signal);
    if (!request.signal.aborted && mounted.current && current === generation.current) {
      add(result.project);
      onOpenProject(result.project.projectId);
    }
    return result;
  }

  return <section style={{ marginBlock: 'auto' }} className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-6 md:px-10 md:py-8" aria-label="Map design home">
    <header className="flex items-end justify-between gap-5 border-b border-border pb-4 [&_h1]:font-serif [&_h1]:text-4xl [&_h1]:tracking-tight md:[&_h1]:text-4xl"><div className="flex items-center gap-3"><img src="/map-design.svg" alt="" className="size-9 shrink-0" /><h1>{t('mapDesign.home.title')}</h1></div></header>
    {agentsLoading ? <MapLoading variant="inline" label={t('common.loading')} /> : null}
    {agentsError ? <Alert variant="destructive"><AlertDescription>{agentsError}</AlertDescription></Alert> : null}
    <MapSourceForm agents={agents} onCreate={create} />
    <RecentMapProjects
      projects={projects}
      loading={projectsLoading}
      error={error}
      projectErrors={projectErrors}
      pendingProjectIds={pendingProjectIds}
      onOpenProject={onOpenProject}
      onRetryProject={(id) => void retry(id)}
      onDeleteProject={(id) => void remove(id)} onRenameProject={rename}
    />
  </section>;
}
