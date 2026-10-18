import { SAFE_MAX_C } from '../shared/constants';
import type { MinuteRow, Prediction } from './types';

// Deterministic stand-in when the ML service is down (P18): linear extrapolation of the last 30 minutes and a
// cycle-rate health check. Deliberately simple and labelled `fallback` + `stale` everywhere it is shown.

// The node's nominal cooling pull: node_config.h COOL_RATE_C_PER_S (0.02 °C/s) per minute, and its heat leak
// near 5 °C (K_LEAK_PER_S 0.0004 x 25 °C) per minute, used when the compressor never switched off.
export const NOMINAL_PULL_C_PER_MIN = 1.2;
export const NOMINAL_WARM_C_PER_MIN = 0.6;
const SPREAD_C = 1.0; // a rule has no calibrated interval: ±1 °C around its line, said plainly in the UI

export function slope(rows: MinuteRow[]): number | null {
  const pts = rows.filter((r) => r.temp !== null).map((r) => [r.ts / 60, r.temp as number]);
  if (pts.length < 2) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const den = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  return den ? pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / den : null;
}

export const band = (score: number | null) =>
  score === null ? 'UNKNOWN' : score >= 80 ? 'GOOD' : score >= 50 ? 'WEAKENING' : 'FAILING';

/** Cooling pull of the compressor (cooling while ON + warming while OFF) against the nominal pull, in %.
 * Minutes with the door open or on battery are left out. */
export function cycleHealth(history: MinuteRow[]): number | null {
  const cool: number[] = [];
  const warm: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1];
    const b = history[i];
    if (b.ts - a.ts !== 60 || a.temp === null || b.temp === null) continue;
    if (a.door > 0 || b.door > 0 || a.battery || b.battery) continue;
    const on = a.comp >= 0.5 && b.comp >= 0.5;
    const off = a.comp < 0.5 && b.comp < 0.5;
    if (on) cool.push(a.temp - b.temp);
    else if (off) warm.push(b.temp - a.temp);
  }
  if (cool.length < 3) return null;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const pull = mean(cool) + (warm.length >= 3 ? mean(warm) : NOMINAL_WARM_C_PER_MIN);
  return Math.max(0, Math.min(100, (100 * pull) / NOMINAL_PULL_C_PER_MIN));
}

export function fallbackPrediction(window: MinuteRow[], history: MinuteRow[]): Prediction {
  const last = [...window].reverse().find((r) => r.temp !== null);
  const now = last?.temp ?? null;
  const last30 = window.slice(-30);
  const s30 = slope(last30); // ~2 compressor cycles: the cycling averages out
  let pred = now === null ? null : Math.max(now - 5, Math.min(now + 15, now + 30 * (s30 ?? 0)));
  // A compressor that is cycling normally (it ran, stayed under 7.5 °C, door shut, mains) keeps the fridge in
  // its band: a warm-up phase must not be extrapolated into a breach.
  const temps = last30.map((r) => r.temp).filter((t): t is number => t !== null);
  const cycling =
    last30.some((r) => r.comp >= 0.5) &&
    temps.length > 0 &&
    Math.max(...temps) <= 7.5 &&
    last30.slice(-15).every((r) => r.door === 0 && !r.battery);
  if (pred !== null && cycling) pred = Math.min(pred, Math.max(...temps) + 0.5);
  const p90 = pred === null ? null : cycling ? Math.min(pred + SPREAD_C, SAFE_MAX_C) : pred + SPREAD_C;
  const level =
    pred === null || p90 === null
      ? 'LOW'
      : pred > SAFE_MAX_C || p90 > SAFE_MAX_C + 1 || (now ?? 0) > SAFE_MAX_C
        ? 'HIGH'
        : p90 > SAFE_MAX_C
          ? 'MEDIUM'
          : 'LOW';
  let toBreach: number | null = null;
  if (now !== null && now > SAFE_MAX_C) toBreach = 0;
  else if (now !== null && pred !== null && pred > SAFE_MAX_C)
    toBreach = (30 * (SAFE_MAX_C - now)) / (pred - now);
  const health = cycleHealth(history);
  const s15 = slope(window.slice(-15));
  return {
    status: 'ok',
    at: last?.ts ?? 0,
    pred_temp_30: pred,
    p10: pred === null ? null : pred - SPREAD_C,
    p90,
    breach_level: level,
    breach_prob: null,
    minutes_to_breach_estimate: toBreach === null ? null : Math.round(toBreach * 10) / 10,
    health_score: health,
    health_band: band(health),
    health_method: health === null ? 'insufficient' : 'fallback',
    health_trend_per_day: null,
    weakening: health !== null && health < 70,
    features_used: { temp_now: now, temp_slope_15: s15, temp_slope_30: s30 },
    health_factors: {},
    model_version: null,
  };
}
