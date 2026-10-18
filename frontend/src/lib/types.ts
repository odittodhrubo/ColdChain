import type { BatchStatus, FridgeStatus } from '../ui/status';

// Shapes the backend returns (docs/backend.md). Kept narrow: only what the UI reads.

export interface LiveState {
  fridge_id: string;
  device_id: string;
  seq: number;
  ts: number; // reading time, unix s
  temp: number | null;
  door: 0 | 1;
  comp: 0 | 1;
  power: 'MAINS' | 'BATTERY';
  batt: number;
  state: 'SAFE' | 'WARNING' | 'BREACH'; // the server's classify()
  exp_s: number;
  latch: 0 | 1;
  mode: 'model' | 'manual';
  buf: number;
  online: boolean;
  last_seen: number; // unix ms (server receipt)
  door_open_at: number | null; // unix s, device event time
  battery_since: number | null;
  comp_off_at: number | null;
}

export interface Fridge {
  id: string;
  name: string;
  capacity: number;
  latch: boolean;
  device_id: string | null;
  load: number;
  batch_counts: Record<BatchStatus, number>;
  status: FridgeStatus;
  live: LiveState | null;
}

export interface FridgeList {
  fridges: Fridge[];
  server_time: number;
  demoScale: number;
}

export interface Batch {
  id: number;
  public_token: string;
  name: string;
  manufacturer: string;
  lot_number: string;
  quantity: number;
  expiry_date: string;
  criticality: number;
  fridge_id: string | null;
  status: BatchStatus;
  expired: boolean;
  weighted_exposure_s: number;
  remaining_pct: number;
  used_minutes: number;
  discarded_at: number | null;
  acknowledged_at: number | null;
}

export interface BatchList {
  batches: Batch[];
  total: number;
  demoScale: number;
}

export interface Alert {
  id: number;
  type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  fridge_id: string | null;
  batch_id: number | null;
  message: string;
  data: { title?: string; lines?: string[] };
  created_at: number;
  status: 'ACTIVE' | 'ACKNOWLEDGED' | 'RESOLVED';
  delivery_status: Record<string, { status?: string; attempts?: number; error?: string } | number>;
}

export interface DeviceEvent {
  seq: number;
  ts: number;
  type: string;
  data: Record<string, unknown>;
  late: 0 | 1;
}

export interface ReadingRow {
  seq: number;
  ts: number;
  temp: number | null;
  door: 0 | 1;
  comp: 0 | 1;
  power: 'MAINS' | 'BATTERY';
  batt: number;
  state: string;
  late: 0 | 1;
  received_at: number;
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/** One stored forecast + health score (GET /api/ml/predictions, socket prediction:update). */
export interface Prediction {
  fridge_id: string;
  created_at: number; // unix ms, when the backend asked
  source: 'model' | 'fallback';
  stale: boolean; // the ML service did not answer: a rule-based fallback
  at: number; // unix s, minute the forecast starts from
  pred_temp_30: number | null;
  p10: number | null;
  p90: number | null;
  breach_level: RiskLevel;
  breach_prob: number | null;
  minutes_to_breach_estimate: number | null;
  health_score: number | null;
  health_band: 'GOOD' | 'WEAKENING' | 'FAILING' | 'UNKNOWN';
  health_method: string;
  health_trend_per_day: number | null;
  weakening: boolean;
  features_used: Record<string, number | null>;
  health_factors: Record<string, number | null>;
  model_version: string | null;
}

export interface PlanMove {
  batch_id: number;
  batch_name: string;
  lot_number: string;
  remaining_pct: number;
  to_fridge: string;
  to_fridge_name: string;
  urgency: RiskLevel;
  reason: string;
}

export interface RelocationPlan {
  id: string;
  status: 'PROPOSED' | 'NO_SAFE_TARGET' | 'CONFIRMED' | 'DISMISSED' | 'EXPIRED' | 'CANCELLED';
  version: number;
  from_fridge: string;
  from_fridge_name: string;
  risk: string;
  rationale: string;
  advice: string | null;
  moves: PlanMove[];
  unsaveable: { batch_id: number; batch_name: string; lot_number: string; reason: string }[];
  shortfall: { batch_id: number; batch_name: string; lot_number: string; reason: string }[];
  targets: { id: string; name: string; p90: number | null; health: number | null; free: number }[];
  rejected_targets: { id: string; name: string; why: string }[];
  created_at: number;
  updated_at: number;
  expires_at: number;
  decided_at: number | null;
  decided_by: number | null;
  decision_note: string | null;
}
