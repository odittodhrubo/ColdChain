import { useQuery } from '@tanstack/react-query';
import { ExposureChart } from '../dashboard/BatchDrawer';
import { api } from '../lib/api';
import type { Batch } from '../lib/types';
import { Drawer } from '../ui/Drawer';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { StatusChip } from '../ui/StatusChip';

interface Detail {
  batch: Batch;
  assignments: { fridge_id: string; fridge_name: string; from_ts: number; to_ts: number | null }[];
}
interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  event_type: string;
  payload: Record<string, unknown>;
}

const when = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const AUDIT_LABEL: Record<string, string> = {
  BATCH_CREATED: 'Created',
  BATCH_UPDATED: 'Edited',
  BATCH_MOVED: 'Moved',
  BATCH_STATUS_CHANGED: 'Status changed',
};

/** Where the batch has been, how much budget it used, and every audited change to it. */
export function DetailsDrawer({ batch, onClose }: { batch: Batch | null; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ['batch', batch?.id],
    enabled: !!batch,
    queryFn: ({ signal }) => api<Detail>(`/api/batches/${batch!.id}`, { signal }),
  });
  const audit = useQuery({
    queryKey: ['batch', batch?.id, 'audit'],
    enabled: !!batch,
    queryFn: ({ signal }) =>
      api<{ entries: AuditEntry[] }>(`/api/audit?batch_id=${batch!.id}&pageSize=50`, { signal }),
  });
  return (
    <Drawer
      open={!!batch}
      onClose={onClose}
      title={batch?.name ?? ''}
      subtitle={batch && `Lot ${batch.lot_number} · ${batch.manufacturer} · expires ${batch.expiry_date}`}
    >
      {batch && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <StatusChip status={batch.status} used={1 - batch.remaining_pct / 100} />
            <span className="figures text-sm text-ink-2">
              {batch.quantity} doses · {Math.round(batch.remaining_pct)} % budget left · {batch.used_minutes}{' '}
              min used
            </span>
          </div>
          <section aria-labelledby={`hist-${batch.id}`}>
            <h3 id={`hist-${batch.id}`} className="mb-2 text-sm font-semibold text-ink">
              Assignment history
            </h3>
            {detail.isPending ? (
              <Skeleton className="h-16" />
            ) : detail.error ? (
              <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
            ) : (
              <ol className="flex flex-col gap-2">
                {detail.data.assignments.map((a) => (
                  <li
                    key={a.from_ts}
                    className="figures flex items-center justify-between gap-3 rounded-md bg-panel-2 px-3 py-2 text-sm"
                  >
                    <span className="font-semibold text-ink">{a.fridge_name}</span>
                    <span className="text-xs text-ink-2">
                      {when(a.from_ts)} → {a.to_ts ? when(a.to_ts) : 'now'}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-label="Cumulative heat exposure">
            <h3 className="mb-2 text-sm font-semibold text-ink">Heat exposure</h3>
            <ExposureChart batchId={batch.id} />
          </section>
          <section aria-labelledby={`audit-${batch.id}`}>
            <h3 id={`audit-${batch.id}`} className="mb-2 text-sm font-semibold text-ink">
              Audit trail
            </h3>
            {audit.isPending ? (
              <Skeleton className="h-24" />
            ) : audit.error ? (
              <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
            ) : audit.data.entries.length === 0 ? (
              <EmptyState title="No audit entries" />
            ) : (
              <ol className="flex flex-col">
                {audit.data.entries.map((e) => (
                  <li key={e.id} className="figures border-t border-rule py-2 text-sm first:border-t-0">
                    <span className="font-semibold text-ink">
                      {AUDIT_LABEL[e.event_type] ?? e.event_type}
                    </span>
                    <span className="text-ink-2">
                      {' '}
                      {e.event_type === 'BATCH_MOVED'
                        ? `${String(e.payload.from)} → ${String(e.payload.to)}`
                        : e.event_type === 'BATCH_STATUS_CHANGED'
                          ? `${String(e.payload.from)} → ${String(e.payload.to)}`
                          : ''}
                    </span>
                    <span className="block text-xs text-ink-3">
                      #{e.id} · {when(e.ts)} · {e.actor}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </Drawer>
  );
}
