// Relocation planner (P18): pure functions, no DB and no clock. Given every fridge's live state and latest
// prediction, it decides whether a fridge is at risk, which of its batches should leave first and where each
// can go safely. It only *proposes*: moving anything is a human decision (relocation service, confirm).

export type Level = 'LOW' | 'MEDIUM' | 'HIGH';
export type Urgency = 'LOW' | 'MEDIUM' | 'HIGH';

export interface PredictionSnapshot {
  level: Level;
  pred: number | null; // °C at +30 min
  p90: number | null;
  health: number | null; // 0-100, null when it cannot be judged
  minutes_to_breach: number | null;
  source: 'model' | 'fallback';
}

export interface FridgeSnapshot {
  id: string;
  name: string;
  capacity: number;
  load: number; // batches in it now (every status takes a slot)
  online: boolean;
  status: string; // server classification: SAFE / WARNING / BREACH / OFFLINE
  temp: number | null;
  door_open: boolean;
  on_battery: boolean;
  batt: number | null;
  temp_rising: boolean;
  prediction: PredictionSnapshot | null;
}

export interface BatchSnapshot {
  id: number;
  name: string;
  lot_number: string;
  fridge_id: string;
  status: 'SAFE' | 'AT_RISK' | 'DISCARD';
  remaining_pct: number;
  criticality: number; // 1 low .. 3 high
  expiry_date: string; // YYYY-MM-DD
}

export interface Move {
  batch_id: number;
  batch_name: string;
  lot_number: string;
  remaining_pct: number;
  to_fridge: string;
  to_fridge_name: string;
  urgency: Urgency;
  reason: string;
}

export interface Plan {
  status: 'PROPOSED' | 'NO_SAFE_TARGET';
  from_fridge: string;
  from_fridge_name: string;
  risk: string; // why the source fridge is at risk
  moves: Move[];
  unsaveable: { batch_id: number; batch_name: string; lot_number: string; reason: string }[];
  shortfall: { batch_id: number; batch_name: string; lot_number: string; reason: string }[];
  targets: { id: string; name: string; p90: number | null; health: number | null; free: number }[];
  rejected_targets: { id: string; name: string; why: string }[];
  rationale: string;
  advice: string | null;
}

export const PLAN_TTL_MS = 15 * 60_000;
const TARGET_P90_MAX = 7.5;
const TARGET_HEALTH_MIN = 60;
const RISK_HEALTH_BELOW = 40;
const RISK_BATT_BELOW = 30;

const fmt = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? '?' : v.toFixed(digits);
const free = (f: FridgeSnapshot) => Math.max(0, f.capacity - f.load);

/** Why the fridge is at risk, or null. HIGH warning; MEDIUM with the door open or on battery; health < 40;
 * on battery below 30 % with the temperature rising. */
export function riskOf(f: FridgeSnapshot): string | null {
  const p = f.prediction;
  if (p?.level === 'HIGH') {
    const when =
      p.minutes_to_breach === null
        ? ''
        : p.minutes_to_breach <= 0 || (f.temp ?? 0) > 8
          ? ', already above 8 °C'
          : `, may pass 8 °C in about ${Math.round(p.minutes_to_breach)} min`;
    return `forecast ${fmt(p.pred)} °C in 30 min (up to ${fmt(p.p90)} °C)${when}`;
  }
  if (p?.level === 'MEDIUM' && (f.door_open || f.on_battery))
    return `forecast up to ${fmt(p.p90)} °C in 30 min with the ${f.door_open ? 'door open' : 'power out'}`;
  if (p?.health !== null && p?.health !== undefined && p.health < RISK_HEALTH_BELOW)
    return `compressor health ${Math.round(p.health)}/100: it can no longer hold the temperature reliably`;
  if (f.on_battery && f.batt !== null && f.batt < RISK_BATT_BELOW && f.temp_rising)
    return `on battery at ${f.batt} % with the temperature rising`;
  return null;
}

/** Why a fridge cannot take batches, or null when it can. */
export function targetProblem(f: FridgeSnapshot): string | null {
  const p = f.prediction;
  if (!f.online) return 'offline';
  if (f.status !== 'SAFE') return `status ${f.status}`;
  if (f.door_open) return 'door open';
  if (f.on_battery) return 'on battery';
  if (!p) return 'no forecast yet';
  if (p.level !== 'LOW') return `its own forecast is ${p.level}`;
  if (p.health === null || p.health < TARGET_HEALTH_MIN) return `compressor health ${fmt(p.health, 0)}`;
  if (p.p90 === null || p.p90 > TARGET_P90_MAX) return `forecast up to ${fmt(p.p90)} °C`;
  if (free(f) === 0) return 'full';
  return null;
}

/** Higher is better: margin under 8 °C dominates, then compressor health, then room. */
export const targetScore = (f: FridgeSnapshot) =>
  (8 - (f.prediction?.p90 ?? 8)) * 10 + (f.prediction?.health ?? 0) * 0.2 + free(f) * 0.5;

/** Lowest remaining budget first, then higher criticality, then earliest expiry, then id (stable). */
export function priority(a: BatchSnapshot, b: BatchSnapshot) {
  return (
    a.remaining_pct - b.remaining_pct ||
    b.criticality - a.criticality ||
    a.expiry_date.localeCompare(b.expiry_date) ||
    a.id - b.id
  );
}

function urgency(b: BatchSnapshot, source: FridgeSnapshot): Urgency {
  if (b.status === 'AT_RISK' || source.prediction?.level === 'HIGH' || (source.temp ?? 0) > 8) return 'HIGH';
  if (b.remaining_pct < 50 || b.criticality >= 3) return 'MEDIUM';
  return 'LOW';
}

const batchReason = (b: BatchSnapshot) =>
  `${Math.round(b.remaining_pct)} % heat budget left, criticality ${b.criticality}, expires ${b.expiry_date}`;

/** The plan for one at-risk fridge, or null when it is not at risk or holds nothing to move. */
export function planFor(
  sourceId: string,
  fridges: FridgeSnapshot[],
  batches: BatchSnapshot[],
  risk = riskOf(fridges.find((f) => f.id === sourceId)!),
): Plan | null {
  const source = fridges.find((f) => f.id === sourceId);
  if (!source || !risk) return null;
  const inside = batches.filter((b) => b.fridge_id === sourceId);
  const candidates = inside.filter((b) => b.status !== 'DISCARD').sort(priority);
  if (candidates.length === 0) return null; // nothing that can still be saved (discards have their own alert)
  const unsaveable = inside
    .filter((b) => b.status === 'DISCARD')
    .map((b) => ({
      batch_id: b.id,
      batch_name: b.name,
      lot_number: b.lot_number,
      reason: 'dispose, cannot be saved',
    }));

  const others = fridges.filter((f) => f.id !== sourceId);
  const rejected_targets = others.flatMap((f) => {
    const why = targetProblem(f);
    return why ? [{ id: f.id, name: f.name, why }] : [];
  });
  const eligible = others.filter((f) => !targetProblem(f)).sort((a, b) => targetScore(b) - targetScore(a));
  const room = new Map(eligible.map((f) => [f.id, free(f)]));

  const moves: Move[] = [];
  const shortfall: Plan['shortfall'] = [];
  for (const b of candidates) {
    const to = eligible.find((f) => (room.get(f.id) ?? 0) > 0); // best target with room left
    if (!to) {
      shortfall.push({
        batch_id: b.id,
        batch_name: b.name,
        lot_number: b.lot_number,
        reason: eligible.length ? 'no room left in a safe fridge' : 'no safe fridge',
      });
      continue;
    }
    room.set(to.id, room.get(to.id)! - 1);
    moves.push({
      batch_id: b.id,
      batch_name: b.name,
      lot_number: b.lot_number,
      remaining_pct: b.remaining_pct,
      to_fridge: to.id,
      to_fridge_name: to.name,
      urgency: urgency(b, source),
      reason: batchReason(b),
    });
  }

  const health = source.prediction?.health;
  const head = `${source.name}: ${risk}${health !== null && health !== undefined ? ` (compressor health ${Math.round(health)})` : ''}.`;
  const used = eligible.filter((f) => moves.some((m) => m.to_fridge === f.id));
  const where = used
    .map((f) => {
      const n = moves.filter((m) => m.to_fridge === f.id).length;
      return `${n} to ${f.name} (forecast ${fmt(f.prediction?.p90)} °C at most, ${free(f) - n} slots left after)`;
    })
    .join('; ');
  const noTarget = moves.length === 0;
  const rationale = noTarget
    ? `${head} No other fridge can take its batches safely${
        rejected_targets.length ? ` (${rejected_targets.map((r) => `${r.name}: ${r.why}`).join('; ')})` : ''
      }.`
    : `${head} Moving ${moves.length} batch${moves.length === 1 ? '' : 'es'}: ${where}.${
        shortfall.length ? ` ${shortfall.length} cannot move (no room left in a safe fridge).` : ''
      }`;
  return {
    status: noTarget ? 'NO_SAFE_TARGET' : 'PROPOSED',
    from_fridge: source.id,
    from_fridge_name: source.name,
    risk,
    moves,
    unsaveable,
    shortfall,
    targets: eligible.map((f) => ({
      id: f.id,
      name: f.name,
      p90: f.prediction?.p90 ?? null,
      health: f.prediction?.health ?? null,
      free: free(f),
    })),
    rejected_targets,
    rationale,
    advice: noTarget
      ? 'Move the batches to a portable cooler or a nearby site now, keep the door shut and check the fridge.'
      : shortfall.length
        ? 'The batches that cannot move need a portable cooler.'
        : null,
  };
}

/** What a confirm commits to: the same moves to the same fridges. Used to refresh only on real change. */
export const fingerprint = (p: Plan) =>
  `${p.status}|${p.moves.map((m) => `${m.batch_id}>${m.to_fridge}`).join(',')}|${p.shortfall.map((s) => s.batch_id).join(',')}`;
