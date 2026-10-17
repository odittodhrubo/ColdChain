import { SAFE_MAX_C, SAFE_MIN_C, WARN_HIGH_C, WARN_LOW_C } from './constants';

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
