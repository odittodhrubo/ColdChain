import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../lib/api';
import { BUDGET_S } from '../lib/constants';
import { clock } from '../lib/time';
import type { Batch } from '../lib/types';
import { Drawer } from '../ui/Drawer';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { StatusChip } from '../ui/StatusChip';

interface Exposure {
  weighted_exposure_s: number;
  demoScale: number;
  timeline: { ts: number; weighted_s: number }[];
}

/** Cumulative weighted exposure (minutes) against the 60-minute budget and the 80 % (At Risk) line. */
export function ExposureChart({ batchId }: { batchId: number }) {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['batch', batchId, 'exposure'],
    queryFn: ({ signal }) => api<Exposure>(`/api/batches/${batchId}/exposure`, { signal }),
  });
  if (isPending) return <Skeleton className="h-56 w-full" />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (data.timeline.length === 0)
    return (
      <EmptyState title="No exposure yet">
        This batch has not spent any time above 8 °C. Exposure appears here as soon as it does.
      </EmptyState>
    );
  const minutes = data.timeline.map((p) => ({ ts: p.ts, used: p.weighted_s / 60 }));
  return (
    <>
      <div
        className="h-56"
        role="img"
        aria-label={`Exposure used: ${(data.weighted_exposure_s / 60).toFixed(1)} of 60 minutes`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={minutes} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="var(--rule)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="ts"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={clock}
              stroke="var(--ink-3)"
              fontSize={11}
            />
            <YAxis
              domain={[0, Math.max(BUDGET_S / 60, Math.ceil(data.weighted_exposure_s / 60))]}
              tickFormatter={(v: number) => `${v}′`}
              stroke="var(--ink-3)"
              fontSize={11}
            />
            <ReferenceLine
              y={BUDGET_S / 60}
              stroke="var(--breach)"
              strokeDasharray="4 3"
              label={{
                value: '60 min budget',
                fill: 'var(--breach)',
                fontSize: 11,
                position: 'insideTopRight',
              }}
            />
            <ReferenceLine y={(BUDGET_S * 0.8) / 60} stroke="var(--atrisk)" strokeDasharray="2 4" />
            <Tooltip
              labelFormatter={(v) => new Date(Number(v) * 1000).toLocaleString()}
              formatter={(v) => [`${Number(v).toFixed(1)} min`, 'Used']}
              contentStyle={{ background: 'var(--panel)', border: '1px solid var(--rule)', borderRadius: 6 }}
            />
            <Area
              type="stepAfter"
              dataKey="used"
              stroke="var(--atrisk)"
              fill="var(--atrisk)"
              fillOpacity={0.15}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {data.demoScale !== 1 && (
        <p className="mt-2 text-xs font-semibold text-demo">
          Demo mode: exposure accelerated ×{data.demoScale}
        </p>
      )}
    </>
  );
}

/** Dashboard drawer: the batch's status and its exposure over time. */
export function BatchDrawer({ batch, onClose }: { batch: Batch | null; onClose: () => void }) {
  return (
    <Drawer
      open={!!batch}
      onClose={onClose}
      title={batch?.name ?? ''}
      subtitle={batch && `Lot ${batch.lot_number} · expires ${batch.expiry_date}`}
    >
      {batch && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <StatusChip status={batch.status} used={1 - batch.remaining_pct / 100} />
            <span className="figures text-sm text-ink-2">
              {Math.round(batch.remaining_pct)} % budget left · {batch.used_minutes} of 60 min used
            </span>
          </div>
          <section aria-label="Cumulative heat exposure">
            <h3 className="mb-2 text-sm font-semibold text-ink">Cumulative exposure</h3>
            <ExposureChart batchId={batch.id} />
          </section>
        </>
      )}
    </Drawer>
  );
}
