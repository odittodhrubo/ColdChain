import { useQuery } from '@tanstack/react-query';
import { Bell, Clock, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { ago } from '../lib/time';
import type { Fridge } from '../lib/types';
import type { Status } from '../ui/status';
import { STATUS } from '../ui/status';
import { VvmMark } from '../ui/VvmMark';
import { fridgeStatus } from './logic';

function Count({ status, n }: { status: Status; n: number }) {
  return (
    <span
      className="figures inline-flex items-center gap-1.5 text-sm"
      style={{ color: n ? STATUS[status].ink : 'var(--ink-3)' }}
    >
      <VvmMark status={status} size={14} />
      <span className="font-bold">{n}</span>
      <span className={n ? 'font-medium' : ''}>{STATUS[status].label}</span>
    </span>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-4 py-3">
      <span className="text-xs font-semibold text-ink-3">{label}</span>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">{children}</div>
    </div>
  );
}

/** The whole cold room in one line: fridges, batches, open alerts, offline nodes, data freshness. */
export function SummaryStrip({ fridges, now }: { fridges: Fridge[]; now: number }) {
  const alerts = useQuery({
    queryKey: ['alerts', 'summary'],
    queryFn: async ({ signal }) => {
      const [active, critical] = await Promise.all([
        api<{ total: number }>('/api/alerts?status=active&pageSize=1', { signal }),
        api<{ total: number }>('/api/alerts?status=active&severity=CRITICAL&pageSize=1', { signal }),
      ]);
      return { active: active.total, critical: critical.total };
    },
  });
  const statuses = fridges.map((f) => fridgeStatus(f, now));
  const n = (s: Status) => statuses.filter((x) => x === s).length;
  const batches = fridges.reduce(
    (acc, f) => ({
      SAFE: acc.SAFE + (f.batch_counts.SAFE ?? 0),
      AT_RISK: acc.AT_RISK + (f.batch_counts.AT_RISK ?? 0),
      DISCARD: acc.DISCARD + (f.batch_counts.DISCARD ?? 0),
    }),
    { SAFE: 0, AT_RISK: 0, DISCARD: 0 },
  );
  const lastSeen = Math.max(0, ...fridges.map((f) => f.live?.last_seen ?? 0));
  const offline = n('OFFLINE');

  return (
    <section
      aria-label="Summary"
      className="mb-5 grid grid-cols-1 divide-y divide-rule rounded-[var(--radius-label)] border border-rule bg-panel sm:grid-cols-2 sm:divide-y-0 xl:grid-cols-[1.2fr_1.2fr_0.8fr_0.8fr_0.9fr] xl:divide-x"
    >
      <Group label="Fridges">
        <Count status="SAFE" n={n('SAFE')} />
        <Count status="WARNING" n={n('WARNING')} />
        <Count status="BREACH" n={n('BREACH')} />
      </Group>
      <Group label="Batches">
        <Count status="SAFE" n={batches.SAFE} />
        <Count status="AT_RISK" n={batches.AT_RISK} />
        <Count status="DISCARD" n={batches.DISCARD} />
      </Group>
      <Group label="Open alerts">
        <span
          className="figures inline-flex items-center gap-1.5 text-sm font-bold"
          style={{
            color: alerts.data?.critical
              ? 'var(--breach)'
              : alerts.data?.active
                ? 'var(--warning)'
                : 'var(--ink-3)',
          }}
        >
          <Bell aria-hidden className="size-4" />
          {alerts.data
            ? `${alerts.data.active}${alerts.data.critical ? ` · ${alerts.data.critical} critical` : ''}`
            : '–'}
        </span>
      </Group>
      <Group label="Nodes offline">
        <span
          className="figures inline-flex items-center gap-1.5 text-sm font-bold"
          style={{ color: offline ? 'var(--offline)' : 'var(--ink-3)' }}
        >
          <WifiOff aria-hidden className="size-4" />
          {offline}
        </span>
      </Group>
      <Group label="Last updated">
        <span
          className="figures inline-flex items-center gap-1.5 text-sm font-medium text-ink-2"
          aria-live="off"
        >
          <Clock aria-hidden className="size-4" />
          {lastSeen ? ago((now - lastSeen) / 1000) : 'no data yet'}
        </span>
      </Group>
    </section>
  );
}
