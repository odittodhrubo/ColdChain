import { randomUUID } from 'node:crypto';
import { freshForMs } from '../../ml/engine';
import { HttpError, notFound } from '../../shared/errors';
import type { AppContext } from '../../shared/http';
import { emit as emitBatch, getBatch, listBatches, moveInTransaction } from '../batches/service';
import { listFridges } from '../fridges/service';
import {
  type BatchSnapshot,
  type FridgeSnapshot,
  fingerprint,
  type Plan,
  PLAN_TTL_MS,
  planFor,
  riskOf,
  targetProblem,
} from './planner';

// Relocation plans (P18): the planner proposes, a human confirms. A fridge must look at risk for 2 consecutive
// scheduler runs before a plan appears and safe for 3 before it is withdrawn (no flapping). One active plan per
// fridge; it is refreshed (new version) only when the moves would change, and expires after 15 minutes.
// Confirming re-checks everything against the current state and moves all batches in one transaction.

const PROPOSE_AFTER = 2;
const CANCEL_AFTER = 3;
const ACTIVE = "status IN ('PROPOSED', 'NO_SAFE_TARGET')";

interface PlanRow {
  id: string;
  from_fridge: string;
  status: 'PROPOSED' | 'NO_SAFE_TARGET' | 'CONFIRMED' | 'DISMISSED' | 'EXPIRED' | 'CANCELLED';
  version: number;
  plan: string;
  rationale: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  decided_at: number | null;
  decided_by: number | null;
  decision_note: string | null;
  result: string | null;
}

export type PlanView = ReturnType<typeof view>;

function view(r: PlanRow) {
  const plan = JSON.parse(r.plan) as Plan;
  return {
    ...plan,
    id: r.id,
    status: r.status,
    version: r.version,
    rationale: r.rationale,
    created_at: r.created_at,
    updated_at: r.updated_at,
    expires_at: r.expires_at,
    decided_at: r.decided_at,
    decided_by: r.decided_by,
    decision_note: r.decision_note,
    result: r.result ? (JSON.parse(r.result) as unknown) : null,
  };
}

const planConflict = (code: string, message: string, plan: PlanView | null, problems?: string[]) =>
  new HttpError(409, code, message, { plan, ...(problems ? { problems } : {}) });

export class RelocationEngine {
  private readonly runs = new Map<string, { risk: number; safe: number }>();
  private readonly dismissedUntil = new Map<string, number>();

  constructor(private readonly ctx: AppContext) {}

  // ------------------------------------------------------------------ state

  /** Live state + latest fresh prediction of every fridge, and every batch that sits in a fridge. */
  snapshots(nowMs = Date.now()): { fridges: FridgeSnapshot[]; batches: BatchSnapshot[] } {
    const fridges = listFridges(this.ctx, nowMs).map((f): FridgeSnapshot => {
      const p = this.ctx.ml.latest(f.id);
      const fresh = p && nowMs - p.created_at <= freshForMs(this.ctx.config.ML_INTERVAL_MS) ? p : null;
      const live = f.live;
      return {
        id: f.id,
        name: f.name,
        capacity: f.capacity,
        load: f.load,
        online: !!live?.online,
        status: f.status,
        temp: live?.temp ?? null,
        door_open: live?.door === 1,
        on_battery: live?.power === 'BATTERY',
        batt: live?.batt ?? null,
        temp_rising: (fresh?.features_used?.temp_slope_15 ?? 0) > 0.05,
        prediction: fresh && {
          level: fresh.breach_level,
          pred: fresh.pred_temp_30,
          p90: fresh.p90,
          health: fresh.health_score,
          minutes_to_breach: fresh.minutes_to_breach_estimate,
          source: fresh.source,
        },
      };
    });
    const batches = listBatches(this.ctx.db, {}, nowMs)
      .filter((b) => b.fridge_id !== null)
      .map((b) => ({
        id: b.id,
        name: b.name,
        lot_number: b.lot_number,
        fridge_id: b.fridge_id!,
        status: b.status,
        remaining_pct: b.remaining_pct,
        criticality: b.criticality,
        expiry_date: b.expiry_date,
      }));
    return { fridges, batches };
  }

  private row(id: string): PlanRow {
    const r = this.ctx.db.prepare('SELECT * FROM relocation_plans WHERE id = ?').get(id) as
      PlanRow | undefined;
    if (!r) throw notFound('Relocation plan not found');
    return r;
  }

  private active(fridgeId: string): PlanRow | undefined {
    return this.ctx.db
      .prepare(`SELECT * FROM relocation_plans WHERE from_fridge = ? AND ${ACTIVE}`)
      .get(fridgeId) as PlanRow | undefined;
  }

  get = (id: string) => view(this.row(id));

  list(q: { status: 'active' | 'all'; limit: number }) {
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM relocation_plans ${q.status === 'active' ? `WHERE ${ACTIVE}` : ''} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(q.limit) as PlanRow[];
    return rows.map(view);
  }

  // ------------------------------------------------------------------ lifecycle

  private emit(id: string) {
    const plan = this.get(id);
    this.ctx.realtime.emit('relocation:update', plan);
    return plan;
  }

  private close(r: PlanRow, status: 'EXPIRED' | 'CANCELLED', note: string, nowMs: number) {
    this.ctx.db
      .prepare('UPDATE relocation_plans SET status = ?, decision_note = ?, updated_at = ? WHERE id = ?')
      .run(status, note, nowMs, r.id);
    this.ctx.alerts.resolve('RELOCATION_PROPOSED', r.from_fridge, null, undefined, nowMs);
    return this.emit(r.id);
  }

  private alert(plan: Plan, nowMs: number) {
    const none = plan.status === 'NO_SAFE_TARGET';
    this.ctx.alerts.raise(
      {
        type: 'RELOCATION_PROPOSED',
        severity: none ? 'CRITICAL' : 'WARNING',
        fridgeId: plan.from_fridge,
        title: none
          ? `No safe fridge for the batches in ${plan.from_fridge_name}`
          : `Relocation proposed: ${plan.from_fridge_name}`,
        lines: [plan.rationale, ...(plan.advice ? [plan.advice] : [])],
        data: { moves: plan.moves.length, status: plan.status },
      },
      nowMs,
    );
  }

  private store(plan: Plan, nowMs: number, existing?: PlanRow): string {
    const { db } = this.ctx;
    if (existing) {
      db.prepare(
        `UPDATE relocation_plans SET status = ?, version = version + 1, plan = ?, rationale = ?, updated_at = ?,
           expires_at = ? WHERE id = ?`,
      ).run(plan.status, JSON.stringify(plan), plan.rationale, nowMs, nowMs + PLAN_TTL_MS, existing.id);
      return existing.id;
    }
    const id = randomUUID();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO relocation_plans (id, from_fridge, status, plan, rationale, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        plan.from_fridge,
        plan.status,
        JSON.stringify(plan),
        plan.rationale,
        nowMs,
        nowMs,
        nowMs + PLAN_TTL_MS,
      );
      this.ctx.audit.append('system', 'RELOCATION_PROPOSED', {
        plan_id: id,
        from: plan.from_fridge,
        status: plan.status,
        moves: plan.moves.map((m) => ({ batch_id: m.batch_id, to: m.to_fridge })),
        rationale: plan.rationale,
      });
    })();
    return id;
  }

  /** After every scheduler run: propose, refresh, expire or withdraw plans. Never moves anything. */
  evaluate(nowMs = Date.now()) {
    const { fridges, batches } = this.snapshots(nowMs);
    for (const f of fridges) {
      const risk = riskOf(f);
      const runs = this.runs.get(f.id) ?? { risk: 0, safe: 0 };
      this.runs.set(f.id, risk ? { risk: runs.risk + 1, safe: 0 } : { risk: 0, safe: runs.safe + 1 });
      const now = this.runs.get(f.id)!;
      let active = this.active(f.id);
      if (active && nowMs > active.expires_at) {
        this.close(active, 'EXPIRED', 'not confirmed within 15 minutes', nowMs);
        active = undefined;
      }
      if (!risk) {
        if (active && now.safe >= CANCEL_AFTER) this.close(active, 'CANCELLED', 'risk resolved', nowMs);
        continue;
      }
      if (now.risk < PROPOSE_AFTER || (this.dismissedUntil.get(f.id) ?? 0) > nowMs) continue;
      const plan = planFor(f.id, fridges, batches, risk);
      if (!plan) {
        if (active) this.close(active, 'CANCELLED', 'nothing left to move', nowMs);
        continue;
      }
      if (active && fingerprint(JSON.parse(active.plan) as Plan) === fingerprint(plan)) continue;
      const id = this.store(plan, nowMs, active);
      this.alert(plan, nowMs);
      this.emit(id);
    }
  }

  // ------------------------------------------------------------------ human decisions

  /**
   * One-click confirm. Idempotent: confirming an already-confirmed plan returns it unchanged. The caller must
   * quote the version it saw; any change since (version, expiry, target, batches, room) answers 409 with the
   * refreshed plan instead of moving anything.
   */
  confirm(id: string, version: number, userId: number, nowMs = Date.now()) {
    const r = this.row(id);
    if (r.status === 'CONFIRMED') return { plan: view(r), already: true };
    if (r.status === 'NO_SAFE_TARGET')
      throw planConflict('NO_SAFE_TARGET', 'There is no safe fridge to move these batches to', view(r));
    if (r.status !== 'PROPOSED')
      throw planConflict('PLAN_NOT_ACTIVE', `This plan is ${r.status.toLowerCase()}`, view(r));
    if (nowMs > r.expires_at) {
      this.close(r, 'EXPIRED', 'not confirmed within 15 minutes', nowMs);
      throw planConflict(
        'PLAN_EXPIRED',
        'This plan expired; a new one appears if the risk persists',
        this.get(id),
      );
    }
    if (version !== r.version)
      throw planConflict('PLAN_CHANGED', 'The plan changed since you opened it: check it again', view(r));

    const plan = JSON.parse(r.plan) as Plan;
    const { fridges, batches } = this.snapshots(nowMs);
    const problems: string[] = [];
    const room = new Map(fridges.map((f) => [f.id, f.capacity - f.load]));
    for (const m of plan.moves) {
      const b = batches.find((x) => x.id === m.batch_id);
      if (!b || b.fridge_id !== plan.from_fridge)
        problems.push(`${m.batch_name} is no longer in ${plan.from_fridge_name}`);
      else if (b.status === 'DISCARD') problems.push(`${m.batch_name} has been discarded`);
      const target = fridges.find((f) => f.id === m.to_fridge);
      const why = target ? targetProblem(target) : 'gone';
      if (why && why !== 'full') problems.push(`${m.to_fridge_name} is no longer safe (${why})`);
      room.set(m.to_fridge, (room.get(m.to_fridge) ?? 0) - 1);
      if ((room.get(m.to_fridge) ?? 0) < 0)
        problems.push(`${m.to_fridge_name} has no room for ${m.batch_name}`);
    }
    if (problems.length) {
      const fresh = planFor(
        plan.from_fridge,
        fridges,
        batches,
        riskOf(fridges.find((f) => f.id === plan.from_fridge)!) ?? plan.risk,
      );
      if (fresh) this.store(fresh, nowMs, r);
      else this.close(r, 'CANCELLED', 'nothing left to move', nowMs);
      const refreshed = this.emit(id);
      throw planConflict(
        'PLAN_CHANGED',
        'Conditions changed since the plan was made: check the refreshed plan',
        refreshed,
        [...new Set(problems)],
      );
    }

    const { db } = this.ctx;
    db.transaction(() => {
      for (const m of plan.moves)
        moveInTransaction(this.ctx, m.batch_id, m.to_fridge, userId, nowMs, {
          plan_id: id,
          rationale: plan.rationale,
        });
      this.ctx.audit.append(`user:${userId}`, 'RELOCATION_CONFIRMED', {
        plan_id: id,
        version: r.version,
        from: plan.from_fridge,
        moves: plan.moves.map((m) => ({ batch_id: m.batch_id, to: m.to_fridge })),
        rationale: plan.rationale,
      });
      // the status guard makes a concurrent second confirm a no-op inside its own transaction
      const done = db
        .prepare(
          `UPDATE relocation_plans SET status = 'CONFIRMED', decided_at = ?, decided_by = ?, updated_at = ?, result = ?
           WHERE id = ? AND status = 'PROPOSED' AND version = ?`,
        )
        .run(
          nowMs,
          userId,
          nowMs,
          JSON.stringify({ moved: plan.moves.map((m) => m.batch_id) }),
          id,
          r.version,
        );
      if (done.changes !== 1)
        throw planConflict('PLAN_CHANGED', 'The plan changed while confirming', view(this.row(id)));
    })();
    for (const m of plan.moves) emitBatch(this.ctx, getBatch(db, m.batch_id, nowMs));
    this.ctx.alerts.resolve('RELOCATION_PROPOSED', plan.from_fridge, null, undefined, nowMs);
    return { plan: this.emit(id), already: false };
  }

  dismiss(id: string, reason: string, userId: number, nowMs = Date.now()) {
    const r = this.row(id);
    if (r.status !== 'PROPOSED' && r.status !== 'NO_SAFE_TARGET')
      throw planConflict('PLAN_NOT_ACTIVE', `This plan is ${r.status.toLowerCase()}`, view(r));
    this.ctx.db.transaction(() => {
      this.ctx.db
        .prepare(
          `UPDATE relocation_plans SET status = 'DISMISSED', decided_at = ?, decided_by = ?, decision_note = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(nowMs, userId, reason, nowMs, id);
      this.ctx.audit.append(`user:${userId}`, 'RELOCATION_DISMISSED', {
        plan_id: id,
        from: r.from_fridge,
        reason,
      });
    })();
    this.dismissedUntil.set(r.from_fridge, nowMs + PLAN_TTL_MS); // not proposed again straight away
    this.ctx.alerts.resolve('RELOCATION_PROPOSED', r.from_fridge, null, undefined, nowMs);
    return this.emit(id);
  }
}
