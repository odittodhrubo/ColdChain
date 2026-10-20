import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BellRing,
  BatteryWarning,
  DoorClosed,
  DoorOpen,
  Fan,
  Minus,
  Plug,
  Plus,
  Thermometer,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { fmt, useT, type StringKey } from '../i18n';
import { api } from '../lib/api';
import { DOOR_ALARM_S } from '../lib/constants';
import { mmss } from '../lib/time';
import type { Fridge } from '../lib/types';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Panel } from '../ui/Panel';
import { useToast } from '../ui/Toast';
import { compressorState, doorState } from './logic';

type SimBody =
  | { action: 'door' | 'ajar' | 'power' | 'wifi'; value: boolean }
  | { action: 'temp' | 'eff'; value: number }
  | { action: 'hold'; value: number | null };

// One click each: too cold (< 2), normal, the warning edge (> 7.5), a breach (x1 exposure), hot (> 12, x2).
const PRESETS: { key: StringKey; c: number }[] = [
  { key: 'sim.preset.cold', c: 1 },
  { key: 'sim.preset.normal', c: 5 },
  { key: 'sim.preset.warm', c: 7.8 },
  { key: 'sim.preset.breach', c: 10 },
  { key: 'sim.preset.hot', c: 13 },
];
const TEMP_MIN = -30; // the server's accepted range (POST /api/fridges/:id/sim)
const TEMP_MAX = 40;

const icon = 'size-4 shrink-0';

/** One device input: its name and live state on top, the buttons that change it underneath. */
function Control({
  label,
  glyph,
  state,
  tone,
  children,
}: {
  label: string;
  glyph: ReactNode;
  state: ReactNode;
  tone?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-col gap-3 border-t border-rule py-4 first:border-t-0 first:pt-0 last:pb-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="flex items-center gap-2 text-sm font-semibold text-ink">
          <span aria-hidden style={{ color: tone }}>
            {glyph}
          </span>
          {label}
        </span>
        <span className="figures text-sm font-semibold" style={{ color: tone ?? 'var(--ink-2)' }}>
          {state}
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * Manual controls (SIM_CONTROLS): press a button to drive the fridge's virtual node like the buttons, switches
 * and temperature slider on the Wokwi board — open, close or leave the door ajar, jump or hold the temperature,
 * cut mains power or Wi-Fi, weaken the compressor. The node applies it over MQTT and the live state below
 * comes back the normal way (signed telemetry), so every label here shows what the fridge reports, not what
 * was clicked. A door left open past DOOR_ALARM_S raises the alarm message here, on the fridge card and as a
 * DOOR_OPEN_LONG alert. Rendered only when the backend reports sim_controls on and the role may act on a device.
 */
export function SimControls({ fridge, now }: { fridge: Fridge; now: number }) {
  const { t } = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const live = fridge.live;
  const [pressed, setPressed] = useState(''); // which button is in flight, for its spinner
  const [hold, setHold] = useState(true);
  const [temp, setTemp] = useState('5');
  const [effPct, setEffPct] = useState(100);
  const [wifiCut, setWifiCut] = useState<boolean | null>(null); // null: not touched here, read the link state

  const send = useMutation({
    mutationFn: (body: SimBody) =>
      api(`/api/fridges/${encodeURIComponent(fridge.id)}/sim`, { method: 'POST', body }),
    onSuccess: (_r, body) => {
      if (body.action === 'wifi') setWifiCut(body.value);
      toast({ tone: 'success', title: t('sim.applied') });
      void qc.invalidateQueries({ queryKey: ['fridge', fridge.id] });
    },
    onError: (e: Error) => toast({ tone: 'error', title: t('sim.failed'), body: e.message }),
  });
  const fire = (key: string, body: SimBody) => {
    setPressed(key);
    send.mutate(body);
  };
  const busy = send.isPending;
  const loading = (key: string) => busy && pressed === key;

  const door = doorState(fridge, now);
  const comp = compressorState(fridge, now);
  const alarmIn = Math.max(0, Math.ceil(DOOR_ALARM_S - door.seconds));
  const onBattery = live?.power === 'BATTERY';
  const held = live?.mode === 'manual';
  const cut = wifiCut ?? (live ? !live.online : false);

  const tempValue = Number(temp);
  const tempError =
    temp.trim() === '' || !Number.isFinite(tempValue) || tempValue < TEMP_MIN || tempValue > TEMP_MAX
      ? fmt(t('sim.tempRange'), { min: TEMP_MIN, max: TEMP_MAX })
      : null;
  const setTemperature = (key: string, c: number) =>
    fire(key, hold ? { action: 'hold', value: c } : { action: 'temp', value: c });
  const nudge = (d: number) =>
    setTemp(String(Math.round(((Number.isFinite(tempValue) ? tempValue : 5) + d) * 10) / 10));
  const onCustom = (e: FormEvent) => {
    e.preventDefault();
    if (!tempError) setTemperature('temp-custom', tempValue);
  };

  return (
    <Panel title={t('sim.title')}>
      <div className="flex flex-col gap-4">
        <p className="max-w-prose text-sm text-ink-2">{t('sim.note')}</p>

        {door.alarm && (
          <div
            role="alert"
            className="flex flex-col items-start gap-3 rounded-[var(--radius-label)] border border-breach/40 bg-breach-wash p-3"
          >
            <div className="flex gap-2.5">
              <BellRing
                aria-hidden
                className="mt-0.5 size-5 shrink-0 text-breach motion-safe:animate-pulse"
              />
              <div>
                <p className="text-sm font-bold text-breach">{t('sim.alarmTitle')}</p>
                <p className="text-sm text-ink">{fmt(t('sim.alarmBody'), { n: DOOR_ALARM_S })}</p>
              </div>
            </div>
            <Button
              className="shrink-0"
              loading={loading('door-alarm')}
              disabled={busy}
              icon={<DoorClosed aria-hidden className={icon} />}
              onClick={() => fire('door-alarm', { action: 'door', value: false })}
            >
              {t('sim.closeNow')}
            </Button>
          </div>
        )}

        <div>
          <Control
            label={t('sim.door')}
            glyph={
              door.alarm ? (
                <BellRing className={icon} />
              ) : door.open ? (
                <DoorOpen className={icon} />
              ) : (
                <DoorClosed className={icon} />
              )
            }
            tone={door.alarm ? 'var(--breach)' : door.open ? 'var(--warning)' : undefined}
            state={
              !live
                ? '–'
                : door.open
                  ? `${fmt(t('sim.openFor'), { t: mmss(door.seconds) })}${door.alarm ? ` · ${t('fridge.alarm')}` : ''}`
                  : t('fridge.closed')
            }
          >
            <div className="flex flex-wrap gap-2">
              <Button
                loading={loading('door')}
                disabled={busy}
                icon={
                  door.open ? (
                    <DoorClosed aria-hidden className={icon} />
                  ) : (
                    <DoorOpen aria-hidden className={icon} />
                  )
                }
                onClick={() => fire('door', { action: 'door', value: !door.open })}
              >
                {door.open ? t('sim.closeDoor') : t('sim.openDoor')}
              </Button>
              {!door.open && (
                <Button
                  variant="secondary"
                  loading={loading('ajar')}
                  disabled={busy}
                  onClick={() => fire('ajar', { action: 'ajar', value: true })}
                >
                  {t('sim.ajar')}
                </Button>
              )}
            </div>
            {door.open && !door.alarm && (
              <div className="flex flex-col gap-1.5">
                <div
                  aria-hidden
                  className="h-1.5 overflow-hidden rounded-full bg-panel-2 ring-1 ring-rule ring-inset"
                >
                  <div
                    className="h-full origin-left bg-warning transition-transform duration-1000 ease-linear motion-reduce:transition-none"
                    style={{ transform: `scaleX(${Math.min(1, door.seconds / DOOR_ALARM_S)})` }}
                  />
                </div>
                <p className="figures text-sm text-ink-2">{fmt(t('sim.alarmIn'), { s: alarmIn })}</p>
              </div>
            )}
          </Control>

          <Control
            label={t('sim.temp')}
            glyph={<Thermometer className={icon} />}
            state={
              !live || live.temp === null
                ? '–'
                : held
                  ? fmt(t('sim.held'), { v: live.temp.toFixed(1) })
                  : `${live.temp.toFixed(1)} °C`
            }
          >
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <Button
                  key={p.c}
                  variant="secondary"
                  className="figures"
                  loading={loading(`temp-${p.c}`)}
                  disabled={busy}
                  onClick={() => setTemperature(`temp-${p.c}`, p.c)}
                >
                  {t(p.key)} · {p.c} °C
                </Button>
              ))}
            </div>
            <form onSubmit={onCustom} noValidate className="flex flex-wrap items-start gap-2">
              <Button
                variant="secondary"
                className="mt-7 min-h-11 w-11 px-0"
                aria-label={t('sim.lower')}
                onClick={() => nudge(-0.5)}
                icon={<Minus aria-hidden className={icon} />}
              />
              <Field
                label={t('sim.custom')}
                type="number"
                inputMode="decimal"
                step="0.1"
                min={TEMP_MIN}
                max={TEMP_MAX}
                className="figures w-28"
                value={temp}
                error={tempError}
                onChange={(e) => setTemp(e.target.value)}
              />
              <Button
                variant="secondary"
                className="mt-7 min-h-11 w-11 px-0"
                aria-label={t('sim.raise')}
                onClick={() => nudge(0.5)}
                icon={<Plus aria-hidden className={icon} />}
              />
              <Button
                type="submit"
                className="mt-7 min-h-11"
                loading={loading('temp-custom')}
                disabled={busy || !!tempError}
              >
                {t('sim.apply')}
              </Button>
            </form>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-h-10 items-start gap-2 text-sm text-ink">
                <input
                  id={`hold-${fridge.id}`}
                  type="checkbox"
                  checked={hold}
                  aria-describedby={`hold-${fridge.id}-hint`}
                  onChange={(e) => setHold(e.target.checked)}
                  className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--teal)]"
                />
                <div>
                  <label htmlFor={`hold-${fridge.id}`} className="cursor-pointer font-semibold">
                    {t('sim.holdMode')}
                  </label>
                  <p id={`hold-${fridge.id}-hint`} className="text-ink-3">
                    {hold ? t('sim.holdOn') : t('sim.holdOff')}
                  </p>
                </div>
              </div>
              {held && (
                <Button
                  variant="secondary"
                  loading={loading('release')}
                  disabled={busy}
                  onClick={() => fire('release', { action: 'hold', value: null })}
                >
                  {t('sim.release')}
                </Button>
              )}
            </div>
          </Control>

          <Control
            label={t('sim.power')}
            glyph={onBattery ? <BatteryWarning className={icon} /> : <Plug className={icon} />}
            tone={onBattery ? 'var(--warning)' : undefined}
            state={!live ? '–' : onBattery ? fmt(t('sim.onBattery'), { n: live.batt }) : t('fridge.mains')}
          >
            <div>
              <Button
                variant="secondary"
                loading={loading('power')}
                disabled={busy}
                icon={<Plug aria-hidden className={icon} />}
                onClick={() => fire('power', { action: 'power', value: !onBattery })}
              >
                {onBattery ? t('sim.restorePower') : t('sim.cutPower')}
              </Button>
            </div>
          </Control>

          <Control
            label={t('sim.wifi')}
            glyph={live?.online ? <Wifi className={icon} /> : <WifiOff className={icon} />}
            tone={live && !live.online ? 'var(--offline)' : undefined}
            state={!live ? '–' : live.online ? t('sim.online') : t('sim.offline')}
          >
            <div>
              <Button
                variant="secondary"
                loading={loading('wifi')}
                disabled={busy}
                icon={cut ? <Wifi aria-hidden className={icon} /> : <WifiOff aria-hidden className={icon} />}
                onClick={() => fire('wifi', { action: 'wifi', value: !cut })}
              >
                {cut ? t('sim.restoreWifi') : t('sim.cutWifi')}
              </Button>
            </div>
          </Control>

          <Control
            label={t('sim.compressor')}
            glyph={<Fan className={icon} />}
            state={
              !live
                ? '–'
                : comp.on
                  ? t('sim.running')
                  : comp.restartInS
                    ? fmt(t('sim.restartIn'), { s: comp.restartInS })
                    : t('fridge.off')
            }
          >
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor={`eff-${fridge.id}`} className="text-sm font-semibold text-ink">
                  {t('sim.cooling')}
                </label>
                <output htmlFor={`eff-${fridge.id}`} className="figures text-sm font-semibold text-ink-2">
                  {effPct} %
                </output>
              </div>
              <input
                id={`eff-${fridge.id}`}
                type="range"
                min={20}
                max={100}
                step={5}
                value={effPct}
                onChange={(e) => setEffPct(Number(e.target.value))}
                className="h-11 w-full cursor-pointer accent-[var(--teal)]"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                loading={loading('eff')}
                disabled={busy}
                onClick={() => fire('eff', { action: 'eff', value: effPct / 100 })}
              >
                {fmt(t('sim.applyCooling'), { n: effPct })}
              </Button>
              <Button
                variant="ghost"
                loading={loading('eff-full')}
                disabled={busy}
                onClick={() => {
                  setEffPct(100);
                  fire('eff-full', { action: 'eff', value: 1 });
                }}
              >
                {t('sim.restoreComp')}
              </Button>
            </div>
          </Control>
        </div>
      </div>
    </Panel>
  );
}
