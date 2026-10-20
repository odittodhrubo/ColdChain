import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '../layout/AppShell';
import { useAuth } from '../auth/AuthProvider';
import { fmt, useT } from '../i18n';
import { can } from '../auth/permissions';
import { api, ApiError } from '../lib/api';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { ago, useServerNow } from '../lib/time';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Panel';
import { Select } from '../ui/Select';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';

const REASONS = ['BAD_JSON', 'UNKNOWN_DEVICE', 'STALE_TS', 'BAD_SIG', 'REPLAY', 'BAD_BODY'] as const;

interface SecurityEvent {
  id: number;
  ts: number; // unix s
  device_id: string | null;
  reason: string;
  topic: string | null;
  size: number | null;
  sample_hash: string | null;
  detail: Record<string, unknown> | null;
}
interface Summary {
  accepted: number;
  rejected: number;
  by_reason: { reason: string; n: number }[];
  devices: {
    device_id: string;
    fridge_id: string;
    active: boolean;
    last_seen_at: number | null;
    open_gap: { from: number; to: number } | null;
    clock_skew_s: number | null;
    rotation_pending?: boolean; // S7: the new secret is sent, the device has not confirmed it yet
    secret_rotated_at?: number | null;
  }[];
  server_time: number;
}

/** Rows that belong to a burst: 5+ rejects with the same device and reason within one minute. */
export function burstIds(events: SecurityEvent[]): Set<number> {
  const out = new Set<number>();
  const groups = new Map<string, SecurityEvent[]>();
  for (const e of events)
    groups.set(`${e.device_id}|${e.reason}`, [...(groups.get(`${e.device_id}|${e.reason}`) ?? []), e]);
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < sorted.length; i++) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1].ts - sorted[i].ts <= 60) j++;
      if (j - i + 1 >= 5) for (let k = i; k <= j; k++) out.add(sorted[k].id);
    }
  }
  return out;
}

/** S7: the server makes a new secret (never shown), seals it under the current one and sends it to the node. */
function RotateSecret({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [why, setWhy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rotate = useMutation({
    mutationFn: () =>
      api(`/api/devices/${encodeURIComponent(deviceId)}/rotate-secret`, {
        method: 'POST',
        body: { reason: why.trim() },
      }),
    onSuccess: () => {
      toast({
        tone: 'success',
        title: fmt(t('rotate.sent'), { id: deviceId }),
        body: t('rotate.sentBody'),
      });
      void qc.invalidateQueries({ queryKey: ['security', 'summary'] });
      onClose();
    },
    onError: (e) =>
      setError(
        e instanceof ApiError && e.code === 'ROTATION_PENDING'
          ? t('rotate.pending')
          : e instanceof Error
            ? e.message
            : t('rotate.notStarted'),
      ),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={fmt(t('rotate.title'), { id: deviceId })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={rotate.isPending}>
            {t('rotate.cancel')}
          </Button>
          <Button
            type="submit"
            form="rotate-form"
            variant="danger"
            loading={rotate.isPending}
            icon={<KeyRound aria-hidden className="size-4" />}
          >
            {t('rotate.rotate')}
          </Button>
        </>
      }
    >
      <form
        id="rotate-form"
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (why.trim().length < 3) return setError(t('rotate.sayWhy'));
          setError(null);
          rotate.mutate();
        }}
      >
        <p className="text-sm text-ink">{t('rotate.body')}</p>
        <Field
          label={t('rotate.reasonLabel')}
          value={why}
          onChange={(e) => setWhy(e.target.value)}
          error={error}
          autoComplete="off"
        />
      </form>
    </Modal>
  );
}

export function SecurityPage() {
  const { t } = useT();
  const { user } = useAuth();
  const canRotate = can(user?.role, 'device:manage');
  const [rotating, setRotating] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [device, setDevice] = useState('');
  const [page, setPage] = useState(1);
  const summary = useQuery({
    queryKey: ['security', 'summary'],
    queryFn: ({ signal }) => api<Summary>('/api/security/summary', { signal }),
  });
  const events = useQuery({
    queryKey: ['security', 'events', reason, device, page],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => {
      const qs = new URLSearchParams({ page: String(page), pageSize: '50' });
      if (reason) qs.set('reason', reason);
      if (device) qs.set('device_id', device);
      return api<{ events: SecurityEvent[]; total: number }>(`/api/security/events?${qs}`, { signal });
    },
  });
  const bursts = burstIds(events.data?.events ?? []);
  const now = useServerNow(15_000);
  const pages = Math.max(1, Math.ceil((events.data?.total ?? 0) / 50));

  return (
    <>
      <PageHeader title={t('page.security.title')} subtitle={t('page.security.subtitle')} />
      <section aria-label="Last hour" className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summary.isPending ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)
        ) : summary.error ? (
          <Panel className="sm:col-span-2 xl:col-span-4">
            <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
          </Panel>
        ) : (
          <>
            <Panel bodyClassName="p-4">
              <p className="text-xs font-semibold text-ink-3">{t('sec.accepted')}</p>
              <p className="figures mt-1 flex items-center gap-2 text-2xl font-bold text-safe">
                <ShieldCheck aria-hidden className="size-5" />
                {summary.data.accepted}
              </p>
            </Panel>
            <Panel bodyClassName="p-4">
              <p className="text-xs font-semibold text-ink-3">{t('sec.rejected')}</p>
              <p
                className="figures mt-1 flex items-center gap-2 text-2xl font-bold"
                style={{ color: summary.data.rejected ? 'var(--breach)' : 'var(--ink-3)' }}
              >
                <ShieldAlert aria-hidden className="size-5" />
                {summary.data.rejected}
              </p>
              <p className="figures mt-1 text-xs text-ink-2">
                {summary.data.by_reason.map((r) => `${r.reason} ${r.n}`).join(' · ') || t('sec.none')}
              </p>
            </Panel>
            <Panel bodyClassName="p-4" className="sm:col-span-2">
              <p className="text-xs font-semibold text-ink-3">{t('sec.devices')}</p>
              <ul className="mt-1 flex flex-col gap-1">
                {summary.data.devices.map((d) => (
                  <li key={d.device_id} className="figures flex flex-wrap justify-between gap-2 text-sm">
                    <span className="font-semibold text-ink">
                      {d.device_id}
                      {!d.active && <span className="ml-2 text-xs text-offline">{t('sec.inactive')}</span>}
                    </span>
                    <span className="text-ink-2">
                      {d.last_seen_at
                        ? fmt(t('sec.lastAccepted'), { t: ago((now - d.last_seen_at) / 1000, t) })
                        : t('sec.neverSeen')}
                      {d.open_gap && (
                        <span className="ml-2 font-semibold text-warning">
                          {fmt(t('sec.seqGap'), { from: d.open_gap.from, to: d.open_gap.to })}
                        </span>
                      )}
                      {d.rotation_pending ? (
                        <span className="ml-2 font-semibold text-warning">{t('sec.rotationPending')}</span>
                      ) : (
                        d.secret_rotated_at && (
                          <span className="ml-2">
                            {fmt(t('sec.secretRotated'), { t: ago((now - d.secret_rotated_at) / 1000, t) })}
                          </span>
                        )
                      )}
                      {d.clock_skew_s !== null && (
                        <span
                          className={`ml-2 ${Math.abs(d.clock_skew_s) > 10 ? 'font-semibold text-warning' : ''}`}
                          title={t('sec.clockSkewTitle')}
                        >
                          {fmt(t('sec.clockSkew'), {
                            v: `${d.clock_skew_s > 0 ? '+' : ''}${d.clock_skew_s}`,
                          })}
                        </span>
                      )}
                      {canRotate && d.active && !d.rotation_pending && (
                        <Button
                          variant="ghost"
                          className="ml-2 min-h-8 px-2"
                          icon={<KeyRound aria-hidden className="size-4" />}
                          onClick={() => setRotating(d.device_id)}
                          aria-label={fmt(t('sec.rotateAria'), { id: d.device_id })}
                        >
                          {t('sec.rotateSecret')}
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </>
        )}
      </section>

      <Panel title={t('sec.rejectedTitle')} bodyClassName="">
        <div className="flex flex-wrap items-end gap-3 border-b border-rule p-4">
          <Select
            label={t('sec.reason')}
            hideLabel
            value={reason}
            onChange={(e) => (setReason(e.target.value), setPage(1))}
            className="w-56"
          >
            <option value="">{t('sec.allReasons')}</option>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          <Select
            label={t('sec.device')}
            hideLabel
            value={device}
            onChange={(e) => (setDevice(e.target.value), setPage(1))}
            className="w-44"
          >
            <option value="">{t('sec.allDevices')}</option>
            {summary.data?.devices.map((d) => (
              <option key={d.device_id} value={d.device_id}>
                {d.device_id}
              </option>
            ))}
          </Select>
          <span className="ml-auto text-xs text-ink-3">{t('sec.liveNote')}</span>
        </div>
        {events.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : events.error ? (
          <div className="px-4">
            <ErrorState error={events.error} onRetry={() => void events.refetch()} />
          </div>
        ) : events.data.events.length === 0 ? (
          <EmptyState icon={<ShieldCheck aria-hidden className="size-6" />} title={t('sec.empty')}>
            {t('sec.emptyBody')}{' '}
            <code className="rounded bg-panel-2 px-1 whitespace-nowrap">
              python -m coldchain_tools.attack replay --own
            </code>
          </EmptyState>
        ) : (
          <>
            <div className="relative overflow-x-auto">
              <table className="figures w-full min-w-[44rem] border-collapse text-left text-sm">
                <caption className="sr-only">Rejected device messages</caption>
                <thead className="bg-panel-2">
                  <tr>
                    {[t('sec.colTime'), t('sec.colDevice'), t('sec.colReason'), t('sec.colTopic'), t('sec.colSize')].map((h) => (
                      <th
                        key={h}
                        scope="col"
                        className="border-b border-rule px-4 py-2.5 text-xs font-semibold tracking-wide text-ink-2 uppercase"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {events.data.events.map((e) => {
                    const burst = bursts.has(e.id);
                    return (
                      <tr
                        key={e.id}
                        className={`border-b border-rule last:border-b-0 ${burst ? 'bg-breach-wash' : ''}`}
                      >
                        <td className="px-4 py-2.5 whitespace-nowrap text-ink">
                          {new Date(e.ts * 1000).toLocaleString()}
                        </td>
                        <td className="px-4 py-2.5 text-ink">{e.device_id ?? t('sec.unknown')}</td>
                        <td className="px-4 py-2.5">
                          <span className="font-semibold text-breach">{e.reason}</span>
                          {burst && (
                            <span className="ml-2 rounded-full bg-breach px-2 py-0.5 text-xs font-bold text-on-breach">
                              {t('sec.burst')}
                            </span>
                          )}
                          <span className="block text-xs text-ink-2">
                            {t(`sec.reason.${e.reason}` as 'sec.reason.BAD_SIG')}
                            {typeof e.detail?.skew_s === 'number' &&
                              ` · ${fmt(t('sec.skewDetail'), { v: e.detail.skew_s })}`}
                          </span>
                        </td>
                        <td
                          className="max-w-[16rem] truncate px-4 py-2.5 text-xs text-ink-2"
                          title={e.topic ?? ''}
                        >
                          {e.topic}
                        </td>
                        <td className="px-4 py-2.5 text-ink-2">{e.size} B</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-rule px-4 py-3 text-sm text-ink-2">
              <span className="figures">
                {fmt(t('sec.total'), { total: events.data.total, page, pages })}
              </span>
              <span className="flex gap-2">
                <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  {t('sec.newer')}
                </Button>
                <Button variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                  {t('sec.older')}
                </Button>
              </span>
            </div>
          </>
        )}
      </Panel>
      {rotating && <RotateSecret deviceId={rotating} onClose={() => setRotating(null)} />}
    </>
  );
}
