import { Truck } from 'lucide-react';
import { PageHeader } from '../layout/AppShell';
import { useServerNow } from '../lib/time';
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
  const active = useRelocations('active');
  const all = useRelocations('all');
  const now = useServerNow(1000);
  const past = (all.data ?? []).filter((p) => p.status !== 'PROPOSED' && p.status !== 'NO_SAFE_TARGET');
  return (
    <>
      <PageHeader
        title="Relocations"
        subtitle="AI-suggested batch moves when a fridge looks unsafe; a person confirms"
      />
      {active.isPending ? (
        <Skeleton className="h-64" />
      ) : active.error ? (
        <Panel>
          <ErrorState error={active.error} onRetry={() => void active.refetch()} />
        </Panel>
      ) : active.data.length === 0 ? (
        <Panel>
          <EmptyState icon={<Truck aria-hidden className="size-6" />} title="No relocation needed">
            When a fridge is forecast to breach, its compressor is failing, or it is on a draining battery, a
            plan appears here naming each batch and a safe destination.
          </EmptyState>
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          {active.data.map((p) => (
            <PlanCard key={p.id} plan={p} now={now} />
          ))}
        </div>
      )}
      <Panel title="Earlier plans" className="mt-5" bodyClassName="">
        {past.length === 0 ? (
          <EmptyState title="None yet">Confirmed, dismissed and expired plans are kept here.</EmptyState>
        ) : (
          <ul>
            {past.map((p) => (
              <li
                key={p.id}
                className="figures flex flex-wrap items-baseline justify-between gap-2 border-t border-rule px-4 py-2.5 text-sm first:border-t-0"
              >
                <span className="min-w-0 text-ink">
                  <span className="font-semibold">{p.from_fridge_name}</span>: {p.moves.length} move
                  {p.moves.length === 1 ? '' : 's'}
                  {p.decision_note && <span className="text-ink-2"> · {p.decision_note}</span>}
                </span>
                <span className="text-xs text-ink-3">
                  <span className="font-bold tracking-wide text-ink-2">{p.status}</span> ·{' '}
                  {when(p.decided_at ?? p.updated_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
