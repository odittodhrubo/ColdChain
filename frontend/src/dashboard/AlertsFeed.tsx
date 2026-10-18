import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/permissions';
import { api } from '../lib/api';
import { useActiveAlerts } from '../lib/queries';
import { ago } from '../lib/time';
import type { Alert } from '../lib/types';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Panel';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { useToast } from '../ui/Toast';

const SEVERITY = {
  CRITICAL: { ink: 'var(--breach)', icon: CircleAlert, label: 'Critical' },
  WARNING: { ink: 'var(--warning)', icon: TriangleAlert, label: 'Warning' },
  INFO: { ink: 'var(--teal)', icon: CircleAlert, label: 'Info' },
} as const;

function AlertRow({ alert, now }: { alert: Alert; now: number }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const ack = useMutation({
    mutationFn: () => api(`/api/alerts/${alert.id}/ack`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['alerts'] }),
    onError: (e: Error) => toast({ tone: 'error', title: 'Could not acknowledge', body: e.message }),
  });
  const sev = SEVERITY[alert.severity];
  const Icon = sev.icon;
  return (
    <li className="flex items-start gap-3 border-t border-rule px-4 py-3 first:border-t-0">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: sev.ink }} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">
          <span className="sr-only">{sev.label}: </span>
          {alert.data.title ?? alert.type}
        </p>
        <p className="figures mt-0.5 text-xs text-ink-3">
          {ago((now - alert.created_at) / 1000)}
          {alert.fridge_id && (
            <>
              {' · '}
              <Link to={`/fridges/${alert.fridge_id}`} className="font-medium text-teal-strong underline">
                {alert.fridge_id}
              </Link>
            </>
          )}
        </p>
      </div>
      {can(user?.role, 'alert:ack') && (
        <Button
          variant="secondary"
          loading={ack.isPending}
          icon={<Check aria-hidden className="size-4" />}
          onClick={() => ack.mutate()}
          className="min-h-9 px-2.5"
        >
          Ack
        </Button>
      )}
    </li>
  );
}

export function AlertsFeed({ now }: { now: number }) {
  const { data, isPending, error, refetch } = useActiveAlerts(8);
  return (
    <Panel
      title="Open alerts"
      bodyClassName=""
      actions={
        <Link to="/alerts" className="text-sm font-semibold text-teal-strong underline">
          All alerts
        </Link>
      }
    >
      {isPending ? (
        <div className="flex flex-col gap-2 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : error ? (
        <div className="px-4">
          <ErrorState error={error} onRetry={() => void refetch()} />
        </div>
      ) : !data || data.alerts.length === 0 ? (
        <EmptyState title="No open alerts">
          Door, power, temperature and budget alerts appear here the moment they fire.
        </EmptyState>
      ) : (
        <ul>
          {data.alerts.map((a) => (
            <AlertRow key={a.id} alert={a} now={now} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
