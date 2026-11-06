import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MapGetContextOutput,
  MapInspectOutput,
  MapRenderPreviewOutput,
  MapRevisionHistoryOutput,
  MapValidateOutput,
} from '@mapseekai/map-design-contracts';
import type { StyleSpecification } from 'maplibre-gl';

import {
  getMapDesignContext,
  getCurrentMapDesignPreview,
  getMapDesignRevisionSnapshot,
  getMapDesignStyle,
  inspectMapDesignProject,
  listMapDesignRevisions,
  MapDesignClientError,
  validateMapDesignProject,
} from '../client';

const COHERENT_SNAPSHOT_ATTEMPTS = 3;
const CURRENT_MAP_DESIGN_PROJECT_VIEW: MapDesignProjectView = { kind: 'current' };

export type MapDesignProjectView =
  | { kind: 'current' }
  | { kind: 'historical'; revision: number };

export interface MapDesignProjectData {
  view: MapDesignProjectView;
  context: MapGetContextOutput;
  currentContext: MapGetContextOutput;
  style: StyleSpecification;
  validation: MapValidateOutput;
  revisions: MapRevisionHistoryOutput;
  inspect: MapInspectOutput;
  preview?: MapRenderPreviewOutput | null;
}

export function useMapDesignProject(
  projectId: string,
  view: MapDesignProjectView,
  seed?: MapDesignProjectData,
): { project: MapDesignProjectData | null; loading: boolean; error: boolean; reload(): Promise<void> } {
  const viewKey = mapDesignProjectViewKey(view);
  const reusableSeed = seed && mapDesignProjectViewKey(seed.view) === viewKey ? seed : null;
  const [revision, setRevision] = useState(0);
  const [project, setProject] = useState<MapDesignProjectData | null>(reusableSeed);
  const [loading, setLoading] = useState(!reusableSeed);
  const [error, setError] = useState(false);
  const generationRef = useRef(0);
  const reloadVersionRef = useRef(0);
  const reloadPendingRef = useRef(false);
  const reloadWaitersRef = useRef<Array<{ resolve(): void; reject(error: unknown): void }>>([]);
  const projectKey = projectId;
  const reload = useCallback(() => new Promise<void>((resolve, reject) => {
    reloadWaitersRef.current.push({ resolve, reject });
    reloadVersionRef.current += 1;
    if (!reloadPendingRef.current) {
      reloadPendingRef.current = true;
      setRevision((value) => value + 1);
    }
  }), []);

  useEffect(() => {
    if (reusableSeed && revision === 0 && reloadWaitersRef.current.length === 0) {
      reloadPendingRef.current = false;
      return;
    }
    const controller = new AbortController();
    const generation = ++generationRef.current;
    const reloadVersion = reloadVersionRef.current;
    reloadPendingRef.current = true;
    setLoading(true);
    setError(false);
    setProject((current) => current && mapDesignProjectViewKey(current.view) === viewKey ? current : null);
    const complete = (next: MapDesignProjectData) => {
      if (controller.signal.aborted || generation !== generationRef.current) return;
      // Finish the current read, then coalesce intervening invalidations into one fresh read.
      if (reloadVersion !== reloadVersionRef.current) {
        setRevision((value) => value + 1);
        return;
      }
      reloadPendingRef.current = false;
      setProject(next);
      setLoading(false);
      for (const waiter of reloadWaitersRef.current.splice(0)) waiter.resolve();
    };
    void (async () => {
      const selectedView = mapDesignProjectViewFromKey(viewKey);
      if (selectedView.kind === 'historical') {
        const [currentContext, revisions, snapshot] = await Promise.all([
          getMapDesignContext(projectId, controller.signal),
          listMapDesignRevisions(projectId, controller.signal),
          getMapDesignRevisionSnapshot(projectId, selectedView.revision, controller.signal),
        ]);
        complete({
          view: selectedView,
          context: currentContext,
          currentContext,
          style: snapshot.style,
          revisions,
          validation: snapshot.validation,
          inspect: snapshot.inspect,
        });
        return;
      }
      for (let attempt = 0; attempt < COHERENT_SNAPSHOT_ATTEMPTS; attempt += 1) {
        try {
          const contextBefore = await getMapDesignContext(projectId, controller.signal);
          const [style, revisions, currentPreview, validation, inspect] = await Promise.all([
            getMapDesignStyle(projectId, controller.signal),
            listMapDesignRevisions(projectId, controller.signal),
            getCurrentMapDesignPreview(projectId, controller.signal),
            validateMapDesignProject(projectId, contextBefore.draftRevision, controller.signal),
            inspectMapDesignProject(projectId, controller.signal),
          ]);
          const contextAfter = await getMapDesignContext(projectId, controller.signal);
          if (
            contextBefore.draftRevision !== contextAfter.draftRevision
            || contextBefore.styleHash !== contextAfter.styleHash
          ) continue;
          complete({
            view: CURRENT_MAP_DESIGN_PROJECT_VIEW,
            context: contextAfter,
            currentContext: contextAfter,
            style,
            revisions,
            validation,
            inspect,
            preview: currentPreview.preview,
          });
          return;
        } catch (error) {
          const canRetry = error instanceof MapDesignClientError
            && error.code === 'REVISION_CONFLICT'
            && attempt + 1 < COHERENT_SNAPSHOT_ATTEMPTS;
          if (!canRetry) throw error;
        }
      }
      throw new Error('MapDesign project changed during reload.');
    })().catch(() => {
      if (controller.signal.aborted || generation !== generationRef.current) return;
      if (reloadVersion !== reloadVersionRef.current) {
        setRevision((value) => value + 1);
        return;
      }
      reloadPendingRef.current = false;
      setError(true);
      setLoading(false);
      for (const waiter of reloadWaitersRef.current.splice(0)) waiter.reject(new Error('MapDesign project reload failed.'));
    });
    return () => controller.abort();
  }, [projectKey, revision, reusableSeed, viewKey]);

  useEffect(() => () => {
    for (const waiter of reloadWaitersRef.current.splice(0)) {
      waiter.reject(new DOMException('MapDesign project loader unmounted.', 'AbortError'));
    }
  }, []);

  const projectForRequestedView = project && mapDesignProjectViewKey(project.view) === viewKey
    ? project
    : reusableSeed;
  const requestedViewPending = project !== null && projectForRequestedView === null;
  return {
    project: projectForRequestedView,
    loading: loading || requestedViewPending,
    error: requestedViewPending ? false : error,
    reload,
  };
}

function mapDesignProjectViewKey(view: MapDesignProjectView): string {
  return view.kind === 'historical' ? `historical:${view.revision}` : 'current';
}

function mapDesignProjectViewFromKey(viewKey: string): MapDesignProjectView {
  if (viewKey === 'current') return CURRENT_MAP_DESIGN_PROJECT_VIEW;
  return { kind: 'historical', revision: Number(viewKey.slice('historical:'.length)) };
}
