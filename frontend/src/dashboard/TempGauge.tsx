import { COMP_OFF_AT_C, COMP_ON_AT_C, SAFE_MAX_C, SAFE_MIN_C } from '../lib/constants';

const MIN = -2;
const MAX = 16;
const pos = (t: number) => `${((Math.min(MAX, Math.max(MIN, t)) - MIN) / (MAX - MIN)) * 100}%`;

/**
 * Where the reading sits against the 2–8 °C band and the compressor's 3 / 7 °C thresholds. The needle glides
 * (transform transition) between readings; out-of-scale readings pin to the edge.
 */
export function TempGauge({ temp, ink }: { temp: number | null; ink: string }) {
  return (
    <div
      role="img"
      aria-label={`${temp === null ? 'No reading' : `${temp.toFixed(1)} °C`}; safe band ${SAFE_MIN_C} to ${SAFE_MAX_C} °C`}
      className="relative mt-3 mb-5 h-3"
    >
      <div className="absolute inset-0 rounded-full bg-panel-2 ring-1 ring-rule ring-inset" />
      <div
        className="absolute inset-y-0 rounded-full"
        style={{
          left: pos(SAFE_MIN_C),
          width: `calc(${pos(SAFE_MAX_C)} - ${pos(SAFE_MIN_C)})`,
          background: 'color-mix(in oklab, var(--safe) 22%, var(--panel))',
          boxShadow: 'inset 0 0 0 1px color-mix(in oklab, var(--safe) 45%, transparent)',
        }}
      />
      {[COMP_OFF_AT_C, COMP_ON_AT_C].map((t) => (
        <span
          key={t}
          aria-hidden
          className="absolute -top-1 h-5 w-px bg-ink-3"
          style={{ left: pos(t) }}
          title={t === COMP_ON_AT_C ? 'Compressor on at 7 °C' : 'Compressor off at 3 °C'}
        />
      ))}
      {[SAFE_MIN_C, COMP_OFF_AT_C, COMP_ON_AT_C, SAFE_MAX_C].map((t) => (
        <span
          key={`l${t}`}
          aria-hidden
          className="figures absolute top-4 -translate-x-1/2 text-[0.65rem] text-ink-3"
          style={{ left: pos(t) }}
        >
          {t}°
        </span>
      ))}
      {temp !== null && (
        <span
          aria-hidden
          className="absolute -top-1.5 h-6 w-1 -translate-x-1/2 rounded-full transition-[left] duration-700 ease-out"
          style={{ left: pos(temp), background: ink, boxShadow: '0 0 0 2px var(--panel)' }}
        />
      )}
    </div>
  );
}
