import { SAFE_MAX_C, SAFE_MIN_C } from '../../shared/constants';
import type { AppContext } from '../../shared/http';
import { logger } from '../../shared/logger';
import type { AlertMessage, Notifier } from '../alerts/notifier';

// Twice-daily temperature summary (P2): at the configured local hours it sends each fridge's min/max since the
// last summary to the alert channels, standing in for the manual morning/evening reading a pharmacy logs.

export class DailySummary {
  private last: number | null = null; // the hour-instant (ms) a summary was last sent for
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly ctx: AppContext,
    private readonly notifier: Notifier = ctx.alerts.notifier,
  ) {}

  /** Job (every few minutes): fire once when the clock reaches a configured hour. */
  tick(nowMs = Date.now()) {
    const hours = this.ctx.config.DAILY_SUMMARY_HOURS;
    if (hours.length === 0) return;
    const now = new Date(nowMs);
    if (!hours.includes(now.getHours())) return;
    const instant = new Date(nowMs);
    instant.setMinutes(0, 0, 0);
    const key = instant.getTime();
    if (this.last === key) return; // already summarised this hour
    const sinceMs = this.last ?? key - 12 * 3600_000; // first run of the process: the last 12 h
    this.last = key;
    this.send(Math.floor(sinceMs / 1000), Math.floor(nowMs / 1000));
  }

  private send(fromS: number, toS: number) {
    const fridges = this.ctx.db.prepare('SELECT id, name FROM fridges ORDER BY id').all() as {
      id: string;
      name: string;
    }[];
    if (fridges.length === 0) return;
    const stat = this.ctx.db.prepare(
      'SELECT MIN(temp) AS min, MAX(temp) AS max, COUNT(temp) AS n FROM readings WHERE fridge_id = ? AND ts >= ? AND ts <= ?',
    );
    const lines = fridges.map((f) => {
      const s = stat.get(f.id, fromS, toS) as { min: number | null; max: number | null; n: number };
      if (!s.n) return `${f.name} (${f.id}): no readings`;
      const breach = s.min! < SAFE_MIN_C || s.max! > SAFE_MAX_C ? ' — outside safe range' : '';
      return `${f.name} (${f.id}): min ${s.min!.toFixed(1)} °C, max ${s.max!.toFixed(1)} °C${breach}`;
    });
    const msg: AlertMessage = {
      title: 'Twice-daily temperature summary',
      lines: [`Since ${new Date(fromS * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`, ...lines],
      severity: 'INFO',
    };
    const p = this.notifier
      .send(msg)
      .catch((err: Error) => logger.error({ err: err.message }, 'daily summary send failed'))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Resolves once every summary in flight has been sent (shutdown, tests). */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
