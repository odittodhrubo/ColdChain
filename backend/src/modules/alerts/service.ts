import type { StoredEvent, StoredReading, RejectReason } from '../../mqtt/ingest';
import { SAFE_MAX_C, SAFE_MIN_C } from '../../shared/constants';
import { conflict, notFound } from '../../shared/errors';
import type { AppContext } from '../../shared/http';
import { logger } from '../../shared/logger';
import type { BatchStatus } from '../../shared/status';
import type { BatchView } from '../batches/service';
import { type AlertMessage, Notifier } from './notifier';

// Alert engine (P12). One alert per episode, keyed type|fridge|batch: raising an active key updates it (and only
// escalates), never duplicates. Re-notification every 10 min (CRITICAL: 5 min) until acknowledged or resolved;
// conditions that end (door closed, temperature back in range, power restored, device back) resolve their alert.
// A later episode is a new alert, so acknowledging one never hides the next. Every raise/ack/resolve is audited.

export const ALERT_TYPES = [
  'DOOR_OPEN_LONG',
  'FRIDGE_BREACH',
  'POWER_FAILURE',
  'BATTERY_LOW',
  'FRIDGE_OFFLINE',
  'BATCH_AT_RISK',
  'BATCH_DISCARD',
  'PREDICTED_BREACH', // P18
  'COMPRESSOR_WEAK', // P18
  'RELOCATION_PROPOSED', // P18
  'SECURITY_FLOOD',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

const RANK: Record<Severity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
export const RENOTIFY_MS: Record<Severity, number> = {
  INFO: Infinity,
  WARNING: 10 * 60_000,
  CRITICAL: 5 * 60_000,
};
export const DOOR_CRITICAL_AFTER_MS = 5 * 60_000; // door alarm escalates WARNING -> CRITICAL
export const BREACH_READINGS = 2; // consecutive accepted readings outside 2-8 C
export const FLOOD_PER_MIN = 20; // rejected messages per minute from one source
const FLOOD_WINDOW_MS = 60_000;

export interface AlertRow {
  id: number;
  key: string;
  type: AlertType;
  severity: Severity;
  fridge_id: string | null;
  batch_id: number | null;
  message: string;
  data: string;
  created_at: number;
  updated_at: number;
  acknowledged_by: number | null;
  acknowledged_at: number | null;
  resolved_at: number | null;
  notified_at: number | null;
  notify_count: number;
  delivery_status: string;
}

export interface RaiseInput {
  type: AlertType;
  severity: Severity;
  fridgeId?: string | null;
  batchId?: number | null;
  source?: string; // extra key part (SECURITY_FLOOD: the sending device)
  title: string;
  lines: string[];
  data?: Record<string, unknown>;
}

/** Episode key: type|fridge|batch (|source). Batch alerts key on the batch alone: they follow it across moves. */
export const alertKey = (
  type: AlertType,
  fridgeId?: string | null,
  batchId?: number | null,
  source?: string,
) => [type, batchId != null ? '-' : (fridgeId ?? '-'), batchId ?? '-', ...(source ? [source] : [])].join('|');

export function alertView(r: AlertRow) {
  const data = JSON.parse(r.data) as { title?: string; lines?: string[] };
  return {
    ...r,
    data,
    delivery_status: JSON.parse(r.delivery_status),
    status: r.resolved_at ? 'RESOLVED' : r.acknowledged_at ? 'ACKNOWLEDGED' : 'ACTIVE',
  };
}

export class AlertEngine {
  private readonly breach = new Map<string, number>(); // fridge -> consecutive out-of-range readings
  private readonly floods = new Map<string, number[]>(); // source -> reject times in the last minute
  private readonly sql;

  constructor(
    private readonly ctx: AppContext,
    readonly notifier = new Notifier(ctx.config),
  ) {
    const db = ctx.db;
    this.sql = {
      active: db.prepare('SELECT * FROM alerts WHERE key = ? AND resolved_at IS NULL'),
      byId: db.prepare('SELECT * FROM alerts WHERE id = ?'),
      insert: db.prepare(
        `INSERT INTO alerts (key, type, severity, fridge_id, batch_id, message, data, created_at, updated_at)
         VALUES (@key, @type, @severity, @fridge_id, @batch_id, @message, @data, @now, @now)`,
      ),
      update: db.prepare(
        'UPDATE alerts SET severity = ?, message = ?, data = ?, updated_at = ? WHERE id = ?',
      ),
      resolve: db.prepare('UPDATE alerts SET resolved_at = ?, updated_at = ? WHERE id = ?'),
      ack: db.prepare(
        'UPDATE alerts SET acknowledged_by = ?, acknowledged_at = ?, updated_at = ? WHERE id = ?',
      ),
      notified: db.prepare('UPDATE alerts SET notified_at = ?, notify_count = notify_count + 1 WHERE id = ?'),
      delivery: db.prepare('UPDATE alerts SET delivery_status = ? WHERE id = ?'),
      due: db.prepare(
        'SELECT * FROM alerts WHERE resolved_at IS NULL AND acknowledged_at IS NULL AND notified_at IS NOT NULL ORDER BY id',
      ),
      doorWarnings: db.prepare(
        "SELECT * FROM alerts WHERE type = 'DOOR_OPEN_LONG' AND severity = 'WARNING' AND resolved_at IS NULL AND created_at <= ?",
      ),
      floods: db.prepare("SELECT * FROM alerts WHERE type = 'SECURITY_FLOOD' AND resolved_at IS NULL"),
      fridgeName: db.prepare('SELECT name FROM fridges WHERE id = ?').pluck(),
    };
  }

  // ---------------------------------------------------------------- core

  raise(input: RaiseInput, nowMs = Date.now()): AlertRow {
    const key = alertKey(input.type, input.fridgeId, input.batchId, input.source);
    const data = JSON.stringify({ title: input.title, lines: input.lines, ...(input.data ?? {}) });
    const message = `${input.title}: ${input.lines.join('; ')}`;
    const existing = this.sql.active.get(key) as AlertRow | undefined;
    if (existing) {
      const escalated = RANK[input.severity] > RANK[existing.severity];
      const severity = escalated ? input.severity : existing.severity;
      this.sql.update.run(severity, message, data, nowMs, existing.id);
      const row = this.sql.byId.get(existing.id) as AlertRow;
      this.ctx.realtime.emit('alert:update', alertView(row));
      if (escalated) {
        this.ctx.audit.append('system', 'ALERT_RAISED', { alert_id: row.id, key, severity, escalated: true });
        this.notify(row, nowMs);
      }
      return row;
    }
    const id = this.ctx.db.transaction(() => {
      const res = this.sql.insert.run({
        key,
        type: input.type,
        severity: input.severity,
        fridge_id: input.fridgeId ?? null,
        batch_id: input.batchId ?? null,
        message,
        data,
        now: nowMs,
      });
      this.ctx.audit.append('system', 'ALERT_RAISED', {
        alert_id: Number(res.lastInsertRowid),
        key,
        type: input.type,
        severity: input.severity,
      });
      return Number(res.lastInsertRowid);
    })();
    const row = this.sql.byId.get(id) as AlertRow;
    this.ctx.realtime.emit('alert:new', alertView(row)); // in-app: the primary channel
    this.notify(row, nowMs);
    return row;
  }

  resolve(
    type: AlertType,
    fridgeId?: string | null,
    batchId?: number | null,
    source?: string,
    nowMs = Date.now(),
  ) {
    const row = this.sql.active.get(alertKey(type, fridgeId, batchId, source)) as AlertRow | undefined;
    if (!row) return null;
    this.sql.resolve.run(nowMs, nowMs, row.id);
    this.ctx.audit.append('system', 'ALERT_RESOLVED', { alert_id: row.id, key: row.key });
    const fresh = this.sql.byId.get(row.id) as AlertRow;
    this.ctx.realtime.emit('alert:update', alertView(fresh));
    return fresh;
  }

  ack(id: number, userId: number, nowMs = Date.now()) {
    const row = this.sql.byId.get(id) as AlertRow | undefined;
    if (!row) throw notFound('Alert not found');
    if (row.acknowledged_at) throw conflict('ALREADY_ACKNOWLEDGED', 'Alert already acknowledged');
    this.ctx.db.transaction(() => {
      this.sql.ack.run(userId, nowMs, nowMs, id);
      this.ctx.audit.append(`user:${userId}`, 'ALERT_ACKED', { alert_id: id, key: row.key });
    })();
    const fresh = alertView(this.sql.byId.get(id) as AlertRow);
    this.ctx.realtime.emit('alert:update', fresh);
    return fresh;
  }

  /** One notification round, in the background: ingestion never waits for Telegram or SMTP. */
  private notify(row: AlertRow, nowMs: number) {
    this.sql.notified.run(nowMs, row.id);
    const round = row.notify_count + 1;
    const data = JSON.parse(row.data) as { title?: string; lines?: string[]; link?: string };
    const msg: AlertMessage = {
      title: round > 1 ? `${data.title ?? row.type} (reminder ${round - 1})` : (data.title ?? row.type),
      lines: data.lines ?? [],
      link: data.link,
      severity: (this.sql.byId.get(row.id) as AlertRow).severity,
    };
    void this.notifier
      .send(msg)
      .then((res) => {
        const status = { in_app: { status: 'sent', at: nowMs }, ...res, round };
        this.sql.delivery.run(JSON.stringify(status), row.id);
        this.ctx.realtime.emit('alert:update', alertView(this.sql.byId.get(row.id) as AlertRow));
      })
      .catch((err: Error) =>
        logger.error({ err: err.message, alertId: row.id }, 'alert delivery bookkeeping failed'),
      );
  }

  /** Job (every few seconds): door escalation, re-notification, flood windows ending. */
  tick(nowMs = Date.now()) {
    for (const row of this.sql.doorWarnings.all(nowMs - DOOR_CRITICAL_AFTER_MS) as AlertRow[]) {
      const data = JSON.parse(row.data) as { lines?: string[] };
      this.raise(
        {
          type: 'DOOR_OPEN_LONG',
          severity: 'CRITICAL',
          fridgeId: row.fridge_id,
          title: 'Door open for more than 5 minutes',
          lines: data.lines ?? this.fridgeLines(row.fridge_id ?? ''),
        },
        nowMs,
      );
    }
    for (const row of this.sql.due.all() as AlertRow[])
      if (nowMs - row.notified_at! >= RENOTIFY_MS[row.severity]) this.notify(row, nowMs);
    for (const row of this.sql.floods.all() as AlertRow[]) {
      const source = row.key.split('|')[3];
      const times = (this.floods.get(source) ?? []).filter((t) => nowMs - t < FLOOD_WINDOW_MS);
      if (times.length === 0) this.resolve('SECURITY_FLOOD', null, null, source, nowMs);
    }
  }

  // ---------------------------------------------------------------- sources

  private fridgeLines(fridgeId: string, extra: string[] = []) {
    const live = this.ctx.ingest.live.get(fridgeId);
    return [
      `Fridge: ${(this.sql.fridgeName.get(fridgeId) as string | undefined) ?? fridgeId} (${fridgeId})`,
      ...(live?.temp !== undefined
        ? [`Temperature: ${live.temp === null ? 'sensor fault' : `${live.temp.toFixed(1)} °C`}`]
        : []),
      ...extra,
    ];
  }

  private link(fridgeId?: string | null) {
    const base = this.ctx.config.PUBLIC_BASE_URL.replace(/\/+$/, '');
    return fridgeId ? `${base}/fridges/${fridgeId}` : `${base}/alerts`;
  }

  /** Device events (ingest hook). Late (synced) events still alert, labelled with when they happened. */
  onDeviceEvent(fridgeId: string, e: StoredEvent, nowMs = Date.now()) {
    const at = new Date(e.ts * 1000).toISOString();
    const delayed = e.late === 1 ? `Delayed (offline) – occurred at ${at}` : null;
    const base = { fridgeId, data: { link: this.link(fridgeId), event_ts: e.ts, late: e.late === 1 } };
    switch (e.type) {
      case 'DOOR_ALARM': {
        this.raise(
          {
            ...base,
            type: 'DOOR_OPEN_LONG',
            severity: 'WARNING',
            title: delayed ? `Door was open > 60 s (${delayed})` : 'Door open for more than 60 s',
            lines: this.fridgeLines(fridgeId, [
              `Open since: ${new Date(e.ts * 1000 - 60_000).toISOString()}`,
            ]),
          },
          nowMs,
        );
        // a delayed alarm whose door has closed since: notified, then the episode is over
        if (delayed && this.ctx.ingest.live.get(fridgeId)?.door === 0)
          this.resolve('DOOR_OPEN_LONG', fridgeId, null, undefined, nowMs);
        break;
      }
      case 'DOOR_CLOSE':
        this.resolve('DOOR_OPEN_LONG', fridgeId, null, undefined, nowMs);
        break;
      case 'POWER_FAIL':
        this.raise(
          {
            ...base,
            type: 'POWER_FAILURE',
            severity: 'WARNING',
            title: delayed ? `Power failure (${delayed})` : 'Power failure: running on battery',
            lines: this.fridgeLines(fridgeId, ['Compressor is off until mains returns']),
          },
          nowMs,
        );
        break;
      case 'BATT_LOW':
        this.raise(
          {
            ...base,
            type: 'BATTERY_LOW',
            severity: 'CRITICAL',
            title: 'Node battery low',
            lines: this.fridgeLines(fridgeId, [
              `Battery: ${String((e.data as { batt?: number }).batt ?? '?')} %`,
            ]),
          },
          nowMs,
        );
        break;
      case 'POWER_RESTORE':
        this.resolve('POWER_FAILURE', fridgeId, null, undefined, nowMs);
        this.resolve('BATTERY_LOW', fridgeId, null, undefined, nowMs);
        break;
      case 'LATCH_SET':
        this.raise(
          {
            ...base,
            type: 'BATCH_DISCARD',
            severity: 'CRITICAL',
            title: 'Fridge latched: heat budget exhausted',
            lines: this.fridgeLines(fridgeId, ['Red LED on until an Admin acknowledges the discard']),
          },
          nowMs,
        );
        break;
    }
  }

  /** Live readings (ingest hook): breach after 2 consecutive out-of-range readings; conditions that ended resolve. */
  onReadings(fridgeId: string, readings: StoredReading[], opts: { late: boolean }, nowMs = Date.now()) {
    if (opts.late) return; // history: the live state decides about the present
    for (const r of readings) {
      const out = r.temp === null || r.temp > SAFE_MAX_C || r.temp < SAFE_MIN_C;
      const streak = out ? (this.breach.get(fridgeId) ?? 0) + 1 : 0;
      this.breach.set(fridgeId, streak);
      if (streak === BREACH_READINGS) {
        this.raise(
          {
            type: 'FRIDGE_BREACH',
            severity: 'CRITICAL',
            fridgeId,
            title: 'Temperature outside 2–8 °C',
            lines: this.fridgeLines(fridgeId, [
              `Reading: ${r.temp === null ? 'sensor fault' : `${r.temp.toFixed(1)} °C`}`,
            ]),
            data: { link: this.link(fridgeId) },
          },
          nowMs,
        );
        this.ctx.audit.append(`device:${r.device_id}`, 'BREACH_START', {
          fridge_id: fridgeId,
          seq: r.seq,
          temp: r.temp,
        });
      }
      if (!out && this.resolve('FRIDGE_BREACH', fridgeId, null, undefined, nowMs))
        this.ctx.audit.append(`device:${r.device_id}`, 'BREACH_END', {
          fridge_id: fridgeId,
          seq: r.seq,
          temp: r.temp,
        });
      if (r.door === 0) this.resolve('DOOR_OPEN_LONG', fridgeId, null, undefined, nowMs);
      if (r.power === 'MAINS') {
        this.resolve('POWER_FAILURE', fridgeId, null, undefined, nowMs);
        this.resolve('BATTERY_LOW', fridgeId, null, undefined, nowMs);
      }
    }
  }

  onDeviceOffline(fridgeId: string, _deviceId: string, offlineForMs: number, nowMs = Date.now()) {
    this.raise(
      {
        type: 'FRIDGE_OFFLINE',
        severity: 'WARNING',
        fridgeId,
        title: 'Fridge node offline',
        lines: this.fridgeLines(fridgeId, [`No accepted message for ${Math.round(offlineForMs / 1000)} s`]),
        data: { link: this.link(fridgeId) },
      },
      nowMs,
    );
  }

  onDeviceOnline(fridgeId: string, _deviceId?: string, nowMs = Date.now()) {
    this.resolve('FRIDGE_OFFLINE', fridgeId, null, undefined, nowMs);
  }

  /** More than 20 rejected messages within a minute from one source. */
  onReject(deviceId: string | null, reason: RejectReason, nowMs = Date.now()) {
    const source = deviceId ?? 'unknown';
    const times = [...(this.floods.get(source) ?? []).filter((t) => nowMs - t < FLOOD_WINDOW_MS), nowMs];
    this.floods.set(source, times);
    if (times.length === FLOOD_PER_MIN + 1)
      this.raise(
        {
          type: 'SECURITY_FLOOD',
          severity: 'WARNING',
          source,
          title: 'Flood of rejected device messages',
          lines: [
            `Source: ${source}`,
            `More than ${FLOOD_PER_MIN} rejected messages in one minute (last: ${reason})`,
          ],
          data: { link: this.link(null) },
        },
        nowMs,
      );
  }

  /** Batch status changes (batch module hook). */
  onBatchStatus(b: BatchView, _from: BatchStatus, to: BatchStatus, nowMs = Date.now()) {
    const lines = [
      `Batch: ${b.name}, lot ${b.lot_number}`,
      ...(b.fridge_id
        ? [`Fridge: ${(this.sql.fridgeName.get(b.fridge_id) as string | undefined) ?? b.fridge_id}`]
        : []),
      `Heat budget left: ${b.remaining_pct} %`,
      `Expiry: ${b.expiry_date}`,
    ];
    const data = { link: `${this.ctx.config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/inventory/${b.id}` };
    if (to === 'AT_RISK')
      this.raise(
        {
          type: 'BATCH_AT_RISK',
          severity: 'WARNING',
          fridgeId: b.fridge_id,
          batchId: b.id,
          title: 'Batch at risk',
          lines,
          data,
        },
        nowMs,
      );
    if (to === 'DISCARD') {
      this.resolve('BATCH_AT_RISK', b.fridge_id, b.id, undefined, nowMs);
      const why = b.expired && b.remaining_pct > 0 ? 'expired' : 'heat budget exhausted';
      this.raise(
        {
          type: 'BATCH_DISCARD',
          severity: 'CRITICAL',
          fridgeId: b.fridge_id,
          batchId: b.id,
          title: `Batch must be discarded (${why})`,
          lines,
          data,
        },
        nowMs,
      );
    }
  }
}
