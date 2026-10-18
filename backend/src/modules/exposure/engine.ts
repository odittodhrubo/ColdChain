import type { StoredEvent, StoredReading } from '../../mqtt/ingest';
import {
  BUDGET_S,
  DOUBLE_ABOVE_C,
  GAP_CONSERVATIVE_S,
  SAFE_MAX_C,
  TELEMETRY_PERIOD_S,
} from '../../shared/constants';
import { conflict, HttpError, notFound } from '../../shared/errors';
import type { AppContext } from '../../shared/http';
import { logger } from '../../shared/logger';
import { getBatch, refreshStatus } from '../batches/service';

// Heat-exposure budget (P11, contract section 2). The source of truth is a recomputation: a batch's exposure is a
// pure function of `readings` and its `batch_assignments` intervals, so late (synced) data gives the same total
// as live data. The live path only adds the one new interval a fresh, newest reading closes. Stored as integer
// weighted milliseconds; it never decreases.

export const MAX_STEP_MS = 5 * TELEMETRY_PERIOD_S * 1000; // a reading counts for at most 5 telemetry periods
const GAP_MS = GAP_CONSERVATIVE_S * 1000;
export const SET_LATCH_AFTER_MS = 10_000; // device still unlatched this long after a discard -> SET_LATCH
const SET_LATCH_EVERY_MS = 30_000;
export const PENDING_GIVE_UP_MS = 5 * 60_000; // holes still open this long after the last progress: data is lost

/** Weighted rate per second: 1 for 8 < T <= 12, 2 above 12. Unknown temperature (sensor fault) = worst case. */
export const rate = (t: number | null) => (t === null ? 2 : t > DOUBLE_ABOVE_C ? 2 : t > SAFE_MAX_C ? 1 : 0);

/** Weighted seconds of (duration s, temperature) samples: what the shared exposure vectors specify. */
export const weightedSeconds = (samples: [number, number][]) =>
  samples.reduce((sum, [dt, t]) => sum + dt * rate(t), 0);

interface Point {
  ts: number; // reading time, unix s
  temp: number | null;
}
type Seq = Point & { seq: number; device_id: string };
interface Segment {
  start: number; // unix ms
  end: number;
  rate: number;
}
interface Interval {
  fridge_id: string;
  from_ts: number; // unix ms
  to_ts: number | null;
}

/**
 * The interval a reading stands for: from its time until the next reading, at most MAX_STEP_MS. Over a gap of
 * more than 15 s (lost data) it counts conservatively with the hotter of the two neighbouring readings.
 */
export function segment(cur: Point, next: Point): Segment {
  const start = cur.ts * 1000;
  const gap = (next.ts - cur.ts) * 1000;
  const temp =
    gap > GAP_MS
      ? cur.temp === null || next.temp === null
        ? null
        : Math.max(cur.temp, next.temp)
      : cur.temp;
  return { start, end: start + Math.min(gap, MAX_STEP_MS), rate: rate(temp) };
}

/** Weighted ms a segment adds inside one assignment interval [from, to): clipped, demo-scaled, integer. */
function contribution(s: Segment, a: Interval, scale: number): number {
  const ms = Math.min(s.end, a.to_ts ?? Infinity) - Math.max(s.start, a.from_ts);
  return ms > 0 && s.rate > 0 ? Math.round(ms * s.rate * scale) : 0;
}

type Waiter = {
  deviceId: string;
  cmdId: string;
  acked: boolean;
  reset: boolean;
  done: (ok: boolean) => void;
};

export interface HeatOptions {
  resetTimeoutMs: number; // per attempt: cmdack + LATCH_RESET event
  resetAttempts: number;
}

export class HeatEngine {
  private readonly waiters = new Set<Waiter>();
  private readonly lastSetLatch = new Map<string, number>();
  private readonly pending = new Map<string, number>(); // fridge -> since when a seq hole waits for data
  private readonly sql;

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: HeatOptions = { resetTimeoutMs: 15_000, resetAttempts: 3 },
  ) {
    const db = ctx.db;
    this.sql = {
      intervals: db.prepare(
        'SELECT fridge_id, from_ts, to_ts FROM batch_assignments WHERE batch_id = ? ORDER BY from_ts, id',
      ),
      readingsFrom: db.prepare(
        'SELECT ts, temp, seq, device_id FROM readings WHERE fridge_id = ? AND ts >= ? ORDER BY ts, seq',
      ),
      newer: db
        .prepare('SELECT 1 FROM readings WHERE fridge_id = ? AND (ts > ? OR (ts = ? AND seq > ?)) LIMIT 1')
        .pluck(),
      previous: db.prepare(
        `SELECT ts, temp, seq, device_id FROM readings WHERE fridge_id = ? AND (ts < ? OR (ts = ? AND seq < ?))
         ORDER BY ts DESC, seq DESC LIMIT 1`,
      ),
      // seqs strictly between two readings that the server holds (telemetry and events share one counter)
      present: db
        .prepare(
          `SELECT COUNT(*) FROM (SELECT seq FROM readings WHERE device_id = ? AND seq > ? AND seq < ?
           UNION SELECT seq FROM events WHERE device_id = ? AND seq > ? AND seq < ?)`,
        )
        .pluck(),
      status: db.prepare('SELECT status FROM batches WHERE id = ?').pluck(),
      overlapping: db.prepare(
        `SELECT a.batch_id, a.fridge_id, a.from_ts, a.to_ts FROM batch_assignments a
         JOIN batches b ON b.id = a.batch_id AND b.deleted_at IS NULL
         WHERE a.fridge_id = ? AND a.from_ts < ? AND (a.to_ts IS NULL OR a.to_ts > ?)`,
      ),
      fridgeBatches: db
        .prepare(
          `SELECT DISTINCT a.batch_id FROM batch_assignments a JOIN batches b ON b.id = a.batch_id
           WHERE a.fridge_id = ? AND b.deleted_at IS NULL`,
        )
        .pluck(),
      add: db.prepare('UPDATE batches SET exposure_ms = exposure_ms + ? WHERE id = ?'),
      raise: db.prepare('UPDATE batches SET exposure_ms = MAX(exposure_ms, ?) WHERE id = ?'), // never decreases
      exposure: db.prepare('SELECT exposure_ms FROM batches WHERE id = ?').pluck(),
      latch: db.prepare('UPDATE fridges SET latch_state = ? WHERE id = ?'),
      latchState: db.prepare('SELECT latch_state FROM fridges WHERE id = ?').pluck(),
      // budget-discarded batches in the fridge that no admin has acknowledged yet (they keep the red latch on)
      oldestDiscard: db
        .prepare(
          `SELECT MIN(b.discarded_at) FROM batches b
           JOIN batch_assignments a ON a.batch_id = b.id AND a.to_ts IS NULL
           WHERE a.fridge_id = ? AND b.deleted_at IS NULL AND b.acknowledged_at IS NULL
             AND b.discarded_at IS NOT NULL AND b.exposure_ms >= ?`,
        )
        .pluck(),
      unacked: db
        .prepare(
          `SELECT b.id FROM batches b JOIN batch_assignments a ON a.batch_id = b.id AND a.to_ts IS NULL
           WHERE a.fridge_id = ? AND b.deleted_at IS NULL AND b.status = 'DISCARD' AND b.acknowledged_at IS NULL`,
        )
        .pluck(),
      ack: db.prepare('UPDATE batches SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ?'),
      device: db
        .prepare(
          'SELECT device_id FROM devices WHERE fridge_id = ? AND active = 1 ORDER BY device_id LIMIT 1',
        )
        .pluck(),
    };
  }

  private get scale() {
    return this.ctx.config.DEMO_TIME_SCALE;
  }

  /**
   * Full recompute from readings and assignments; also the cumulative timeline (weighted s) for charts.
   * holes='skip' leaves out intervals over a device seq hole (data that may still arrive by sync); 'count'
   * integrates them with the contract's conservative gap rule (data given up on, or for display).
   */
  computeExposure(
    batchId: number,
    holes: 'skip' | 'count' = 'count',
  ): { exposureMs: number; points: { ts: number; weighted_s: number }[]; holes: boolean } {
    let total = 0;
    let skipped = false;
    const points: { ts: number; weighted_s: number }[] = [];
    for (const a of this.sql.intervals.all(batchId) as Interval[]) {
      const rows = this.sql.readingsFrom.all(
        a.fridge_id,
        Math.floor((a.from_ts - MAX_STEP_MS) / 1000),
      ) as Seq[];
      for (let i = 0; i + 1 < rows.length && rows[i].ts * 1000 < (a.to_ts ?? Infinity); i++) {
        const s = segment(rows[i], rows[i + 1]);
        const c = contribution(s, a, this.scale);
        if (c === 0) continue;
        if (holes === 'skip' && this.hole(rows[i], rows[i + 1])) {
          skipped = true;
          continue;
        }
        total += c;
        points.push({ ts: Math.min(s.end, a.to_ts ?? Infinity) / 1000, weighted_s: total / 1000 });
      }
    }
    return { exposureMs: total, points, holes: skipped };
  }

  /** Is data missing between two consecutive readings (a seq the server never received)? */
  private hole(a: Seq, b: Seq): boolean {
    const between = b.seq - a.seq - 1;
    if (a.device_id !== b.device_id || between < 0) return true;
    return (
      between > 0 && this.sql.present.get(b.device_id, a.seq, b.seq, b.device_id, a.seq, b.seq) !== between
    );
  }

  /** Ingest hook: readings were stored (live or synced). */
  onReadings(fridgeId: string, readings: StoredReading[], opts: { late: boolean }, nowMs = Date.now()) {
    if (opts.late || readings.length !== 1) this.recomputeFridge(fridgeId, nowMs);
    else this.applyLive(fridgeId, readings[0], nowMs);
    const last = readings.at(-1);
    if (last && !opts.late) this.checkDeviceLatch(fridgeId, last, nowMs);
  }

  /**
   * Fast path for an in-order reading: it closes the interval of the reading before it, which is added to every
   * batch whose assignment overlaps it. Only when nothing is missing between the two (no device seq hole): data
   * that may still arrive by sync is never estimated here. A hole marks the fridge pending; the recompute on
   * sync, or tick() once the data is given up on, counts it. So the stored total only ever grows towards the
   * full recompute and ends equal to it, whatever order the data arrives in.
   */
  applyLive(fridgeId: string, r: StoredReading, nowMs = Date.now()) {
    if (this.sql.newer.get(fridgeId, r.ts, r.ts, r.seq)) return this.recomputeFridge(fridgeId, nowMs);
    const prev = this.sql.previous.get(fridgeId, r.ts, r.ts, r.seq) as Seq | undefined;
    if (!prev) return;
    if (this.hole(prev, r)) {
      if (!this.pending.has(fridgeId)) this.pending.set(fridgeId, nowMs);
      return;
    }
    const s = segment(prev, r);
    const changed: number[] = [];
    this.ctx.db.transaction(() => {
      for (const a of this.sql.overlapping.all(fridgeId, s.end, s.start) as (Interval & {
        batch_id: number;
      })[]) {
        const c = contribution(s, a, this.scale);
        if (c > 0) {
          this.sql.add.run(c, a.batch_id);
          changed.push(a.batch_id);
        }
      }
    })();
    this.afterExposure(changed, nowMs);
  }

  /** Job: holes nobody filled for PENDING_GIVE_UP_MS (lost data, reboot seq jumps) are counted conservatively. */
  tick(nowMs = Date.now()) {
    for (const [fridgeId, since] of this.pending)
      if (nowMs - since >= PENDING_GIVE_UP_MS) this.recomputeFridge(fridgeId, nowMs, 'count');
  }

  /**
   * Recomputes every batch that was ever in the fridge (late data, out-of-order data). Holes are skipped until
   * given up on; while synced data keeps arriving the give-up timer restarts. Never lowers a stored total.
   */
  recomputeFridge(fridgeId: string, nowMs = Date.now(), holes: 'skip' | 'count' = 'skip') {
    const changed: number[] = [];
    let open = false;
    for (const id of this.sql.fridgeBatches.all(fridgeId) as number[]) {
      const before = this.sql.exposure.get(id) as number;
      const r = this.computeExposure(id, holes);
      open ||= r.holes;
      this.sql.raise.run(r.exposureMs, id);
      if (this.sql.exposure.get(id) !== before) changed.push(id);
    }
    if (open) this.pending.set(fridgeId, nowMs);
    else this.pending.delete(fridgeId);
    this.afterExposure(changed, nowMs);
  }

  /** Status transitions (each fires once: refreshStatus acts only on change) and the red latch on discard. */
  private afterExposure(batchIds: number[], nowMs: number) {
    for (const id of batchIds) {
      const before = this.sql.status.get(id) as string; // persisted: transitions are detected against it
      const after = refreshStatus(this.ctx, id, nowMs);
      const b = getBatch(this.ctx.db, id, nowMs);
      if (after === before) this.ctx.realtime.emit('batch:update', b); // exposure moved, status did not
      if (before !== 'DISCARD' && after === 'DISCARD' && b.remaining_pct <= 0 && b.fridge_id) {
        // Out of budget: the server latches the fridge too (the device latches itself at its own budget).
        this.sql.latch.run(1, b.fridge_id);
        this.ctx.realtime.emit('fridge:latch', { fridge_id: b.fridge_id, latch: true, batch_id: id });
        logger.warn(
          { batchId: id, fridgeId: b.fridge_id },
          'batch out of heat budget: DISCARD, fridge latched',
        );
      }
    }
  }

  /** A batch in this fridge was discarded > 10 s ago but the device still reports latch=0: send SET_LATCH. */
  private checkDeviceLatch(fridgeId: string, r: StoredReading, nowMs: number) {
    if (r.latch === 1 || this.sql.latchState.get(fridgeId) !== 1) return;
    const since = this.sql.oldestDiscard.get(fridgeId, BUDGET_S * 1000) as number | null;
    if (!since || nowMs - since <= SET_LATCH_AFTER_MS) return;
    if (nowMs - (this.lastSetLatch.get(fridgeId) ?? 0) < SET_LATCH_EVERY_MS) return;
    this.lastSetLatch.set(fridgeId, nowMs);
    this.ctx.ingest.sender.command(r.device_id, 'SET_LATCH');
  }

  // ---------------------------------------------------------------- admin reset

  onCommandAck(deviceId: string, ack: { cmd_id: string; ok: boolean }) {
    for (const w of this.waiters) {
      if (w.deviceId !== deviceId || w.cmdId !== ack.cmd_id) continue;
      if (!ack.ok) {
        w.done(false); // the device refused it: the next attempt sends a fresh command
        continue;
      }
      w.acked = true;
      if (w.reset) w.done(true);
    }
  }

  onDeviceEvent(_fridgeId: string, e: StoredEvent) {
    if (e.type !== 'LATCH_RESET') return;
    for (const w of this.waiters) {
      if (w.deviceId !== e.device_id) continue;
      w.reset = true;
      if (w.acked) w.done(true);
    }
  }

  private attempt(deviceId: string): Promise<{ ok: boolean; cmdId: string | null }> {
    return new Promise((resolve) => {
      const cmdId = this.ctx.ingest.sender.command(deviceId, 'RESET_LATCH');
      if (!cmdId) return resolve({ ok: false, cmdId: null });
      const w: Waiter = {
        deviceId,
        cmdId,
        acked: false,
        reset: false,
        done: (ok) => {
          clearTimeout(timer);
          this.waiters.delete(w);
          resolve({ ok, cmdId });
        },
      };
      const timer = setTimeout(() => w.done(false), this.opts.resetTimeoutMs);
      this.waiters.add(w);
    });
  }

  /**
   * Admin reset (POST /api/fridges/:id/reset-latch). Acknowledges every DISCARD batch in the fridge (they stay
   * DISCARD forever: the reset only records the disposal and turns the red LED off), then sends the signed
   * RESET_LATCH and waits for the device's cmdack and LATCH_RESET event, retrying with fresh commands.
   */
  async resetLatch(fridgeId: string, adminId: number, reason: string) {
    const { db, audit, ingest } = this.ctx;
    if (this.sql.latchState.get(fridgeId) === undefined) throw notFound('Fridge not found');
    const batchIds = this.sql.unacked.all(fridgeId) as number[];
    const latched = this.sql.latchState.get(fridgeId) === 1 || ingest.live.get(fridgeId)?.latch === 1;
    if (!latched && batchIds.length === 0) return { fridge_id: fridgeId, latch: false, changed: false };
    const deviceId = this.sql.device.get(fridgeId) as string | undefined;
    if (!deviceId) throw conflict('NO_DEVICE', 'No active device for this fridge');

    const now = Date.now();
    if (batchIds.length) {
      db.transaction(() => {
        for (const id of batchIds) this.sql.ack.run(adminId, now, id);
        audit.append(`user:${adminId}`, 'DISCARD_ACK', { fridge_id: fridgeId, batch_ids: batchIds, reason });
      })();
      for (const id of batchIds) this.ctx.realtime.emit('batch:update', getBatch(db, id));
    }

    for (let attempt = 1; attempt <= this.opts.resetAttempts; attempt++) {
      const { ok, cmdId } = await this.attempt(deviceId);
      if (!ok) continue;
      this.sql.latch.run(0, fridgeId);
      audit.append(`user:${adminId}`, 'LATCH_RESET', {
        fridge_id: fridgeId,
        device_id: deviceId,
        reason,
        cmd_id: cmdId,
        attempts: attempt,
      });
      this.ctx.realtime.emit('fridge:latch', { fridge_id: fridgeId, latch: false });
      return {
        fridge_id: fridgeId,
        latch: false,
        changed: true,
        acknowledged_batches: batchIds,
        attempts: attempt,
      };
    }
    throw new HttpError(
      504,
      'DEVICE_TIMEOUT',
      `The device did not confirm the reset after ${this.opts.resetAttempts} attempts; the latch stays on`,
    );
  }
}
