import { OFFLINE_AFTER_MS, type LiveState } from '../../mqtt/ingest';
import { notFound } from '../../shared/errors';
import type { AppContext } from '../../shared/http';
import { classify, type FridgeState } from '../../shared/status';

// Read side of fridges (P14): live state for the dashboard and history for the detail page. The live state is
// the ingestor's (server-classified), and falls back to the newest stored reading after a restart.

export const MAX_POINTS = 600;

interface FridgeRow {
  id: string;
  name: string;
  capacity: number;
  latch_state: number;
}

export type FridgeStatus = FridgeState | 'OFFLINE';

const READING_COLS =
  'seq, ts, temp, door, comp, power, batt, state, exp_s, latch, mode, late, seeded, received_at';

function liveOf(ctx: AppContext, fridgeId: string, nowMs: number): LiveState | null {
  const live = ctx.ingest.live.get(fridgeId);
  if (live) return { ...live, online: live.online && nowMs - live.last_seen <= OFFLINE_AFTER_MS };
  const r = ctx.db
    .prepare(
      `SELECT device_id, ${READING_COLS} FROM readings WHERE fridge_id = ? ORDER BY ts DESC, seq DESC LIMIT 1`,
    )
    .get(fridgeId) as
    | (Omit<LiveState, 'online' | 'last_seen' | 'buf' | 'rssi' | 'device_state'> & { received_at: number })
    | undefined;
  if (!r) return null;
  const lastEvent = (type: string) =>
    (ctx.db
      .prepare('SELECT ts FROM events WHERE fridge_id = ? AND type = ? ORDER BY ts DESC LIMIT 1')
      .pluck()
      .get(fridgeId, type) as number | undefined) ?? null;
  return {
    ...r,
    fridge_id: fridgeId,
    state: classify(r.temp, r.door === 1, r.power === 'BATTERY', r.temp === null),
    device_state: r.state,
    buf: 0,
    rssi: 0,
    online: nowMs - r.received_at <= OFFLINE_AFTER_MS,
    last_seen: r.received_at,
    door_open_at: r.door === 1 ? lastEvent('DOOR_OPEN') : null,
    battery_since: r.power === 'BATTERY' ? lastEvent('POWER_FAIL') : null,
    comp_off_at: r.comp === 0 ? lastEvent('COMP_OFF') : null,
  };
}

function view(ctx: AppContext, f: FridgeRow, nowMs: number) {
  const live = liveOf(ctx, f.id, nowMs);
  const counts = ctx.db
    .prepare(
      `SELECT b.status, COUNT(*) AS n FROM batches b JOIN batch_assignments a ON a.batch_id = b.id AND a.to_ts IS NULL
       WHERE a.fridge_id = ? AND b.deleted_at IS NULL GROUP BY b.status`,
    )
    .all(f.id) as { status: string; n: number }[];
  const batch_counts = { SAFE: 0, AT_RISK: 0, DISCARD: 0 } as Record<string, number>;
  for (const c of counts) batch_counts[c.status] = c.n;
  const device = ctx.db
    .prepare('SELECT device_id FROM devices WHERE fridge_id = ? AND active = 1 ORDER BY device_id LIMIT 1')
    .pluck()
    .get(f.id) as string | undefined;
  return {
    id: f.id,
    name: f.name,
    capacity: f.capacity,
    latch: f.latch_state === 1 || live?.latch === 1,
    device_id: device ?? null,
    load: batch_counts.SAFE + batch_counts.AT_RISK + batch_counts.DISCARD,
    batch_counts,
    // server-derived: the shared classify() on the latest reading, OFFLINE when the node is silent
    status: (live && live.online ? live.state : 'OFFLINE') as FridgeStatus,
    live,
  };
}

export type FridgeView = ReturnType<typeof view>;

export function listFridges(ctx: AppContext, nowMs = Date.now()) {
  const rows = ctx.db
    .prepare('SELECT id, name, capacity, latch_state FROM fridges ORDER BY id')
    .all() as FridgeRow[];
  return rows.map((f) => view(ctx, f, nowMs));
}

export function getFridge(ctx: AppContext, id: string, nowMs = Date.now()) {
  const f = ctx.db.prepare('SELECT id, name, capacity, latch_state FROM fridges WHERE id = ?').get(id) as
    FridgeRow | undefined;
  if (!f) throw notFound('Fridge not found');
  return view(ctx, f, nowMs);
}

export function recentEvents(ctx: AppContext, fridgeId: string, limit = 50) {
  return (
    ctx.db
      .prepare(
        'SELECT seq, ts, type, data, late, received_at FROM events WHERE fridge_id = ? ORDER BY ts DESC, seq DESC LIMIT ?',
      )
      .all(fridgeId, limit) as { data: string }[]
  ).map((e) => ({ ...e, data: JSON.parse(e.data) }));
}

export function recentReadings(ctx: AppContext, fridgeId: string, limit = 25) {
  return ctx.db
    .prepare(`SELECT ${READING_COLS} FROM readings WHERE fridge_id = ? ORDER BY ts DESC, seq DESC LIMIT ?`)
    .all(fridgeId, limit);
}

/**
 * History for the chart, downsampled on the server: readings averaged into buckets so a 24 h range is at most
 * MAX_POINTS points (17 280 raw readings at 5 s). Each bucket keeps min/max temperature and whether the door
 * was open, the compressor ran, the node was on battery, or any reading in it arrived late through sync.
 */
export function readingsHistory(
  ctx: AppContext,
  fridgeId: string,
  q: { from: number; to: number; bucket?: number },
) {
  getFridge(ctx, fridgeId);
  const span = Math.max(1, q.to - q.from);
  const bucket = Math.max(q.bucket ?? 5, Math.ceil(span / MAX_POINTS), 1);
  // CAST: better-sqlite3 binds JS numbers as REAL, which would turn ts / bucket into real division
  const points = ctx.db
    .prepare(
      `SELECT (ts / CAST(@b AS INTEGER)) * CAST(@b AS INTEGER) AS ts, ROUND(AVG(temp), 2) AS temp, MIN(temp) AS min, MAX(temp) AS max,
              MAX(door) AS door, MAX(comp) AS comp, MAX(power = 'BATTERY') AS battery, MAX(late) AS late,
              MAX(seeded) AS seeded,
              COUNT(*) AS n
       FROM readings WHERE fridge_id = @f AND ts >= @from AND ts <= @to
       GROUP BY ts / CAST(@b AS INTEGER) ORDER BY ts`,
    )
    .all({ b: bucket, f: fridgeId, from: q.from, to: q.to });
  const events = (
    ctx.db
      .prepare(
        'SELECT seq, ts, type, data, late FROM events WHERE fridge_id = ? AND ts >= ? AND ts <= ? ORDER BY ts, seq',
      )
      .all(fridgeId, q.from, q.to) as { data: string }[]
  ).map((e) => ({ ...e, data: JSON.parse(e.data) }));
  return { fridge_id: fridgeId, from: q.from, to: q.to, bucket, points, events };
}
