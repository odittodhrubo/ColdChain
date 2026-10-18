// One vocabulary for every status in the app: colour, word and VVM fill always travel together.

export type FridgeStatus = 'SAFE' | 'WARNING' | 'BREACH' | 'OFFLINE';
export type BatchStatus = 'SAFE' | 'AT_RISK' | 'DISCARD';
export type Status = FridgeStatus | BatchStatus;

export interface StatusMeta {
  label: string;
  ink: string; // CSS colour (token)
  wash: string;
  used: number; // default VVM square fill, 0 (fresh) to 1 (spent)
  description: string; // screen-reader text
}

export const STATUS: Record<Status, StatusMeta> = {
  SAFE: {
    label: 'Safe',
    ink: 'var(--safe)',
    wash: 'var(--safe-wash)',
    used: 0.12,
    description: 'within 2 to 8 °C, nothing to do',
  },
  WARNING: {
    label: 'Warning',
    ink: 'var(--warning)',
    wash: 'var(--warning-wash)',
    used: 0.45,
    description: 'near the edge of the safe band, door open, or on battery',
  },
  BREACH: {
    label: 'Breach',
    ink: 'var(--breach)',
    wash: 'var(--breach-wash)',
    used: 0.85,
    description: 'outside 2 to 8 °C',
  },
  OFFLINE: {
    label: 'Offline',
    ink: 'var(--offline)',
    wash: 'var(--offline-wash)',
    used: 0,
    description: 'no data from the fridge node',
  },
  AT_RISK: {
    label: 'At risk',
    ink: 'var(--atrisk)',
    wash: 'var(--atrisk-wash)',
    used: 0.82,
    description: 'less than 20 % of the heat budget left',
  },
  DISCARD: {
    label: 'Discard',
    ink: 'var(--discard)',
    wash: 'var(--discard-wash)',
    used: 1,
    description: 'heat budget used up or expired; never use',
  },
};
