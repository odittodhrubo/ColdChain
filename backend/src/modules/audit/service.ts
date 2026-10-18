import type { Db } from '../../db';
import { logger } from '../../shared/logger';
import { appendAudit, appendEntries, type AuditEntry, type AuditEventType, type AuditRow } from './chain';

export const REJECT_WINDOW_MS = 60_000;

interface RejectWindow {
  deviceId: string | null;
  reason: string;
  count: number;
  firstTs: number;
  lastTs: number;
  sample?: Record<string, unknown>;
}

/**
 * Audit log service: synchronous append for normal callers, a bounded async queue for high-rate ones, and
 * SECURITY_REJECT coalescing (one entry per device + reason per minute, with a count) so a flood of forged
 * messages cannot bloat the chain.
 */
export class AuditLog {
  private queue: AuditEntry[] = [];
  private scheduled = false;
  private rejects = new Map<string, RejectWindow>();
  dropped = 0;

  constructor(
    private readonly db: Db,
    private readonly maxQueue = 1000,
  ) {}

  append(actor: string, type: AuditEventType, payload: unknown): AuditRow {
    return appendAudit(this.db, actor, type, payload);
  }

  /** Non-blocking: written in one transaction on the next tick. Returns false (and counts) when the queue is full. */
  enqueue(actor: string, type: AuditEventType, payload: unknown): boolean {
    if (this.queue.length >= this.maxQueue) {
      this.dropped += 1;
      if (this.dropped === 1 || this.dropped % 1000 === 0)
        logger.warn({ dropped: this.dropped }, 'audit queue full');
      return false;
    }
    this.queue.push({ actor, type, payload, ts: Date.now() });
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this.flush());
    }
    return true;
  }

  flush(): number {
    this.scheduled = false;
    if (this.queue.length === 0) return 0;
    const batch = this.queue;
    this.queue = [];
    appendEntries(this.db, batch);
    return batch.length;
  }

  /** Count a rejected device message; written as one coalesced SECURITY_REJECT per device + reason per minute. */
  securityReject(
    deviceId: string | null,
    reason: string,
    sample?: Record<string, unknown>,
    now = Date.now(),
  ) {
    const key = `${deviceId ?? '-'}|${reason}`;
    const w = this.rejects.get(key);
    if (w && now - w.firstTs < REJECT_WINDOW_MS) {
      w.count += 1;
      w.lastTs = now;
      return;
    }
    if (w) this.writeReject(key, w);
    this.rejects.set(key, { deviceId, reason, count: 1, firstTs: now, lastTs: now, sample });
  }

  /** Writes windows that are a minute old (all of them with force, e.g. at shutdown). */
  flushRejects(now = Date.now(), force = false): number {
    let n = 0;
    for (const [key, w] of this.rejects) {
      if (force || now - w.firstTs >= REJECT_WINDOW_MS) {
        this.writeReject(key, w);
        n += 1;
      }
    }
    return n;
  }

  private writeReject(key: string, w: RejectWindow) {
    this.rejects.delete(key);
    this.enqueue(w.deviceId ? `device:${w.deviceId}` : 'system', 'SECURITY_REJECT', {
      device_id: w.deviceId,
      reason: w.reason,
      count: w.count,
      first_ts: w.firstTs,
      last_ts: w.lastTs,
      ...(w.sample ? { sample: w.sample } : {}),
    });
  }
}
