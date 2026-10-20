import { describe, expect, it } from 'vitest';
import { checkpointReadings, verifyChain } from '../src/modules/audit/chain';
import { retireReadings, rollupReadings } from '../src/modules/fridges/retention';
import { readingsHistory } from '../src/modules/fridges/service';
import { nowS, setup } from './deviceHelpers';

const DAY = 86_400;

/** 350 readings 100 days ago (5 s apart), then 50 from the last hour: four checkpoint blocks of 100. */
function seedReadings(s: ReturnType<typeof setup>) {
  const insert = s.t.db.prepare(
    `INSERT INTO readings (device_id, fridge_id, seq, ts, temp, door, comp, power, batt, state, exp_s, latch, mode,
                           reason, late, received_at, seeded)
     VALUES ('fridge-01', 'fridge-01', ?, ?, ?, ?, ?, ?, 100, 'SAFE', 0, 0, 'model', 'periodic', 0, ?, 0)`,
  );
  const old = Math.floor((nowS - 100 * DAY) / 3600) * 3600; // hour-aligned, so the blocks map to known hours
  for (let i = 0; i < 350; i++) {
    const temp = i % 50 === 0 ? null : 4 + (i % 7); // 4..10 °C, a sensor fault every 50th
    insert.run(i + 1, old + i * 5, temp, i % 9 === 0 ? 1 : 0, i % 2, i % 13 === 0 ? 'BATTERY' : 'MAINS', 0);
  }
  for (let i = 0; i < 50; i++) insert.run(351 + i, nowS - 3600 + i * 5, 5.0, 0, 1, 'MAINS', 0);
  expect(checkpointReadings(s.t.db, 'fridge-01')).toBe(4);
  return old;
}

describe('readings rollup and retention (R8)', () => {
  it('rolls finished hours up exactly as the raw rows aggregate', () => {
    const s = setup();
    const old = seedReadings(s);
    expect(rollupReadings(s.ctx, nowS)).toBeGreaterThan(0);
    const raw = s.t.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(temp) AS t_min, MAX(temp) AS t_max, ROUND(AVG(temp), 3) AS t_avg,
                SUM(temp > 8) AS n_above_8, SUM(door) AS n_door_open, SUM(comp) AS n_comp_on,
                SUM(power = 'BATTERY') AS n_battery
         FROM readings WHERE fridge_id = 'fridge-01' AND ts >= ? AND ts < ?`,
      )
      .get(old, old + 3600);
    const rolled = s.t.db
      .prepare(
        `SELECT n, t_min, t_max, t_avg, n_above_8, n_door_open, n_comp_on, n_battery FROM readings_hourly
         WHERE fridge_id = 'fridge-01' AND hour = ?`,
      )
      .get(old);
    expect(rolled).toEqual(raw);
    // the current (unfinished) hour is not rolled up
    const current = Math.floor(nowS / 3600) * 3600;
    expect(s.t.db.prepare('SELECT COUNT(*) FROM readings_hourly WHERE hour >= ?').pluck().get(current)).toBe(
      0,
    );
    // running again changes nothing (idempotent upsert)
    rollupReadings(s.ctx, nowS);
    expect(s.t.db.prepare('SELECT * FROM readings_hourly WHERE hour = ?').get(old)).toMatchObject(
      raw as object,
    );
  });

  it('retires only old, rolled-up checkpoint blocks, audits each, and Verify Integrity stays green', async () => {
    const s = setup();
    seedReadings(s);
    expect(retireReadings(s.ctx, nowS)).toBe(0); // nothing is rolled up yet: never delete un-rolled hours
    rollupReadings(s.ctx, nowS);
    expect(retireReadings(s.ctx, nowS)).toBe(300); // blocks 1-3; block 4 holds the last hour's readings
    expect(s.t.db.prepare('SELECT COUNT(*) FROM readings').pluck().get()).toBe(100);
    const retired = s.t.db
      .prepare("SELECT payload FROM audit_log WHERE event_type = 'READINGS_RETIRED' ORDER BY id")
      .pluck()
      .all() as string[];
    expect(retired.map((p) => JSON.parse(p))).toEqual([
      expect.objectContaining({ fridge_id: 'fridge-01', from_id: 1, to_id: 100, count: 100 }),
      expect.objectContaining({ from_id: 101, to_id: 200 }),
      expect.objectContaining({ from_id: 201, to_id: 300 }),
    ]);
    const v = await verifyChain(s.t.db);
    expect(v).toMatchObject({ valid: true, checkpoints: 4, retired: 3 });
    expect(retireReadings(s.ctx, nowS)).toBe(0); // idempotent
    expect(s.t.db.prepare('SELECT COUNT(*) FROM readings_hourly').pluck().get()).toBeGreaterThan(0); // record kept
  });

  it('a deletion without a READINGS_RETIRED entry in the chain is still tampering', async () => {
    const s = setup();
    seedReadings(s);
    rollupReadings(s.ctx, nowS);
    // an attacker deletes a block and fakes the bookkeeping table, but cannot add the chain entry unnoticed
    s.t.db.prepare("DELETE FROM readings WHERE fridge_id = 'fridge-01' AND id BETWEEN 1 AND 100").run();
    s.t.db
      .prepare(
        "INSERT INTO readings_retired (fridge_id, from_id, to_id, retired_at) VALUES ('fridge-01', 1, 100, 0)",
      )
      .run();
    expect(await verifyChain(s.t.db)).toMatchObject({ valid: false, reason: 'READINGS_TAMPERED' });
  });

  it('a partly deleted retired block is tampering too', async () => {
    const s = setup();
    seedReadings(s);
    rollupReadings(s.ctx, nowS);
    retireReadings(s.ctx, nowS);
    s.t.db.prepare("DELETE FROM readings WHERE fridge_id = 'fridge-01' AND id = 350").run(); // block 4
    expect(await verifyChain(s.t.db)).toMatchObject({ valid: false, reason: 'READINGS_TAMPERED' });
  });

  it('the chart shows hourly rollups where raw readings were retired', () => {
    const s = setup();
    const old = seedReadings(s);
    rollupReadings(s.ctx, nowS);
    retireReadings(s.ctx, nowS);
    const h = readingsHistory(s.ctx, 'fridge-01', { from: old, to: old + 3 * 3600 });
    // the hour holds 300 retired + 50 still raw readings: one rollup point with all 350, never counted twice
    expect(h.points).toEqual([expect.objectContaining({ ts: old, rollup: 1, n: 350 })]);
    const before = s.t.db.prepare('SELECT * FROM readings_hourly WHERE hour = ?').get(old) as {
      t_avg: number;
    };
    expect((h.points[0] as { temp: number }).temp).toBeCloseTo(before.t_avg, 2);
    const recent = readingsHistory(s.ctx, 'fridge-01', { from: nowS - 3600, to: nowS });
    expect(recent.points.some((p) => (p as { rollup?: number }).rollup === 1)).toBe(false);
  });
});
