import { Refrigerator } from 'lucide-react';
import { AlertsFeed } from '../dashboard/AlertsFeed';
import { BudgetPanel } from '../dashboard/BudgetPanel';
import { FridgeCard } from '../dashboard/FridgeCard';
import { SummaryStrip } from '../dashboard/SummaryStrip';
import { PageHeader } from '../layout/AppShell';
import { useFridges } from '../lib/queries';
import { useServerNow } from '../lib/time';
import { Panel } from '../ui/Panel';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';

/** The control-room view: every fridge, every batch's heat budget, open alerts. */
export function DashboardPage() {
  const { data, isPending, error, refetch } = useFridges();
  const now = useServerNow(1000);
  const fridges = data?.fridges ?? [];

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Every fridge and batch at a glance" />
      {isPending ? (
        <div className="flex flex-col gap-5">
          <Skeleton className="h-20 w-full" />
          <div className="grid gap-5 lg:grid-cols-2">
            <Skeleton className="h-[26rem]" />
            <Skeleton className="h-[26rem]" />
          </div>
        </div>
      ) : error ? (
        <Panel>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Panel>
      ) : fridges.length === 0 ? (
        <Panel>
          <EmptyState icon={<Refrigerator aria-hidden className="size-6" />} title="No fridges yet">
            Run <code className="rounded bg-panel-2 px-1">npm run seed</code> to register the two fridges and
            their nodes.
          </EmptyState>
        </Panel>
      ) : (
        <>
          <SummaryStrip fridges={fridges} now={now} />
          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(18rem,0.75fr)]">
            {fridges.map((f) => (
              <div key={f.id} className="flex min-w-0 flex-col gap-5">
                <FridgeCard fridge={f} now={now} />
                <BudgetPanel fridge={f} now={now} />
              </div>
            ))}
            <div className="min-w-0 lg:col-span-2 xl:col-span-1">
              <AlertsFeed now={now} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
