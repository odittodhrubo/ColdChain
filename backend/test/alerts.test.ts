import { describe, expect, it, vi } from 'vitest';
import { type BatchInput, createBatch, refreshStatus } from '../src/modules/batches/service';
import { AlertEngine, RENOTIFY_MS } from '../src/modules/alerts/service';
import { Notifier, telegramText } from '../src/modules/alerts/notifier';
import { CommandTracker } from '../src/mqtt/commands';
import { guarded } from '../src/jobs';
import { OFFLINE_ALERT_AFTER_MS } from '../src/mqtt/ingest';
import { envelope, NOW, nowS, reading, setup, telemetry, topic } from './deviceHelpers';
import { addUser, batchInput, bearer, tokenFor } from './helpers';

const flush = () => new Promise((r) => setTimeout(r, 0));
const TOKEN = '123456:SECRET-BOT-TOKEN';

/** fridge-01/02 with devices; alerts go to a mocked Telegram (no SMTP). */
function withTelegram(fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))) {
  const s = setup();
  const config = { ...s.t.config, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' };
  const notifier = new Notifier(config, {
    fetch: fetchImpl as typeof fetch,
    mailer: null,
    retryDelaysMs: [0, 0],
  });
  s.ctx.alerts = new AlertEngine(s.ctx, notifier);
  let seq = 100;
  const event = (type: string, o: { late?: boolean; ts?: number } = {}) =>
    s.ingest.handle(topic('event'), envelope('event', { seq: ++seq, ts: o.ts ?? nowS, type, data: {} }), NOW);
  const tele = (o: Record<string, unknown> = {}) =>
    s.ingest.handle(topic('telemetry'), envelope('telemetry', telemetry(++seq, o)), NOW);
  const alerts = () => s.t.db.prepare('SELECT * FROM alerts ORDER BY id').all() as Record<string, never>[];
  return { ...s, fetchImpl, event, tele, alerts };
}

const sentTexts = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).text as string);

describe('door alarm', () => {
  it('a DOOR_ALARM event raises an in-app alert and a Telegram message at once', async () => {
    const s = withTelegram();
    s.tele({ temp: 6.4 });
    s.event('DOOR_ALARM');
    const started = Date.now();
    await flush();
    expect(s.rt.of('alert:new')).toEqual([
      expect.objectContaining({ type: 'DOOR_OPEN_LONG', severity: 'WARNING' }),
    ]);
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(5000);
    const [url, init] = s.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ chat_id: '42', parse_mode: 'Markdown' });
    expect(body.text).toContain('Door open for more than 60 s');
    expect(body.text).toContain('Fridge: fridge-01 (fridge-01)');
    expect(body.text).toContain('Temperature: 6.4 °C');
    expect(body.text).toContain('[Open dashboard](http://localhost:5173/fridges/fridge-01)');
    expect(body.text).not.toContain(TOKEN); // secrets never go into notification text
    const delivery = JSON.parse(s.alerts()[0].delivery_status);
    expect(delivery).toMatchObject({
      in_app: { status: 'sent' },
      telegram: { status: 'sent', attempts: 1 },
      email: { status: 'skipped' },
    });
  });

  it('no duplicates while open, resolved on close; a new episode is a new alert even after an ack', async () => {
    const s = withTelegram();
    s.event('DOOR_ALARM');
    s.event('DOOR_ALARM');
    expect(s.alerts()).toHaveLength(1);
    const admin = bearer(tokenFor(s.t, await addUser(s.t, 'PHARMACIST')));
    expect((await s.t.http().post(`/api/alerts/${s.alerts()[0].id}/ack`).set(admin)).status).toBe(200);
    s.event('DOOR_CLOSE');
    expect(s.alerts()[0].resolved_at).not.toBeNull();
    s.event('DOOR_ALARM');
    expect(s.alerts()).toHaveLength(2);
    expect(s.alerts()[1].resolved_at).toBeNull();
    const types = s.t.db.prepare('SELECT event_type FROM audit_log ORDER BY id').pluck().all();
    expect(types.filter((t) => String(t).startsWith('ALERT_'))).toEqual([
      'ALERT_RAISED',
      'ALERT_ACKED',
      'ALERT_RESOLVED',
      'ALERT_RAISED',
    ]);
  });

  it('escalates to CRITICAL after 5 minutes open', () => {
    const s = withTelegram();
    s.event('DOOR_ALARM');
    const created = s.alerts()[0].created_at as number;
    s.ctx.alerts.tick(created + 4 * 60_000);
    expect(s.alerts()[0].severity).toBe('WARNING');
    s.ctx.alerts.tick(created + 5 * 60_000);
    expect(s.alerts()[0].severity).toBe('CRITICAL');
    expect(s.alerts()).toHaveLength(1);
  });

  it('a door alarm that arrives late through sync is still sent, labelled delayed', async () => {
    const s = withTelegram();
    const at = nowS - 600;
    s.ingest.handle(
      topic('sync'),
      envelope('sync', {
        from_seq: 10,
        to_seq: 12,
        readings: [
          reading(10, { ts: at - 70, door: 1 }),
          { seq: 11, ts: at, type: 'DOOR_ALARM', data: {} },
          reading(12, { ts: at + 5, door: 1 }),
        ],
      }),
      NOW,
    );
    await flush();
    const [text] = sentTexts(s.fetchImpl);
    expect(text).toContain(`Delayed (offline) – occurred at ${new Date(at * 1000).toISOString()}`);
  });
});

describe('dedupe, re-notification and acknowledgement', () => {
  it('re-notifies every 10 min (CRITICAL every 5) until acknowledged', async () => {
    const s = withTelegram();
    const t0 = 2_000_000_000_000;
    const warn = s.ctx.alerts.raise(
      { type: 'FRIDGE_OFFLINE', severity: 'WARNING', fridgeId: 'fridge-01', title: 'Offline', lines: [] },
      t0,
    );
    s.ctx.alerts.raise(
      { type: 'FRIDGE_OFFLINE', severity: 'WARNING', fridgeId: 'fridge-01', title: 'Offline', lines: [] },
      t0 + 1000,
    );
    s.ctx.alerts.raise(
      { type: 'BATTERY_LOW', severity: 'CRITICAL', fridgeId: 'fridge-02', title: 'Battery', lines: [] },
      t0,
    );
    await flush();
    expect(s.fetchImpl).toHaveBeenCalledTimes(2); // the repeat raise did not notify again
    s.ctx.alerts.tick(t0 + RENOTIFY_MS.CRITICAL - 1);
    await flush();
    expect(s.fetchImpl).toHaveBeenCalledTimes(2);
    s.ctx.alerts.tick(t0 + RENOTIFY_MS.CRITICAL);
    await flush();
    expect(sentTexts(s.fetchImpl)[2]).toContain('Battery (reminder 1)');
    s.ctx.alerts.tick(t0 + RENOTIFY_MS.WARNING);
    await flush();
    expect(sentTexts(s.fetchImpl).slice(3)).toEqual([
      expect.stringContaining('Offline (reminder 1)'),
      expect.stringContaining('Battery (reminder 2)'),
    ]);
    s.ctx.alerts.ack(warn.id, (await addUser(s.t, 'PHARMACIST')).id, t0 + RENOTIFY_MS.WARNING);
    s.ctx.alerts.tick(t0 + 3 * RENOTIFY_MS.WARNING);
    await flush();
    expect(sentTexts(s.fetchImpl).filter((x) => x.includes('Offline'))).toHaveLength(2); // acked: no more
  });

  it('ack is role-restricted, audited and once only', async () => {
    const s = withTelegram();
    const a = s.ctx.alerts.raise({
      type: 'FRIDGE_OFFLINE',
      severity: 'WARNING',
      fridgeId: 'fridge-01',
      title: 'x',
      lines: [],
    });
    const inspector = bearer(tokenFor(s.t, await addUser(s.t, 'INSPECTOR')));
    expect((await s.t.http().post(`/api/alerts/${a.id}/ack`).set(inspector)).status).toBe(403);
    const admin = bearer(tokenFor(s.t, await addUser(s.t, 'ADMIN')));
    const ok = await s.t.http().post(`/api/alerts/${a.id}/ack`).set(admin);
    expect(ok.body.alert).toMatchObject({ status: 'ACKNOWLEDGED' });
    expect((await s.t.http().post(`/api/alerts/${a.id}/ack`).set(admin)).status).toBe(409);
    const list = await s.t.http().get('/api/alerts?status=acknowledged').set(inspector);
    expect(list.body.alerts.map((x: { id: number }) => x.id)).toEqual([a.id]);
  });
});

describe('escalation (P3)', () => {
  it('an unacknowledged alert escalates once after ESCALATE_AFTER_S; an ack stops it', async () => {
    const s = withTelegram();
    s.ctx.config.ESCALATE_AFTER_S = 600; // 10 min
    const t0 = 2_000_000_000_000;
    s.ctx.alerts.raise(
      { type: 'FRIDGE_BREACH', severity: 'CRITICAL', fridgeId: 'fridge-01', title: 'Temperature outside 2–8 °C', lines: [] },
      t0,
    );
    await flush();
    s.ctx.alerts.tick(t0 + 599_000); // renotify may fire, but not escalation yet
    await flush();
    expect(s.alerts()[0].escalated_at).toBeNull();
    s.ctx.alerts.tick(t0 + 600_000); // escalates
    await flush();
    expect(sentTexts(s.fetchImpl).at(-1)).toContain('ESCALATED (unacknowledged 10 min): Temperature outside');
    expect(s.alerts()[0].escalated_at).not.toBeNull();
    expect(
      s.t.db.prepare("SELECT COUNT(*) FROM audit_log WHERE event_type = 'ALERT_ESCALATED'").pluck().get(),
    ).toBe(1);
    s.ctx.alerts.tick(t0 + 2 * 3600_000); // never escalates twice
    await flush();
    expect(
      s.t.db.prepare("SELECT COUNT(*) FROM audit_log WHERE event_type = 'ALERT_ESCALATED'").pluck().get(),
    ).toBe(1);

    const acked = s.ctx.alerts.raise(
      { type: 'FRIDGE_OFFLINE', severity: 'WARNING', fridgeId: 'fridge-02', title: 'Offline', lines: [] },
      t0,
    );
    s.ctx.alerts.ack(acked.id, (await addUser(s.t, 'ADMIN')).id, t0 + 60_000);
    s.ctx.alerts.tick(t0 + 3600_000);
    expect(
      s.t.db.prepare('SELECT escalated_at FROM alerts WHERE id = ?').pluck().get(acked.id),
    ).toBeNull();
  });
});

describe('alert sources', () => {
  it('breach after 2 consecutive out-of-range readings, resolved back in range, audited', () => {
    const s = withTelegram();
    s.tele({ temp: 8.6 });
    expect(s.alerts()).toHaveLength(0);
    s.tele({ temp: 9.1 });
    s.tele({ temp: 9.4 });
    expect(s.alerts()).toEqual([expect.objectContaining({ type: 'FRIDGE_BREACH', severity: 'CRITICAL' })]);
    s.tele({ temp: 6 });
    expect(s.alerts()[0].resolved_at).not.toBeNull();
    const audit = s.t.db
      .prepare("SELECT event_type FROM audit_log WHERE event_type LIKE 'BREACH_%'")
      .pluck()
      .all();
    expect(audit).toEqual(['BREACH_START', 'BREACH_END']);
  });

  it('power failure, battery low, power restore; offline and back online', () => {
    const s = withTelegram();
    s.tele();
    s.event('POWER_FAIL');
    s.event('BATT_LOW');
    expect(s.alerts().map((a) => a.type)).toEqual(['POWER_FAILURE', 'BATTERY_LOW']);
    s.event('POWER_RESTORE');
    expect(s.alerts().every((a) => a.resolved_at !== null)).toBe(true);
    s.ingest.tick(Date.now() + OFFLINE_ALERT_AFTER_MS + 1000);
    expect(s.alerts().at(-1)).toMatchObject({ type: 'FRIDGE_OFFLINE', resolved_at: null });
    s.tele();
    expect(s.alerts().at(-1)!.resolved_at).not.toBeNull();
  });

  it('At Risk and Discard batches alert; the discard supersedes the at-risk alert', () => {
    const s = withTelegram();
    const b = createBatch(s.ctx, batchInput('fridge-01') as BatchInput);
    s.t.db.prepare('UPDATE batches SET exposure_ms = 3000000 WHERE id = ?').run(b.id);
    refreshStatus(s.ctx, b.id);
    s.t.db.prepare('UPDATE batches SET exposure_ms = 3600000 WHERE id = ?').run(b.id);
    refreshStatus(s.ctx, b.id);
    const rows = s.alerts();
    expect(rows.map((a) => [a.type, a.batch_id, a.resolved_at === null])).toEqual([
      ['BATCH_AT_RISK', b.id, false],
      ['BATCH_DISCARD', b.id, true],
    ]);
  });

  it('more than 20 rejects per minute from one source: one SECURITY_FLOOD alert, resolved when quiet', () => {
    const s = withTelegram();
    for (let i = 0; i < 50; i++)
      s.ingest.handle(
        topic('telemetry'),
        envelope('telemetry', telemetry(i), { secret: 'ff'.repeat(32) }),
        NOW,
      );
    const floods = s.alerts().filter((a) => a.type === 'SECURITY_FLOOD');
    expect(floods).toHaveLength(1);
    s.ctx.alerts.tick(Date.now() + 61_000);
    expect(s.alerts().find((a) => a.type === 'SECURITY_FLOOD')!.resolved_at).not.toBeNull();
  });
});

describe('notification channels', () => {
  it('retries a failing channel with backoff and records the outcome', async () => {
    let calls = 0;
    const flaky = vi.fn(async () =>
      ++calls < 3 ? new Response('down', { status: 502 }) : new Response('{}'),
    );
    const s = withTelegram(flaky);
    s.event('POWER_FAIL');
    await vi.waitFor(() =>
      expect(JSON.parse(s.alerts()[0].delivery_status).telegram).toMatchObject({
        status: 'sent',
        attempts: 3,
      }),
    );
    const dead = withTelegram(
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    dead.event('POWER_FAIL');
    await vi.waitFor(() =>
      expect(JSON.parse(dead.alerts()[0].delivery_status).telegram).toMatchObject({
        status: 'failed',
        attempts: 3,
        error: 'ECONNRESET',
      }),
    );
  });

  it('a hanging Telegram never blocks ingestion', async () => {
    const s = withTelegram(vi.fn(() => new Promise<Response>(() => undefined)));
    const t0 = performance.now();
    for (let i = 0; i < 20; i++)
      expect(s.event(i % 2 ? 'DOOR_CLOSE' : 'DOOR_ALARM')).toMatchObject({ accepted: true });
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('runs without any external account: channels skipped, alert in-app and in the log', async () => {
    const s = setup();
    s.ingest.handle(
      topic('event'),
      envelope('event', { seq: 1, ts: nowS, type: 'DOOR_ALARM', data: {} }),
      NOW,
    );
    expect(s.rt.of('alert:new')).toHaveLength(1);
    await flush();
    const row = s.t.db.prepare('SELECT delivery_status FROM alerts').pluck().get() as string;
    expect(JSON.parse(row)).toMatchObject({ telegram: { status: 'skipped' }, email: { status: 'skipped' } });
  });

  it('email goes through the SMTP transport with severity in the subject', async () => {
    const s = setup();
    const sendMail = vi.fn(async () => ({}));
    const config = { ...s.t.config, ALERT_EMAIL_TO: 'ops@example.org', SMTP_USER: 'bot@example.org' };
    s.ctx.alerts = new AlertEngine(
      s.ctx,
      new Notifier(config, { mailer: { sendMail }, retryDelaysMs: [0, 0] }),
    );
    s.ctx.alerts.raise({
      type: 'BATTERY_LOW',
      severity: 'CRITICAL',
      fridgeId: 'fridge-01',
      title: 'Node battery low',
      lines: ['Battery: 18 %'],
    });
    await flush();
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ops@example.org', subject: '[ColdChain CRITICAL] Node battery low' }),
    );
  });

  it('Telegram Markdown escapes user data', () => {
    expect(telegramText({ title: 'Batch *x*', lines: ['lot A_1'], severity: 'WARNING' })).toBe(
      '🟠 *Batch \\*x\\**\nlot A\\_1',
    );
  });
});

describe('command publisher', () => {
  it('signed BUZZER_TEST retried with the same cmd_id and fresh envelopes until it times out', async () => {
    const s = setup();
    s.ctx.commands = new CommandTracker(s.t.db, s.ingest.sender, s.rt, { retryMs: 20, attempts: 3 });
    const id = s.ctx.commands.send('fridge-01', 'BUZZER_TEST')!;
    await vi.waitFor(() => expect(s.ctx.commands.get(id)?.status).toBe('TIMEOUT'), { timeout: 2000 });
    const sent = s.published.filter((p) => p.topic.endsWith('/cmd')).map((p) => JSON.parse(p.payload));
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((e) => JSON.parse(e.body).cmd_id))).toEqual(new Set([id]));
    expect(new Set(sent.map((e) => e.nonce)).size).toBe(3);
    expect(s.ctx.commands.get(id)).toMatchObject({ attempts: 3, type: 'BUZZER_TEST' });
  });

  it('the device cmdack closes the command (ACKED or FAILED) and stops retries', async () => {
    const s = setup();
    s.ctx.commands = new CommandTracker(s.t.db, s.ingest.sender, s.rt, { retryMs: 30, attempts: 3 });
    const ok = s.ctx.commands.send('fridge-01', 'BUZZER_TEST')!;
    const bad = s.ctx.commands.send('fridge-01', 'SYNC_REQUEST')!;
    s.ingest.handle(
      topic('cmdack'),
      envelope('cmdack', { cmd_id: ok, ok: true, detail: 'beeped 1000 ms' }),
      NOW,
    );
    s.ingest.handle(topic('cmdack'), envelope('cmdack', { cmd_id: bad, ok: false, detail: 'stale' }), NOW);
    await new Promise((r) => setTimeout(r, 120));
    expect(s.ctx.commands.get(ok)).toMatchObject({ status: 'ACKED', attempts: 1, detail: 'beeped 1000 ms' });
    expect(s.ctx.commands.get(bad)).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(s.published.filter((p) => p.topic.endsWith('/cmd'))).toHaveLength(2);
  });

  it('test-buzzer endpoint: Pharmacist yes, Inspector no; status readable', async () => {
    const s = setup();
    const pharm = bearer(tokenFor(s.t, await addUser(s.t, 'PHARMACIST')));
    const res = await s.t.http().post('/api/fridges/fridge-01/buzzer-test').set(pharm);
    expect(res.status).toBe(202);
    expect(res.body.command).toMatchObject({
      type: 'BUZZER_TEST',
      status: 'PENDING',
      device_id: 'fridge-01',
    });
    const insp = bearer(tokenFor(s.t, await addUser(s.t, 'INSPECTOR')));
    expect((await s.t.http().post('/api/fridges/fridge-01/buzzer-test').set(insp)).status).toBe(403);
    expect(
      (await s.t.http().get(`/api/commands/${res.body.command.cmd_id}`).set(insp)).body.command.status,
    ).toBe('PENDING');
    s.ctx.commands.stop();
  });
});

describe('robustness', () => {
  it('an alert row without stored lines does not break escalation or re-notification', async () => {
    const s = withTelegram();
    const t0 = Date.now();
    s.t.db
      .prepare(
        "INSERT INTO alerts (key, type, severity, fridge_id, message, data, created_at, updated_at, notified_at) VALUES ('DOOR_OPEN_LONG|fridge-01|-', 'DOOR_OPEN_LONG', 'WARNING', 'fridge-01', 'x', '{}', ?, ?, ?)",
      )
      .run(t0, t0, t0);
    expect(() => s.ctx.alerts.tick(t0 + 6 * 60_000)).not.toThrow();
    expect(s.alerts()[0].severity).toBe('CRITICAL');
  });

  it('a failing background job is logged, never thrown into the timer', async () => {
    expect(() =>
      guarded('boom', () => {
        throw new Error('bad row');
      })(),
    ).not.toThrow();
  });
});
