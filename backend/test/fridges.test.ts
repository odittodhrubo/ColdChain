import { describe, expect, it } from 'vitest';
import { type BatchInput, createBatch } from '../src/modules/batches/service';
import { MAX_POINTS } from '../src/modules/fridges/service';
import { envelope, NOW, nowS, reading, setup, telemetry, topic } from './deviceHelpers';
import { addUser, batchInput, bearer, tokenFor } from './helpers';

async function as(s: ReturnType<typeof setup>, role: 'ADMIN' | 'INSPECTOR' = 'INSPECTOR') {
  return bearer(tokenFor(s.t, await addUser(s.t, role)));
}

describe('fridges read API', () => {
  it('lists fridges with server-classified live state, batch counts and OFFLINE when silent', async () => {
    const s = setup();
    createBatch(s.ctx, batchInput('fridge-01') as BatchInput);
    s.ingest.handle(
      topic('telemetry'),
      envelope('telemetry', telemetry(1, { temp: 9.3, state: 'SAFE' })),
      NOW,
    );
    const res = await s.t
      .http()
      .get('/api/fridges')
      .set(await as(s));
    const [a, b] = res.body.fridges;
    expect(a).toMatchObject({
      id: 'fridge-01',
      device_id: 'fridge-01',
      load: 1,
      batch_counts: { SAFE: 1, AT_RISK: 0, DISCARD: 0 },
      live: { temp: 9.3, state: 'BREACH', device_state: 'SAFE' }, // the server's classify(), not the device's word
    });
    expect(b).toMatchObject({ id: 'fridge-02', status: 'OFFLINE', live: null });
    expect(typeof res.body.server_time).toBe('number');
  });

  it('door, battery and compressor-off times come from the device events, not from receipt', () => {
    const s = setup();
    let seq = 0;
    const event = (type: string, ts: number) =>
      s.ingest.handle(topic('event'), envelope('event', { seq: ++seq, ts, type, data: {} }), NOW);
    const tele = (o: Record<string, unknown>) =>
      s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(++seq, o)), NOW);
    tele({ door: 0, comp: 1 });
    event('DOOR_OPEN', nowS - 42);
    event('COMP_OFF', nowS - 10);
    event('POWER_FAIL', nowS - 90);
    tele({ door: 1, comp: 0, power: 'BATTERY' });
    expect(s.ingest.live.get('fridge-01')).toMatchObject({
      door_open_at: nowS - 42,
      comp_off_at: nowS - 10,
      battery_since: nowS - 90,
    });
    tele({ door: 1, comp: 0, power: 'BATTERY' }); // still the same episode
    expect(s.ingest.live.get('fridge-01')!.door_open_at).toBe(nowS - 42);
    tele({ door: 0, comp: 1, power: 'MAINS' });
    expect(s.ingest.live.get('fridge-01')).toMatchObject({
      door_open_at: null,
      comp_off_at: null,
      battery_since: null,
    });
  });

  it('detail: fridge, recent events and readings with the late flag', async () => {
    const s = setup();
    s.ingest.handle(
      topic('sync'),
      envelope('sync', {
        from_seq: 1,
        to_seq: 3,
        readings: [reading(1), { seq: 2, ts: nowS - 3000, type: 'DOOR_OPEN', data: {} }, reading(3)],
      }),
      NOW,
    );
    const res = await s.t
      .http()
      .get('/api/fridges/fridge-01')
      .set(await as(s));
    expect(res.body.fridge.id).toBe('fridge-01');
    expect(res.body.events).toEqual([expect.objectContaining({ type: 'DOOR_OPEN', late: 1 })]);
    expect(res.body.readings.map((r: { seq: number; late: number }) => [r.seq, r.late])).toEqual([
      [3, 1],
      [1, 1],
    ]);
    expect(
      (
        await s.t
          .http()
          .get('/api/fridges/nope')
          .set(await as(s))
      ).status,
    ).toBe(404);
  });

  it('history is downsampled on the server to at most 600 points, with band flags and events', async () => {
    const s = setup();
    const insert = s.t.db.prepare(
      `INSERT INTO readings (device_id, fridge_id, seq, ts, temp, door, comp, power, batt, state, exp_s, latch, mode,
        reason, late, received_at) VALUES ('fridge-01', 'fridge-01', ?, ?, ?, ?, ?, 'MAINS', 100, 'SAFE', 0, 0,
        'model', 'periodic', ?, 0)`,
    );
    const day = 86_400;
    const t0 = 1_800_000_000;
    s.t.db.transaction(() => {
      for (let i = 0; i < day / 5; i++)
        insert.run(
          i + 1,
          t0 + i * 5,
          4 + (i % 10) / 10,
          i % 500 < 3 ? 1 : 0,
          i % 80 < 40 ? 1 : 0,
          i % 1000 === 0 ? 1 : 0,
        );
    })();
    const auth = await as(s);
    const res = await s.t
      .http()
      .get(`/api/fridges/fridge-01/readings?from=${t0}&to=${t0 + day}`)
      .set(auth);
    expect(res.body.points.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(res.body.bucket).toBe(144);
    expect(res.body.points[0]).toMatchObject({ ts: t0, door: 1, comp: 1, late: 1 });
    const fine = await s.t
      .http()
      .get(`/api/fridges/fridge-01/readings?from=${t0}&to=${t0 + 300}&bucket=5`)
      .set(auth);
    expect(fine.body.points).toHaveLength(61);
    expect((await s.t.http().get(`/api/fridges/fridge-01/readings?from=10&to=5`).set(auth)).status).toBe(400);
  });
});
