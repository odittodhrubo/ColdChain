import { describe, expect, it, vi } from 'vitest';
import { AlertEngine } from '../src/modules/alerts/service';
import { Notifier } from '../src/modules/alerts/notifier';
import { buildReport } from '../src/modules/fridges/report';
import { DailySummary } from '../src/modules/fridges/summary';
import { createBatch, type BatchInput } from '../src/modules/batches/service';
import { setup } from './deviceHelpers';
import { batchInput, bearer, tokenFor, addUser } from './helpers';

const H0 = 1_767_225_600; // 2026-01-01T00:00:00Z, a clean hour boundary (unix s)

/** Insert controlled readings/events straight into the DB (no device round trip). */
function seedReadings(db: ReturnType<typeof setup>['t']['db']) {
  const ins = db.prepare(
    `INSERT INTO readings (device_id, fridge_id, seq, ts, temp, door, comp, power, batt, state, exp_s, latch, mode, reason, received_at)
     VALUES (?, 'fridge-01', ?, ?, ?, ?, ?, ?, 100, 'SAFE', 0, 0, 'model', 'periodic', ?)`,
  );
  let seq = 0;
  const r = (ts: number, temp: number | null, o: { door?: number; comp?: number; power?: string } = {}) =>
    ins.run('fridge-01', ++seq, ts, temp, o.door ?? 0, o.comp ?? 1, o.power ?? 'MAINS', ts * 1000);
  // hour 0: 4, 6  (min 4, max 6)
  r(H0, 4);
  r(H0 + 5, 6);
  // hour 1: two consecutive above-8 readings (an excursion), then back in range
  r(H0 + 3600, 9);
  r(H0 + 3605, 10);
  r(H0 + 3610, 7);
  const ev = db.prepare(
    `INSERT INTO events (device_id, fridge_id, seq, ts, type, data, received_at) VALUES ('fridge-01', 'fridge-01', ?, ?, ?, '{}', ?)`,
  );
  ev.run(100, H0 + 20, 'DOOR_OPEN', H0 * 1000);
  ev.run(101, H0 + 30, 'POWER_FAIL', H0 * 1000);
}

describe('temperature report (P2)', () => {
  it('daily min/max/avg, excursions, event counts and audit head match the data', () => {
    const s = setup();
    seedReadings(s.t.db);
    // a batch in fridge-01 spanning the excursion, so it shows as affected
    const b = createBatch(s.ctx, batchInput('fridge-01') as BatchInput);
    s.t.db.prepare('UPDATE batch_assignments SET from_ts = 0 WHERE batch_id = ?').run(b.id);

    const rep = buildReport(s.ctx, 'fridge-01', H0, H0 + 2 * 3600);
    expect(rep.days).toEqual([{ date: '2026-01-01', n: 5, min: 4, max: 10, avg: 7.2, above8: 2 }]);
    expect(rep.excursions).toHaveLength(1);
    expect(rep.excursions[0]).toMatchObject({ start: H0 + 3600, end: H0 + 3605, peak: 10, fault: false });
    expect(rep.excursions[0].batches).toEqual([b.name]);
    expect(rep.door_opens).toBe(1);
    expect(rep.power_failures).toBe(1);
    expect(rep.audit_head.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an Inspector downloads CSV and HTML; the export is audited', async () => {
    const s = setup();
    seedReadings(s.t.db);
    const insp = bearer(tokenFor(s.t, await addUser(s.t, 'INSPECTOR')));
    const csv = await s.t.http().get(`/api/fridges/fridge-01/report?from=${H0}&to=${H0 + 7200}`).set(insp);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('.csv');
    expect(csv.text.split('\n')[0]).toBe(
      'hour,readings,with_temp,t_min_c,t_max_c,t_avg_c,above_8c,door_open,comp_on,on_battery',
    );
    expect(csv.text).toContain('2026-01-01T01:00:00.000Z,3,3,7,10,'); // hour 1: 3 readings, min 7 max 10

    const html = await s.t.http().get(`/api/fridges/fridge-01/report?from=${H0}&to=${H0 + 7200}&format=html`).set(insp);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.text).toContain('Temperature record');
    expect(html.text).toContain('Excursions above 8');

    const exported = s.t.db.prepare("SELECT COUNT(*) FROM audit_log WHERE event_type = 'REPORT_EXPORTED'").pluck().get();
    expect(exported).toBe(2);
  });

  it('rejects an inverted range', async () => {
    const s = setup();
    const insp = bearer(tokenFor(s.t, await addUser(s.t, 'INSPECTOR')));
    expect((await s.t.http().get('/api/fridges/fridge-01/report?from=100&to=50').set(insp)).status).toBe(400);
  });
});

describe('daily summary (P2)', () => {
  it('fires once at a configured local hour and reports each fridge min/max', async () => {
    const s = setup();
    seedReadings(s.t.db);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const config = { ...s.t.config, TELEGRAM_BOT_TOKEN: '1:T', TELEGRAM_CHAT_ID: '9' };
    const notifier = new Notifier(config, { fetch: fetchImpl as typeof fetch, mailer: null });
    s.ctx.alerts = new AlertEngine(s.ctx, notifier);
    const summary = new DailySummary(s.ctx, notifier);

    // Pick a local instant whose hour we configure, so the test is timezone-independent.
    const at = new Date(H0 * 1000 + 9 * 3600_000); // some wall-clock time
    s.ctx.config.DAILY_SUMMARY_HOURS = [at.getHours()];

    summary.tick(at.getTime());
    summary.tick(at.getTime() + 60_000); // same hour: no second send
    await summary.idle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const text = JSON.parse(init.body as string).text as string;
    expect(text).toContain('Twice-daily temperature summary');
    expect(text).toContain('fridge-01');
  });
});
