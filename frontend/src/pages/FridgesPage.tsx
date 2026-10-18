import { FridgeCard } from '../dashboard/FridgeCard';
import { PageHeader } from '../layout/AppShell';
import { useFridges } from '../lib/queries';
import { useServerNow } from '../lib/time';
import { Panel } from '../ui/Panel';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';

export function FridgesPage() {
  const { data, isPending, error, refetch } = useFridges();
  const now = useServerNow(1000);
  return (
    <>
      <PageHeader title="Fridges" subtitle="Open a fridge for its history, events and readings" />
      {isPending ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Skeleton className="h-[26rem]" />
          <Skeleton className="h-[26rem]" />
        </div>
      ) : error ? (
        <Panel>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Panel>
      ) : data.fridges.length === 0 ? (
        <Panel>
          <EmptyState title="No fridges yet">Seed the database to register the fridges.</EmptyState>
        </Panel>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {data.fridges.map((f) => (
            <FridgeCard key={f.id} fridge={f} now={now} />
          ))}
        </div>
      )}
    </>
  );
}
