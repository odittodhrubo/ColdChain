import { CircleAlert, CircleCheck, CloudOff, TriangleAlert, type LucideIcon } from 'lucide-react';
import { SAFE_MAX_C } from '../lib/constants';
import { ago } from '../lib/time';
import type { Prediction, RiskLevel } from '../lib/types';

/** Risk as colour + glyph + word, like the status chips (never colour alone). */
export const RISK: Record<RiskLevel, { label: string; ink: string; wash: string; icon: LucideIcon }> = {
  LOW: { label: 'Low risk', ink: 'var(--safe)', wash: 'var(--safe-wash)', icon: CircleCheck },
  MEDIUM: { label: 'Medium risk', ink: 'var(--warning)', wash: 'var(--warning-wash)', icon: TriangleAlert },
  HIGH: { label: 'High risk', ink: 'var(--breach)', wash: 'var(--breach-wash)', icon: CircleAlert },
};

/** Older than this the forecast is not shown as current (two scheduler runs plus slack). */
export const STALE_AFTER_MS = 75_000;

export function RiskBadge({ level, size = 'md' }: { level: RiskLevel; size?: 'sm' | 'md' }) {
  const r = RISK[level];
  const Icon = r.icon;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-semibold whitespace-nowrap ${
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm'
      }`}
      style={{
        color: r.ink,
        backgroundColor: r.wash,
        borderColor: `color-mix(in oklab, ${r.ink} 35%, transparent)`,
      }}
    >
      <Icon aria-hidden className={size === 'sm' ? 'size-3.5' : 'size-4'} />
      {r.label}
    </span>
  );
}

const c = (v: number | null) => (v === null ? '?' : `${v.toFixed(1)} °C`);

/** "Forecast 8.9 °C in 30 min – may exceed 8 °C in ~18 min": the one-line why behind the badge. */
export function forecastSentence(p: Prediction): string {
  const head = `Forecast ${c(p.pred_temp_30)} in 30 min`;
  const now = p.features_used?.temp_now ?? null;
  if (now !== null && now > SAFE_MAX_C) return `${head}: already above ${SAFE_MAX_C} °C`;
  if (p.minutes_to_breach_estimate !== null && p.breach_level !== 'LOW')
    return `${head} – may exceed ${SAFE_MAX_C} °C in ~${Math.max(1, Math.round(p.minutes_to_breach_estimate))} min`;
  if (p.breach_level === 'LOW') return `${head}, staying within 2–8 °C`;
  return `${head}, could reach ${c(p.p90)} at worst`;
}

/** Where the numbers come from and how old they are. A stale or fallback answer is never shown as live. */
export function PredictionMeta({ p, now }: { p: Prediction; now: number }) {
  const age = Math.max(0, (now - p.created_at) / 1000);
  const old = now - p.created_at > STALE_AFTER_MS;
  return (
    <p className="figures flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
      {p.source === 'fallback' && (
        <span className="inline-flex items-center gap-1 rounded-full bg-warning-wash px-2 py-0.5 font-semibold text-warning">
          <CloudOff aria-hidden className="size-3" />
          rule-based fallback · AI service down
        </span>
      )}
      {old && <span className="rounded-full bg-panel-2 px-2 py-0.5 font-semibold text-offline">stale</span>}
      <span>updated {ago(age)}</span>
    </p>
  );
}

/** Compact "Next 30 min" line for a fridge card. */
export function ForecastChip({ p, now }: { p: Prediction | null | undefined; now: number }) {
  if (!p)
    return (
      <p className="flex min-h-9 items-center text-xs text-ink-3">
        Next 30 min: forecast appears after a few minutes of data
      </p>
    );
  const old = now - p.created_at > STALE_AFTER_MS;
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-2 text-sm">
      <span className="font-semibold text-ink-2">Next 30 min</span>
      <span className="figures font-semibold text-ink">{c(p.pred_temp_30)}</span>
      <RiskBadge level={p.breach_level} size="sm" />
      {(p.source === 'fallback' || old) && (
        <span className="text-xs font-semibold text-offline">
          {p.source === 'fallback' ? 'fallback' : 'stale'}
        </span>
      )}
    </div>
  );
}
