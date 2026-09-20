import type { MapRevisionHistoryOutput } from '@mapseekai/map-design-contracts';
import { Badge, Button, Empty, EmptyDescription } from '@mapseekai/components';
import { GitCommitHorizontal } from 'lucide-react';
import { useI18n } from '../../i18n';
import { revisionViewCopy } from '../../i18n/locales/revision-view';

export function MapDesignRevisionPanel({ revisions, canCommit, committing, currentCommittedRevision, selectedRevision, onCommit, onViewRevision }: {
  revisions: MapRevisionHistoryOutput; canCommit: boolean; committing: boolean;
  currentCommittedRevision: number | null; selectedRevision: number | null;
  onCommit(): void;
  onViewRevision(revision: number): void;
}) {
  const { t, locale } = useI18n();
  return <section className="flex flex-col gap-3 p-3" aria-label={t('mapDesign.studio.revisions')}>
    <Button variant="outline" size="sm" type="button" disabled={!canCommit || committing} onClick={onCommit}>
      <GitCommitHorizontal data-icon="inline-start" />
      {committing ? t('mapDesign.studio.committing') : t('mapDesign.studio.commit')}
    </Button>
    <ol className="grid list-none gap-2 p-0 [&>li]:grid [&>li]:grid-cols-[minmax(0,1fr)_auto] [&>li]:items-center [&>li]:gap-2 [&>li]:rounded-md [&>li]:border [&>li]:bg-card [&>li]:p-2.5 [&>li[aria-current=true]]:border-s-4 [&>li[aria-current=true]]:border-s-primary [&_code]:col-span-full [&_code]:text-[10px] [&_code]:text-muted-foreground">
      {revisions.revisions.length === 0 ? <li><Empty className="col-span-full"><EmptyDescription>{t('mapDesign.studio.revisionsEmpty')}</EmptyDescription></Empty></li>
        : revisions.revisions.map((revision) => <li key={revision.revision} aria-current={selectedRevision === revision.revision || undefined}>
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <strong>{t('mapDesign.studio.revision')} {revision.revision}</strong>
            {selectedRevision === revision.revision ? <Badge variant="secondary" data-selected="true">{t('mapDesign.revision.viewing')}</Badge> : null}
          </div>
          <span>{new Date(revision.committedAt).toLocaleString()}</span>
          <code>{revision.styleHash.slice(0, 10)}</code>
          <div className="col-span-full flex items-center justify-between gap-2">
          {currentCommittedRevision === revision.revision ? <Badge>{t('mapDesign.revision.currentCommit')}</Badge> : <span />}
          <Button type="button" variant="outline" size="sm" disabled={selectedRevision === revision.revision}
            aria-label={t('mapDesign.revision.view', { revision: revision.revision })}
            onClick={() => onViewRevision(revision.revision)}>
            {revisionViewCopy[locale]}
          </Button>
          </div>
        </li>)}
    </ol>
  </section>;
}
