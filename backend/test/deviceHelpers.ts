import { randomBytes } from 'node:crypto';
import { encryptSecret } from '../src/shared/secretbox';
import { sign } from '../src/mqtt/envelope';
import type { Ingestor } from '../src/mqtt/ingest';
import { RecordingRealtime } from '../src/realtime';
import type { AppContext } from '../src/shared/http';
import { makeApp } from './helpers';

// A simulated fridge node: signed device messages fed straight into the ingestor (no broker).

export const SECRET = 'a1'.repeat(32);
export const PREFIX = 'coldchain/v1';
export const NOW = 1_767_225_600_000; // fixed clock (unix ms)
export const nowS = NOW / 1000;

export function setup(
  devices: Record<string, string> = { 'fridge-01': SECRET, 'fridge-02': 'b2'.repeat(32) },
) {
  const t = makeApp();
  const ctx = t.app.locals.ctx as AppContext;
  const rt = new RecordingRealtime();
  ctx.realtime = rt;
  const published: { topic: string; payload: string }[] = [];
  ctx.ingest.setPublisher((topic, payload) => published.push({ topic, payload }));
  for (const [id, secret] of Object.entries(devices)) {
    t.db.prepare('INSERT INTO fridges (id, name, capacity, created_at) VALUES (?, ?, 20, 0)').run(id, id);
    t.db
      .prepare('INSERT INTO devices (device_id, fridge_id, secret_enc, created_at) VALUES (?, ?, ?, 0)')
      .run(id, id, encryptSecret(secret, t.config.APP_SECRET_KEY));
  }
  return { t, ctx, ingest: ctx.ingest as Ingestor, rt, published };
}

export const nonce = () => randomBytes(8).toString('hex');
export function envelope(
  kind: string,
  body: object | string,
  o: { ts?: number; device?: string; secret?: string; nonce?: string } = {},
): string {
  const device = o.device ?? 'fridge-01';
  const ts = o.ts ?? nowS;
  const n = o.nonce ?? nonce();
  const b = typeof body === 'string' ? body : JSON.stringify(body);
  return JSON.stringify({
    v: 1,
    device_id: device,
    kind,
    ts,
    nonce: n,
    body: b,
    sig: sign(o.secret ?? SECRET, device, kind, ts, n, b),
  });
}
export const topic = (kind: string, device = 'fridge-01') => `${PREFIX}/${device}/${kind}`;

export const reading = (seq: number, o: Record<string, unknown> = {}) => ({
  seq, ts: nowS - 3600 + seq * 5, temp: 4.5, door: 0, comp: 1, power: 'MAINS', batt: 100, state: 'SAFE',
  exp_s: 0, latch: 0, mode: 'model', reason: 'periodic', ...o,
}); // prettier-ignore
export const telemetry = (seq: number, o: Record<string, unknown> = {}) => ({
  ...reading(seq, { ts: nowS }),
  buf: 0,
  rssi: -60,
  fw: '1.0.0',
  ...o,
});
