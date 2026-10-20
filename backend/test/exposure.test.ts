import { describe, expect, it, vi } from 'vitest';
import vectors from '../../contracts/test_vectors.json';
import {
  type BatchInput,
  createBatch,
  getBatch,
  moveBatch,
  refreshStatus,
} from '../src/modules/batches/service';
import { HeatEngine, MAX_STEP_MS, rate, segment, weightedSeconds } from '../src/modules/exposure/engine';
import { sign } from '../src/mqtt/envelope';
import { RecordingRealtime } from '../src/realtime';
import type { AppContext } from '../src/shared/http';
import { remainingPct } from '../src/shared/status';
import { envelope, NOW, SECRET, setup, telemetry, topic } from './deviceHelpers';
import { addFridge, addUser, batchInput, bearer, makeApp, tokenFor, type TestApp } from './helpers';

const T0 = 1_800_000_000_000; // fixed timeline (unix ms), far from any real reading
const ctxOf = (t: TestApp) => t.app.locals.ctx as AppContext;

/** Stores a reading like the ingestor does and hands it to the heat engine. */
function feed(t: TestApp, fridgeId: string, seq: number, tsS: number, temp: number | null, late = false) {
  const row = {
    device_id: `dev-${fridgeId}`,
    fridge_id: fridgeId,
    seq,
    ts: tsS,
    temp,
    door: 0 as const,
    comp: 0 as const,
    power: 'MAINS' as const,
    batt: 100,
    state: 'SAFE' as const,
    exp_s: 0,
    latch: 0 as const,
    mode: 'model' as const,
    reason: 'periodic' as const,
    late: (late ? 1 : 0) as 0 | 1,
    received_at: T0,
  };
  t.db
    .prepare(
      `INSERT INTO readings (device_id, fridge_id, seq, ts, temp, door, comp, power, batt, state, exp_s, latch, mode,
        reason, late, received_at) VALUES (@device_id, @fridge_id, @seq, @ts, @temp, @door, @comp, @power, @batt,
        @state, @exp_s, @latch, @mode, @reason, @late, @received_at)`,
    )
    .run(row);
  ctxOf(t).heat.onReadings(fridgeId, [row], { late }, T0);
}

function fridgeWithDevice(t: TestApp, capacity = 20) {
  const f = addFridge(t, capacity);
  t.db
    .prepare("INSERT INTO devices (device_id, fridge_id, secret_enc, created_at) VALUES (?, ?, 'x', 0)")
    .run(`dev-${f}`, f);
  return f;
}

const exposureS = (t: TestApp, id: number) =>
  (t.db.prepare('SELECT exposure_ms FROM batches WHERE id = ?').pluck().get(id) as number) / 1000;
const mk = (t: TestApp, f: string, nowMs = T0) =>
  createBatch(ctxOf(t), batchInput(f) as BatchInput, undefined, nowMs);

/** Readings every 5 s at a constant temperature from startS for durationS (plus one closing reading). */
function run(t: TestApp, f: string, startS: number, durationS: number, temp: number, seq0: number) {
  for (let k = 0; k * 5 <= durationS; k++) feed(t, f, seq0 + k, startS + k * 5, temp);
  return seq0 + durationS / 5 + 1;
}

describe('accrual rule (contract section 2)', () => {
  it('matches every shared exposure vector', () => {
    for (const v of vectors.exposure) {
      const w = weightedSeconds(v.samples as [number, number][]);
      expect(w, v.name).toBe(v.expected_weighted_s);
      expect(remainingPct(w), v.name).toBeCloseTo(v.expected_remaining_pct, 3);
    }
  });

  it('boundaries: 8.0 adds nothing, 12.0 counts x1, 12.01 counts x2, unknown counts x2', () => {
    expect(rate(8)).toBe(0);
    expect(rate(8.01)).toBe(1);
    expect(rate(12)).toBe(1);
    expect(rate(12.01)).toBe(2);
    expect(rate(null)).toBe(2);
  });

  it('a reading counts until the next one, capped at 5 periods; gaps > 15 s count the hotter neighbour', () => {
    expect(segment({ ts: 0, temp: 9 }, { ts: 5, temp: 4 })).toEqual({ start: 0, end: 5000, rate: 1 });
    expect(segment({ ts: 0, temp: 9 }, { ts: 15, temp: 13 }).rate).toBe(1); // 15 s is not a gap yet
    expect(segment({ ts: 0, temp: 9 }, { ts: 16, temp: 13 }).rate).toBe(2); // conservative over lost data
    expect(segment({ ts: 0, temp: 4 }, { ts: 600, temp: 4 })).toEqual({
      start: 0,
      end: MAX_STEP_MS,
      rate: 0,
    });
  });
});

describe('heat engine', () => {
  it('60 s at 9 C adds 60 weighted s; 60 s at 13 C adds 120', () => {
    const t = makeApp();
    const [a, b] = [fridgeWithDevice(t), fridgeWithDevice(t)];
    const warm = mk(t, a);
    const hot = mk(t, b);
    run(t, a, T0 / 1000, 60, 9, 1);
    run(t, b, T0 / 1000, 60, 13, 1);
    expect(exposureS(t, warm.id)).toBe(60);
    expect(exposureS(t, hot.id)).toBe(120);
    expect(getBatch(t.db, warm.id).used_minutes).toBe(1);
  });

  it('only counts while the batch is in the fridge; a moved batch carries its used budget', () => {
    const t = makeApp();
    const [a, b] = [fridgeWithDevice(t), fridgeWithDevice(t)];
    const batch = mk(t, a);
    const s0 = T0 / 1000;
    run(t, b, s0, 60, 13, 1000); // hot in B before the batch arrives: not counted
    const seq = run(t, a, s0, 60, 9, 1); // 60 s x1
    moveBatch(ctxOf(t), batch.id, b, undefined, T0 + 60_000);
    run(t, a, s0 + 65, 60, 13, seq); // A keeps being hot after the move: not counted
    run(t, b, s0 + 65, 30, 13, 2000); // B, after a device seq jump (hole): live accrual waits for the data
    expect(exposureS(t, batch.id)).toBe(60 + 60);
    ctxOf(t).heat.tick(T0 + 10 * 60_000); // the hole is given up on: counted with the contract's gap rule
    // B's reading at +60 s (13 C) stands for [60, 65): the batch arrived at 60, so 5 s x2 more
    expect(exposureS(t, batch.id)).toBe(60 + 10 + 60);
    expect(ctxOf(t).heat.computeExposure(batch.id).exposureMs).toBe(130_000);
  });

  it('live, late and out-of-order data give the same totals as a full recompute (property test)', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 25; round++) {
      const t = makeApp();
      const [a, b] = [fridgeWithDevice(t), fridgeWithDevice(t)];
      const batches = [mk(t, a), mk(t, a), mk(t, b)];
      // two fridges, random temperatures and spacing (incl. lost-data gaps), a move in the middle
      const series = [a, b].map((f) => {
        let ts = T0 / 1000;
        return Array.from({ length: 80 }, (_, i) => {
          ts += 1 + Math.floor(rnd() * (rnd() < 0.15 ? 60 : 8));
          return { f, seq: i + 1, ts, temp: rnd() < 0.05 ? null : Math.round(rnd() * 160) / 10 };
        });
      });
      const moveAt = (series[0][40].ts + 2) * 1000;
      moveBatch(ctxOf(t), batches[1].id, b, undefined, moveAt);
      // deliver: mostly in order, but 30 % of readings held back and synced later in shuffled chunks
      const late: (typeof series)[0] = [];
      for (const r of series.flat().sort((x, y) => x.ts - y.ts)) {
        if (rnd() < 0.3) late.push(r);
        else feed(t, r.f, r.seq, r.ts, r.temp);
      }
      late.sort(() => rnd() - 0.5);
      for (const r of late) {
        const before = batches.map((x) => exposureS(t, x.id));
        feed(t, r.f, r.seq, r.ts, r.temp, true);
        batches.forEach((x, i) => expect(exposureS(t, x.id)).toBeGreaterThanOrEqual(before[i])); // never decreases
      }
      for (const batch of batches)
        expect(exposureS(t, batch.id) * 1000, `round ${round}`).toBe(
          ctxOf(t).heat.computeExposure(batch.id).exposureMs,
        );
    }
  }, 30_000); // ~1.5 s alone; far longer when every suite runs at once

  it('At Risk and Discard fire once each, discard latches the fridge and is permanent', () => {
    const t = makeApp();
    const ctx = ctxOf(t);
    const rt = new RecordingRealtime();
    ctx.realtime = rt;
    const hook = vi.fn();
    ctx.hooks.batchStatusChanged = hook;
    const f = fridgeWithDevice(t);
    const batch = mk(t, f);
    let seq = run(t, f, T0 / 1000, 1500, 13, 1); // 3000 weighted s: 16.7 % left
    expect(getBatch(t.db, batch.id).status).toBe('AT_RISK');
    seq = run(t, f, T0 / 1000 + 1505, 400, 13, seq); // past the budget
    expect(getBatch(t.db, batch.id)).toMatchObject({ status: 'DISCARD', remaining_pct: 0 });
    run(t, f, T0 / 1000 + 1910, 100, 13, seq); // still hot: nothing fires again
    expect(hook.mock.calls.map((c) => c.slice(1))).toEqual([
      ['SAFE', 'AT_RISK'],
      ['AT_RISK', 'DISCARD'],
    ]);
    const audits = t.db
      .prepare("SELECT COUNT(*) FROM audit_log WHERE event_type = 'BATCH_STATUS_CHANGED'")
      .pluck()
      .get();
    expect(audits).toBe(2);
    expect(t.db.prepare('SELECT latch_state FROM fridges WHERE id = ?').pluck().get(f)).toBe(1);
    expect(rt.of('fridge:latch')).toEqual([{ fridge_id: f, latch: true, batch_id: batch.id }]);
    // exposure never decreases, and a discarded batch never becomes Safe
    ctx.heat.recomputeFridge(f, T0);
    t.db.prepare('UPDATE batches SET exposure_ms = 0 WHERE id = ?').run(batch.id);
    expect(getBatch(t.db, batch.id).status).toBe('DISCARD');
  });

  it('DEMO_TIME_SCALE 30 turns 2 real minutes at 9 C into the whole 60-minute budget, and says so', async () => {
    const t = makeApp({ DEMO_TIME_SCALE: '30' });
    const f = fridgeWithDevice(t);
    const batch = mk(t, f);
    run(t, f, T0 / 1000, 120, 9, 1);
    expect(getBatch(t.db, batch.id)).toMatchObject({ weighted_exposure_s: 3600, status: 'DISCARD' });
    const auth = bearer(tokenFor(t, await addUser(t, 'INSPECTOR')));
    const res = await t.http().get(`/api/batches/${batch.id}/exposure`).set(auth);
    expect(res.body).toMatchObject({ demoScale: 30, weighted_exposure_s: 3600, remaining_pct: 0 });
    expect(res.body.timeline.at(-1)).toEqual({ ts: T0 / 1000 + 120, weighted_s: 3600 });
    expect((await t.http().get('/api/batches').set(auth)).body.demoScale).toBe(30);
    expect((await t.http().get('/api/health')).body.demoScale).toBe(30);
  });

  it('exposure timeline is cumulative and capped at 500 points', async () => {
    const t = makeApp();
    const f = fridgeWithDevice(t);
    const batch = mk(t, f);
    run(t, f, T0 / 1000, 5000, 9, 1); // 1000 hot intervals
    const auth = bearer(tokenFor(t, await addUser(t, 'PHARMACIST')));
    const { timeline } = (await t.http().get(`/api/batches/${batch.id}/exposure`).set(auth)).body;
    expect(timeline.length).toBeLessThanOrEqual(501);
    expect(timeline.at(-1).weighted_s).toBe(5000);
    for (let i = 1; i < timeline.length; i++)
      expect(timeline[i].weighted_s).toBeGreaterThan(timeline[i - 1].weighted_s);
  });
});

// ---------------------------------------------------------------- device latch and the admin reset

/** fridge-01 with a signed device, one budget-discarded batch, and a scripted device answering commands. */
function latchedFridge(reply: (attempt: number) => { ack?: boolean; event?: boolean }) {
  const s = setup({ 'fridge-01': SECRET });
  const ctx = s.ctx;
  ctx.heat = new HeatEngine(ctx, { resetTimeoutMs: 150, resetAttempts: 3 });
  const batch = createBatch(ctx, batchInput('fridge-01') as BatchInput);
  s.t.db.prepare('UPDATE batches SET exposure_ms = 3600000 WHERE id = ?').run(batch.id);
  refreshStatus(ctx, batch.id); // -> DISCARD
  s.t.db.prepare("UPDATE fridges SET latch_state = 1 WHERE id = 'fridge-01'").run();
  let attempt = 0;
  let seq = 500;
  const commands: { type: string; cmd_id: string }[] = [];
  ctx.ingest.setPublisher((tp, payload) => {
    if (!tp.endsWith('/cmd')) return;
    const env = JSON.parse(payload);
    expect(env.sig).toBe(sign(SECRET, env.device_id, env.kind, env.ts, env.nonce, env.body)); // signed
    const body = JSON.parse(env.body);
    commands.push(body);
    const r = reply(++attempt);
    setImmediate(() => {
      // a real node answers over MQTT, later than the publish call
      if (r.event)
        ctx.ingest.handle(
          topic('event'),
          envelope('event', { seq: ++seq, ts: NOW / 1000, type: 'LATCH_RESET', data: {} }),
          NOW,
        );
      if (r.ack !== undefined)
        ctx.ingest.handle(
          topic('cmdack'),
          envelope('cmdack', { cmd_id: body.cmd_id, ok: r.ack, detail: 'x' }),
          NOW,
        );
    });
  });
  return { ...s, batch, commands };
}

async function reset(s: ReturnType<typeof latchedFridge>, role: 'ADMIN' | 'PHARMACIST' = 'ADMIN') {
  const auth = bearer(tokenFor(s.t, await addUser(s.t, role)));
  return s.t.http().post('/api/fridges/fridge-01/reset-latch').set(auth).send({ reason: 'vials destroyed' });
}

describe('admin latch reset', () => {
  it('acknowledges the discards, sends a signed RESET_LATCH, clears the latch on cmdack + LATCH_RESET', async () => {
    const s = latchedFridge(() => ({ ack: true, event: true }));
    const res = await reset(s);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      latch: false,
      changed: true,
      attempts: 1,
      acknowledged_batches: [s.batch.id],
    });
    expect(s.commands.map((c) => c.type)).toEqual(['RESET_LATCH']);
    expect(s.t.db.prepare("SELECT latch_state FROM fridges WHERE id = 'fridge-01'").pluck().get()).toBe(0);
    const b = getBatch(s.t.db, s.batch.id);
    expect(b.status).toBe('DISCARD'); // discard is forever: the reset only acknowledges it
    expect(b.acknowledged_by).not.toBeNull();
    const types = s.t.db.prepare('SELECT event_type FROM audit_log ORDER BY id').pluck().all();
    expect(types).toEqual(expect.arrayContaining(['DISCARD_ACK', 'LATCH_RESET']));
    expect((await s.t.http().get(`/api/public/batch/${s.batch.public_token}`)).body.status).toBe('DISCARD');
  });

  it('the fridge reads unlatched as soon as the reset returns, before the next telemetry', async () => {
    const s = latchedFridge(() => ({ ack: true, event: true }));
    // the device's last reading still says latched (its next one is up to 5 s away)
    s.ctx.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(1, { latch: 1 })), NOW);
    const auth = bearer(tokenFor(s.t, await addUser(s.t, 'ADMIN')));
    const before = await s.t.http().get('/api/fridges/fridge-01').set(auth);
    expect(before.body.fridge.latch).toBe(true);
    expect((await reset(s)).status).toBe(200);
    const after = await s.t.http().get('/api/fridges/fridge-01').set(auth);
    expect(after.body.fridge.latch).toBe(false); // no stale red banner on the client's refetch
    expect(after.body.fridge.live.latch).toBe(0);
  });

  it('retries with a fresh command when the device does not answer, then succeeds', async () => {
    const s = latchedFridge((n) => (n === 1 ? {} : { ack: true, event: true }));
    const res = await reset(s);
    expect(res.body).toMatchObject({ latch: false, attempts: 2 });
    expect(new Set(s.commands.map((c) => c.cmd_id)).size).toBe(2);
  });

  it('a cmdack without the LATCH_RESET event is not enough; after 3 attempts: 504 and the latch stays', async () => {
    const s = latchedFridge(() => ({ ack: true }));
    const res = await reset(s);
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('DEVICE_TIMEOUT');
    expect(s.commands).toHaveLength(3);
    expect(s.t.db.prepare("SELECT latch_state FROM fridges WHERE id = 'fridge-01'").pluck().get()).toBe(1);
  });

  it('only an Admin can reset', async () => {
    const s = latchedFridge(() => ({ ack: true, event: true }));
    expect((await reset(s, 'PHARMACIST')).status).toBe(403);
    expect(s.commands).toHaveLength(0);
  });

  it('a discarded fridge whose device still reports latch=0 after 10 s gets a signed SET_LATCH', () => {
    const s = latchedFridge(() => ({}));
    const sent: string[] = [];
    s.ctx.ingest.setPublisher(
      (tp, payload) => tp.endsWith('/cmd') && sent.push(JSON.parse(JSON.parse(payload).body).type),
    );
    s.t.db.prepare('UPDATE batches SET discarded_at = ? WHERE id = ?').run(Date.now() - 20_000, s.batch.id);
    s.ctx.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(1, { latch: 0 })), NOW);
    s.ctx.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(2, { latch: 0 })), NOW);
    expect(sent).toEqual(['SET_LATCH']); // once, not on every reading
    s.ctx.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(3, { latch: 1 })), NOW);
    expect(sent).toHaveLength(1);
  });
});
