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
