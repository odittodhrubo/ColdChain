import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, Check, CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/permissions';
import { useT } from '../i18n';
import { PageHeader } from '../layout/AppShell';
import { api } from '../lib/api';
import { useFridges } from '../lib/queries';
import type { Alert } from '../lib/types';
import { Button } from '../ui/Button';
import { PAGE_SIZE, Pager } from '../ui/Pager';
import { Panel } from '../ui/Panel';
import { Select } from '../ui/Select';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { useToast } from '../ui/Toast';

const PAGE = PAGE_SIZE; // 15, like the other paged lists
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
  const { t } = useT();
  const channels = Object.entries(status).filter(
    (e): e is [string, { status?: string; attempts?: number; error?: string }] =>
      typeof e[1] === 'object' && e[1] !== null,
  );
  if (channels.length === 0) return <span className="text-ink-3">{t('al.pending')}</span>;
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
            {r.status ? t(`al.delivery.${r.status}` as 'al.delivery.sent') : '–'}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AckButton({ alert }: { alert: Alert }) {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const ack = useMutation({
    mutationFn: () => api(`/api/alerts/${alert.id}/ack`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['alerts'] }),
    onError: (e: Error) => toast({ tone: 'error', title: t('al.couldNotAck'), body: e.message }),
  });
  return (
    <Button
      variant="secondary"
      loading={ack.isPending}
      icon={<Check aria-hidden className="size-4" />}
      onClick={() => ack.mutate()}
      className="min-h-9 px-2.5"
      aria-label={`${t('al.ack')}: ${alert.data.title ?? alert.type}`}
    >
      {t('al.ack')}
    </Button>
  );
}

export function AlertsPage() {
  const { t } = useT();
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
      <PageHeader title={t('page.alerts.title')} subtitle={t('page.alerts.subtitle')} />
      <Panel bodyClassName="">
        <div className="flex flex-wrap items-end gap-3 border-b border-rule p-4">
          <Select label={t('al.fStatus')} hideLabel value={status} onChange={filter(setStatus)} className="w-40">
            <option value="all">{t('al.allStatuses')}</option>
            <option value="active">{t('al.active')}</option>
            <option value="acknowledged">{t('al.acknowledged')}</option>
            <option value="resolved">{t('al.resolved')}</option>
          </Select>
          <Select label={t('al.fSeverity')} hideLabel value={severity} onChange={filter(setSeverity)} className="w-40">
            <option value="">{t('al.allSeverities')}</option>
            <option value="CRITICAL">{t('al.sev.CRITICAL')}</option>
            <option value="WARNING">{t('al.sev.WARNING')}</option>
            <option value="INFO">{t('al.sev.INFO')}</option>
          </Select>
          <Select label={t('al.fType')} hideLabel value={type} onChange={filter(setType)} className="w-52">
            <option value="">{t('al.allTypes')}</option>
            {TYPES.map((code) => (
              <option key={code}>{code}</option>
            ))}
          </Select>
          <Select label={t('al.fFridge')} hideLabel value={fridge} onChange={filter(setFridge)} className="w-44">
            <option value="">{t('al.allFridges')}</option>
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
            title={filtered ? t('al.emptyMatch') : t('al.emptyYet')}
          >
            {filtered ? t('al.emptyMatchBody') : t('al.emptyYetBody')}
          </EmptyState>
        ) : (
          <>
            <div className="relative overflow-x-auto">
              <table className="figures w-full min-w-[56rem] border-collapse text-left text-sm">
                <caption className="sr-only">Alerts, newest first</caption>
                <thead className="bg-panel-2">
                  <tr>
                    {[t('al.colAlert'), t('al.colFridge'), t('al.colRaised'), t('al.colStatus'), t('al.colDelivery')].map((h) => (
                      <th
                        key={h}
                        scope="col"
                        className="border-b border-rule px-4 py-2.5 text-xs font-semibold tracking-wide text-ink-2 uppercase"
                      >
                        {h}
                      </th>
                    ))}
                    <th scope="col" className="border-b border-rule px-4 py-2.5">
                      <span className="sr-only">{t('al.colActions')}</span>
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
                                <span className="sr-only">{t(`al.sev.${a.severity}`)}: </span>
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
                          {t(`al.status.${a.status}`)}
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
            <Pager
              page={page - 1}
              pages={pages}
              setPage={(p) => setPage(p + 1)}
              from={list.data.total ? (page - 1) * PAGE + 1 : 0}
              to={Math.min(list.data.total, page * PAGE)}
              total={list.data.total}
              label={t('page.alerts.title')}
            />
          </>
        )}
      </Panel>
    </>
  );
}
