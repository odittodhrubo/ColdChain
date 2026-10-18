import {
  BatteryWarning,
  BellRing,
  CloudUpload,
  DoorClosed,
  DoorOpen,
  Fan,
  Lock,
  Plug,
  Power,
  ThermometerSnowflake,
  Unlock,
  Wifi,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AiPanel } from '../ai/AiPanel';
import { RISK, STALE_AFTER_MS } from '../ai/Forecast';
import { usePrediction } from '../ai/queries';
import { BudgetPanel } from '../dashboard/BudgetPanel';
import { FridgeCard } from '../dashboard/FridgeCard';
import { PageHeader } from '../layout/AppShell';
import { DOUBLE_ABOVE_C, SAFE_MAX_C, SAFE_MIN_C } from '../lib/constants';
import { useFridge, useReadings, type HistoryPoint } from '../lib/queries';
import { serverNow, useServerNow } from '../lib/time';
import type { DeviceEvent, Prediction, ReadingRow } from '../lib/types';
import { Panel } from '../ui/Panel';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { Table } from '../ui/Table';

const RANGES = [
  { key: '15m', label: '15 min', s: 15 * 60, bucket: 5 },
  { key: '1h', label: '1 h', s: 3600, bucket: 10 },
  { key: '6h', label: '6 h', s: 6 * 3600 },
  { key: '24h', label: '24 h', s: 24 * 3600 },
] as const;

const EVENT: Record<string, { icon: LucideIcon; label: string; ink?: string }> = {
  DOOR_OPEN: { icon: DoorOpen, label: 'Door opened', ink: 'var(--warning)' },
  DOOR_CLOSE: { icon: DoorClosed, label: 'Door closed' },
  DOOR_ALARM: { icon: BellRing, label: 'Door alarm (open > 60 s)', ink: 'var(--breach)' },
  POWER_FAIL: { icon: BatteryWarning, label: 'Power failure: on battery', ink: 'var(--warning)' },
  POWER_RESTORE: { icon: Plug, label: 'Mains power restored' },
  BATT_LOW: { icon: BatteryWarning, label: 'Battery low', ink: 'var(--breach)' },
  COMP_ON: { icon: Fan, label: 'Compressor on', ink: 'var(--teal)' },
  COMP_OFF: { icon: Fan, label: 'Compressor off' },
  LATCH_SET: { icon: Lock, label: 'Discard latch set', ink: 'var(--breach)' },
  LATCH_RESET: { icon: Unlock, label: 'Discard latch reset' },
  WIFI_LOST: { icon: WifiOff, label: 'Wi-Fi lost (buffering)', ink: 'var(--offline)' },
  WIFI_BACK: { icon: Wifi, label: 'Wi-Fi back (syncing)' },
  SENSOR_FAULT: { icon: ThermometerSnowflake, label: 'Temperature sensor fault', ink: 'var(--breach)' },
  BOOT: { icon: Power, label: 'Node started' },
};

const time = (s: number, withDate = false) =>
  new Date(s * 1000).toLocaleString([], {
    ...(withDate ? { month: 'short', day: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/** Contiguous buckets with the compressor running, as [from, to] strips. */
function compressorStrips(points: HistoryPoint[], bucket: number) {
  const strips: [number, number][] = [];
  for (const p of points) {
    const last = strips.at(-1);
    if (!p.comp) continue;
    if (last && p.ts - last[1] <= bucket) last[1] = p.ts + bucket;
    else strips.push([p.ts, p.ts + bucket]);
  }
  return strips;
}

/** A bucket holding data that arrived late through sync gets a diamond on the line. */
function LateDot(props: { cx?: number; cy?: number; payload?: HistoryPoint; index?: number }) {
  const { cx, cy, payload, index } = props;
  if (!payload?.late || cx === undefined || cy === undefined) return <g key={index} />;
  return (
    <rect
      key={index}
      x={cx - 3.5}
      y={cy - 3.5}
      width={7}
      height={7}
      transform={`rotate(45 ${cx} ${cy})`}
      fill="var(--warning)"
      stroke="var(--panel)"
      strokeWidth={1}
    />
  );
}

type ChartPoint = HistoryPoint & { fc?: number | null; band?: [number, number] | null; forecast?: boolean };

/** The forecast as two extra points: from the last reading to +30 min (median line + p10-p90 band). */
export function forecastPoints(points: HistoryPoint[], p: Prediction | null | undefined, nowMs: number) {
  const last = [...points].reverse().find((x) => x.temp !== null);
  if (!p || !last || p.pred_temp_30 === null || p.p10 === null || p.p90 === null) return [];
  if (nowMs - p.created_at > STALE_AFTER_MS) return []; // never draw an old forecast as if it were current
  const t = last.temp as number;
  const blank = { temp: null, min: null, max: null, door: 0, comp: 0, battery: 0, late: 0 };
  return [
    { ...blank, ts: last.ts, fc: t, band: [t, t] as [number, number], forecast: true },
    {
      ...blank,
      ts: last.ts + 1800,
      fc: p.pred_temp_30,
      band: [p.p10, p.p90] as [number, number],
      forecast: true,
    },
  ];
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: ChartPoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  if (p.forecast && p.band)
    return (
      <div className="figures rounded-md border border-rule bg-panel px-3 py-2 text-xs shadow-[0_8px_24px_rgb(15_27_42/0.14)]">
        <p className="font-semibold text-ink">Forecast {time(p.ts, true)}</p>
        <p className="text-ink-2">
          {p.fc?.toFixed(1)} °C (80 % range {p.band[0].toFixed(1)}–{p.band[1].toFixed(1)})
        </p>
      </div>
    );
  return (
    <div className="figures rounded-md border border-rule bg-panel px-3 py-2 text-xs shadow-[0_8px_24px_rgb(15_27_42/0.14)]">
      <p className="font-semibold text-ink">{time(p.ts, true)}</p>
      <p className="text-ink-2">
        {p.temp === null ? 'no reading' : `${p.temp.toFixed(2)} °C`}
        {p.min !== null && p.max !== null && p.min !== p.max && ` (${p.min.toFixed(1)}–${p.max.toFixed(1)})`}
      </p>
      <p className="text-ink-3">
        {p.comp ? 'compressor on' : 'compressor off'}
        {p.door ? ' · door opened' : ''}
        {p.battery ? ' · on battery' : ''}
        {p.late ? ' · synced late' : ''}
      </p>
    </div>
  );
}

function HistoryChart({ fridgeId }: { fridgeId: string }) {
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[1]);
  const { data, isPending, error, refetch } = useReadings(
    fridgeId,
    range.s,
    'bucket' in range ? range.bucket : undefined,
  );
  const points = useMemo(() => data?.points ?? [], [data]);
  const prediction = usePrediction(fridgeId).data?.latest;
  const fc = useMemo(() => forecastPoints(points, prediction, serverNow()), [points, prediction]);
  const chartData: ChartPoint[] = useMemo(() => [...points, ...fc], [points, fc]);
  const risk = prediction ? RISK[prediction.breach_level] : null;
  const strips = useMemo(() => compressorStrips(points, data?.bucket ?? 5), [points, data?.bucket]);
  const markers = (data?.events ?? []).filter((e) =>
    ['DOOR_OPEN', 'DOOR_ALARM', 'POWER_FAIL'].includes(e.type),
  );
  // explicit numeric domains: the band and the 12 °C line always show, real readings are never clipped
  const temps = [...points.flatMap((p) => [p.min, p.max, p.temp]), ...fc.flatMap((p) => p.band ?? [])].filter(
    (t): t is number => t !== null,
  );
  const yDomain = [
    Math.floor(Math.min(SAFE_MIN_C - 1, ...temps)),
    Math.ceil(Math.max(DOUBLE_ABOVE_C + 1, ...temps)),
  ];
  const xDomain = [
    points[0]?.ts ?? 0,
    Math.max((points.at(-1)?.ts ?? 0) + (data?.bucket ?? 0), fc.at(-1)?.ts ?? 0),
  ];

  return (
    <Panel
      title="Temperature history"
      actions={
        <div role="radiogroup" aria-label="Range" className="flex rounded-md border border-rule p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              role="radio"
              aria-checked={r.key === range.key}
              onClick={() => setRange(r)}
              className={`min-h-8 cursor-pointer rounded px-2.5 text-xs font-semibold whitespace-nowrap ${
                r.key === range.key ? 'bg-teal text-on-teal' : 'text-ink-2 hover:bg-panel-2'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      }
    >
      {isPending ? (
        <Skeleton className="h-72 w-full" />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : points.length === 0 ? (
        <EmptyState title="No readings in this range">
          Pick a longer range, or check that the node is online.
        </EmptyState>
      ) : (
        <>
          <div
            className="h-72"
            role="img"
            aria-label={`Temperature over the last ${range.label}, ${points.length} points${
              fc.length ? `, forecast ${prediction!.pred_temp_30!.toFixed(1)} °C in 30 minutes` : ''
            }`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 10, right: 12, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="var(--rule)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="time"
                  domain={xDomain}
                  allowDataOverflow
                  tickFormatter={(v: number) => time(v).slice(0, 5)}
                  stroke="var(--ink-3)"
                  fontSize={11}
                />
                <YAxis
                  domain={yDomain}
                  allowDataOverflow
                  tickFormatter={(v: number) => `${v}°`}
                  stroke="var(--ink-3)"
                  fontSize={11}
                />
                {strips.map(([a, b]) => (
                  <ReferenceArea
                    key={a}
                    x1={a}
                    x2={b}
                    fill="var(--teal)"
                    fillOpacity={0.07}
                    stroke="none"
                    ifOverflow="hidden"
                  />
                ))}
                <ReferenceArea
                  y1={SAFE_MIN_C}
                  y2={SAFE_MAX_C}
                  fill="var(--safe)"
                  fillOpacity={0.1}
                  stroke="none"
                />
                <ReferenceLine
                  y={SAFE_MAX_C}
                  stroke="var(--breach)"
                  strokeDasharray="5 3"
                  label={{ value: '8 °C', position: 'insideTopLeft', fill: 'var(--breach)', fontSize: 11 }}
                />
                <ReferenceLine
                  y={DOUBLE_ABOVE_C}
                  stroke="var(--breach)"
                  strokeDasharray="2 3"
                  label={{
                    value: '12 °C ×2',
                    position: 'insideTopLeft',
                    fill: 'var(--breach)',
                    fontSize: 11,
                  }}
                />
                {markers.map((e) => (
                  <ReferenceLine
                    key={`${e.seq}-${e.type}`}
                    x={e.ts}
                    stroke={e.type === 'POWER_FAIL' ? 'var(--offline)' : 'var(--warning)'}
                    strokeDasharray="3 3"
                    ifOverflow="hidden"
                  />
                ))}
                <Tooltip content={<ChartTooltip />} />
                {fc.length > 0 && (
                  <>
                    <Area
                      dataKey="band"
                      stroke="none"
                      fill={risk!.ink}
                      fillOpacity={0.14}
                      isAnimationActive={false}
                      connectNulls
                    />
                    <Line
                      dataKey="fc"
                      stroke={risk!.ink}
                      strokeWidth={2}
                      strokeDasharray="6 4"
                      dot={false}
                      isAnimationActive={false}
                      connectNulls
                    />
                    <ReferenceDot
                      x={fc[1].ts}
                      y={fc[1].fc!}
                      r={5}
                      fill={risk!.ink}
                      stroke="var(--panel)"
                      strokeWidth={2}
                    />
                  </>
                )}
                <Line
                  type="monotone"
                  dataKey="temp"
                  stroke="var(--ink)"
                  strokeWidth={1.75}
                  dot={LateDot}
                  activeDot={{ r: 3.5 }}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-ink-2" aria-label="Chart legend">
            <li className="flex items-center gap-1.5">
              <span
                className="h-2.5 w-4 rounded-sm"
                style={{ background: 'color-mix(in oklab, var(--safe) 25%, transparent)' }}
              />
              Safe band 2–8 °C
            </li>
            <li className="flex items-center gap-1.5">
              <span
                className="h-2.5 w-4 rounded-sm"
                style={{ background: 'color-mix(in oklab, var(--teal) 18%, transparent)' }}
              />
              Compressor running
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-3 w-0 border-l-2 border-dashed border-warning" />
              Door opened
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-3 w-0 border-l-2 border-dashed border-offline" />
              Power failure
            </li>
            <li className="flex items-center gap-1.5">
              <span className="size-2 rotate-45 bg-warning" />
              Arrived late through sync
            </li>
            {fc.length > 0 && (
              <li className="flex items-center gap-1.5">
                <span className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: risk!.ink }} />
                Forecast +30 min, shaded 80 % range
              </li>
            )}
            <li className="text-ink-3">{data!.bucket} s per point</li>
          </ul>
        </>
      )}
    </Panel>
  );
}

function Timeline({ events }: { events: DeviceEvent[] }) {
  if (events.length === 0)
    return (
      <EmptyState title="No events yet">Door, power, alarm, latch and sync events appear here.</EmptyState>
    );
  return (
    <ol className="flex flex-col">
      {events.map((e) => {
        const m = EVENT[e.type] ?? { icon: Power, label: e.type };
        const Icon = m.icon;
        return (
          <li
            key={`${e.seq}-${e.type}`}
            className="flex items-start gap-3 border-t border-rule py-2.5 first:border-t-0"
          >
            <Icon aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: m.ink ?? 'var(--ink-3)' }} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{m.label}</p>
              <p className="figures text-xs text-ink-3">
                {time(e.ts, true)} · seq {e.seq}
              </p>
            </div>
            {e.late === 1 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning-wash px-2 py-0.5 text-xs font-semibold text-warning">
                <CloudUpload aria-hidden className="size-3" />
                synced
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function FridgeDetailPage() {
  const { id = '' } = useParams();
  const { data, isPending, error, refetch } = useFridge(id);
  const now = useServerNow(1000);

  if (isPending)
    return (
      <>
        <PageHeader title="Fridge" />
        <div className="grid gap-5 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.6fr)]">
          <Skeleton className="h-[26rem]" />
          <Skeleton className="h-[26rem]" />
        </div>
      </>
    );
  if (error)
    return (
      <>
        <PageHeader title="Fridge" />
        <Panel>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Panel>
      </>
    );

  const { fridge, events, readings } = data;
  return (
    <>
      <PageHeader
        title={fridge.name}
        subtitle={`${fridge.id} · node ${fridge.device_id ?? 'not registered'}`}
        actions={
          <Link to="/fridges" className="text-sm font-semibold text-teal-strong underline">
            All fridges
          </Link>
        }
      />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.6fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <FridgeCard fridge={fridge} now={now} />
          <AiPanel fridgeId={fridge.id} now={now} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <HistoryChart fridgeId={fridge.id} />
          <BudgetPanel fridge={fridge} now={now} />
          <div className="grid gap-5 2xl:grid-cols-2">
            <Panel title="Event timeline" bodyClassName="px-4 py-1 max-h-[28rem] overflow-y-auto">
              <Timeline events={events} />
            </Panel>
            <Panel title="Recent readings" bodyClassName="">
              {readings.length === 0 ? (
                <EmptyState title="No readings yet">
                  Readings arrive every 5 seconds once the node is online.
                </EmptyState>
              ) : (
                <Table<ReadingRow>
                  caption="Most recent readings"
                  rows={readings}
                  rowKey={(r) => r.seq}
                  columns={[
                    { key: 'ts', header: 'Time', cell: (r) => time(r.ts) },
                    {
                      key: 'temp',
                      header: '°C',
                      align: 'right',
                      cell: (r) => (r.temp === null ? '–' : r.temp.toFixed(2)),
                    },
                    { key: 'door', header: 'Door', cell: (r) => (r.door ? 'Open' : 'Closed') },
                    { key: 'comp', header: 'Comp.', cell: (r) => (r.comp ? 'On' : 'Off') },
                    {
                      key: 'power',
                      header: 'Power',
                      cell: (r) => (r.power === 'BATTERY' ? `Battery ${r.batt} %` : 'Mains'),
                    },
                    {
                      key: 'late',
                      header: 'Arrival',
                      cell: (r) =>
                        r.late ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-warning-wash px-2 py-0.5 text-xs font-semibold text-warning">
                            <CloudUpload aria-hidden className="size-3" />
                            late · synced
                          </span>
                        ) : (
                          <span className="text-ink-3">live</span>
                        ),
                    },
                  ]}
                />
              )}
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}
