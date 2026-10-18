import { COMP_MIN_OFF_S, DOOR_ALARM_S, DOUBLE_ABOVE_C, SAFE_MAX_C } from '../lib/constants';
import type { Fridge } from '../lib/types';
import type { FridgeStatus } from '../ui/status';

// Pure dashboard rules, unit-tested. Inputs are server fields and server time only.

export const STALE_AFTER_MS = 20_000; // no accepted message for this long: the card goes grey

/** The server's classification of the latest reading; OFFLINE when the node is silent or the data is stale. */
export function fridgeStatus(f: Pick<Fridge, 'live'>, nowMs: number): FridgeStatus {
  const live = f.live;
  if (!live || !live.online || nowMs - live.last_seen > STALE_AFTER_MS) return 'OFFLINE';
  return live.state;
}

/** Seconds without data once stale, otherwise null. */
export function staleFor(f: Pick<Fridge, 'live'>, nowMs: number): number | null {
  if (!f.live) return null;
  const s = (nowMs - f.live.last_seen) / 1000;
  return s * 1000 > STALE_AFTER_MS ? Math.floor(s) : null;
}

/** Door open for n s (from the device's DOOR_OPEN time); an alarm past DOOR_ALARM_S, like the node's buzzer. */
export function doorState(f: Pick<Fridge, 'live'>, nowMs: number) {
  const live = f.live;
  if (!live || live.door !== 1) return { open: false, seconds: 0, alarm: false };
  const seconds = live.door_open_at ? nowMs / 1000 - live.door_open_at : 0;
  return { open: true, seconds, alarm: seconds > DOOR_ALARM_S };
}

/** Compressor: on, or off with the seconds left of its minimum off-time (0 = may restart). */
export function compressorState(f: Pick<Fridge, 'live'>, nowMs: number) {
  const live = f.live;
  if (!live) return { on: false, restartInS: 0 };
  if (live.comp === 1) return { on: true, restartInS: 0 };
  const left = live.comp_off_at ? COMP_MIN_OFF_S - (nowMs / 1000 - live.comp_off_at) : 0;
  return { on: false, restartInS: Math.max(0, Math.ceil(left)) };
}

export type BudgetTone = 'safe' | 'warning' | 'atrisk' | 'breach';

/** Budget bar colour: green, amber from 50 %, orange below 20 % (At Risk), red at 0 (Discard). */
export function budgetTone(remainingPct: number): BudgetTone {
  if (remainingPct <= 0) return 'breach';
  if (remainingPct < 20) return 'atrisk';
  if (remainingPct < 50) return 'warning';
  return 'safe';
}

export type Accrual = 'x2' | 'x1' | 'none' | 'unknown';

/** How a batch in this fridge accrues exposure right now (contract section 2): x1 above 8 °C, x2 above 12 °C. */
export function accrual(f: Pick<Fridge, 'live'>, nowMs: number): Accrual {
  if (fridgeStatus(f, nowMs) === 'OFFLINE') return 'unknown';
  const t = f.live!.temp;
  if (t === null || t > DOUBLE_ABOVE_C) return 'x2';
  return t > SAFE_MAX_C ? 'x1' : 'none';
}

export const ACCRUAL_LABEL: Record<Accrual, string> = {
  x2: 'accruing ×2',
  x1: 'accruing ×1',
  none: 'not accruing',
  unknown: 'no live data',
};
