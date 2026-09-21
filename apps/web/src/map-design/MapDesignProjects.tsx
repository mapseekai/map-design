import { useI18n } from '../i18n';
import { navigationCopy } from '../i18n/locales/navigation';
import { RecentMapProjects } from './components/RecentMapProjects';
import { useMapDesignProjects } from './hooks/useMapDesignProjects';

export function MapDesignProjects({ onOpenProject }: { onOpenProject(id: string): void }) {
  const { locale } = useI18n();
  const { projects, loading, error, projectErrors, pendingProjectIds, retry, remove, rename } = useMapDesignProjects();
  return <section className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-6 py-10 md:px-10">
    <header className="flex flex-wrap items-center justify-between gap-4 [&_h1]:font-serif [&_h1]:text-4xl"><h1>{navigationCopy[locale].projects}</h1></header>
    <RecentMapProjects showHeading={false} projects={projects} loading={loading} error={error} projectErrors={projectErrors}
      pendingProjectIds={pendingProjectIds} onOpenProject={onOpenProject}
      onRetryProject={(id) => void retry(id)} onDeleteProject={(id) => void remove(id)} onRenameProject={rename} />
  </section>;
}
