import { describe, expect, it } from 'vitest';
import vectors from '../../contracts/test_vectors.json';
import { flushAuditFor } from './ingestHelpers';
import { bearer, addUser, tokenFor } from './helpers';
import { sign, type Envelope } from '../src/mqtt/envelope';
import { envelope, NOW, nowS, reading, SECRET, setup, telemetry, topic } from './deviceHelpers';
import { GAP_SYNC_AFTER_MS, OFFLINE_AFTER_MS, OFFLINE_ALERT_AFTER_MS } from '../src/mqtt/ingest';
import { classify } from '../src/shared/status';

describe('envelope signing', () => {
  it('matches every shared HMAC vector', () => {
    for (const v of vectors.hmac)
      expect(sign(v.secret, v.device_id, v.kind, v.ts, v.nonce, v.body)).toBe(v.sig);
  });

  it('accepts the shared telemetry vector end to end', () => {
    const v = vectors.hmac[0];
    const { ingest, t } = setup({ 'fridge-01': v.secret });
    const msg = JSON.stringify({
      v: 1,
      device_id: v.device_id,
      kind: v.kind,
      ts: v.ts,
      nonce: v.nonce,
      body: v.body,
      sig: v.sig,
    });
    expect(ingest.handle(topic('telemetry'), msg, v.ts * 1000)).toMatchObject({
      accepted: true,
      kind: 'telemetry',
      inserted: 1,
    });
    expect(t.db.prepare('SELECT seq, temp FROM readings').get()).toEqual({ seq: 1204, temp: 4.62 });
  });

  it('server classify() passes the shared status vectors', () => {
    for (const v of vectors.status)
      expect(classify(v.temp, v.door === 1, v.power === 'BATTERY', v.sensor_fault)).toBe(v.expected);
  });
});

describe('accepted telemetry', () => {
  it('is stored once, updates the live state with the server-side status, and is pushed', () => {
    const { ingest, t, rt } = setup();
    const msg = envelope('telemetry', telemetry(7, { temp: 7.8, state: 'SAFE' })); // device says SAFE, server says WARNING
    expect(ingest.handle(topic('telemetry'), msg, NOW)).toMatchObject({ accepted: true, inserted: 1 });
    expect(t.db.prepare('SELECT device_id, fridge_id, seq, temp, late FROM readings').all()).toEqual([
      { device_id: 'fridge-01', fridge_id: 'fridge-01', seq: 7, temp: 7.8, late: 0 },
    ]);
    const live = ingest.live.get('fridge-01')!;
    expect(live).toMatchObject({
      seq: 7,
      state: 'WARNING',
      device_state: 'SAFE',
      online: true,
      last_seen: NOW,
    });
    expect(rt.of('fridge:update')).toHaveLength(1);
    // the same reading again (new nonce): duplicate seq ignored
    expect(ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(7)), NOW)).toMatchObject({
      accepted: true,
      inserted: 0,
    });
    expect(t.db.prepare('SELECT COUNT(*) FROM readings').pluck().get()).toBe(1);
  });

  it('writes a telemetry checkpoint every 100 accepted readings', () => {
    const { ingest, t } = setup();
    for (let s = 1; s <= 100; s++)
      ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(s)), NOW);
    expect(
      t.db.prepare("SELECT COUNT(*) FROM audit_log WHERE event_type = 'TELEMETRY_CHECKPOINT'").pluck().get(),
    ).toBe(1);
  });
});

describe('rejections', () => {
  const cases: [string, (s: ReturnType<typeof setup>) => [string, string], string][] = [
    ['not JSON', () => [topic('telemetry'), '{nope'], 'BAD_JSON'],
    [
      'missing fields',
      () => [topic('telemetry'), JSON.stringify({ v: 1, device_id: 'fridge-01' })],
      'BAD_JSON',
    ],
    ['kind differs from the topic', () => [topic('event'), envelope('telemetry', telemetry(1))], 'BAD_JSON'],
    ['oversized', () => [topic('telemetry'), 'x'.repeat(20_000)], 'BAD_JSON'],
    [
      'unknown device',
      () => [topic('telemetry', 'fridge-99'), envelope('telemetry', telemetry(1), { device: 'fridge-99' })],
      'UNKNOWN_DEVICE',
    ],
    [
      'topic device differs from the envelope',
      () => [topic('telemetry', 'fridge-02'), envelope('telemetry', telemetry(1))],
      'UNKNOWN_DEVICE',
    ],
    [
      'stale but correctly signed',
      () => [topic('telemetry'), envelope('telemetry', telemetry(1), { ts: nowS - 600 })],
      'STALE_TS',
    ],
    [
      'from the future',
      () => [topic('telemetry'), envelope('telemetry', telemetry(1), { ts: nowS + 31 })],
      'STALE_TS',
    ],
    [
      'wrong key',
      () => [topic('telemetry'), envelope('telemetry', telemetry(1), { secret: 'c3'.repeat(32) })],
      'BAD_SIG',
    ],
    [
      'body changed after signing',
      () => {
        const e = JSON.parse(envelope('telemetry', telemetry(1))) as Envelope;
        e.body = e.body.replace('"temp":4.5', '"temp":4.0');
        return [topic('telemetry'), JSON.stringify(e)];
      },
      'BAD_SIG',
    ],
    [
      'valid signature, unknown body field',
      () => [topic('telemetry'), envelope('telemetry', telemetry(1, { evil: 1 }))],
      'BAD_BODY',
    ],
    [
      'valid signature, body not JSON',
      () => [topic('telemetry'), envelope('telemetry', 'not json')],
      'BAD_BODY',
    ],
  ];
  for (const [name, make, reason] of cases) {
    it(`${name} -> ${reason}, logged in security_events, the audit chain and realtime`, () => {
      const s = setup();
      const [tp, msg] = make(s);
      expect(s.ingest.handle(tp, msg, NOW)).toEqual({ accepted: false, reason });
      const ev = s.t.db.prepare('SELECT * FROM security_events').get() as Record<string, unknown>;
      expect(ev).toMatchObject({
        reason,
        topic: tp,
        size: Buffer.byteLength(msg),
        sample_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(JSON.stringify(ev)).not.toContain(SECRET);
      expect(s.rt.of('security:event')).toEqual([expect.objectContaining({ reason })]);
      expect(flushAuditFor(s.ctx)).toEqual([expect.objectContaining({ reason, count: 1 })]);
      expect(s.t.db.prepare('SELECT COUNT(*) FROM readings').pluck().get()).toBe(0);
      expect(s.ingest.metrics.rejected[reason as 'BAD_JSON']).toBe(1);
    });
  }

  it('records the clock skew of a stale message', () => {
    const s = setup();
    s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(1), { ts: nowS - 600 }), NOW);
    expect(JSON.parse(s.t.db.prepare('SELECT detail FROM security_events').pluck().get() as string)).toEqual({
      skew_s: 600,
    });
  });

  it('a replay of the exact same bytes is rejected; the first copy was accepted', () => {
    const s = setup();
    const msg = envelope('telemetry', telemetry(1));
    expect(s.ingest.handle(topic('telemetry'), msg, NOW).accepted).toBe(true);
    expect(s.ingest.handle(topic('telemetry'), msg, NOW + 5000)).toEqual({
      accepted: false,
      reason: 'REPLAY',
    });
    // still rejected when its ts would be fresh again later in the window: the nonce outlives the window
    expect(s.ingest.handle(topic('telemetry'), msg, NOW + 29_000)).toEqual({
      accepted: false,
      reason: 'REPLAY',
    });
  });

  it('unauthenticated senders cannot fill the nonce table', () => {
    const s = setup();
    for (let i = 0; i < 1000; i++)
      s.ingest.handle(
        topic('telemetry'),
        envelope('telemetry', telemetry(1), { secret: 'd4'.repeat(32) }),
        NOW,
      );
    expect(s.t.db.prepare('SELECT COUNT(*) FROM nonces').pluck().get()).toBe(0);
    expect(s.ingest.metrics.rejected.BAD_SIG).toBe(1000);
  });

  it('a disabled device is unknown', () => {
    const s = setup();
    s.t.db.prepare("UPDATE devices SET active = 0 WHERE device_id = 'fridge-01'").run();
    s.ingest.devices.invalidate();
    expect(s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(1)), NOW)).toEqual({
      accepted: false,
      reason: 'UNKNOWN_DEVICE',
    });
  });

  it('flood: 50 invalid msg/s from one device are coalesced in the audit chain and handled fast', () => {
    const s = setup();
    const times: number[] = [];
    for (let i = 0; i < 250; i++) {
      const msg =
        i % 10 === 0
          ? envelope('telemetry', telemetry(i + 1), {})
          : envelope('telemetry', telemetry(1), { secret: 'e5'.repeat(32) });
      const t0 = performance.now();
      s.ingest.handle(topic('telemetry'), msg, NOW + i * 20);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(20); // p95 per message
    expect(s.t.db.prepare('SELECT COUNT(*) FROM security_events').pluck().get()).toBe(225);
    expect(flushAuditFor(s.ctx)).toEqual([expect.objectContaining({ reason: 'BAD_SIG', count: 225 })]);
  });
});

describe('events', () => {
  it('are stored, audited when relevant, update the latch state and reach the alert hook', () => {
    const s = setup();
    const seen: string[] = [];
    s.ingest.hooks.onDeviceEvent = (_f, e) => seen.push(e.type);
    for (const [seq, type] of [
      [1, 'DOOR_OPEN'],
      [2, 'DOOR_ALARM'],
      [3, 'LATCH_SET'],
    ] as const) {
      expect(
        s.ingest.handle(topic('event'), envelope('event', { seq, ts: nowS, type, data: {} }), NOW),
      ).toMatchObject({ accepted: true, inserted: 1 });
    }
    expect(seen).toEqual(['DOOR_OPEN', 'DOOR_ALARM', 'LATCH_SET']);
    expect(s.t.db.prepare("SELECT latch_state FROM fridges WHERE id = 'fridge-01'").pluck().get()).toBe(1);
    const audited = s.t.db
      .prepare("SELECT payload FROM audit_log WHERE event_type = 'DEVICE_EVENT'")
      .pluck()
      .all() as string[];
    expect(audited.map((p) => JSON.parse(p).type)).toEqual(['DOOR_ALARM', 'LATCH_SET']);
    s.ingest.handle(
      topic('event'),
      envelope('event', { seq: 4, ts: nowS, type: 'LATCH_RESET', data: {} }),
      NOW,
    );
    expect(s.t.db.prepare("SELECT latch_state FROM fridges WHERE id = 'fridge-01'").pluck().get()).toBe(0);
  });
});

describe('sync', () => {
  const chunk = (seqs: number[]) => ({
    from_seq: seqs[0],
    to_seq: seqs.at(-1)!,
    readings: seqs.map((q) => reading(q)),
  });
  const acks = (published: { topic: string; payload: string }[]) =>
    published
      .filter((p) => p.topic === topic('ack'))
      .map((p) => {
        const e = JSON.parse(p.payload) as Envelope;
        expect(e.sig).toBe(sign(SECRET, e.device_id, 'ack', e.ts, e.nonce, e.body)); // signed by the server
        expect(e.nonce).toMatch(/^[0-9a-f]{16}$/);
        return JSON.parse(e.body).seq_upto as number;
      });

  it('360 readings in 15 chunks, one duplicated, shuffled: exactly 360 rows in order, final ack = 360', () => {
    const s = setup();
    const chunks = Array.from({ length: 15 }, (_, i) =>
      chunk(Array.from({ length: 24 }, (_, j) => i * 24 + j + 1)),
    );
    const order = [7, 0, 3, 3, 14, 1, 2, 9, 4, 5, 6, 8, 10, 11, 12, 13]; // chunk 3 twice
    for (const i of order) {
      const r = s.ingest.handle(topic('sync'), envelope('sync', chunks[i]), NOW);
      expect(r).toMatchObject({ accepted: true, kind: 'sync' });
      if (r.accepted) expect(r.seqUpto).toBeGreaterThanOrEqual(chunks[i].to_seq); // never below its own chunk
    }
    const seqs = s.t.db
      .prepare("SELECT seq FROM readings WHERE device_id = 'fridge-01' ORDER BY seq")
      .pluck()
      .all();
    expect(seqs).toEqual(Array.from({ length: 360 }, (_, i) => i + 1));
    expect(s.t.db.prepare('SELECT COUNT(*) FROM readings WHERE late = 1').pluck().get()).toBe(360);
    const a = acks(s.published);
    expect(a).toHaveLength(order.length);
    expect(a.at(-1)).toBe(360);
    expect([...a].sort((x, y) => x - y)).toEqual(a); // acks never go backwards
  });

  it('a resent chunk (lost ack) is stored once and re-acked idempotently', () => {
    const s = setup();
    const c = chunk([1, 2, 3, 4, 5]);
    s.ingest.handle(topic('sync'), envelope('sync', c), NOW);
    s.ingest.handle(topic('sync'), envelope('sync', c), NOW + 5000); // retry: fresh nonce, same items
    expect(s.t.db.prepare('SELECT COUNT(*) FROM readings').pluck().get()).toBe(5);
    expect(acks(s.published)).toEqual([5, 5]);
  });

  it('a lost live message or a reboot seq jump does not stall the sync', () => {
    const s = setup();
    for (const q of [21, 22, 23, 25])
      s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(q)), NOW); // 24 lost
    // buffered while offline; seqs 31..33 were sent live (and stored) in between the buffered ones
    for (const q of [31, 32, 33])
      s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(q)), NOW);
    s.ingest.handle(topic('sync'), envelope('sync', chunk([26, 27, 28, 29, 30, 34])), NOW);
    expect(acks(s.published)).toEqual([34]); // 24 (below from_seq) never blocks; 31..33 stored live
  });

  it('extends the ack only through seqs actually stored', () => {
    const s = setup();
    s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(6)), NOW);
    s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(8)), NOW);
    s.ingest.handle(topic('sync'), envelope('sync', chunk([1, 2, 3, 4, 5])), NOW);
    expect(acks(s.published)).toEqual([6]); // 6 stored, 7 missing: stops there
  });

  it('accepts old reading timestamps (only the envelope ts is checked) and buffered events', () => {
    const s = setup();
    const c = {
      from_seq: 1,
      to_seq: 3,
      readings: [
        reading(1, { ts: nowS - 86_400 }),
        { seq: 2, ts: nowS - 86_000, type: 'DOOR_ALARM', data: {} },
        reading(3),
      ],
    };
    expect(s.ingest.handle(topic('sync'), envelope('sync', c), NOW)).toMatchObject({
      accepted: true,
      inserted: 3,
      seqUpto: 3,
    });
    expect(s.t.db.prepare('SELECT type, late FROM events').get()).toEqual({ type: 'DOOR_ALARM', late: 1 });
  });

  it('rejects oversized or inconsistent chunks as BAD_BODY', () => {
    const s = setup();
    const big = chunk(Array.from({ length: 26 }, (_, i) => i + 1));
    expect(s.ingest.handle(topic('sync'), envelope('sync', big), NOW)).toEqual({
      accepted: false,
      reason: 'BAD_BODY',
    });
    expect(s.ingest.handle(topic('sync'), envelope('sync', { ...chunk([1, 2]), to_seq: 9 }), NOW)).toEqual({
      accepted: false,
      reason: 'BAD_BODY',
    });
  });

  it('recomputes exposure: late readings reach the heat-engine hook flagged late', () => {
    const s = setup();
    const calls: { n: number; late: boolean }[] = [];
    s.ingest.hooks.onReadingsInserted = (_f, rows, o) => calls.push({ n: rows.length, late: o.late });
    s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(10)), NOW);
    s.ingest.handle(topic('sync'), envelope('sync', chunk([1, 2, 3])), NOW);
    expect(calls).toEqual([
      { n: 1, late: false },
      { n: 3, late: true },
    ]);
  });
});

describe('gaps, offline watchdog, status hints', () => {
  const cmds = (published: { topic: string; payload: string }[]) =>
    published
      .filter((p) => p.topic === topic('cmd'))
      .map((p) => {
        const e = JSON.parse(p.payload) as Envelope;
        expect(e.sig).toBe(sign(SECRET, e.device_id, 'cmd', e.ts, e.nonce, e.body));
        return JSON.parse(e.body).type as string;
      });

  it('a seq gap with no sync for 30 s triggers a signed SYNC_REQUEST', () => {
    const s = setup();
    s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(10)), NOW);
    s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(15)), NOW);
    s.ingest.tick(NOW + GAP_SYNC_AFTER_MS - 1);
    expect(cmds(s.published)).toEqual([]);
    s.ingest.tick(NOW + GAP_SYNC_AFTER_MS);
    expect(cmds(s.published)).toEqual(['SYNC_REQUEST']);
    s.ingest.tick(NOW + 2 * GAP_SYNC_AFTER_MS);
    expect(cmds(s.published)).toHaveLength(1); // once per gap
  });

  it('a sync clears the gap; WIFI_BACK with an open gap asks at once', () => {
    const s = setup();
    s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(10)), NOW);
    s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(15)), NOW);
    s.ingest.handle(
      topic('sync'),
      envelope('sync', { from_seq: 11, to_seq: 14, readings: [11, 12, 13, 14].map((q) => reading(q)) }),
      NOW,
    );
    s.ingest.tick(NOW + GAP_SYNC_AFTER_MS);
    expect(cmds(s.published)).toEqual([]);
    s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(30)), NOW);
    s.ingest.handle(
      topic('event'),
      envelope('event', { seq: 31, ts: nowS, type: 'WIFI_BACK', data: {} }),
      NOW,
    );
    expect(cmds(s.published)).toEqual(['SYNC_REQUEST']);
  });

  it('marks a silent fridge OFFLINE after 20 s, alerts after 60 s, recovers on the next message', () => {
    const s = setup();
    const offline: number[] = [];
    s.ingest.hooks.onDeviceOffline = (_f, _d, ms) => offline.push(ms);
    s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(1)), NOW);
    s.ingest.tick(NOW + OFFLINE_AFTER_MS);
    expect(s.ingest.live.get('fridge-01')!.online).toBe(true);
    s.ingest.tick(NOW + OFFLINE_AFTER_MS + 1);
    expect(s.ingest.live.get('fridge-01')!.online).toBe(false);
    expect(s.rt.of('fridge:update').at(-1)).toMatchObject({ online: false });
    s.ingest.tick(NOW + OFFLINE_ALERT_AFTER_MS + 1);
    s.ingest.tick(NOW + OFFLINE_ALERT_AFTER_MS + 5000);
    expect(offline).toEqual([OFFLINE_ALERT_AFTER_MS + 1]);
    s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(2), { ts: nowS + 70 }), NOW + 70_000);
    expect(s.ingest.live.get('fridge-01')!.online).toBe(true);
  });

  it('the unsigned LWT status is only a hint: stored nowhere, trusted for nothing', () => {
    const s = setup();
    expect(s.ingest.handle(topic('status'), 'offline', NOW)).toEqual({ accepted: true, kind: 'status' });
    expect(s.rt.of('device:status')).toEqual([{ device_id: 'fridge-01', status: 'offline', hint: true }]);
    expect(s.t.db.prepare('SELECT COUNT(*) FROM security_events').pluck().get()).toBe(0);
    expect(s.ingest.live.size).toBe(0);
  });

  it('purges expired nonces', () => {
    const s = setup();
    s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(1)), NOW);
    expect(s.ingest.purgeNonces(NOW + 119_000)).toBe(0);
    expect(s.ingest.purgeNonces(NOW + 121_000)).toBe(1);
  });

  it('forwards command acks', () => {
    const s = setup();
    const got: unknown[] = [];
    s.ingest.hooks.onCommandAck = (d, a) => got.push([d, a]);
    s.ingest.handle(
      topic('cmdack'),
      envelope('cmdack', { cmd_id: 'c1', ok: true, detail: 'latch cleared' }),
      NOW,
    );
    expect(got).toEqual([['fridge-01', { cmd_id: 'c1', ok: true, detail: 'latch cleared' }]]);
  });
});

describe('API', () => {
  it('metrics (Admin/Inspector) and security events (all roles) reflect the traffic', async () => {
    const s = setup();
    s.ingest.handle(
      topic('telemetry'),
      envelope('telemetry', telemetry(1), { ts: Math.floor(Date.now() / 1000) }),
      Date.now(),
    );
    s.ingest.handle(topic('telemetry'), '{bad', Date.now());
    const inspector = bearer(tokenFor(s.t, await addUser(s.t, 'INSPECTOR')));
    const m = await s.t.http().get('/api/metrics/ingest').set(inspector);
    expect(m.status).toBe(200);
    expect(m.body.accepted.telemetry).toBe(1);
    expect(m.body.rejected.BAD_JSON).toBe(1);
    expect(m.body.devices).toEqual([
      expect.objectContaining({ device_id: 'fridge-01', max_seq: 1, online: true }),
    ]);
    const sec = await s.t.http().get('/api/security/events?reason=BAD_JSON').set(inspector);
    expect(sec.body).toMatchObject({ total: 1, events: [{ reason: 'BAD_JSON', device_id: 'fridge-01' }] });
    expect(JSON.stringify(sec.body)).not.toContain('{bad');
  });
});
