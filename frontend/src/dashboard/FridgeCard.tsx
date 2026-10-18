import {
  BatteryCharging,
  BatteryWarning,
  BellRing,
  DoorClosed,
  DoorOpen,
  Fan,
  Plug,
  Siren,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/permissions';
import { ago, clock, mmss } from '../lib/time';
import type { Fridge } from '../lib/types';
import { STATUS } from '../ui/status';
import { StatusChip } from '../ui/StatusChip';
import { compressorState, doorState, fridgeStatus, staleFor } from './logic';
import { ResetLatchButton } from './ResetLatch';
import { Sparkline } from './Sparkline';
import { ForecastChip } from '../ai/Forecast';
import { usePrediction } from '../ai/queries';
import { TempGauge } from './TempGauge';

function Row({
  icon,
  label,
  children,
  tone,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex min-h-11 items-center gap-3 border-t border-rule py-2 text-sm">
      <span aria-hidden className="text-ink-3" style={tone ? { color: tone } : undefined}>
        {icon}
      </span>
      <span className="w-24 shrink-0 text-ink-2">{label}</span>
      <span
        className="figures min-w-0 flex-1 font-medium text-ink"
        style={tone ? { color: tone } : undefined}
      >
        {children}
      </span>
    </div>
  );
}

/** One fridge, everything about it readable in a second: status, temperature, door, power, compressor, link. */
export function FridgeCard({ fridge, now }: { fridge: Fridge; now: number }) {
  const { user } = useAuth();
  const live = fridge.live;
  const status = fridgeStatus(fridge, now);
  const meta = STATUS[status];
  const stale = staleFor(fridge, now);
  const door = doorState(fridge, now);
  const prediction = usePrediction(fridge.id).data?.latest;
  const comp = compressorState(fridge, now);
  const icon = 'size-[18px]';

  return (
    <article
      aria-labelledby={`fridge-${fridge.id}`}
      className={`flex flex-col rounded-[var(--radius-label)] border bg-panel shadow-[0_1px_2px_rgb(15_27_42/0.05)] transition-[filter,opacity] duration-300 ${
        stale !== null || !live ? 'opacity-80 grayscale' : ''
      }`}
      style={{ borderColor: status === 'BREACH' ? 'var(--breach)' : 'var(--rule)' }}
    >
      {fridge.latch && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-t-[var(--radius-label)] bg-breach px-4 py-2.5 text-on-breach"
        >
          <span className="flex items-center gap-2 text-sm font-bold">
            <Siren aria-hidden className="size-4" />
            DISCARD LATCH – admin reset required
          </span>
          {can(user?.role, 'latch:reset') && (
            <ResetLatchButton fridgeId={fridge.id} fridgeName={fridge.name} />
          )}
        </div>
      )}

      <header className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <h2 id={`fridge-${fridge.id}`} className="truncate text-base font-semibold text-ink">
            <Link to={`/fridges/${fridge.id}`} className="hover:underline">
              {fridge.name}
            </Link>
          </h2>
          <p className="text-xs text-ink-3">
            {fridge.id} · {fridge.load}/{fridge.capacity} batches
          </p>
        </div>
        <StatusChip status={status} />
      </header>

      <div className="px-4 pt-3">
        <p className="flex items-baseline gap-1.5">
          <span
            key={live?.temp ?? 'none'}
            className="figures value-flash text-[2.6rem] leading-none font-bold tracking-[-0.03em]"
            style={{ color: status === 'SAFE' ? 'var(--ink)' : meta.ink }}
          >
            {live?.temp === null || live === null ? '––' : live.temp.toFixed(1)}
          </span>
          <span className="text-lg font-semibold text-ink-2">°C</span>
          {live?.mode === 'manual' && <span className="ml-2 text-xs text-ink-3">probe</span>}
        </p>
        {stale !== null && (
          <p role="status" className="mt-1 text-sm font-semibold text-offline">
            No data for {stale} s
          </p>
        )}
        <TempGauge temp={live?.temp ?? null} ink={meta.ink} />
      </div>

      <div className="px-4">
        <Row
          icon={
            door.alarm ? (
              <BellRing className={`${icon} motion-safe:animate-pulse`} />
            ) : door.open ? (
              <DoorOpen className={icon} />
            ) : (
              <DoorClosed className={icon} />
            )
          }
          label="Door"
          tone={door.alarm ? 'var(--breach)' : door.open ? 'var(--warning)' : undefined}
        >
          {!live
            ? '–'
            : door.open
              ? `Open for ${mmss(door.seconds)}${door.alarm ? ' · alarm' : ''}`
              : 'Closed'}
        </Row>
        <Row
          icon={live?.power === 'BATTERY' ? <BatteryWarning className={icon} /> : <Plug className={icon} />}
          label="Power"
          tone={live?.power === 'BATTERY' ? 'var(--warning)' : undefined}
        >
          {!live ? (
            '–'
          ) : live.power === 'BATTERY' ? (
            <span className="flex items-center gap-2">
              Battery
              <span
                aria-label={`battery ${live.batt} %`}
                className="relative h-2 w-16 overflow-hidden rounded-full bg-panel-2 ring-1 ring-rule ring-inset"
              >
                <span
                  className="absolute inset-y-0 left-0 transition-[width] duration-700"
                  style={{
                    width: `${live.batt}%`,
                    background: live.batt <= 20 ? 'var(--breach)' : 'var(--warning)',
                  }}
                />
              </span>
              {live.batt} %{live.battery_since ? ` · since ${clock(live.battery_since)}` : ''}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              Mains <BatteryCharging aria-hidden className="size-3.5 text-ink-3" /> {live.batt} %
            </span>
          )}
        </Row>
        <Row
          icon={
            <Fan className={`${icon} ${comp.on ? 'motion-safe:animate-[spin_2.4s_linear_infinite]' : ''}`} />
          }
          label="Compressor"
          tone={comp.on ? 'var(--teal)' : undefined}
        >
          {!live
            ? '–'
            : comp.on
              ? 'On · cooling'
              : comp.restartInS > 0
                ? `Off · off-timer ${comp.restartInS} s until restart allowed`
                : 'Off'}
        </Row>
        <Row
          icon={status === 'OFFLINE' ? <WifiOff className={icon} /> : <Wifi className={icon} />}
          label="Link"
          tone={status === 'OFFLINE' ? 'var(--offline)' : undefined}
        >
          {!live
            ? 'Never seen'
            : status === 'OFFLINE'
              ? `Offline · last seen ${ago((now - live.last_seen) / 1000)}`
              : `Online · ${ago((now - live.last_seen) / 1000)}`}
          {live && live.buf > 0 && (
            <span className="block text-xs font-medium text-warning">
              buffered {live.buf} readings, syncing…
            </span>
          )}
        </Row>
      </div>

      <div className="mt-auto border-t border-rule px-4 pt-2 pb-3">
        <Sparkline fridgeId={fridge.id} ink={meta.ink} />
        <ForecastChip p={prediction} now={now} />
      </div>
    </article>
  );
}
