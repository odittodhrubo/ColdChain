// Readings rollup and retention (R8). 5 s readings are 17 280 rows per fridge per day; hourly rollups keep the
// record (min / max / average, excursions, door, compressor, battery) and raw rows older than
// READINGS_RETENTION_DAYS are deleted. The audit chain stays verifiable: rows go one telemetry-checkpoint block
// at a time, each deletion is a READINGS_RETIRED entry quoting that block's checkpoint hash, and verifyChain
// accepts a missing block only when such an entry exists. Exposure totals never shrink (stored, MAX-only).
import { appendAudit } from '../audit/chain';
import type { AppContext } from '../../shared/http';
import { logger } from '../../shared/logger';

const HOUR = 3600;
const REAGGREGATE_S = 48 * HOUR; // late (synced) readings for recent hours are folded in on the next run
const RETIRE_BATCH = 200; // checkpoint blocks per fridge per run: bounded work, the job runs hourly

/** Aggregates every finished hour from (last rolled hour - 48 h) up to the current hour. Returns hours written. */
export function rollupReadings(ctx: AppContext, nowS = Math.floor(Date.now() / 1000)): number {
  const { db } = ctx;
  const until = Math.floor(nowS / HOUR) * HOUR; // the current hour is not finished
  let written = 0;
  for (const fridgeId of db.prepare('SELECT id FROM fridges').pluck().all() as string[]) {
    const last = db
      .prepare('SELECT MAX(hour) FROM readings_hourly WHERE fridge_id = ?')
      .pluck()
      .get(fridgeId) as number | null;
    const first =
      last === null
        ? (db.prepare('SELECT MIN(ts) FROM readings WHERE fridge_id = ?').pluck().get(fridgeId) as
            number | null)
        : last - REAGGREGATE_S;
    if (first === null) continue;
    written += db
      .prepare(
        `INSERT INTO readings_hourly (fridge_id, hour, n, n_temp, t_min, t_max, t_avg, n_above_8, n_door_open,
                                      n_comp_on, n_battery, n_seeded)
         SELECT fridge_id, (ts / ${HOUR}) * ${HOUR}, COUNT(*), COUNT(temp), MIN(temp), MAX(temp),
                ROUND(AVG(temp), 3), COALESCE(SUM(temp > 8), 0), SUM(door), SUM(comp), SUM(power = 'BATTERY'),
                SUM(seeded)
         FROM readings WHERE fridge_id = ? AND ts >= ? AND ts < ?
         GROUP BY ts / ${HOUR}
         ON CONFLICT (fridge_id, hour) DO UPDATE SET
           n = excluded.n, n_temp = excluded.n_temp, t_min = excluded.t_min, t_max = excluded.t_max,
           t_avg = excluded.t_avg,
           n_above_8 = excluded.n_above_8, n_door_open = excluded.n_door_open, n_comp_on = excluded.n_comp_on,
           n_battery = excluded.n_battery, n_seeded = excluded.n_seeded`,
      )
      .run(fridgeId, Math.floor(first / HOUR) * HOUR, until).changes;
  }
  return written;
}

interface Checkpoint {
  fridge_id: string;
  from_id: number;
  to_id: number;
  sha256: string;
  count: number;
}

/**
 * Deletes whole checkpoint blocks whose newest reading is older than the retention cutoff and whose hours are
 * rolled up, each with a READINGS_RETIRED audit entry in the same transaction. Returns readings deleted.
 */
export function retireReadings(ctx: AppContext, nowS = Math.floor(Date.now() / 1000)): number {
  const { db } = ctx;
  const cutoff = nowS - ctx.config.READINGS_RETENTION_DAYS * 86_400;
  ctx.audit.flush(); // queued entries first: the chain stays in time order
  let deleted = 0;
  for (const fridgeId of db.prepare('SELECT id FROM fridges').pluck().all() as string[]) {
    const lastRetired =
      (db.prepare('SELECT MAX(to_id) FROM readings_retired WHERE fridge_id = ?').pluck().get(fridgeId) as
        number | null) ?? 0;
    // hours up to here are rolled up (the newest rolled hour is complete)
    const rolledUntil =
      ((db.prepare('SELECT MAX(hour) FROM readings_hourly WHERE fridge_id = ?').pluck().get(fridgeId) as
        number | null) ?? -HOUR) + HOUR;
    const blocks = (
      db
        .prepare(
          `SELECT payload FROM audit_log WHERE event_type = 'TELEMETRY_CHECKPOINT'
             AND json_valid(payload) -- a tampered checkpoint is never retired: Verify keeps flagging it
             AND json_extract(payload, '$.fridge_id') = ? AND json_extract(payload, '$.from_id') > ?
           ORDER BY id LIMIT ?`,
        )
        .pluck()
        .all(fridgeId, lastRetired, RETIRE_BATCH) as string[]
    ).map((p) => JSON.parse(p) as Checkpoint);
    for (const b of blocks) {
      const newest = db
        .prepare('SELECT MAX(ts) FROM readings WHERE fridge_id = ? AND id BETWEEN ? AND ?')
        .pluck()
        .get(fridgeId, b.from_id, b.to_id) as number | null;
      if (newest === null) continue; // nothing left (an earlier partial run); keep looking
      if (newest >= cutoff || newest >= rolledUntil) break; // blocks are in id order: the rest are newer
      db.transaction(() => {
        const n = db
          .prepare('DELETE FROM readings WHERE fridge_id = ? AND id BETWEEN ? AND ?')
          .run(fridgeId, b.from_id, b.to_id).changes;
        appendAudit(db, 'system', 'READINGS_RETIRED', {
          fridge_id: fridgeId,
          from_id: b.from_id,
          to_id: b.to_id,
          sha256: b.sha256,
          count: n,
          newest_ts: newest,
          reason: `retention ${ctx.config.READINGS_RETENTION_DAYS} days`,
        });
        db.prepare(
          'INSERT INTO readings_retired (fridge_id, from_id, to_id, retired_at) VALUES (?, ?, ?, ?)',
        ).run(fridgeId, b.from_id, b.to_id, nowS * 1000);
        deleted += n;
      })();
    }
  }
  if (deleted) logger.info({ deleted, cutoff }, 'readings retired (rolled up, audited)');
  return deleted;
}
