import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, Check, CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/permissions';
import { PageHeader } from '../layout/AppShell';
import { api } from '../lib/api';
import { useFridges } from '../lib/queries';
import type { Alert } from '../lib/types';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Panel';
import { Select } from '../ui/Select';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { useToast } from '../ui/Toast';

const PAGE = 50;
const TYPES = [
  'DOOR_OPEN_LONG', 'FRIDGE_BREACH', 'POWER_FAILURE', 'BATTERY_LOW', 'FRIDGE_OFFLINE', 'BATCH_AT_RISK',
  'BATCH_DISCARD', 'PREDICTED_BREACH', 'COMPRESSOR_WEAK', 'RELOCATION_PROPOSED', 'SECURITY_FLOOD',
]; // prettier-ignore
const SEVERITY = {
  CRITICAL: { ink: 'var(--breach)', icon: CircleAlert, label: 'Critical' },
  WARNING: { ink: 'var(--warning)', icon: TriangleAlert, label: 'Warning' },
  INFO: { ink: 'var(--teal)', icon: Info, label: 'Info' },
} as const;
const STATUS_INK = {
  ACTIVE: 'var(--breach)',
  ACKNOWLEDGED: 'var(--warning)',
  RESOLVED: 'var(--ink-3)',
} as const;
const DELIVERY_INK: Record<string, string> = {
  sent: 'var(--safe)',
  failed: 'var(--breach)',
  skipped: 'var(--ink-3)',
};

/** Per-channel delivery (in-app, email, SMS…): the notifier's last result for each. */
function Delivery({ status }: { status: Alert['delivery_status'] }) {
  const channels = Object.entries(status).filter(
    (e): e is [string, { status?: string; attempts?: number; error?: string }] =>
      typeof e[1] === 'object' && e[1] !== null,
  );
  if (channels.length === 0) return <span className="text-ink-3">pending</span>;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1">
      {channels.map(([ch, r]) => (
        <li
          key={ch}
          title={r.error ?? (r.attempts ? `${r.attempts} attempt(s)` : undefined)}
          className="whitespace-nowrap"
        >
          <span className="text-ink-2">{ch.replace('_', '-')}</span>{' '}
          <span className="font-semibold" style={{ color: DELIVERY_INK[r.status ?? ''] ?? 'var(--ink-2)' }}>
            {r.status ?? '–'}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AckButton({ alert }: { alert: Alert }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ack = useMutation({
    mutationFn: () => api(`/api/alerts/${alert.id}/ack`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['alerts'] }),
    onError: (e: Error) => toast({ tone: 'error', title: 'Could not acknowledge', body: e.message }),
  });
  return (
    <Button
      variant="secondary"
      loading={ack.isPending}
      icon={<Check aria-hidden className="size-4" />}
      onClick={() => ack.mutate()}
      className="min-h-9 px-2.5"
      aria-label={`Acknowledge ${alert.data.title ?? alert.type}`}
    >
      Ack
    </Button>
  );
}

export function AlertsPage() {
  const { user } = useAuth();
  const canAck = can(user?.role, 'alert:ack');
  const fridges = useFridges();
  const [status, setStatus] = useState('all');
  const [severity, setSeverity] = useState('');
  const [type, setType] = useState('');
  const [fridge, setFridge] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['alerts', 'history', status, severity, type, fridge, page],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => {
      const qs = new URLSearchParams({ status, page: String(page), pageSize: String(PAGE) });
      if (severity) qs.set('severity', severity);
      if (type) qs.set('type', type);
      if (fridge) qs.set('fridge_id', fridge);
      return api<{ alerts: Alert[]; total: number }>(`/api/alerts?${qs}`, { signal });
    },
  });
  const filter = (set: (v: string) => void) => (e: { target: { value: string } }) => (
    set(e.target.value),
    setPage(1)
  );
  const filtered = status !== 'all' || severity || type || fridge;
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE));

  return (
    <>
      <PageHeader title="Alerts" subtitle="Door, power, breach and budget alerts, open and past" />
      <Panel bodyClassName="">
        <div className="flex flex-wrap items-end gap-3 border-b border-rule p-4">
          <Select label="Status" hideLabel value={status} onChange={filter(setStatus)} className="w-40">
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
          </Select>
          <Select label="Severity" hideLabel value={severity} onChange={filter(setSeverity)} className="w-40">
            <option value="">All severities</option>
            <option value="CRITICAL">Critical</option>
            <option value="WARNING">Warning</option>
            <option value="INFO">Info</option>
          </Select>
          <Select label="Type" hideLabel value={type} onChange={filter(setType)} className="w-52">
            <option value="">All types</option>
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
          <Select label="Fridge" hideLabel value={fridge} onChange={filter(setFridge)} className="w-44">
            <option value="">All fridges</option>
            {fridges.data?.fridges.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </div>
        {list.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : list.error ? (
          <div className="px-4">
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : list.data.alerts.length === 0 ? (
          <EmptyState
            icon={<BellOff aria-hidden className="size-6" />}
            title={filtered ? 'No alerts match' : 'No alerts yet'}
          >
            {filtered
              ? 'Clear a filter to see more.'
              : 'Door, power, temperature and heat-budget problems are raised here.'}
          </EmptyState>
        ) : (
          <>
            <div className="relative overflow-x-auto">
              <table className="figures w-full min-w-[56rem] border-collapse text-left text-sm">
                <caption className="sr-only">Alerts, newest first</caption>
                <thead className="bg-panel-2">
                  <tr>
                    {['Alert', 'Fridge', 'Raised', 'Status', 'Delivery'].map((h) => (
                      <th
                        key={h}
                        scope="col"
                        className="border-b border-rule px-4 py-2.5 text-xs font-semibold tracking-wide text-ink-2 uppercase"
                      >
                        {h}
                      </th>
                    ))}
                    <th scope="col" className="border-b border-rule px-4 py-2.5">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.alerts.map((a) => {
                    const sev = SEVERITY[a.severity];
                    const Icon = sev.icon;
                    return (
                      <tr key={a.id} className="border-b border-rule align-top last:border-b-0">
                        <td className="px-4 py-3">
                          <span className="flex items-start gap-2">
                            <Icon aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: sev.ink }} />
                            <span className="min-w-0">
                              <span className="block font-semibold text-ink">
                                <span className="sr-only">{sev.label}: </span>
                                {a.data.title ?? a.type}
                              </span>
                              {a.data.lines?.map((l, i) => (
                                <span key={i} className="block text-xs text-ink-2">
                                  {l}
                                </span>
                              ))}
                              <span className="block text-xs text-ink-3">{a.type}</span>
                            </span>
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {a.fridge_id ? (
                            <Link
                              to={`/fridges/${a.fridge_id}`}
                              className="font-medium whitespace-nowrap text-teal-strong underline"
                            >
                              {a.fridge_id}
                            </Link>
                          ) : (
                            <span className="text-ink-3">–</span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-ink-2">
                          {new Date(a.created_at).toLocaleString()}
                        </td>
                        <td
                          className="px-4 py-3 text-xs font-bold tracking-wide"
                          style={{ color: STATUS_INK[a.status] }}
                        >
                          {a.status}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <Delivery status={a.delivery_status} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          {canAck && a.status === 'ACTIVE' && <AckButton alert={a} />}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-rule px-4 py-3 text-sm text-ink-2">
              <span className="figures">
                {list.data.total} alerts · page {page} of {pages}
              </span>
              <span className="flex gap-2">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Newer
                </Button>
                <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                  Older
                </Button>
              </span>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
