import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
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
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { StatusChip } from '../ui/StatusChip';

interface Exposure {
  weighted_exposure_s: number;
  remaining_pct: number;
  used_minutes: number;
  demoScale: number;
  timeline: { ts: number; weighted_s: number }[];
}

/** Side drawer (native dialog) with the batch's cumulative exposure against its 60-minute budget. */
export function BatchDrawer({ batch, onClose }: { batch: Batch | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    // showModal where supported; a plain open attribute elsewhere (old browsers, jsdom)
    if (batch && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
    if (!batch && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
  }, [batch]);
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['batch', batch?.id, 'exposure'],
    queryFn: ({ signal }) => api<Exposure>(`/api/batches/${batch!.id}/exposure`, { signal }),
    enabled: !!batch,
  });

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-0 ml-auto h-dvh max-h-dvh w-[min(34rem,100vw)] max-w-none border-l border-rule bg-panel p-0 text-ink shadow-[0_0_48px_rgb(15_27_42/0.25)] backdrop:bg-[rgb(10_18_28/0.4)]"
    >
      {batch && (
        <div className="flex h-full flex-col">
          <header className="flex items-start justify-between gap-3 border-b border-rule px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="truncate text-lg font-bold">
                {batch.name}
              </h2>
              <p className="figures text-sm text-ink-2">
                Lot {batch.lot_number} · expires {batch.expiry_date}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid size-10 cursor-pointer place-items-center rounded-md text-ink-2 hover:bg-panel-2 hover:text-ink"
            >
              <X aria-hidden className="size-5" />
            </button>
          </header>
          <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <StatusChip status={batch.status} used={1 - batch.remaining_pct / 100} />
              <span className="figures text-sm text-ink-2">
                {Math.round(batch.remaining_pct)} % budget left · {batch.used_minutes} of 60 min used
              </span>
            </div>
            <section aria-label="Cumulative heat exposure">
              <h3 className="mb-2 text-sm font-semibold text-ink">Cumulative exposure</h3>
              {isPending ? (
                <Skeleton className="h-56 w-full" />
              ) : error ? (
                <ErrorState error={error} onRetry={() => void refetch()} />
              ) : !data || data.timeline.length === 0 ? (
                <EmptyState title="No exposure yet">
                  This batch has not spent any time above 8 °C. Exposure appears here as soon as it does.
                </EmptyState>
              ) : (
                <>
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={data.timeline} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
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
                          dataKey={(p: { weighted_s: number }) => p.weighted_s / 60}
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
                        <ReferenceLine
                          y={(BUDGET_S * 0.8) / 60}
                          stroke="var(--atrisk)"
                          strokeDasharray="2 4"
                        />
                        <Tooltip
                          labelFormatter={(v) => new Date(Number(v) * 1000).toLocaleString()}
                          formatter={(v) => [`${(Number(v) / 60).toFixed(1)} min`, 'Used']}
                          contentStyle={{
                            background: 'var(--panel)',
                            border: '1px solid var(--rule)',
                            borderRadius: 6,
                          }}
                        />
                        <Area
                          type="stepAfter"
                          dataKey={(p: { weighted_s: number }) => p.weighted_s / 60}
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
              )}
            </section>
          </div>
        </div>
      )}
    </dialog>
  );
}
