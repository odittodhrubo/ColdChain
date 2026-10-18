import { AT_RISK_PCT, BUDGET_S, SAFE_MAX_C, SAFE_MIN_C, WARN_HIGH_C, WARN_LOW_C } from './constants';

export type FridgeState = 'SAFE' | 'WARNING' | 'BREACH';

/** Fridge status (contract section 2), identical to the firmware and the simulator; tested on the shared vectors. */
export function classify(
  temp: number | null,
  doorOpen: boolean,
  onBattery: boolean,
  sensorFault: boolean,
): FridgeState {
  if (sensorFault || temp === null || Number.isNaN(temp) || temp > SAFE_MAX_C || temp < SAFE_MIN_C)
    return 'BREACH';
  if (temp > WARN_HIGH_C || temp < WARN_LOW_C) return 'WARNING';
  if (doorOpen || onBattery) return 'WARNING';
  return 'SAFE';
}

export type BatchStatus = 'SAFE' | 'AT_RISK' | 'DISCARD';

/** Remaining heat budget in percent (contract section 2): max(0, 100 x (1 - weighted / BUDGET_S)). */
export const remainingPct = (weightedExposureS: number) =>
  Math.max(0, 100 * (1 - weightedExposureS / BUDGET_S));

/** Today as YYYY-MM-DD in UTC: expiry dates compare as UTC calendar dates, whatever the server's timezone. */
export const utcToday = (nowMs = Date.now()) => new Date(nowMs).toISOString().slice(0, 10);

/**
 * Batch status (contract section 2), the one function every module uses. DISCARD when discarded before, out of
 * budget, or expired (expiry date before today, UTC); AT_RISK below 20 % remaining; SAFE otherwise.
 */
export function deriveBatchStatus(
  remaining: number,
  expiryDate: string,
  discarded: boolean,
  today = utcToday(),
): BatchStatus {
  if (discarded || remaining <= 0 || expiryDate < today) return 'DISCARD';
  if (remaining < AT_RISK_PCT) return 'AT_RISK';
  return 'SAFE';
}
