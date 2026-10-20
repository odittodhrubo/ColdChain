import { createHash } from 'node:crypto';
import type { Db } from '../../db';
import { canonicalJson } from './canonical';

// Tamper-evident audit chain (P08).
//   hash = SHA256(prev_hash | id | ts | actor | event_type | payload)   payload = canonical JSON text
// Genesis prev_hash = 64 zeros. Every row commits to the previous one, so an edit, deletion, insertion or
// reordering anywhere breaks verification at that record. This proves integrity, not who wrote a row:
// anyone with full write access could recompute the whole chain, which the external anchors catch.

export const GENESIS = '0'.repeat(64);

export const AUDIT_EVENTS = [
  'AUTH_LOGIN', 'AUTH_FAIL', 'USER_CREATED', 'USER_UPDATED', 'USER_DISABLED',
  'BATCH_CREATED', 'BATCH_UPDATED', 'BATCH_MOVED', 'BATCH_STATUS_CHANGED',
  'LATCH_RESET', 'DISCARD_ACK', 'ALERT_RAISED', 'ALERT_ACKED', 'ALERT_RESOLVED', 'ALERT_ESCALATED', 'SECURITY_REJECT',
  'RELOCATION_PROPOSED', 'RELOCATION_CONFIRMED', 'RELOCATION_DISMISSED',
  'DEVICE_EVENT', 'BREACH_START', 'BREACH_END', 'TELEMETRY_CHECKPOINT', 'AUDIT_VERIFY', 'READINGS_RETIRED',
  'DEVICE_SECRET_ROTATED',
  'DISPLAY_TOKEN_CREATED', 'DISPLAY_TOKEN_REVOKED', 'REPORT_EXPORTED', 'DEVICE_CALIBRATED',
] as const; // prettier-ignore
export type AuditEventType = (typeof AUDIT_EVENTS)[number];

export interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  event_type: string;
  payload: string;
  prev_hash: string;
  hash: string;
}

export interface AuditEntry {
  actor: string; // "user:<id>", "device:<id>" or "system"
  type: AuditEventType;
  payload: unknown;
  ts?: number; // unix ms, default now
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export function rowHash(
  prevHash: string,
  id: number,
  ts: number,
  actor: string,
  type: string,
  payload: string,
): string {
  return sha256(`${prevHash}|${id}|${ts}|${actor}|${type}|${payload}`);
}

/**
 * Appends entries in one IMMEDIATE transaction: it takes the write lock before reading the head, so two writers
 * (even in different processes) can never both extend the same head and fork the chain.
 */
export function appendEntries(db: Db, entries: AuditEntry[]): AuditRow[] {
  const head = db.prepare('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1');
  const insert = db.prepare(
    'INSERT INTO audit_log (id, ts, actor, event_type, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  return db
    .transaction(() => {
      const last = head.get() as { id: number; hash: string } | undefined;
      let id = last?.id ?? 0;
      let prev = last?.hash ?? GENESIS;
      return entries.map((e) => {
        id += 1;
        const ts = e.ts ?? Date.now();
        const payload = canonicalJson(e.payload ?? {});
        const prevHash = prev;
        const hash = rowHash(prevHash, id, ts, e.actor, e.type, payload);
        insert.run(id, ts, e.actor, e.type, payload, prevHash, hash);
        prev = hash;
        return { id, ts, actor: e.actor, event_type: e.type, payload, prev_hash: prevHash, hash };
      });
    })
    .immediate();
}

export function appendAudit(
  db: Db,
  actor: string,
  type: AuditEventType,
  payload: unknown,
  ts?: number,
): AuditRow {
  return appendEntries(db, [{ actor, type, payload, ts }])[0];
}

export type VerifyReason =
  | 'HASH_MISMATCH'
  | 'PREV_LINK_BROKEN'
  | 'ID_GAP'
  | 'GENESIS_INVALID'
  | 'ANCHOR_MISMATCH'
  | 'READINGS_TAMPERED';

export interface VerifyResult {
  valid: boolean;
  checked: number;
  headId: number;
  headHash: string;
  checkpoints: number;
  retired?: number; // checkpoint blocks whose readings were deleted by retention (READINGS_RETIRED), not checked
  anchors: number;
  // S8: the newest anchor that a Time-Stamp Authority also signed (its reply is kept in audit_anchor.tsa_reply)
  externalAnchor?: { headId: number; at: number; url: string } | null;
  firstBrokenId?: number;
  reason?: VerifyReason;
  expected?: string | number;
  actual?: string | number | null;
}

const yieldToLoop = () => new Promise((r) => setImmediate(r));

/**
 * Recomputes the chain from `fromId` (default 1: genesis) in chunks, yielding to the event loop between chunks so
 * the API stays responsive. Then checks every anchor and every TELEMETRY_CHECKPOINT against the current readings.
 */
export async function verifyChain(
  db: Db,
  opts: { fromId?: number; chunk?: number; onProgress?: (checked: number, total: number) => void } = {},
): Promise<VerifyResult> {
  const fromId = Math.max(1, opts.fromId ?? 1);
  const chunk = opts.chunk ?? 5000;
  const total = db.prepare('SELECT COUNT(*) FROM audit_log WHERE id >= ?').pluck().get(fromId) as number;
  const page = db.prepare('SELECT * FROM audit_log WHERE id >= ? ORDER BY id LIMIT ?');
  let prevHash = GENESIS;
  let expectedId = fromId;
  if (fromId > 1) {
    const before = db
      .prepare('SELECT hash FROM audit_log WHERE id = ?')
      .pluck()
      .get(fromId - 1) as string | undefined;
    if (before === undefined) return broken(0, fromId - 1, GENESIS, 'ID_GAP', fromId - 1, null);
    prevHash = before; // partial verification trusts the row before `from`
  }
  let checked = 0;
  let headHash = prevHash;
  let headId = fromId - 1;
  const checkpointRows: AuditRow[] = [];
  // Ranges retention deleted on purpose, as recorded *in the chain* (a row in readings_retired alone proves
  // nothing): fridge:from:to:sha256 of the checkpoint each one retired.
  const retiredRanges = new Set<string>();
  const rangeKey = (p: { fridge_id: string; from_id: number; to_id: number; sha256: string }) =>
    `${p.fridge_id}:${p.from_id}:${p.to_id}:${p.sha256}`;

  for (let cursor = fromId; ;) {
    const rows = page.all(cursor, chunk) as AuditRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.id !== expectedId) return broken(checked, row.id, headHash, 'ID_GAP', expectedId, row.id);
      if (row.id === 1 && row.prev_hash !== GENESIS)
        return broken(checked, 1, headHash, 'GENESIS_INVALID', GENESIS, row.prev_hash);
      if (row.prev_hash !== prevHash)
        return broken(checked, row.id, headHash, 'PREV_LINK_BROKEN', prevHash, row.prev_hash);
      const recomputed = rowHash(row.prev_hash, row.id, row.ts, row.actor, row.event_type, row.payload);
      if (recomputed !== row.hash)
        return broken(checked, row.id, headHash, 'HASH_MISMATCH', recomputed, row.hash);
      if (row.event_type === 'TELEMETRY_CHECKPOINT') checkpointRows.push(row);
      if (row.event_type === 'READINGS_RETIRED') retiredRanges.add(rangeKey(JSON.parse(row.payload)));
      prevHash = headHash = row.hash;
      headId = row.id;
      expectedId += 1;
      checked += 1;
    }
    cursor = rows[rows.length - 1].id + 1;
    opts.onProgress?.(checked, total);
    await yieldToLoop();
  }

  // Anchors: a deleted tail or a fully recomputed chain no longer matches a head that was recorded off-box.
  const anchors = db.prepare('SELECT head_id, head_hash FROM audit_anchor ORDER BY id').all() as {
    head_id: number;
    head_hash: string;
  }[];
  const hashAt = db.prepare('SELECT hash FROM audit_log WHERE id = ?').pluck();
  for (const a of anchors) {
    if (a.head_id < fromId) continue;
    const actual = (hashAt.get(a.head_id) as string | undefined) ?? null;
    if (actual !== a.head_hash)
      return broken(checked, a.head_id, headHash, 'ANCHOR_MISMATCH', a.head_hash, actual, headId);
  }

  let retired = 0;
  for (const row of checkpointRows) {
    const p = JSON.parse(row.payload) as {
      fridge_id: string;
      from_id: number;
      to_id: number;
      sha256: string;
    };
    const actual = readingsDigest(db, p.fridge_id, p.from_id, p.to_id);
    if (actual === p.sha256) continue;
    // Gone on purpose: retention deleted the whole block and said so in the chain, quoting this very hash.
    const none = db
      .prepare('SELECT COUNT(*) FROM readings WHERE fridge_id = ? AND id BETWEEN ? AND ?')
      .pluck()
      .get(p.fridge_id, p.from_id, p.to_id);
    if (none === 0 && retiredRanges.has(rangeKey(p))) {
      retired += 1;
      continue;
    }
    return broken(checked, row.id, headHash, 'READINGS_TAMPERED', p.sha256, actual, headId);
  }

  const tsa = db
    .prepare(
      'SELECT head_id, tsa_at, tsa_url FROM audit_anchor WHERE tsa_reply IS NOT NULL ORDER BY id DESC LIMIT 1',
    )
    .get() as { head_id: number; tsa_at: number; tsa_url: string } | undefined;
  return {
    valid: true,
    checked,
    headId,
    headHash,
    checkpoints: checkpointRows.length,
    retired,
    anchors: anchors.length,
    externalAnchor: tsa ? { headId: tsa.head_id, at: tsa.tsa_at, url: tsa.tsa_url } : null,
  };

  function broken(
    n: number,
    id: number,
    head: string,
    reason: VerifyReason,
    expected: string | number,
    actual: string | number | null,
    hid = id - 1,
  ): VerifyResult {
    return {
      valid: false,
      checked: n,
      headId: hid,
      headHash: head,
      checkpoints: checkpointRows.length,
      anchors: 0,
      firstBrokenId: id,
      reason,
      expected,
      actual,
    };
  }
}

// ---------------------------------------------------------------- anchors

export function writeAnchor(db: Db, ts = Date.now()) {
  const head = db.prepare('SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as
    { id: number; hash: string } | undefined;
  const count = db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get() as number;
  const anchor = { ts, head_id: head?.id ?? 0, head_hash: head?.hash ?? GENESIS, count };
  db.prepare('INSERT INTO audit_anchor (ts, head_id, head_hash, count) VALUES (?, ?, ?, ?)').run(
    ts,
    anchor.head_id,
    anchor.head_hash,
    count,
  );
  return anchor;
}

// ---------------------------------------------------------------- telemetry checkpoints

export const CHECKPOINT_EVERY = 100;

/** SHA-256 over the canonical JSON of every reading row of a fridge with id in [fromId, toId], in id order. */
export function readingsDigest(db: Db, fridgeId: string, fromId: number, toId: number): string {
  const rows = db
    .prepare('SELECT * FROM readings WHERE fridge_id = ? AND id BETWEEN ? AND ? ORDER BY id')
    .all(fridgeId, fromId, toId);
  return sha256(rows.map(canonicalJson).join('\n'));
}

/**
 * Writes a TELEMETRY_CHECKPOINT for every full block of CHECKPOINT_EVERY readings not yet covered.
 * Blocks are ranges of reading row ids, not seqs: late (synced) rows always get higher ids, so they never fall
 * inside a range that was already checkpointed. Editing or deleting a covered reading breaks verification.
 */
export function checkpointReadings(db: Db, fridgeId: string, size = CHECKPOINT_EVERY): number {
  const state = db.prepare('SELECT last_to_id FROM telemetry_checkpoint_state WHERE fridge_id = ?').pluck();
  const next = db.prepare('SELECT id, seq FROM readings WHERE fridge_id = ? AND id > ? ORDER BY id LIMIT ?');
  const save = db.prepare(
    `INSERT INTO telemetry_checkpoint_state (fridge_id, last_to_id) VALUES (?, ?)
     ON CONFLICT(fridge_id) DO UPDATE SET last_to_id = excluded.last_to_id`,
  );
  return db.transaction(() => {
    let written = 0;
    let last = (state.get(fridgeId) as number | undefined) ?? 0;
    for (;;) {
      const block = next.all(fridgeId, last, size) as { id: number; seq: number }[];
      if (block.length < size) return written;
      const fromId = block[0].id;
      const toId = block[block.length - 1].id;
      const seqs = block.map((r) => r.seq);
      appendAudit(db, 'system', 'TELEMETRY_CHECKPOINT', {
        fridge_id: fridgeId,
        from_id: fromId,
        to_id: toId,
        from_seq: Math.min(...seqs),
        to_seq: Math.max(...seqs),
        count: block.length,
        sha256: readingsDigest(db, fridgeId, fromId, toId),
      });
      save.run(fridgeId, toId);
      last = toId;
      written += 1;
    }
  })();
}
