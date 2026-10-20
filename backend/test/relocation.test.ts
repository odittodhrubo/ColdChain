import { describe, expect, it } from 'vitest';
import { assignmentHistory, getBatch } from '../src/modules/batches/service';
import {
  type BatchSnapshot,
  type FridgeSnapshot,
  fingerprint,
  planFor,
  priority,
  riskOf,
  targetProblem,
} from '../src/modules/relocation/planner';
import { addUser, bearer, makeApp, tokenFor } from './helpers';
import { ctxOf, prediction, proposedPlan, setPrediction } from './relocationHelpers';

// ------------------------------------------------------------------------------------ planner (pure)

const fridge = (o: Partial<FridgeSnapshot> = {}): FridgeSnapshot => ({
  id: 'fridge-b',
  name: 'Fridge B',
  capacity: 10,
  load: 3,
  online: true,
  status: 'SAFE',
  temp: 4.8,
  door_open: false,
  on_battery: false,
  batt: 100,
  temp_rising: false,
  prediction: { level: 'LOW', pred: 5, p90: 5.9, health: 92, minutes_to_breach: null, source: 'model' },
  ...o,
});
const hot = fridge({
  id: 'fridge-a',
  name: 'Fridge A',
  temp: 7.6,
  prediction: { level: 'HIGH', pred: 8.9, p90: 9.8, health: 41, minutes_to_breach: 18, source: 'model' },
});
let nextId = 1;
const batch = (o: Partial<BatchSnapshot> = {}): BatchSnapshot => ({
  id: nextId++,
  name: `B${nextId}`,
  lot_number: `L${nextId}`,
  fridge_id: 'fridge-a',
  status: 'SAFE',
  remaining_pct: 80,
  criticality: 2,
  expiry_date: '2027-06-30',
  ...o,
});

describe('relocation planner', () => {
  it('moves every saveable batch from the at-risk fridge to the safe one, explained', () => {
    const batches = [batch({ name: 'Polio' }), batch({ name: 'MMR', remaining_pct: 30 })];
    const plan = planFor('fridge-a', [hot, fridge()], batches)!;
    expect(plan.status).toBe('PROPOSED');
    expect(plan.moves.map((m) => [m.batch_name, m.to_fridge])).toEqual([
      ['MMR', 'fridge-b'],
      ['Polio', 'fridge-b'],
    ]);
    expect(plan.moves.every((m) => m.urgency === 'HIGH')).toBe(true); // the source forecast is HIGH
    expect(plan.rationale).toMatch(
      /^Fridge A: forecast 8\.9 °C in 30 min .*compressor health 41.*Moving 2 batches: 2 to Fridge B/,
    );
  });

  it('orders by lowest budget, then higher criticality, then earliest expiry', () => {
    const a = batch({ remaining_pct: 50, criticality: 1, expiry_date: '2027-01-01' });
    const b = batch({ remaining_pct: 50, criticality: 3, expiry_date: '2028-01-01' });
    const c = batch({ remaining_pct: 50, criticality: 3, expiry_date: '2027-01-01' });
    const d = batch({ remaining_pct: 10 });
    expect([a, b, c, d].sort(priority)).toEqual([d, c, b, a]);
  });

  it('FEFO when risk is equal: with one free slot, the soonest-expiring batch moves (A4)', () => {
    // same budget and criticality: expiry alone decides which batch gets the single safe slot
    const soon = batch({ name: 'Soon', remaining_pct: 60, criticality: 2, expiry_date: '2027-02-01' });
    const later = batch({ name: 'Later', remaining_pct: 60, criticality: 2, expiry_date: '2027-09-01' });
    const plan = planFor('fridge-a', [hot, fridge({ capacity: 4, load: 3 })], [later, soon])!;
    expect(plan.moves.map((m) => m.batch_name)).toEqual(['Soon']);
    expect(plan.shortfall.map((s) => s.batch_name)).toEqual(['Later']);
  });

  it('weighs destination capacity and the destination’s own forecast (A4)', () => {
    expect(targetProblem(fridge({ capacity: 6, load: 6 }))).toBe('full'); // capacity
    expect(targetProblem(fridge({ prediction: { level: 'MEDIUM', pred: 7, p90: 8.2, health: 90, minutes_to_breach: null, source: 'model' } }))).toMatch(
      /own forecast is MEDIUM/,
    ); // never move into a fridge about to breach
  });

  it('never moves a discarded batch: it is listed as unsaveable', () => {
    const plan = planFor('fridge-a', [hot, fridge()], [batch({ status: 'DISCARD', name: 'Old' }), batch()])!;
    expect(plan.moves).toHaveLength(1);
    expect(plan.unsaveable).toEqual([
      expect.objectContaining({ batch_name: 'Old', reason: 'dispose, cannot be saved' }),
    ]);
    expect(planFor('fridge-a', [hot, fridge()], [batch({ status: 'DISCARD' })])).toBeNull(); // nothing to save
  });

  it('with no safe destination: NO_SAFE_TARGET, why each fridge was refused, manual advice', () => {
    const warm = fridge({
      prediction: { level: 'LOW', pred: 6.8, p90: 7.9, health: 90, minutes_to_breach: null, source: 'model' },
    });
    const plan = planFor('fridge-a', [hot, warm, fridge({ id: 'c', name: 'C', online: false })], [batch()])!;
    expect(plan.status).toBe('NO_SAFE_TARGET');
    expect(plan.moves).toEqual([]);
    expect(plan.rejected_targets).toEqual([
      { id: 'fridge-b', name: 'Fridge B', why: 'forecast up to 7.9 °C' },
      { id: 'c', name: 'C', why: 'offline' },
    ]);
    expect(plan.advice).toMatch(/portable cooler/);
  });

  it('capacity shortfall: highest priority first, the rest reported', () => {
    const batches = [
      batch({ remaining_pct: 90 }),
      batch({ remaining_pct: 15, name: 'Urgent' }),
      batch({ remaining_pct: 60 }),
    ];
    const plan = planFor('fridge-a', [hot, fridge({ capacity: 5, load: 4 })], batches)!;
    expect(plan.moves.map((m) => m.batch_name)).toEqual(['Urgent']);
    expect(plan.shortfall).toHaveLength(2);
    expect(plan.rationale).toMatch(/2 cannot move/);
    expect(plan.advice).toMatch(/portable cooler/);
  });

  it('spreads over several safe fridges, best margin first', () => {
    const cool = fridge({
      id: 'c',
      name: 'Cool',
      capacity: 4,
      load: 3,
      prediction: { level: 'LOW', pred: 4, p90: 4.5, health: 95, minutes_to_breach: null, source: 'model' },
    });
    const plan = planFor('fridge-a', [hot, fridge(), cool], [batch(), batch()])!;
    expect(plan.moves.map((m) => m.to_fridge)).toEqual(['c', 'fridge-b']);
  });

  it('risk triggers and target rules', () => {
    expect(riskOf(fridge())).toBeNull();
    expect(riskOf(hot)).toMatch(/forecast 8\.9/);
    expect(riskOf({ ...hot, temp: 9.4 })).toMatch(/already above 8 °C$/);
    expect(riskOf(hot)).toMatch(/may pass 8 °C in about 18 min$/);
    const medium = {
      level: 'MEDIUM' as const,
      pred: 7,
      p90: 8.4,
      health: 90,
      minutes_to_breach: null,
      source: 'model' as const,
    };
    expect(riskOf(fridge({ prediction: medium }))).toBeNull();
    expect(riskOf(fridge({ prediction: medium, door_open: true }))).toMatch(/door open/);
    expect(riskOf(fridge({ prediction: { ...medium, level: 'LOW', health: 35 } }))).toMatch(
      /compressor health 35/,
    );
    expect(riskOf(fridge({ on_battery: true, batt: 25, temp_rising: true }))).toMatch(/on battery at 25 %/);
    expect(targetProblem(fridge({ door_open: true }))).toBe('door open');
    expect(targetProblem(fridge({ on_battery: true }))).toBe('on battery');
    expect(targetProblem(fridge({ load: 10 }))).toBe('full');
    expect(targetProblem(fridge({ prediction: null }))).toBe('no forecast yet');
    expect(targetProblem(fridge({ prediction: { ...medium, level: 'LOW', p90: 7, health: 55 } }))).toBe(
      'compressor health 55',
    );
    expect(targetProblem(fridge({ status: 'WARNING' }))).toBe('status WARNING');
  });

  it('fingerprint changes only when the moves change', () => {
    const batches = [batch(), batch()];
    const a = planFor('fridge-a', [hot, fridge()], batches)!;
    const b = planFor('fridge-a', [{ ...hot, temp: 7.9 }, fridge({ temp: 5.1 })], batches)!;
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).not.toBe(fingerprint(planFor('fridge-a', [hot, fridge()], batches.slice(1))!));
  });
});

// ------------------------------------------------------------------------------------ plans in the service

describe('relocation plans', () => {
  it('needs the risk on 2 runs to propose, and 3 safe runs to withdraw (no flapping)', () => {
    const t = makeApp();
    const ctx = ctxOf(t);
    const { from, plan } = proposedPlan(t); // 2 evaluations
    expect(plan.status).toBe('PROPOSED');
    expect(plan.version).toBe(1);
    ctx.relocation.evaluate();
    expect(ctx.relocation.get(plan.id).version).toBe(1); // same moves: not refreshed
    setPrediction(t, from, prediction(), Date.now() + 1);
    ctx.relocation.evaluate(Date.now() + 2);
    ctx.relocation.evaluate(Date.now() + 3);
    expect(ctx.relocation.get(plan.id).status).toBe('PROPOSED');
    ctx.relocation.evaluate(Date.now() + 4);
    expect(ctx.relocation.get(plan.id).status).toBe('CANCELLED');
  });

  it('a plan is audited and alerted; one active plan per fridge', () => {
    const t = makeApp();
    const { from } = proposedPlan(t);
    ctxOf(t).audit.flush();
    expect(
      t.db.prepare("SELECT COUNT(*) FROM audit_log WHERE event_type = 'RELOCATION_PROPOSED'").pluck().get(),
    ).toBe(1);
    const alert = t.db
      .prepare("SELECT * FROM alerts WHERE type = 'RELOCATION_PROPOSED' AND fridge_id = ?")
      .get(from) as {
      severity: string;
      resolved_at: number | null;
    };
    expect(alert.severity).toBe('WARNING');
    expect(
      t.db.prepare('SELECT COUNT(*) FROM relocation_plans WHERE from_fridge = ?').pluck().get(from),
    ).toBe(1);
  });

  it('confirm moves every batch in one transaction, audited with the plan and rationale; a second click is a no-op', async () => {
    const t = makeApp();
    const { to, batches, plan } = proposedPlan(t, 3);
    const user = await addUser(t, 'PHARMACIST');
    const res = await t
      .http()
      .post(`/api/relocations/${plan.id}/confirm`)
      .set(bearer(tokenFor(t, user)))
      .send({ version: plan.version });
    expect(res.status).toBe(200);
    expect(res.body.plan.status).toBe('CONFIRMED');
    expect(res.body.already).toBe(false);
    for (const b of batches) {
      expect(getBatch(t.db, b.id).fridge_id).toBe(to);
      expect(assignmentHistory(t.db, b.id)).toHaveLength(2);
    }
    ctxOf(t).audit.flush();
    const moved = (
      t.db.prepare("SELECT actor, payload FROM audit_log WHERE event_type = 'BATCH_MOVED'").all() as {
        actor: string;
        payload: string;
      }[]
    ).map((r) => ({
      actor: r.actor,
      ...JSON.parse(r.payload),
    }));
    expect(moved).toHaveLength(3);
    expect(
      moved.every(
        (m) => m.actor === `user:${user.id}` && m.plan_id === plan.id && m.rationale === plan.rationale,
      ),
    ).toBe(true);
    expect(
      t.db.prepare("SELECT COUNT(*) FROM audit_log WHERE event_type = 'RELOCATION_CONFIRMED'").pluck().get(),
    ).toBe(1);

    const again = await t
      .http()
      .post(`/api/relocations/${plan.id}/confirm`)
      .set(bearer(tokenFor(t, user)))
      .send({ version: plan.version });
    expect(again.status).toBe(200);
    expect(again.body.already).toBe(true);
    ctxOf(t).audit.flush();
    expect(
      t.db.prepare("SELECT COUNT(*) FROM audit_log WHERE event_type = 'BATCH_MOVED'").pluck().get(),
    ).toBe(3);
    const alert = t.db
      .prepare("SELECT resolved_at FROM alerts WHERE type = 'RELOCATION_PROPOSED'")
      .pluck()
      .get();
    expect(alert).not.toBeNull();
  });

  it('confirm race: the target became unsafe after the proposal -> 409 with the refreshed plan, nothing moved', async () => {
    const t = makeApp();
    const { from, to, batches, plan } = proposedPlan(t);
    setPrediction(t, to, prediction({ p90: 8.3, breach_level: 'MEDIUM' }), Date.now() + 1);
    const admin = await addUser(t, 'ADMIN');
    const res = await t
      .http()
      .post(`/api/relocations/${plan.id}/confirm`)
      .set(bearer(tokenFor(t, admin)))
      .send({ version: plan.version });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_CHANGED');
    expect(res.body.error.details.problems.join()).toMatch(/no longer safe/);
    expect(res.body.error.details.plan.status).toBe('NO_SAFE_TARGET');
    expect(res.body.error.details.plan.version).toBe(2);
    for (const b of batches) expect(getBatch(t.db, b.id).fridge_id).toBe(from);
  });

  it('a stale version or an expired plan is refused with 409', async () => {
    const t = makeApp();
    const { plan } = proposedPlan(t);
    const user = await addUser(t, 'PHARMACIST');
    const stale = await t
      .http()
      .post(`/api/relocations/${plan.id}/confirm`)
      .set(bearer(tokenFor(t, user)))
      .send({ version: 99 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('PLAN_CHANGED');
    expect(() => ctxOf(t).relocation.confirm(plan.id, plan.version, user.id, plan.expires_at + 1)).toThrow(
      /expired/,
    );
    expect(ctxOf(t).relocation.get(plan.id).status).toBe('EXPIRED');
  });

  it('the scheduler expires an unconfirmed plan after 15 minutes', () => {
    const t = makeApp();
    const { plan } = proposedPlan(t);
    ctxOf(t).relocation.evaluate(plan.expires_at + 1);
    expect(ctxOf(t).relocation.get(plan.id).status).toBe('EXPIRED');
  });

  it('no safe target: CRITICAL alert, the plan cannot be confirmed', async () => {
    const t = makeApp();
    const now = Date.now();
    const { from, plan: first } = proposedPlan(t);
    // the only other fridge now forecasts warm: the plan is refreshed to NO_SAFE_TARGET
    const others = t.db.prepare('SELECT id FROM fridges WHERE id != ?').pluck().all(from) as string[];
    for (const id of others) setPrediction(t, id, prediction({ p90: 7.9 }), now + 1);
    ctxOf(t).relocation.evaluate(now + 2);
    const plan = ctxOf(t).relocation.get(first.id);
    expect(plan.status).toBe('NO_SAFE_TARGET');
    const alert = t.db
      .prepare("SELECT severity FROM alerts WHERE type = 'RELOCATION_PROPOSED' AND fridge_id = ?")
      .pluck()
      .get(from);
    expect(alert).toBe('CRITICAL');
    const admin = await addUser(t, 'ADMIN');
    const res = await t
      .http()
      .post(`/api/relocations/${plan.id}/confirm`)
      .set(bearer(tokenFor(t, admin)))
      .send({ version: plan.version });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_SAFE_TARGET');
  });

  it('dismiss records the reason, is audited, and holds off a new plan', async () => {
    const t = makeApp();
    const { plan } = proposedPlan(t);
    const user = await addUser(t, 'PHARMACIST');
    const res = await t
      .http()
      .post(`/api/relocations/${plan.id}/dismiss`)
      .set(bearer(tokenFor(t, user)))
      .send({ reason: 'Moved by hand already' });
    expect(res.status).toBe(200);
    expect(res.body.plan).toMatchObject({
      status: 'DISMISSED',
      decision_note: 'Moved by hand already',
      decided_by: user.id,
    });
    ctxOf(t).relocation.evaluate();
    ctxOf(t).relocation.evaluate();
    expect(ctxOf(t).relocation.list({ status: 'active', limit: 10 })).toEqual([]);
    ctxOf(t).audit.flush();
    expect(
      t.db.prepare("SELECT COUNT(*) FROM audit_log WHERE event_type = 'RELOCATION_DISMISSED'").pluck().get(),
    ).toBe(1);
  });

  it('an inspector can read plans but cannot confirm or dismiss them', async () => {
    const t = makeApp();
    const { plan, from } = proposedPlan(t);
    const token = tokenFor(t, await addUser(t, 'INSPECTOR'));
    expect((await t.http().get(`/api/relocations/${plan.id}`).set(bearer(token))).status).toBe(200);
    const res = await t
      .http()
      .post(`/api/relocations/${plan.id}/confirm`)
      .set(bearer(token))
      .send({ version: plan.version });
    expect(res.status).toBe(403);
    expect(ctxOf(t).relocation.get(plan.id).status).toBe('PROPOSED');
    expect(
      t.db
        .prepare(
          'SELECT COUNT(*) FROM batch_assignments a JOIN batches b ON b.id = a.batch_id WHERE a.to_ts IS NULL AND a.fridge_id = ?',
        )
        .pluck()
        .get(from),
    ).toBe(2);
  });
});
