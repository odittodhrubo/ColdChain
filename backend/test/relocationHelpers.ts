import { createBatch, type BatchInput } from '../src/modules/batches/service';
import type { Prediction } from '../src/ml/types';
import type { AppContext } from '../src/shared/http';
import { addFridge, batchInput, type TestApp } from './helpers';

export const ctxOf = (t: TestApp) => t.app.locals.ctx as AppContext;

let seq = 0;
/** A fridge with a device and one fresh reading (so it is online with the given live state). */
export function liveFridge(
  t: TestApp,
  o: { capacity?: number; temp?: number; door?: 0 | 1; power?: 'MAINS' | 'BATTERY'; batt?: number } = {},
  nowMs = Date.now(),
) {
  const id = addFridge(t, o.capacity ?? 20);
  t.db
    .prepare('INSERT INTO devices (device_id, fridge_id, secret_enc, created_at) VALUES (?, ?, ?, 0)')
    .run(`dev-${id}`, id, 'x');
  addReading(t, id, { ...o, ts: Math.floor(nowMs / 1000) }, nowMs);
  return id;
}

export function addReading(
  t: TestApp,
  fridgeId: string,
  r: { ts: number; temp?: number; door?: 0 | 1; comp?: 0 | 1; power?: 'MAINS' | 'BATTERY'; batt?: number },
  receivedAt = r.ts * 1000,
) {
  seq += 1;
  t.db
    .prepare(
      `INSERT INTO readings (device_id, fridge_id, seq, ts, temp, door, comp, power, batt, state, exp_s, latch, mode,
         reason, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SAFE', 0, 0, 'model', 'periodic', ?)`,
    )
    .run(
      `dev-${fridgeId}`,
      fridgeId,
      seq,
      r.ts,
      r.temp ?? 5,
      r.door ?? 0,
      r.comp ?? 0,
      r.power ?? 'MAINS',
      r.batt ?? 100,
      receivedAt,
    );
}

export const prediction = (o: Partial<Prediction> = {}): Prediction => ({
  status: 'ok',
  at: 0,
  pred_temp_30: 5,
  p10: 4,
  p90: 6,
  breach_level: 'LOW',
  breach_prob: 0.01,
  minutes_to_breach_estimate: null,
  health_score: 92,
  health_band: 'GOOD',
  health_method: 'model',
  health_trend_per_day: null,
  weakening: false,
  features_used: { temp_slope_15: 0 },
  health_factors: {},
  model_version: 'test',
  ...o,
});

/** Stores a prediction as the scheduler would (newest wins). */
export function setPrediction(
  t: TestApp,
  fridgeId: string,
  p: Prediction,
  nowMs = Date.now(),
  source = 'model',
) {
  t.db
    .prepare(
      `INSERT INTO ml_predictions (fridge_id, created_at, horizon_min, forecast, breach_prob, health_score, level, source, model_version)
       VALUES (?, ?, 30, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fridgeId,
      nowMs,
      JSON.stringify(p),
      p.breach_prob,
      p.health_score,
      p.breach_level,
      source,
      p.model_version,
    );
}

export const HOT = prediction({
  pred_temp_30: 8.9,
  p10: 7.6,
  p90: 9.8,
  breach_level: 'HIGH',
  breach_prob: 0.9,
  minutes_to_breach_estimate: 18,
  health_score: 41,
  health_band: 'FAILING',
  weakening: true,
});

/** Source fridge at risk with `n` batches, a safe target, and an active plan from two evaluations. */
export function proposedPlan(t: TestApp, n = 2, nowMs = Date.now()) {
  const ctx = ctxOf(t);
  const from = liveFridge(t, { temp: 7.4 }, nowMs);
  const to = liveFridge(t, {}, nowMs);
  const batches = Array.from({ length: n }, (_, i) =>
    createBatch(ctx, batchInput(from, { name: `Batch ${i + 1}` }) as BatchInput, undefined, nowMs),
  );
  setPrediction(t, from, HOT, nowMs);
  setPrediction(t, to, prediction(), nowMs);
  ctx.relocation.evaluate(nowMs);
  ctx.relocation.evaluate(nowMs);
  const plan = ctx.relocation.list({ status: 'active', limit: 100 }).find((p) => p.from_fridge === from)!;
  return { from, to, batches, plan };
}
