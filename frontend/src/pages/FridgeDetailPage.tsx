import {
  BatteryWarning,
  BellRing,
  CloudUpload,
  DoorClosed,
  DoorOpen,
  Fan,
  List,
  Lock,
  Plug,
  Power,
  ThermometerSnowflake,
  Unlock,
  Wifi,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { Download, Printer, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/permissions';
import { api, ApiError } from '../lib/api';
import type { Fridge } from '../lib/types';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { Select } from '../ui/Select';
import { useToast } from '../ui/Toast';
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
import { SimControls } from '../dashboard/SimControls';
import { fmt, useT, type StringKey } from '../i18n';
import { PageHeader } from '../layout/AppShell';
import { CALIBRATION_MAX_C, DOUBLE_ABOVE_C, SAFE_MAX_C, SAFE_MIN_C } from '../lib/constants';
import { useFridge, useReadings, type HistoryPoint } from '../lib/queries';
import { serverNow, useServerNow } from '../lib/time';
import type { DeviceEvent, LiveState, Prediction, ReadingRow } from '../lib/types';
import { Panel } from '../ui/Panel';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { Pager, usePaged } from '../ui/Pager';
import { Table, type Column } from '../ui/Table';

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
  const { t } = useT();
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  if (p.forecast && p.band)
    return (
      <div className="figures rounded-md border border-rule bg-panel px-3 py-2 text-xs shadow-[0_8px_24px_rgb(15_27_42/0.14)]">
        <p className="font-semibold text-ink">{fmt(t('fd.tipForecast'), { t: time(p.ts, true) })}</p>
        <p className="text-ink-2">
          {fmt(t('fd.tipBand'), {
            v: p.fc?.toFixed(1) ?? '?',
            a: p.band[0].toFixed(1),
            b: p.band[1].toFixed(1),
          })}
        </p>
      </div>
    );
  return (
    <div className="figures rounded-md border border-rule bg-panel px-3 py-2 text-xs shadow-[0_8px_24px_rgb(15_27_42/0.14)]">
      <p className="font-semibold text-ink">{time(p.ts, true)}</p>
      <p className="text-ink-2">
        {p.temp === null ? t('fd.tipNoReading') : `${p.temp.toFixed(2)} °C`}
        {p.min !== null && p.max !== null && p.min !== p.max && ` (${p.min.toFixed(1)}–${p.max.toFixed(1)})`}
      </p>
      <p className="text-ink-3">
        {p.comp ? t('fd.tipCompOn') : t('fd.tipCompOff')}
        {p.door ? t('fd.tipDoor') : ''}
        {p.battery ? t('fd.tipBattery') : ''}
        {p.late ? t('fd.tipLate') : ''}
        {p.seeded ? t('fd.tipSeeded') : ''}
      </p>
    </div>
  );
}

function HistoryChart({ fridgeId, live }: { fridgeId: string; live?: LiveState | null }) {
  const { t } = useT();
  const rangeLabel = (key: string) => t(`fd.range${key}` as StringKey);
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[1]);
  const { data, isPending, error, refetch } = useReadings(
    fridgeId,
    range.s,
    'bucket' in range ? range.bucket : undefined,
  );
  const points = useMemo(() => {
    const raw = data?.points ? [...data.points] : [];
    if (!live || live.temp === null || live.temp === undefined || !live.ts) return raw;
    const bucket = data?.bucket ?? ('bucket' in range ? range.bucket : 5);
    const liveTs = Math.floor(live.ts / bucket) * bucket;
    if (raw.length === 0) {
      return [
        {
          ts: liveTs,
          temp: live.temp,
          min: live.temp,
          max: live.temp,
          door: live.door ?? 0,
          comp: live.comp ?? 0,
          battery: live.power === 'BATTERY' ? 1 : 0,
          late: 0,
        },
      ];
    }
    const last = raw[raw.length - 1];
    if (liveTs > last.ts) {
      raw.push({
        ts: liveTs,
        temp: live.temp,
        min: live.temp,
        max: live.temp,
        door: live.door ?? 0,
        comp: live.comp ?? 0,
        battery: live.power === 'BATTERY' ? 1 : 0,
        late: 0,
      });
    } else {
      raw[raw.length - 1] = {
        ...last,
        temp: live.temp,
        min: Math.min(last.min ?? live.temp, live.temp),
        max: Math.max(last.max ?? live.temp, live.temp),
        door: live.door ?? last.door,
        comp: live.comp ?? last.comp,
        battery: live.power === 'BATTERY' ? 1 : last.battery,
      };
    }
    return raw;
  }, [data, range, live]);
  const prediction = usePrediction(fridgeId).data?.latest;
  const fc = useMemo(() => forecastPoints(points, prediction, serverNow()), [points, prediction]);
  const chartData: ChartPoint[] = useMemo(() => [...points, ...fc], [points, fc]);
  const risk = prediction ? RISK[prediction.breach_level] : null;
  const strips = useMemo(() => compressorStrips(points, data?.bucket ?? 5), [points, data?.bucket]);
  const seededUntil = points.filter((p) => p.seeded).at(-1)?.ts; // demo backfill, disclosed on the chart
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
      title={t('fd.tempHistory')}
      actions={
        <div
          role="radiogroup"
          aria-label={t('fd.rangeLabel')}
          className="flex rounded-md border border-rule p-0.5"
        >
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
              {rangeLabel(r.key)}
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
        <EmptyState title={t('fd.noRange')}>{t('fd.noRangeBody')}</EmptyState>
      ) : (
        <>
          <div
            className="h-72"
            role="img"
            aria-label={fmt(t('fd.chartAria'), {
              range: rangeLabel(range.key),
              n: points.length,
              fc: fc.length ? fmt(t('fd.chartAriaFc'), { v: prediction!.pred_temp_30!.toFixed(1) }) : '',
            })}
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
                {seededUntil !== undefined && (
                  <ReferenceArea
                    x1={points[0].ts}
                    x2={seededUntil}
                    fill="var(--ink-3)"
                    fillOpacity={0.08}
                    stroke="none"
                    ifOverflow="hidden"
                    label={{
                      value: t('fd.seededDemo'),
                      position: 'insideBottomLeft',
                      fill: 'var(--ink-3)',
                      fontSize: 11,
                    }}
                  />
                )}
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
              {t('fd.legendSafe')}
            </li>
            <li className="flex items-center gap-1.5">
              <span
                className="h-2.5 w-4 rounded-sm"
                style={{ background: 'color-mix(in oklab, var(--teal) 18%, transparent)' }}
              />
              {t('fd.legendComp')}
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-3 w-0 border-l-2 border-dashed border-warning" />
              {t('fd.legendDoor')}
            </li>
            <li className="flex items-center gap-1.5">
              <span className="h-3 w-0 border-l-2 border-dashed border-offline" />
              {t('fd.legendPower')}
            </li>
            <li className="flex items-center gap-1.5">
              <span className="size-2 rotate-45 bg-warning" />
              {t('fd.legendLate')}
            </li>
            {seededUntil !== undefined && (
              <li className="flex items-center gap-1.5">
                <span className="h-2.5 w-4 rounded-sm bg-ink-3/20" />
                {t('fd.legendSeeded')}
              </li>
            )}
            {fc.length > 0 && (
              <li className="flex items-center gap-1.5">
                <span className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: risk!.ink }} />
                {t('fd.legendForecast')}
              </li>
            )}
            <li className="text-ink-3">{fmt(t('fd.perPoint'), { n: data!.bucket })}</li>
          </ul>
        </>
      )}
    </Panel>
  );
}

function Timeline({ events }: { events: DeviceEvent[] }) {
  const { t } = useT();
  if (events.length === 0) return <EmptyState title={t('fd.noEvents')}>{t('fd.noEventsBody')}</EmptyState>;
  return (
    <ol className="flex flex-col">
      {events.map((e) => {
        const m = EVENT[e.type] ?? { icon: Power, label: e.type };
        const label = EVENT[e.type] ? t(`fd.ev.${e.type}` as StringKey) : e.type;
        const Icon = m.icon;
        return (
          <li
            key={`${e.seq}-${e.type}`}
            className="flex items-start gap-3 border-t border-rule py-2.5 first:border-t-0"
          >
            <Icon aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: m.ink ?? 'var(--ink-3)' }} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{label}</p>
              <p className="figures text-xs text-ink-3">
                {time(e.ts, true)} · seq {e.seq}
              </p>
            </div>
            {e.late === 1 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning-wash px-2 py-0.5 text-xs font-semibold text-warning">
                <CloudUpload aria-hidden className="size-3" />
                {t('fd.syncedBadge')}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

const EXPORT_RANGES = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
] as const;

/** P2: export a temperature record. CSV downloads; the print-ready HTML opens in a tab to save as PDF. */
function ExportDialog({ fridge, onClose }: { fridge: Fridge; onClose: () => void }) {
  const { t } = useT();
  const EXPORT_LABEL: Record<number, StringKey> = { 7: 'fd.last7', 30: 'fd.last30', 90: 'fd.last90' };
  const [days, setDays] = useState(7);
  const go = (format: 'csv' | 'html') => {
    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 86_400;
    const url = `/api/fridges/${encodeURIComponent(fridge.id)}/report?from=${from}&to=${to}&format=${format}`;
    window.open(url, '_blank', 'noopener'); // GET with the same-origin session cookie; honours Content-Disposition
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('fd.exportTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('fd.cancel')}
          </Button>
          <Button
            variant="secondary"
            icon={<Printer aria-hidden className="size-4" />}
            onClick={() => go('html')}
          >
            {t('fd.printPdf')}
          </Button>
          <Button icon={<Download aria-hidden className="size-4" />} onClick={() => go('csv')}>
            {t('fd.downloadCsv')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <p className="text-sm text-ink-2">{t('fd.exportBody')}</p>
        <Select label={t('fd.period')} value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
          {EXPORT_RANGES.map((r) => (
            <option key={r.days} value={r.days}>
              {t(EXPORT_LABEL[r.days])}
            </option>
          ))}
        </Select>
      </div>
    </Modal>
  );
}

/** P4: set the sensor calibration offset (Admin). Bounded to ±CALIBRATION_MAX_C; the device applies it. */
function CalibrateDialog({ fridge, onClose }: { fridge: Fridge; onClose: () => void }) {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [offset, setOffset] = useState(String(fridge.calibration_offset_c));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const calibrate = useMutation({
    mutationFn: () =>
      api(`/api/devices/${encodeURIComponent(fridge.device_id!)}/calibrate`, {
        method: 'POST',
        body: { offset_c: Number(offset), reason: reason.trim() },
      }),
    onSuccess: () => {
      toast({ tone: 'success', title: t('fd.calSent') });
      void qc.invalidateQueries({ queryKey: ['fridge', fridge.id] });
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('fd.calFail')),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(offset);
    if (!Number.isFinite(n) || Math.abs(n) > CALIBRATION_MAX_C)
      return setError(fmt(t('fd.offsetRangeErr'), { m: CALIBRATION_MAX_C }));
    if (reason.trim().length < 3) return setError(t('fd.giveReason'));
    setError(null);
    calibrate.mutate();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('fd.calibrateTitle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={calibrate.isPending}>
            {t('fd.cancel')}
          </Button>
          <Button type="submit" form="calibrate-form" loading={calibrate.isPending}>
            {t('fd.sendToDevice')}
          </Button>
        </>
      }
    >
      <form id="calibrate-form" onSubmit={submit} noValidate className="grid gap-4">
        {error && (
          <p
            role="alert"
            className="rounded-md border border-breach/40 bg-breach-wash px-3 py-2 text-sm font-medium text-breach"
          >
            {error}
          </p>
        )}
        <p className="text-sm text-ink-2">{t('fd.calBody')}</p>
        <Field
          label={t('fd.offset')}
          type="number"
          inputMode="decimal"
          step="0.1"
          min={-CALIBRATION_MAX_C}
          max={CALIBRATION_MAX_C}
          value={offset}
          onChange={(e) => setOffset(e.target.value)}
          hint={fmt(t('fd.offsetHint'), {
            m: CALIBRATION_MAX_C,
            c: `${fridge.calibration_offset_c > 0 ? '+' : ''}${fridge.calibration_offset_c}`,
          })}
        />
        <Field
          label={t('fd.reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('fd.reasonPlaceholder')}
          autoComplete="off"
        />
      </form>
    </Modal>
  );
}

function DetailActions({ fridge }: { fridge: Fridge }) {
  const { t } = useT();
  const { user } = useAuth();
  const [dialog, setDialog] = useState<'export' | 'calibrate' | null>(null);
  const mayCalibrate = can(user?.role, 'device:manage') && fridge.device_id;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        className="min-h-9 px-2.5"
        icon={<Download aria-hidden className="size-4" />}
        onClick={() => setDialog('export')}
      >
        {t('fd.exportRecord')}
      </Button>
      {mayCalibrate && (
        <Button
          variant="secondary"
          className="min-h-9 px-2.5"
          icon={<SlidersHorizontal aria-hidden className="size-4" />}
          onClick={() => setDialog('calibrate')}
        >
          {t('fd.calibrate')}
        </Button>
      )}
      <Link to="/fridges" className="text-sm font-semibold text-teal-strong underline">
        {t('fd.allFridges')}
      </Link>
      {dialog === 'export' && <ExportDialog fridge={fridge} onClose={() => setDialog(null)} />}
      {dialog === 'calibrate' && <CalibrateDialog fridge={fridge} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** Readings table columns, shared by the paged panel and the "View all" dialog. */
function useReadingColumns() {
  const { t } = useT();
  const columns: Column<ReadingRow>[] = [
    { key: 'ts', header: t('fd.colTime'), className: 'whitespace-nowrap', cell: (r) => time(r.ts) },
    {
      key: 'temp',
      header: '°C',
      align: 'right',
      cell: (r) => (r.temp === null ? '–' : r.temp.toFixed(2)),
    },
    {
      key: 'door',
      header: t('fd.colDoor'),
      cell: (r) => (r.door ? t('fd.open') : t('fd.closed')),
    },
    {
      key: 'comp',
      header: t('fd.colComp'),
      cell: (r) => (r.comp ? t('fd.on') : t('fd.off')),
    },
    {
      key: 'power',
      header: t('fd.colPower'),
      cell: (r) => (r.power === 'BATTERY' ? fmt(t('fd.battery'), { n: r.batt }) : t('fd.mains')),
    },
    {
      key: 'late',
      header: t('fd.colArrival'),
      cell: (r) =>
        r.seeded ? (
          <span className="text-ink-3">{t('fd.seeded')}</span>
        ) : r.late ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning-wash px-2 py-0.5 text-xs font-semibold text-warning">
            <CloudUpload aria-hidden className="size-3" />
            {t('fd.lateSynced')}
          </span>
        ) : (
          <span className="text-ink-3">{t('fd.live')}</span>
        ),
    },
  ];
  return columns;
}

/** Event timeline, 15 per page, with every loaded event in a dialog. */
function EventsPanel({ events }: { events: DeviceEvent[] }) {
  const { t } = useT();
  const paged = usePaged(events);
  const [all, setAll] = useState(false);
  const title = t('fd.eventTimeline');
  return (
    <Panel
      title={title}
      bodyClassName=""
      actions={
        events.length > 0 && (
          <Button
            variant="ghost"
            className="min-h-9 px-2.5"
            onClick={() => setAll(true)}
            icon={<List aria-hidden className="size-4" />}
          >
            {fmt(t('pager.viewAll'), { n: events.length })}
          </Button>
        )
      }
    >
      <div className="px-4 py-1">
        <Timeline events={paged.rows} />
      </div>
      <Pager {...paged} label={title} />
      <Modal
        wide
        open={all}
        onClose={() => setAll(false)}
        title={fmt(t('pager.allTitle'), { list: title, n: events.length })}
      >
        <div className="px-5 py-1">
          <Timeline events={events} />
        </div>
      </Modal>
    </Panel>
  );
}

/** Recent readings, 15 per page, with every loaded reading in a dialog. */
function ReadingsPanel({ readings }: { readings: ReadingRow[] }) {
  const { t } = useT();
  const columns = useReadingColumns();
  const paged = usePaged(readings);
  const [all, setAll] = useState(false);
  const title = t('fd.recentReadings');
  return (
    <Panel
      title={title}
      bodyClassName=""
      actions={
        readings.length > 0 && (
          <Button
            variant="ghost"
            className="min-h-9 px-2.5"
            onClick={() => setAll(true)}
            icon={<List aria-hidden className="size-4" />}
          >
            {fmt(t('pager.viewAll'), { n: readings.length })}
          </Button>
        )
      }
    >
      {readings.length === 0 ? (
        <EmptyState title={t('fd.noReadings')}>{t('fd.noReadingsBody')}</EmptyState>
      ) : (
        <>
          <Table<ReadingRow> caption={title} rows={paged.rows} rowKey={(r) => r.seq} columns={columns} />
          <Pager {...paged} label={title} />
        </>
      )}
      <Modal
        wide
        open={all}
        onClose={() => setAll(false)}
        title={fmt(t('pager.allTitle'), { list: title, n: readings.length })}
      >
        <Table<ReadingRow> caption={title} rows={readings} rowKey={(r) => r.seq} columns={columns} />
      </Modal>
    </Panel>
  );
}

export function FridgeDetailPage() {
  const { t } = useT();
  const { id = '' } = useParams();
  const { data, isPending, error, refetch } = useFridge(id);
  const now = useServerNow(1000);
  const { user } = useAuth();

  if (isPending)
    return (
      <>
        <PageHeader title={t('page.fridge.title')} />
        <div className="grid gap-5 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.6fr)]">
          <Skeleton className="h-[26rem]" />
          <Skeleton className="h-[26rem]" />
        </div>
      </>
    );
  if (error)
    return (
      <>
        <PageHeader title={t('page.fridge.title')} />
        <Panel>
          <ErrorState error={error} onRetry={() => void refetch()} />
        </Panel>
      </>
    );

  const { fridge, events, readings, sim_controls } = data;
  return (
    <>
      <PageHeader
        title={fridge.name}
        subtitle={`${fridge.id} · node ${fridge.device_id ?? 'not registered'}${
          fridge.calibration_offset_c
            ? ` · sensor offset ${fridge.calibration_offset_c > 0 ? '+' : ''}${fridge.calibration_offset_c} °C`
            : ''
        }`}
        actions={<DetailActions fridge={fridge} />}
      />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(20rem,0.8fr)_minmax(0,1.6fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <FridgeCard fridge={fridge} now={now} />
          {sim_controls && can(user?.role, 'device:test') && <SimControls fridge={fridge} now={now} />}
          <AiPanel fridgeId={fridge.id} now={now} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <HistoryChart fridgeId={fridge.id} live={fridge.live} />
          <BudgetPanel fridge={fridge} now={now} />
          <div className="grid gap-5 2xl:grid-cols-2">
            <EventsPanel events={events} />
            <ReadingsPanel readings={readings} />
          </div>
        </div>
      </div>
    </>
  );
}
