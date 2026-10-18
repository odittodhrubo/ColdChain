import { randomBytes } from 'node:crypto';
import type { Db } from '../../db';
import { badRequest, conflict, HttpError, notFound } from '../../shared/errors';
import type { AppContext } from '../../shared/http';
import { BUDGET_S } from '../../shared/constants';
import { deriveBatchStatus, remainingPct, utcToday, type BatchStatus } from '../../shared/status';

// Vaccine batch inventory (P10). A batch lives in one fridge at a time (one open batch_assignments interval);
// moving it closes that interval and opens the next in one transaction, so exposure (P11) is attributed to
// exactly one fridge for every moment. Status is always derived with deriveBatchStatus().

interface BatchRow {
  id: number;
  public_token: string;
  name: string;
  manufacturer: string;
  lot_number: string;
  quantity: number;
  expiry_date: string;
  criticality: number;
  status: BatchStatus; // last persisted status: transitions are detected against it
  exposure_ms: number; // weighted milliseconds (P11)
  discarded_at: number | null;
  acknowledged_by: number | null;
  acknowledged_at: number | null;
  created_by: number | null;
  created_at: number;
  updated_at: number;
  fridge_id: string | null; // current fridge (open assignment)
}

export type BatchView = ReturnType<typeof view>;

export interface BatchInput {
  name: string;
  manufacturer: string;
  lot_number: string;
  quantity: number;
  expiry_date: string;
  criticality: number;
  fridge_id: string;
}

const SELECT = `SELECT b.*, a.fridge_id FROM batches b
  LEFT JOIN batch_assignments a ON a.batch_id = b.id AND a.to_ts IS NULL`;

/** Public QR token: 12 URL-safe chars = 72 random bits, never sequential (no inventory enumeration). */
export const newPublicToken = () => randomBytes(9).toString('base64url');

function view(row: BatchRow, nowMs = Date.now()) {
  const weighted = row.exposure_ms / 1000;
  const remaining = remainingPct(weighted);
  const today = utcToday(nowMs);
  return {
    id: row.id,
    public_token: row.public_token,
    name: row.name,
    manufacturer: row.manufacturer,
    lot_number: row.lot_number,
    quantity: row.quantity,
    expiry_date: row.expiry_date,
    criticality: row.criticality,
    fridge_id: row.fridge_id,
    status: deriveBatchStatus(remaining, row.expiry_date, row.discarded_at !== null, today),
    expired: row.expiry_date < today,
    weighted_exposure_s: weighted,
    remaining_pct: Math.round(remaining * 100) / 100,
    used_minutes: Math.round((Math.min(weighted, BUDGET_S) / 60) * 10) / 10,
    discarded_at: row.discarded_at,
    acknowledged_by: row.acknowledged_by,
    acknowledged_at: row.acknowledged_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function row(db: Db, id: number): BatchRow {
  const r = db.prepare(`${SELECT} WHERE b.id = ? AND b.deleted_at IS NULL`).get(id) as BatchRow | undefined;
  if (!r) throw notFound('Batch not found');
  return r;
}

export const getBatch = (db: Db, id: number, nowMs = Date.now()) => view(row(db, id), nowMs);

export function getBatchByToken(db: Db, token: string): BatchView | null {
  const r = db.prepare(`${SELECT} WHERE b.public_token = ? AND b.deleted_at IS NULL`).get(token) as
    BatchRow | undefined;
  return r ? view(r) : null;
}

export function listBatches(
  db: Db,
  f: { fridge_id?: string; status?: BatchStatus; expiring_within_days?: number; q?: string },
  nowMs = Date.now(),
): BatchView[] {
  const where = ['b.deleted_at IS NULL'];
  const args: (string | number)[] = [];
  if (f.fridge_id) {
    where.push('a.fridge_id = ?');
    args.push(f.fridge_id);
  }
  if (f.expiring_within_days !== undefined) {
    where.push('b.expiry_date <= ?');
    args.push(utcToday(nowMs + f.expiring_within_days * 86_400_000));
  }
  if (f.q) {
    where.push(
      "(b.name LIKE ? ESCAPE '\\' OR b.lot_number LIKE ? ESCAPE '\\' OR b.manufacturer LIKE ? ESCAPE '\\')",
    );
    const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    args.push(like, like, like);
  }
  const rows = db
    .prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY b.expiry_date, b.id`)
    .all(...args) as BatchRow[];
  // Status is derived (expiry moves with the calendar), so it is filtered after deriving it.
  return rows.map((r) => view(r, nowMs)).filter((b) => !f.status || b.status === f.status);
}

/** Batches currently in the fridge. Capacity counts batches (Part 3.6: capacity 20 per fridge). */
function load(db: Db, fridgeId: string): number {
  return db
    .prepare(
      `SELECT COUNT(*) FROM batch_assignments a JOIN batches b ON b.id = a.batch_id
       WHERE a.fridge_id = ? AND a.to_ts IS NULL AND b.deleted_at IS NULL`,
    )
    .pluck()
    .get(fridgeId) as number;
}

function checkRoom(db: Db, fridgeId: string) {
  const fridge = db.prepare('SELECT capacity FROM fridges WHERE id = ?').get(fridgeId) as
    { capacity: number } | undefined;
  if (!fridge) throw new HttpError(404, 'FRIDGE_NOT_FOUND', 'Fridge not found');
  if (load(db, fridgeId) >= fridge.capacity)
    throw conflict('FRIDGE_FULL', `Fridge ${fridgeId} is full (${fridge.capacity} batches)`);
}

const futureDate = (date: string, nowMs: number) => {
  if (date <= utcToday(nowMs)) throw badRequest('expiry_date must be in the future');
};

const actorOf = (userId?: number) => (userId ? `user:${userId}` : 'system');

export function assignmentHistory(db: Db, batchId: number) {
  return db
    .prepare(
      `SELECT a.fridge_id, f.name AS fridge_name, a.from_ts, a.to_ts FROM batch_assignments a
       JOIN fridges f ON f.id = a.fridge_id WHERE a.batch_id = ? ORDER BY a.from_ts, a.id`,
    )
    .all(batchId) as { fridge_id: string; fridge_name: string; from_ts: number; to_ts: number | null }[];
}

export function createBatch(ctx: AppContext, input: BatchInput, userId?: number, nowMs = Date.now()) {
  const { db } = ctx;
  futureDate(input.expiry_date, nowMs);
  const id = db.transaction(() => {
    checkRoom(db, input.fridge_id);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO batches (public_token, name, manufacturer, lot_number, quantity, expiry_date, criticality,
           created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newPublicToken(),
        input.name,
        input.manufacturer,
        input.lot_number,
        input.quantity,
        input.expiry_date,
        input.criticality,
        userId ?? null,
        nowMs,
        nowMs,
      );
    const batchId = Number(lastInsertRowid);
    db.prepare('INSERT INTO batch_assignments (batch_id, fridge_id, from_ts) VALUES (?, ?, ?)').run(
      batchId,
      input.fridge_id,
      nowMs,
    );
    ctx.audit.append(actorOf(userId), 'BATCH_CREATED', {
      batch_id: batchId,
      name: input.name,
      lot_number: input.lot_number,
      quantity: input.quantity,
      expiry_date: input.expiry_date,
      fridge_id: input.fridge_id,
    });
    return batchId;
  })();
  refreshStatus(ctx, id, nowMs);
  return emit(ctx, getBatch(db, id, nowMs));
}

export function updateBatch(
  ctx: AppContext,
  id: number,
  changes: Partial<Pick<BatchInput, 'name' | 'quantity' | 'criticality' | 'expiry_date'>>,
  userId?: number,
  nowMs = Date.now(),
) {
  const { db } = ctx;
  row(db, id);
  if (changes.expiry_date !== undefined) futureDate(changes.expiry_date, nowMs);
  const fields = Object.keys(changes).sort() as (keyof typeof changes)[];
  db.transaction(() => {
    db.prepare(
      `UPDATE batches SET ${fields.map((f) => `${f} = @${f}`).join(', ')}, updated_at = @now WHERE id = @id`,
    ).run({ ...changes, now: nowMs, id });
    ctx.audit.append(actorOf(userId), 'BATCH_UPDATED', { batch_id: id, ...changes });
  })();
  refreshStatus(ctx, id, nowMs);
  return emit(ctx, getBatch(db, id, nowMs));
}

/**
 * Moves a batch: closes the open interval and opens the next one at the same instant, in one transaction with
 * the audit entry, so a failure anywhere leaves the batch where it was. A DISCARD batch cannot move (409). The
 * batch keeps its used exposure: exposure belongs to the batch, not the fridge.
 */
export function moveBatch(
  ctx: AppContext,
  id: number,
  toFridgeId: string,
  userId?: number,
  nowMs = Date.now(),
) {
  ctx.db.transaction(() => moveInTransaction(ctx, id, toFridgeId, userId, nowMs))();
  return emit(ctx, getBatch(ctx.db, id, nowMs));
}

/**
 * The move itself, for a caller that already holds a transaction (a confirmed relocation plan moves several
 * batches atomically). `extra` goes into the BATCH_MOVED audit payload (plan id, AI rationale). The caller
 * emits the socket updates after its commit.
 */
export function moveInTransaction(
  ctx: AppContext,
  id: number,
  toFridgeId: string,
  userId?: number,
  nowMs = Date.now(),
  extra: Record<string, unknown> = {},
) {
  const { db } = ctx;
  const b = view(row(db, id), nowMs);
  if (b.status === 'DISCARD') throw conflict('BATCH_DISCARDED', 'A discarded batch cannot be moved');
  if (b.fridge_id === toFridgeId) throw conflict('SAME_FRIDGE', `Batch is already in ${toFridgeId}`);
  checkRoom(db, toFridgeId);
  db.prepare('UPDATE batch_assignments SET to_ts = ? WHERE batch_id = ? AND to_ts IS NULL').run(nowMs, id);
  db.prepare('INSERT INTO batch_assignments (batch_id, fridge_id, from_ts) VALUES (?, ?, ?)').run(
    id,
    toFridgeId,
    nowMs,
  );
  db.prepare('UPDATE batches SET updated_at = ? WHERE id = ?').run(nowMs, id);
  ctx.audit.append(actorOf(userId), 'BATCH_MOVED', {
    batch_id: id,
    from: b.fridge_id,
    to: toFridgeId,
    ...extra,
  });
  return b.fridge_id;
}

/** Soft delete, Admin only, once the batch is used up (quantity 0). It leaves its fridge; history stays. */
export function deleteBatch(ctx: AppContext, id: number, userId?: number, nowMs = Date.now()) {
  const { db } = ctx;
  const b = row(db, id);
  if (b.quantity !== 0) throw conflict('QUANTITY_NOT_ZERO', 'Only a batch with quantity 0 can be deleted');
  db.transaction(() => {
    db.prepare('UPDATE batch_assignments SET to_ts = ? WHERE batch_id = ? AND to_ts IS NULL').run(nowMs, id);
    db.prepare('UPDATE batches SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowMs, nowMs, id);
    ctx.audit.append(actorOf(userId), 'BATCH_UPDATED', { batch_id: id, deleted: true });
  })();
  ctx.realtime.emit('batch:update', { id, deleted: true });
  return { id, deleted: true };
}

/**
 * Persists a status change (or nothing). Every change: audit BATCH_STATUS_CHANGED, socket batch:update, alert
 * hook. Reaching DISCARD records discarded_at, which makes it permanent: no later edit can revive the batch.
 */
export function refreshStatus(ctx: AppContext, id: number, nowMs = Date.now()): BatchStatus {
  const { db } = ctx;
  const r = row(db, id);
  const b = view(r, nowMs);
  if (b.status === r.status) return b.status;
  db.transaction(() => {
    db.prepare(
      'UPDATE batches SET status = ?, discarded_at = COALESCE(discarded_at, ?), updated_at = ? WHERE id = ?',
    ).run(b.status, b.status === 'DISCARD' ? nowMs : null, nowMs, id);
    ctx.audit.append('system', 'BATCH_STATUS_CHANGED', {
      batch_id: id,
      from: r.status,
      to: b.status,
      remaining_pct: b.remaining_pct,
      expired: b.expired,
    });
  })();
  const fresh = getBatch(db, id, nowMs);
  emit(ctx, fresh);
  ctx.hooks.batchStatusChanged?.(fresh, r.status, b.status);
  return b.status;
}

/** Expiry moves with the calendar: re-derive every batch (background job, and at start). */
export function refreshAllStatuses(ctx: AppContext, nowMs = Date.now()): number {
  const ids = ctx.db.prepare('SELECT id FROM batches WHERE deleted_at IS NULL').pluck().all() as number[];
  return ids.filter((id) => {
    const before = ctx.db.prepare('SELECT status FROM batches WHERE id = ?').pluck().get(id);
    return refreshStatus(ctx, id, nowMs) !== before;
  }).length;
}

export function emit(ctx: AppContext, b: BatchView): BatchView {
  ctx.realtime.emit('batch:update', b);
  return b;
}
