import { createHash } from 'node:crypto';
import { checkpointReadings } from '../modules/audit/chain';
import type { AppContext } from '../shared/http';
import { logger } from '../shared/logger';
import { classify, type FridgeState } from '../shared/status';
import { DeviceSender, type Publish } from './commands';
import { DeviceRegistry } from './devices';
import { isEnvelope, sign, sigEqual, type Envelope } from './envelope';
import {
  cmdackBody,
  eventBody,
  syncBody,
  telemetryBody,
  type EventBody,
  type SyncReading,
  type TelemetryBody,
} from './schemas';

// Device message pipeline (P09, contract sections 3-5). Every message is authenticated before anything is stored.

export const REJECT_REASONS = [
  'BAD_JSON',
  'UNKNOWN_DEVICE',
  'STALE_TS',
  'BAD_SIG',
  'REPLAY',
  'BAD_BODY',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const MAX_MESSAGE_BYTES = 16 * 1024; // the device's MQTT buffer is 8 kB
export const GAP_SYNC_AFTER_MS = 30_000; // seq gap with no sync for this long -> SYNC_REQUEST
export const OFFLINE_AFTER_MS = 20_000; // no accepted message -> fridge OFFLINE
export const OFFLINE_ALERT_AFTER_MS = 60_000; // -> offline alert hook (P12)

const DATA_KINDS = ['telemetry', 'event', 'sync', 'cmdack'] as const;
type DataKind = (typeof DATA_KINDS)[number];

export interface StoredReading extends SyncReading {
  device_id: string;
  fridge_id: string;
  late: 0 | 1;
}
export interface StoredEvent extends EventBody {
  device_id: string;
  fridge_id: string;
  late: 0 | 1;
}

export interface LiveState {
  fridge_id: string;
  device_id: string;
  seq: number;
  ts: number;
  temp: number | null;
  door: 0 | 1;
  comp: 0 | 1;
  power: 'MAINS' | 'BATTERY';
  batt: number;
  state: FridgeState; // computed by the server with the shared classify()
  device_state: FridgeState; // what the device reported
  exp_s: number;
  latch: 0 | 1;
  mode: 'model' | 'manual';
  buf: number;
  rssi: number;
  online: boolean;
  last_seen: number; // unix ms of the last accepted message
}

/** Extension points for later prompts: heat engine (P11), alerts and commands (P12). */
export interface IngestHooks {
  onReadingsInserted?: (fridgeId: string, readings: StoredReading[], opts: { late: boolean }) => void;
  onDeviceEvent?: (fridgeId: string, event: StoredEvent) => void;
  onDeviceOffline?: (fridgeId: string, deviceId: string, offlineForMs: number) => void;
  onCommandAck?: (deviceId: string, ack: { cmd_id: string; ok: boolean; detail: string }) => void;
}

export type IngestResult =
  | { accepted: true; kind: string; inserted?: number; seqUpto?: number }
  | { accepted: false; reason: RejectReason };

interface DeviceTrack {
  maxSeq: number;
  gap?: { from: number; to: number; since: number };
  ackedUpto: number;
  lastAccepted: number;
  offline: boolean;
  offlineAlerted: boolean;
  syncRequests: number;
  statusHint?: string;
}

const DEVICE_EVENT_AUDIT = new Set([
  'DOOR_ALARM',
  'POWER_FAIL',
  'POWER_RESTORE',
  'LATCH_SET',
  'LATCH_RESET',
  'SENSOR_FAULT',
]);

export class Ingestor {
  readonly devices: DeviceRegistry;
  readonly sender: DeviceSender;
  readonly live = new Map<string, LiveState>();
  readonly hooks: IngestHooks;
  readonly metrics = {
    startedAt: Date.now(),
    accepted: { telemetry: 0, event: 0, sync: 0, cmdack: 0, status: 0 } as Record<string, number>,
    rejected: Object.fromEntries(REJECT_REASONS.map((r) => [r, 0])) as Record<RejectReason, number>,
    lateReadings: 0,
    syncRequests: 0,
  };
  private track = new Map<string, DeviceTrack>();
  private readonly window: number; // HMAC_WINDOW_S (env override)
  private readonly nonceTtl: number; // NONCE_TTL_S, >= 2 x window (enforced by config)
  private readonly sql;

  constructor(
    private readonly ctx: AppContext,
    opts: { publish?: Publish; hooks?: IngestHooks } = {},
  ) {
    const { db, config } = ctx;
    this.window = config.HMAC_WINDOW_S;
    this.nonceTtl = config.NONCE_TTL_S;
    this.devices = new DeviceRegistry(db, config.APP_SECRET_KEY);
    this.sender = new DeviceSender(config.MQTT_TOPIC_PREFIX, this.devices, opts.publish ?? (() => undefined));
    this.hooks = opts.hooks ?? {};
    this.sql = {
      nonce: db.prepare('INSERT INTO nonces (device_id, nonce, expires_at) VALUES (?, ?, ?)'),
      reject: db.prepare(
        'INSERT INTO security_events (ts, device_id, reason, topic, size, sample_hash, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ),
      reading: db.prepare(
        `INSERT INTO readings (device_id, fridge_id, seq, ts, temp, door, comp, power, batt, state, exp_s, latch, mode, reason, late, received_at)
         VALUES (@device_id, @fridge_id, @seq, @ts, @temp, @door, @comp, @power, @batt, @state, @exp_s, @latch, @mode, @reason, @late, @received_at)
         ON CONFLICT (device_id, seq) DO NOTHING`,
      ),
      event: db.prepare(
        `INSERT INTO events (device_id, fridge_id, seq, ts, type, data, late, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, seq) DO NOTHING`,
      ),
      seen: db.prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?'),
      latch: db.prepare('UPDATE fridges SET latch_state = ? WHERE id = ?'),
      storedAfter: db.prepare(
        `SELECT seq FROM readings WHERE device_id = ? AND seq > ?
         UNION SELECT seq FROM events WHERE device_id = ? AND seq > ? ORDER BY seq LIMIT 500`,
      ),
      purge: db.prepare('DELETE FROM nonces WHERE expires_at < ?'),
    };
  }

  setPublisher(publish: Publish) {
    this.sender.setPublisher(publish);
  }

  // ---------------------------------------------------------------- entry point

  handle(topic: string, payload: Buffer | string, nowMs = Date.now()): IngestResult {
    const raw = typeof payload === 'string' ? payload : payload.toString('utf8');
    const size = Buffer.byteLength(raw);
    const parts = topic.split('/');
    const prefix = this.ctx.config.MQTT_TOPIC_PREFIX;
    const kind = parts.at(-1) ?? '';
    const topicDevice =
      parts.length === prefix.split('/').length + 2 && topic.startsWith(`${prefix}/`) ? parts.at(-2)! : null;

    if (kind === 'status' && topicDevice) return this.statusHint(topicDevice, raw);
    const reject = (reason: RejectReason, detail?: Record<string, unknown>): IngestResult => {
      this.recordReject(nowMs, topicDevice, reason, topic, size, raw, detail);
      return { accepted: false, reason };
    };

    // 1. parse
    if (!topicDevice || !(DATA_KINDS as readonly string[]).includes(kind) || size > MAX_MESSAGE_BYTES)
      return reject('BAD_JSON');
    let env: Envelope;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isEnvelope(parsed)) return reject('BAD_JSON');
      env = parsed;
    } catch {
      return reject('BAD_JSON');
    }
    if (env.kind !== kind) return reject('BAD_JSON', { envelope_kind: env.kind });

    // 2. known, active device; the topic and the envelope must name the same one
    if (env.device_id !== topicDevice)
      return reject('UNKNOWN_DEVICE', { envelope_device: env.device_id.slice(0, 64) });
    const device = this.devices.get(topicDevice, nowMs);
    if (!device) return reject('UNKNOWN_DEVICE');

    // 3. freshness of the send time (reading times inside a sync body are old by design and never checked here)
    const nowS = Math.floor(nowMs / 1000);
    const skew = nowS - env.ts;
    if (Math.abs(skew) > this.window) return reject('STALE_TS', { skew_s: skew });

    // 4. HMAC over the raw body string, constant-time compare
    if (!sigEqual(sign(device.secret, env.device_id, env.kind, env.ts, env.nonce, env.body), env.sig))
      return reject('BAD_SIG');

    // 5. nonce, stored only now that the HMAC verified: unauthenticated senders cannot fill the table
    try {
      this.sql.nonce.run(device.deviceId, env.nonce, nowS + this.nonceTtl);
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return reject('REPLAY');
      throw err;
    }

    // 6. body schema per kind
    let body: unknown;
    try {
      body = JSON.parse(env.body);
    } catch {
      return reject('BAD_BODY');
    }
    const schema = { telemetry: telemetryBody, event: eventBody, sync: syncBody, cmdack: cmdackBody }[
      kind as DataKind
    ];
    const parsed = schema.safeParse(body);
    if (!parsed.success) return reject('BAD_BODY', { issue: parsed.error.issues[0]?.path.join('.') });

    this.metrics.accepted[kind] += 1;
    this.sql.seen.run(nowMs, device.deviceId);
    this.markSeen(device.deviceId, device.fridgeId, nowMs);
    switch (kind as DataKind) {
      case 'telemetry':
        return this.onTelemetry(device.deviceId, device.fridgeId, parsed.data as TelemetryBody, nowMs);
      case 'event':
        return this.onEvent(device.deviceId, device.fridgeId, parsed.data as EventBody, nowMs);
      case 'sync':
        return this.onSync(
          device.deviceId,
          device.fridgeId,
          parsed.data as { from_seq: number; to_seq: number; readings: (SyncReading | EventBody)[] },
          nowMs,
        );
      case 'cmdack': {
        const ack = parsed.data as { cmd_id: string; ok: boolean; detail: string };
        logger.info({ deviceId: device.deviceId, ...ack }, 'command acknowledged');
        this.hooks.onCommandAck?.(device.deviceId, ack);
        this.ctx.realtime.emit('device:cmdack', { device_id: device.deviceId, ...ack });
        return { accepted: true, kind };
      }
    }
  }

  // ---------------------------------------------------------------- kinds

  private onTelemetry(deviceId: string, fridgeId: string, t: TelemetryBody, nowMs: number): IngestResult {
    const row = this.readingRow(deviceId, fridgeId, t, 0, nowMs);
    const inserted = this.sql.reading.run(row).changes > 0;
    if (inserted) {
      this.hooks.onReadingsInserted?.(fridgeId, [row], { late: false });
      checkpointReadings(this.ctx.db, fridgeId);
    }
    this.noteSeq(deviceId, t.seq, nowMs);

    const state = classify(t.temp, t.door === 1, t.power === 'BATTERY', t.temp === null);
    if (state !== t.state)
      logger.debug({ deviceId, seq: t.seq, server: state, device: t.state }, 'STATE_MISMATCH');
    const prev = this.live.get(fridgeId);
    if (!prev || t.seq >= prev.seq) {
      const live: LiveState = {
        fridge_id: fridgeId,
        device_id: deviceId,
        seq: t.seq,
        ts: t.ts,
        temp: t.temp,
        door: t.door,
        comp: t.comp,
        power: t.power,
        batt: t.batt,
        state,
        device_state: t.state,
        exp_s: t.exp_s,
        latch: t.latch,
        mode: t.mode,
        buf: t.buf,
        rssi: t.rssi,
        online: true,
        last_seen: nowMs,
      };
      this.live.set(fridgeId, live);
      this.ctx.realtime.emit('fridge:update', live);
    }
    return { accepted: true, kind: 'telemetry', inserted: inserted ? 1 : 0 };
  }

  private onEvent(deviceId: string, fridgeId: string, e: EventBody, nowMs: number): IngestResult {
    const inserted = this.storeEvent(deviceId, fridgeId, e, 0, nowMs);
    this.noteSeq(deviceId, e.seq, nowMs);
    if (e.type === 'WIFI_BACK' && this.trackOf(deviceId).gap) this.requestSync(deviceId); // reconnect with a known hole
    return { accepted: true, kind: 'event', inserted: inserted ? 1 : 0 };
  }

  /**
   * Buffered data. Items are stored in seq order (duplicates ignored), then acked with seq_upto = the highest
   * seq up to which nothing the device may still hold is missing. Starting point: from_seq, because the device's
   * oldest buffered item is from_seq (it holds nothing older). Inside [from_seq, to_seq] the device buffered
   * exactly the items in the chunk; seqs missing from it were sent live, so they are not waited for. Past to_seq
   * the ack only advances through seqs actually stored. It never covers data the device holds and the server
   * lacks, and seq jumps (reboots) or a lost live message can never stall the sync.
   */
  private onSync(
    deviceId: string,
    fridgeId: string,
    s: { from_seq: number; to_seq: number; readings: (SyncReading | EventBody)[] },
    nowMs: number,
  ): IngestResult {
    const items = [...s.readings].sort((a, b) => a.seq - b.seq);
    const newReadings: StoredReading[] = [];
    const newEvents: StoredEvent[] = [];
    this.ctx.db.transaction(() => {
      for (const item of items) {
        if ('type' in item) {
          if (this.storeEvent(deviceId, fridgeId, item, 1, nowMs, false))
            newEvents.push({ ...item, device_id: deviceId, fridge_id: fridgeId, late: 1 });
        } else {
          const row = this.readingRow(deviceId, fridgeId, item, 1, nowMs);
          if (this.sql.reading.run(row).changes > 0) newReadings.push(row);
        }
      }
    })();
    for (const e of newEvents) this.eventSideEffects(e);
    if (newReadings.length) {
      this.metrics.lateReadings += newReadings.length;
      this.hooks.onReadingsInserted?.(fridgeId, newReadings, { late: true }); // exposure is recomputed (P11)
      checkpointReadings(this.ctx.db, fridgeId);
    }

    let upto = s.to_seq;
    for (const next of this.sql.storedAfter.pluck().all(deviceId, upto, deviceId, upto) as number[]) {
      if (next !== upto + 1) break;
      upto = next;
    }
    const tr = this.trackOf(deviceId);
    tr.ackedUpto = Math.max(tr.ackedUpto, upto);
    tr.gap = undefined; // the device is syncing: no need to ask for it
    this.sender.ack(deviceId, tr.ackedUpto);
    return {
      accepted: true,
      kind: 'sync',
      inserted: newReadings.length + newEvents.length,
      seqUpto: tr.ackedUpto,
    };
  }

  // ---------------------------------------------------------------- storage helpers

  private readingRow(
    deviceId: string,
    fridgeId: string,
    r: SyncReading,
    late: 0 | 1,
    nowMs: number,
  ): StoredReading & { received_at: number } {
    const { seq, ts, temp, door, comp, power, batt, state, exp_s, latch, mode, reason } = r;
    return {
      device_id: deviceId,
      fridge_id: fridgeId,
      seq,
      ts,
      temp,
      door,
      comp,
      power,
      batt,
      state,
      exp_s,
      latch,
      mode,
      reason,
      late,
      received_at: nowMs,
    };
  }

  private storeEvent(
    deviceId: string,
    fridgeId: string,
    e: EventBody,
    late: 0 | 1,
    nowMs: number,
    effects = true,
  ): boolean {
    const inserted =
      this.sql.event.run(deviceId, fridgeId, e.seq, e.ts, e.type, JSON.stringify(e.data), late, nowMs)
        .changes > 0;
    if (inserted && effects) this.eventSideEffects({ ...e, device_id: deviceId, fridge_id: fridgeId, late });
    return inserted;
  }

  private eventSideEffects(e: StoredEvent) {
    if (e.type === 'LATCH_SET') this.sql.latch.run(1, e.fridge_id);
    if (e.type === 'LATCH_RESET') this.sql.latch.run(0, e.fridge_id); // the device confirms the admin reset
    if (DEVICE_EVENT_AUDIT.has(e.type)) {
      this.ctx.audit.append(`device:${e.device_id}`, 'DEVICE_EVENT', {
        type: e.type,
        seq: e.seq,
        ts: e.ts,
        fridge_id: e.fridge_id,
        late: e.late === 1,
        data: e.data,
      });
    }
    this.hooks.onDeviceEvent?.(e.fridge_id, e); // alerts for DOOR_ALARM, POWER_FAIL, BATT_LOW, LATCH_SET (P12)
  }

  private recordReject(
    nowMs: number,
    deviceId: string | null,
    reason: RejectReason,
    topic: string,
    size: number,
    raw: string,
    detail?: Record<string, unknown>,
  ) {
    this.metrics.rejected[reason] += 1;
    // Only a hash of the payload is kept: never the payload itself, never a secret.
    const sampleHash = createHash('sha256').update(raw).digest('hex');
    const device = deviceId?.slice(0, 64) ?? null;
    this.sql.reject.run(
      Math.floor(nowMs / 1000),
      device,
      reason,
      topic.slice(0, 200),
      size,
      sampleHash,
      detail ? JSON.stringify(detail) : null,
    );
    this.ctx.audit.securityReject(device, reason, undefined, nowMs);
    this.ctx.realtime.emit('security:event', {
      ts: nowMs,
      device_id: device,
      reason,
      topic: topic.slice(0, 200),
      ...(detail ?? {}),
    });
    logger.warn(
      { deviceId: device, reason, size, sampleHash: sampleHash.slice(0, 12), ...(detail ?? {}) },
      'device message rejected',
    );
  }

  // ---------------------------------------------------------------- gaps, offline, status

  private trackOf(deviceId: string): DeviceTrack {
    let tr = this.track.get(deviceId);
    if (!tr) {
      tr = {
        maxSeq: 0,
        ackedUpto: 0,
        lastAccepted: 0,
        offline: false,
        offlineAlerted: false,
        syncRequests: 0,
      };
      this.track.set(deviceId, tr);
    }
    return tr;
  }

  private noteSeq(deviceId: string, seq: number, nowMs: number) {
    const tr = this.trackOf(deviceId);
    if (tr.maxSeq > 0 && seq > tr.maxSeq + 1 && !tr.gap)
      tr.gap = { from: tr.maxSeq + 1, to: seq - 1, since: nowMs };
    tr.maxSeq = Math.max(tr.maxSeq, seq);
  }

  private markSeen(deviceId: string, fridgeId: string, nowMs: number) {
    const tr = this.trackOf(deviceId);
    tr.lastAccepted = nowMs;
    if (tr.offline) {
      tr.offline = tr.offlineAlerted = false;
      const live = this.live.get(fridgeId);
      if (live)
        this.ctx.realtime.emit('fridge:update', Object.assign(live, { online: true, last_seen: nowMs }));
    }
  }

  private requestSync(deviceId: string) {
    const tr = this.trackOf(deviceId);
    tr.gap = undefined;
    if (this.sender.command(deviceId, 'SYNC_REQUEST')) {
      tr.syncRequests += 1;
      this.metrics.syncRequests += 1;
    }
  }

  private statusHint(deviceId: string, raw: string): IngestResult {
    // LWT online/offline: unsigned, informational only. Never trusted for data or for the online state.
    const status = raw === 'online' || raw === 'offline' ? raw : 'unknown';
    this.trackOf(deviceId).statusHint = status;
    this.metrics.accepted.status += 1;
    this.ctx.realtime.emit('device:status', { device_id: deviceId.slice(0, 64), status, hint: true });
    return { accepted: true, kind: 'status' };
  }

  /** Call every second: seq gaps without a sync -> SYNC_REQUEST; silent devices -> OFFLINE, then an alert. */
  tick(nowMs = Date.now()) {
    for (const [deviceId, tr] of this.track) {
      if (tr.gap && nowMs - tr.gap.since >= GAP_SYNC_AFTER_MS) this.requestSync(deviceId);
      if (!tr.lastAccepted) continue;
      const silentFor = nowMs - tr.lastAccepted;
      const device = this.devices.get(deviceId, nowMs);
      if (!device) continue;
      if (!tr.offline && silentFor > OFFLINE_AFTER_MS) {
        tr.offline = true;
        const live = this.live.get(device.fridgeId);
        this.ctx.realtime.emit(
          'fridge:update',
          live ? Object.assign(live, { online: false }) : { fridge_id: device.fridgeId, online: false },
        );
      }
      if (tr.offline && !tr.offlineAlerted && silentFor > OFFLINE_ALERT_AFTER_MS) {
        tr.offlineAlerted = true;
        this.hooks.onDeviceOffline?.(device.fridgeId, deviceId, silentFor);
      }
    }
  }

  purgeNonces(nowMs = Date.now()): number {
    return this.sql.purge.run(Math.floor(nowMs / 1000)).changes;
  }

  snapshot(nowMs = Date.now()) {
    return {
      started_at: this.metrics.startedAt,
      accepted: this.metrics.accepted,
      rejected: this.metrics.rejected,
      late_readings: this.metrics.lateReadings,
      sync_requests: this.metrics.syncRequests,
      devices: [...this.track.entries()].map(([deviceId, tr]) => ({
        device_id: deviceId,
        last_seen: tr.lastAccepted || null,
        online: tr.lastAccepted > 0 && !tr.offline && nowMs - tr.lastAccepted <= OFFLINE_AFTER_MS,
        status_hint: tr.statusHint ?? null,
        max_seq: tr.maxSeq,
        acked_upto: tr.ackedUpto,
        open_gap: tr.gap ? { from: tr.gap.from, to: tr.gap.to } : null,
        sync_requests: tr.syncRequests,
      })),
    };
  }
}
