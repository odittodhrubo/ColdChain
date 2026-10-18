import { describe, expect, it, vi } from 'vitest';
import type { PredictRequest } from '../src/ml/client';
import { forwardFill, minuteRows } from '../src/ml/engine';
import { cycleHealth, fallbackPrediction, NOMINAL_PULL_C_PER_MIN } from '../src/ml/fallback';
import type { MinuteRow } from '../src/ml/types';
import { addUser, bearer, makeApp, tokenFor, type TestApp } from './helpers';
import { addReading, ctxOf, HOT, liveFridge, prediction } from './relocationHelpers';

/** An hour of 5 s readings ending now: a compressor cycling 3-7 °C every 14 min. */
function hour(t: TestApp, fridgeId: string, nowS: number) {
  for (let i = 0; i < 720; i++) {
    const ts = nowS - (719 - i) * 5;
    const phase = (i % 168) / 168;
    const temp = phase < 0.5 ? 3 + 8 * phase : 7 - 8 * (phase - 0.5);
    addReading(t, fridgeId, { ts, temp, comp: phase >= 0.5 ? 1 : 0 });
  }
}

function recorder(t: TestApp) {
  const events: { event: string; data: unknown }[] = [];
  ctxOf(t).realtime = { emit: (event, data) => events.push({ event, data }) };
  return events;
}

describe('ML scheduler', () => {
  it('sends the last hour as 1-minute rows and stores and pushes the answer', async () => {
    const t = makeApp();
    const now = Date.now();
    const f = liveFridge(t, {}, now);
    hour(t, f, Math.floor(now / 1000));
    const events = recorder(t);
    const seen: PredictRequest[] = [];
    ctxOf(t).ml.predict = async (body) => {
      seen.push(body);
      return prediction();
    };
    await ctxOf(t).ml.tick(now);
    expect(seen).toHaveLength(1);
    expect(seen[0].readings.length).toBeGreaterThanOrEqual(59);
    expect(seen[0].readings.length).toBeLessThanOrEqual(61);
    expect(seen[0].readings.every((r) => r.ts % 60 === 0)).toBe(true);
    expect(ctxOf(t).ml.latest(f)).toMatchObject({
      source: 'model',
      stale: false,
      breach_level: 'LOW',
      fridge_id: f,
    });
    expect(events.find((e) => e.event === 'prediction:update')?.data).toMatchObject({ fridge_id: f });
  });

  it('skips silent fridges', async () => {
    const t = makeApp();
    const now = Date.now();
    const quiet = liveFridge(t, {}, now - 10 * 60_000); // one reading, 10 minutes old
    const predict = vi.fn(async () => prediction());
    ctxOf(t).ml.predict = predict;
    await ctxOf(t).ml.tick(now);
    expect(predict).not.toHaveBeenCalled();
    expect(ctxOf(t).ml.latest(quiet)).toBeNull();
  });

  it('PREDICTED_BREACH after 2 runs at MEDIUM or above, resolved after 2 calm runs; COMPRESSOR_WEAK likewise', async () => {
    const t = makeApp();
    const now = Date.now();
    const f = liveFridge(t, {}, now);
    hour(t, f, Math.floor(now / 1000));
    const ml = ctxOf(t).ml;
    const alert = (type: string) =>
      t.db
        .prepare('SELECT severity, resolved_at FROM alerts WHERE type = ? AND fridge_id = ?')
        .get(type, f) as { severity: string; resolved_at: number | null } | undefined;
    ml.predict = async () => HOT;
    await ml.tick(now);
    expect(alert('PREDICTED_BREACH')).toBeUndefined(); // one run is not enough
    await ml.tick(now + 1);
    expect(alert('PREDICTED_BREACH')).toMatchObject({ severity: 'CRITICAL', resolved_at: null });
    expect(alert('COMPRESSOR_WEAK')).toMatchObject({ severity: 'CRITICAL' }); // health 41
    ml.predict = async () => prediction();
    await ml.tick(now + 2);
    expect(alert('PREDICTED_BREACH')!.resolved_at).toBeNull();
    await ml.tick(now + 3);
    expect(alert('PREDICTED_BREACH')!.resolved_at).not.toBeNull();
    await ml.tick(now + 4);
    expect(alert('COMPRESSOR_WEAK')!.resolved_at).not.toBeNull(); // 3 healthy runs
  });

  it('ML service down: the rule-based fallback answers, marked stale; nothing throws', async () => {
    const t = makeApp({ ML_URL: 'http://127.0.0.1:1' }); // nothing listens there
    const now = Date.now();
    const f = liveFridge(t, {}, now);
    hour(t, f, Math.floor(now / 1000));
    await expect(ctxOf(t).ml.tick(now)).resolves.toBeUndefined();
    const latest = ctxOf(t).ml.latest(f)!;
    expect(latest).toMatchObject({
      source: 'fallback',
      stale: true,
      model_version: null,
      breach_level: 'LOW',
    });
    expect(latest.health_score).toBeGreaterThan(70);
    const token = tokenFor(t, await addUser(t, 'INSPECTOR'));
    const res = await t.http().get(`/api/ml/predictions/${f}`).set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.predictions).toHaveLength(1);
    expect(res.body.latest.stale).toBe(true);
    const report = await t.http().get('/api/ml/report').set(bearer(token));
    expect(report.status).toBe(503);
    expect(report.body.error.code).toBe('ML_UNAVAILABLE');
  });

  it('feeds the relocation planner on every run', async () => {
    const t = makeApp();
    const now = Date.now();
    const f = liveFridge(t, {}, now);
    hour(t, f, Math.floor(now / 1000));
    const spy = vi.spyOn(ctxOf(t).relocation, 'evaluate');
    ctxOf(t).ml.predict = async () => prediction();
    await ctxOf(t).ml.tick(now);
    expect(spy).toHaveBeenCalledWith(now);
  });
});

describe('minute rows and the fallback rule', () => {
  const row = (ts: number, temp: number | null, o: Partial<MinuteRow> = {}): MinuteRow => ({
    ts,
    temp,
    door: 0,
    comp: 0,
    battery: false,
    batt: 100,
    ...o,
  });

  it('buckets readings by minute (fractions for door / compressor)', () => {
    const t = makeApp();
    const f = liveFridge(t);
    const base = 1_800_000_000 - (1_800_000_000 % 60);
    for (let i = 0; i < 12; i++)
      addReading(t, f, { ts: base + i * 5, temp: 4 + i * 0.1, door: i < 3 ? 1 : 0, comp: i % 2 ? 1 : 0 });
    const [m] = minuteRows(ctxOf(t), f, base, base + 59);
    expect(m.ts).toBe(base);
    expect(m.temp).toBeCloseTo(4.55);
    expect(m.door).toBeCloseTo(0.25);
    expect(m.comp).toBeCloseTo(0.5);
  });

  it('forward-fills gaps of up to 3 minutes only', () => {
    const filled = forwardFill([row(0, 5), row(240, 6), row(600, 7)]);
    expect(filled.map((r) => r.ts)).toEqual([0, 60, 120, 180, 240, 600]);
    expect(filled[2].temp).toBe(5);
  });

  it('fallback: a flat hour is LOW; a steady climb to 8 °C is HIGH with a time to breach', () => {
    const flat = Array.from({ length: 60 }, (_, i) => row(i * 60, 5));
    expect(fallbackPrediction(flat, flat)).toMatchObject({ breach_level: 'LOW', pred_temp_30: 5 });
    const climb = Array.from({ length: 60 }, (_, i) => row(i * 60, 4 + i * 0.05));
    const p = fallbackPrediction(climb, climb);
    expect(p.breach_level).toBe('HIGH');
    expect(p.minutes_to_breach_estimate).toBeGreaterThan(0);
    expect(p.p10! < p.pred_temp_30! && p.pred_temp_30! < p.p90!).toBe(true);
  });

  it('fallback: the warm half of a normal compressor cycle is not a breach', () => {
    const warmUp = Array.from({ length: 60 }, (_, i) =>
      row(i * 60, i < 45 ? 3 + ((i % 15) / 15) * 4 : 3 + (i - 45) * 0.25, {
        comp: i < 45 && i % 15 > 10 ? 1 : 0,
      }),
    );
    expect(fallbackPrediction(warmUp, warmUp).breach_level).toBe('LOW');
  });

  it('cycle-rate health: a healthy pull scores high, a weak compressor low, no cycles unknown', () => {
    // 6 minutes off warming 0.6 °C/min, 6 minutes on cooling at (pull - 0.6) °C/min
    const cycles = (pull: number) =>
      Array.from({ length: 240 }, (_, i) => {
        const on = Math.floor(i / 6) % 2 === 1;
        return row(i * 60, on ? 7 - (pull - 0.6) * (i % 6) : 3 + 0.6 * (i % 6), { comp: on ? 1 : 0 });
      });
    expect(cycleHealth(cycles(NOMINAL_PULL_C_PER_MIN))).toBeGreaterThan(90);
    expect(cycleHealth(cycles(0.7))).toBeLessThan(70);
    expect(cycleHealth([row(0, 5), row(60, 5)])).toBeNull();
  });
});
