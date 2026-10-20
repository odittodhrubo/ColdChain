import { Info, Truck } from 'lucide-react';
import { useState } from 'react';
import { fmt, useT } from '../i18n';
import { PageHeader } from '../layout/AppShell';
import { useServerNow } from '../lib/time';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Panel } from '../ui/Panel';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { PlanCard } from './RelocationPanel';
import { useRelocations } from './queries';

/** Dashboard: active plans first, above everything else. Renders nothing when there are none. */
export function ActivePlans() {
  const { data } = useRelocations('active');
  const now = useServerNow(1000);
  if (!data?.length) return null;
  return (
    <section aria-label="Relocation proposals" className="mb-5 flex flex-col gap-4">
      {data.map((p) => (
        <PlanCard key={p.id} plan={p} now={now} />
      ))}
    </section>
  );
}

const when = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export function RelocationsPage() {
  const { t } = useT();
  const active = useRelocations('active');
  const all = useRelocations('all');
  const now = useServerNow(1000);
  const past = (all.data ?? []).filter((p) => p.status !== 'PROPOSED' && p.status !== 'NO_SAFE_TARGET');
  const [detail, setDetail] = useState<(typeof past)[number] | null>(null);
  return (
    <>
      <PageHeader title={t('page.relocations.title')} subtitle={t('page.relocations.subtitle')} />
      {active.isPending ? (
        <Skeleton className="h-64" />
      ) : active.error ? (
        <Panel>
          <ErrorState error={active.error} onRetry={() => void active.refetch()} />
        </Panel>
      ) : active.data.length === 0 ? (
        <Panel>
          <EmptyState icon={<Truck aria-hidden className="size-6" />} title={t('rel.noNeeded')}>
            {t('rel.noNeededBody')}
          </EmptyState>
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          {active.data.map((p) => (
            <PlanCard key={p.id} plan={p} now={now} />
          ))}
        </div>
      )}
      <Panel title={t('rel.earlierPlans')} className="mt-5" bodyClassName="">
        {past.length === 0 ? (
          <EmptyState title={t('rel.noneYet')}>{t('rel.noneYetBody')}</EmptyState>
        ) : (
          <ul>
            {past.map((p) => (
              <li
                key={p.id}
                className="figures flex flex-wrap items-baseline justify-between gap-2 border-t border-rule px-4 py-2.5 text-sm first:border-t-0"
              >
                <span className="min-w-0 text-ink">
                  <span className="font-semibold">{p.from_fridge_name}</span>:{' '}
                  {fmt(t('rel.moves'), { n: p.moves.length })}
                  {p.decision_note && <span className="text-ink-2"> · {p.decision_note}</span>}
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-ink-3">
                    <span className="font-bold tracking-wide text-ink-2">{p.status}</span> ·{' '}
                    {when(p.decided_at ?? p.updated_at)}
                  </span>
                  <Button
                    variant="secondary"
                    className="min-h-9 px-2.5"
                    icon={<Info aria-hidden className="size-4" />}
                    onClick={() => setDetail(p)}
                  >
                    {t('rel.details')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {detail && (
        <Modal
          wide
          open
          onClose={() => setDetail(null)}
          title={fmt(t('rel.detailsTitle'), { f: detail.from_fridge_name })}
        >
          <div className="p-4">
            <PlanCard plan={detail} now={now} />
          </div>
        </Modal>
      )}
    </>
  );
}
