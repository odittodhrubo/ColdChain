import { useState } from 'react';
import { useT } from '../i18n';
import { useFridgeBatches } from '../lib/queries';
import type { Batch, Fridge } from '../lib/types';
import { Panel } from '../ui/Panel';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { StatusChip } from '../ui/StatusChip';
import { BatchDrawer } from './BatchDrawer';
import { accrual, budgetTone } from './logic';

const TONE_INK = {
  safe: 'var(--safe)',
  warning: 'var(--warning)',
  atrisk: 'var(--atrisk)',
  breach: 'var(--breach)',
};

/** Remaining heat budget as a bar: green, amber from 50 %, orange below 20 %, red (struck) at 0. */
export function BudgetBar({ remaining }: { remaining: number }) {
  const tone = budgetTone(remaining);
  return (
    <span
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(remaining)}
      aria-label="Heat budget remaining"
      data-tone={tone}
      className={`relative block h-2 w-full overflow-hidden rounded-full bg-panel-2 ring-1 ring-rule ring-inset ${
        tone === 'breach' ? 'strike-pattern' : ''
      }`}
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out"
        style={{ width: `${Math.max(0, Math.min(100, remaining))}%`, background: TONE_INK[tone] }}
      />
    </span>
  );
}

/** Every batch in the fridge, lowest remaining budget first; a row opens its exposure chart. */
export function BudgetPanel({ fridge, now }: { fridge: Fridge; now: number }) {
  const { t } = useT();
  const { data, isPending, error, refetch } = useFridgeBatches(fridge.id);
  const [open, setOpen] = useState<Batch | null>(null);
  const mode = accrual(fridge, now);
  const rows = [...(data?.batches ?? [])].sort((a, b) => a.remaining_pct - b.remaining_pct);

  return (
    <Panel title={`${t('budget.title')} · ${fridge.name}`} bodyClassName="px-2 pb-2">
      {isPending ? (
        <div className="flex flex-col gap-2 p-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : error ? (
        <div className="px-2">
          <ErrorState error={error} onRetry={() => void refetch()} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title={t('budget.emptyTitle')}>{t('budget.emptyBody')}</EmptyState>
      ) : (
        <ul className="flex flex-col">
          {rows.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => setOpen(b)}
                className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 rounded-md px-2 py-2.5 text-left hover:bg-panel-2"
              >
                <span className="min-w-0">
                  <span
                    className={`block truncate text-sm font-semibold text-ink ${b.status === 'DISCARD' ? 'line-through decoration-2' : ''}`}
                  >
                    {b.name}
                  </span>
                  <span className="figures block text-xs text-ink-3">
                    {t('budget.lot')} {b.lot_number}
                  </span>
                </span>
                <StatusChip status={b.status} used={1 - b.remaining_pct / 100} size="sm" />
                <span className="col-span-2 flex items-center gap-3">
                  <BudgetBar remaining={b.remaining_pct} />
                  <span className="figures w-40 shrink-0 text-right text-xs text-ink-2">
                    {t('budget.used')
                      .replace('{p}', String(Math.round(b.remaining_pct)))
                      .replace('{u}', String(b.used_minutes))}
                  </span>
                </span>
                <span className="col-span-2 text-xs text-ink-3">
                  {b.status === 'DISCARD' ? t('budget.discardRow') : t(`accrual.${mode}`)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <BatchDrawer batch={open} onClose={() => setOpen(null)} />
    </Panel>
  );
}
