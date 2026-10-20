import { z } from 'zod';
import { SYNC_CHUNK } from '../shared/constants';

// Message bodies (contract section 5). Strict: an unknown field is BAD_BODY.

export const EVENT_TYPES = [
  'DOOR_OPEN', 'DOOR_CLOSE', 'DOOR_ALARM', 'POWER_FAIL', 'POWER_RESTORE', 'BATT_LOW', 'COMP_ON', 'COMP_OFF',
  'LATCH_SET', 'LATCH_RESET', 'WIFI_LOST', 'WIFI_BACK', 'SENSOR_FAULT', 'BOOT',
] as const; // prettier-ignore

const seq = z.number().int().nonnegative();
const ts = z.number().int().nonnegative(); // reading time: never checked against the freshness window
const bit = z.union([z.literal(0), z.literal(1)]);

const readingFields = {
  seq,
  ts,
  temp: z.number().min(-100).max(150).nullable(), // null = sensor fault
  // A3: optional room temperature from a second DS18B20 outside the fridge. Absent on nodes without one
  // (Wokwi, and any single-sensor node), so it never changes existing message signatures.
  ambient: z.number().min(-100).max(150).nullable().optional(),
  door: bit,
  comp: bit,
  power: z.enum(['MAINS', 'BATTERY']),
  batt: z.number().int().min(0).max(100),
  state: z.enum(['SAFE', 'WARNING', 'BREACH']),
  exp_s: z.number().int().nonnegative(),
  latch: bit,
  mode: z.enum(['model', 'manual']),
  reason: z.enum(['periodic', 'door']),
};

export const telemetryBody = z.strictObject({
  ...readingFields,
  buf: z.number().int().nonnegative(),
  rssi: z.number().int(),
  fw: z.string().max(32),
  dropped: z.number().int().nonnegative().optional(), // only after an offline-buffer overflow
});

export const syncReading = z.strictObject(readingFields);

export const eventBody = z.strictObject({
  seq,
  ts,
  type: z.enum(EVENT_TYPES),
  data: z.record(z.string(), z.unknown()),
});

export const syncBody = z
  .strictObject({
    from_seq: seq,
    to_seq: seq,
    readings: z
      .array(z.union([syncReading, eventBody]))
      .min(1)
      .max(SYNC_CHUNK),
  })
  .refine((b) => {
    const seqs = b.readings.map((r) => r.seq);
    return (
      Math.min(...seqs) === b.from_seq && Math.max(...seqs) === b.to_seq && new Set(seqs).size === seqs.length
    );
  }, 'from_seq / to_seq must match the items, and seqs must be unique');

export const cmdackBody = z.strictObject({
  cmd_id: z.string().min(1).max(64),
  ok: z.boolean(),
  detail: z.string().max(200),
});

export type TelemetryBody = z.infer<typeof telemetryBody>;
export type SyncReading = z.infer<typeof syncReading>;
export type EventBody = z.infer<typeof eventBody>;
export type SyncBody = z.infer<typeof syncBody>;
