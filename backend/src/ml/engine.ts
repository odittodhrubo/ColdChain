import type { AppContext } from '../shared/http';
import { logger } from '../shared/logger';
import { httpPredict, type PredictFn } from './client';
import { fallbackPrediction } from './fallback';
import type { MinuteRow, Prediction, StoredPrediction } from './types';

// Scheduled inference (P18): every 30 s per fridge, the last 60 minutes of readings (1-minute buckets, gaps
// forward-filled up to 3 minutes) and the last 24 h of minutes go to the ML service. The answer is stored,
// pushed to the UI, turned into PREDICTED_BREACH / COMPRESSOR_WEAK alerts, and handed to the relocation
// planner. If the service is down the rule-based fallback answers instead, marked stale. Ingestion never waits
// for any of this: it runs on its own timer.

/** A prediction older than two runs (plus slack) is stale: the planner ignores it. */
export const freshForMs = (intervalMs: number) => 2 * intervalMs + 10_000;
const FILL_MAX_MIN = 3;
const MIN_READINGS = 20;
const SILENT_AFTER_S = 180; // no reading for 3 min: nothing new to predict on
const RAISE_AFTER = 2; // consecutive runs before an alert (no flapping)
const CLEAR_WEAK_AFTER = 3;

interface Streak {
  breach: number;
  calm: number;
  weak: number;
  strong: number;
}

/** 1-minute buckets of a fridge's readings in [fromS, toS]. */
export function minuteRows(ctx: AppContext, fridgeId: string, fromS: number, toS: number): MinuteRow[] {
  const rows = ctx.db
    .prepare(
      `SELECT (ts / 60) * 60 AS ts, AVG(temp) AS temp, AVG(door) AS door, AVG(comp) AS comp,
              MAX(power = 'BATTERY') AS battery, MIN(batt) AS batt
       FROM readings WHERE fridge_id = ? AND ts >= ? AND ts <= ? GROUP BY ts / 60 ORDER BY ts`,
    )
    .all(fridgeId, fromS, toS) as (Omit<MinuteRow, 'battery'> & { battery: number })[];
  return rows.map((r) => ({ ...r, battery: r.battery === 1 }));
}

/** Copies the previous minute into gaps of at most `max` minutes; longer gaps stay gaps. */
export function forwardFill(rows: MinuteRow[], max = FILL_MAX_MIN): MinuteRow[] {
  const out: MinuteRow[] = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    if (prev) {
      const gap = (r.ts - prev.ts) / 60 - 1;
      if (gap >= 1 && gap <= max) for (let k = 1; k <= gap; k++) out.push({ ...prev, ts: prev.ts + 60 * k });
    }
    out.push(r);
  }
  return out;
}

export class MlEngine {
  predict: PredictFn;
  /** Unix ms of the last answer from the ML service, and of the last rule-based fallback (readiness). */
  lastModelAt = 0;
  lastFallbackAt = 0;
  private running = false;
  private readonly streaks = new Map<string, Streak>();
  private readonly insert;
  private readonly latestStmt;

  constructor(private readonly ctx: AppContext) {
    this.predict = httpPredict(ctx.config);
    this.insert = ctx.db.prepare(
      `INSERT INTO ml_predictions (fridge_id, created_at, horizon_min, forecast, breach_prob, health_score, level, source, model_version)
       VALUES (?, ?, 30, ?, ?, ?, ?, ?, ?)`,
    );
    this.latestStmt = ctx.db.prepare(
      'SELECT * FROM ml_predictions WHERE fridge_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    );
  }

  /** The newest stored prediction for a fridge (any age), or null. */
  latest(fridgeId: string): StoredPrediction | null {
    const r = this.latestStmt.get(fridgeId) as PredictionRow | undefined;
    return r ? fromRow(r) : null;
  }

  /** One scheduler run over every fridge. Overlapping runs are skipped, never queued. */
  async tick(nowMs = Date.now()) {
    if (this.running) return;
    this.running = true;
    try {
      const fridges = this.ctx.db.prepare('SELECT id FROM fridges ORDER BY id').pluck().all() as string[];
      for (const id of fridges) await this.runFridge(id, nowMs);
      this.ctx.relocation.evaluate(nowMs);
    } finally {
      this.running = false;
    }
  }

  private async runFridge(fridgeId: string, nowMs: number) {
    const lastTs = this.ctx.db
      .prepare('SELECT MAX(ts) FROM readings WHERE fridge_id = ?')
      .pluck()
      .get(fridgeId) as number | null;
    if (lastTs === null || nowMs / 1000 - lastTs > SILENT_AFTER_S) return;
    const window = forwardFill(minuteRows(this.ctx, fridgeId, lastTs - 3600 + 1, lastTs));
    if (window.filter((r) => r.temp !== null).length < MIN_READINGS) return;
    const history = minuteRows(this.ctx, fridgeId, lastTs - 86_400 + 1, lastTs);
    const health_history = this.healthHistory(fridgeId, nowMs);

    let prediction: Prediction;
    let source: 'model' | 'fallback' = 'model';
    try {
      const res = await this.predict({
        fridge_id: fridgeId,
        readings: window,
        history_24h: history,
        health_history,
      });
      this.lastModelAt = nowMs; // the service answered, even if it wants more data
      if (res.status !== 'ok') return; // the service wants more data: say nothing rather than guess
      prediction = res;
    } catch (err) {
      logger.warn({ fridgeId, err: (err as Error).message }, 'ML service unavailable: rule-based fallback');
      prediction = fallbackPrediction(window, history);
      source = 'fallback';
      this.lastFallbackAt = nowMs;
    }
    const stored: StoredPrediction = {
      ...prediction,
      fridge_id: fridgeId,
      created_at: nowMs,
      source,
      stale: source === 'fallback',
    };
    this.insert.run(
      fridgeId,
      nowMs,
      JSON.stringify(prediction),
      prediction.breach_prob,
      prediction.health_score,
      prediction.breach_level,
      source,
      prediction.model_version,
    );
    this.ctx.realtime.emit('prediction:update', stored);
    this.alerts(fridgeId, stored, nowMs);
  }

  private healthHistory(fridgeId: string, nowMs: number) {
    const rows = this.ctx.db
      .prepare(
        `SELECT created_at, health_score FROM ml_predictions
         WHERE fridge_id = ? AND created_at > ? AND health_score IS NOT NULL AND source = 'model' ORDER BY created_at`,
      )
      .all(fridgeId, nowMs - 86_400_000) as { created_at: number; health_score: number }[];
    const step = Math.max(1, Math.ceil(rows.length / 200));
    return rows
      .filter((_, i) => i % step === 0)
      .map((r) => ({ ts: Math.floor(r.created_at / 1000), score: Math.round(r.health_score * 10) / 10 }));
  }

  private alerts(fridgeId: string, p: StoredPrediction, nowMs: number) {
    const s = this.streaks.get(fridgeId) ?? { breach: 0, calm: 0, weak: 0, strong: 0 };
    this.streaks.set(fridgeId, s);
    const name = this.ctx.db.prepare('SELECT name FROM fridges WHERE id = ?').pluck().get(fridgeId) as string;
    const tag = p.source === 'fallback' ? ' (rule-based fallback: ML service down)' : '';
    if (p.breach_level !== 'LOW') {
      s.breach += 1;
      s.calm = 0;
    } else {
      s.calm += 1;
      s.breach = 0;
    }
    if (s.breach >= RAISE_AFTER) {
      this.ctx.alerts.raise(
        {
          type: 'PREDICTED_BREACH',
          severity: p.breach_level === 'HIGH' ? 'CRITICAL' : 'WARNING',
          fridgeId,
          title: `Breach predicted: ${name}`,
          lines: [
            `Forecast ${fmt(p.pred_temp_30)} °C in 30 min (80 % range ${fmt(p.p10)}–${fmt(p.p90)} °C)${tag}`,
            p.minutes_to_breach_estimate !== null
              ? `May pass 8 °C in about ${Math.round(p.minutes_to_breach_estimate)} min`
              : `Risk level ${p.breach_level}`,
          ],
          data: { level: p.breach_level, source: p.source },
        },
        nowMs,
      );
    } else if (s.calm >= RAISE_AFTER)
      this.ctx.alerts.resolve('PREDICTED_BREACH', fridgeId, null, undefined, nowMs);

    if (p.weakening) {
      s.weak += 1;
      s.strong = 0;
    } else if (p.health_score !== null) {
      s.strong += 1;
      s.weak = 0;
    }
    if (s.weak >= RAISE_AFTER) {
      this.ctx.alerts.raise(
        {
          type: 'COMPRESSOR_WEAK',
          severity: (p.health_score ?? 100) < 50 ? 'CRITICAL' : 'WARNING',
          fridgeId,
          title: `Weakening compressor: ${name}`,
          lines: [
            `Health ${Math.round(p.health_score ?? 0)}/100 (${p.health_band})${tag}`,
            p.health_trend_per_day !== null
              ? `Trend ${p.health_trend_per_day.toFixed(1)} points/day`
              : 'Service recommended',
          ],
          data: { health: p.health_score, source: p.source },
        },
        nowMs,
      );
    } else if (s.strong >= CLEAR_WEAK_AFTER)
      this.ctx.alerts.resolve('COMPRESSOR_WEAK', fridgeId, null, undefined, nowMs);
  }
}

const fmt = (v: number | null) => (v === null ? '?' : v.toFixed(1));

export interface PredictionRow {
  id: number;
  fridge_id: string;
  created_at: number;
  forecast: string;
  source: 'model' | 'fallback';
}

export const fromRow = (r: PredictionRow): StoredPrediction => ({
  ...(JSON.parse(r.forecast) as Prediction),
  fridge_id: r.fridge_id,
  created_at: r.created_at,
  source: r.source,
  stale: r.source === 'fallback',
});
