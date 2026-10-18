import { Wrench } from 'lucide-react';
import { Line, LineChart, ReferenceLine, ResponsiveContainer, YAxis } from 'recharts';
import type { Prediction } from '../lib/types';
import { useHealthHistory } from './queries';

const BANDS = [
  { from: 0, to: 50, label: 'Failing', ink: 'var(--breach)' },
  { from: 50, to: 80, label: 'Weakening', ink: 'var(--warning)' },
  { from: 80, to: 100, label: 'Good', ink: 'var(--safe)' },
] as const;

export const bandOf = (score: number) => BANDS.find((b) => score < b.to) ?? BANDS[2];

// semicircle: score 0 at the left end, 100 at the right end
const R = 52;
const point = (score: number) => {
  const a = Math.PI * (1 - score / 100);
  return [60 + R * Math.cos(a), 62 - R * Math.sin(a)] as const;
};
const arc = (from: number, to: number) => {
  const [x1, y1] = point(from);
  const [x2, y2] = point(to);
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
};

/** Plain-language reasons behind the score, from the cycle features the model used. */
export function healthFactors(p: Prediction): string[] {
  const f = p.health_factors ?? {};
  const out: string[] = [];
  if (f.cool_rate_on != null)
    out.push(
      f.cool_rate_on > 0
        ? `While running it cools ${f.cool_rate_on.toFixed(2)} °C a minute`
        : 'While running it no longer cools the fridge down',
    );
  if (f.duty_24 != null) out.push(`It ran ${Math.round(f.duty_24 * 100)} % of the time over the last day`);
  if (f.cycles_per_hour != null && f.n_cycles != null && f.n_cycles >= 3)
    out.push(`${f.cycles_per_hour.toFixed(1)} on/off cycles an hour`);
  if (f.longest_on_run != null && f.longest_on_run >= 60)
    out.push(`Longest continuous run ${Math.round(f.longest_on_run)} min`);
  if (p.health_method === 'fallback') out.push('Too few complete cycles: scored from its cooling rate alone');
  if (p.health_method === 'insufficient') out.push('Not enough compressor data yet to judge');
  if (p.health_trend_per_day != null)
    out.push(
      `Trend ${p.health_trend_per_day > 0 ? '+' : ''}${p.health_trend_per_day.toFixed(1)} points a day`,
    );
  return out;
}

function Trend({ fridgeId }: { fridgeId: string }) {
  const { data } = useHealthHistory(fridgeId);
  if (!data || data.length < 2)
    return <p className="text-xs text-ink-3">7-day trend appears as scores build up</p>;
  return (
    <div
      className="h-10"
      role="img"
      aria-label={`Health over 7 days, from ${Math.round(data[0].health)} to ${Math.round(data.at(-1)!.health)}`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <YAxis hide domain={[0, 100]} />
          <ReferenceLine y={70} stroke="var(--warning)" strokeDasharray="3 3" />
          <Line
            type="monotone"
            dataKey="health"
            stroke="var(--ink-2)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Compressor health 0-100 on a semicircle with the Good / Weakening / Failing bands. */
export function HealthGauge({ p, fridgeId }: { p: Prediction; fridgeId: string }) {
  const score = p.health_score;
  const band = score === null ? null : bandOf(score);
  const factors = healthFactors(p);
  return (
    <section aria-label="Compressor health" className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <svg
          viewBox="0 0 120 70"
          className="w-40 shrink-0"
          role="img"
          aria-label={
            score === null ? 'Health unknown' : `Health ${Math.round(score)} of 100, ${band!.label}`
          }
        >
          {BANDS.map((b) => (
            <path
              key={b.label}
              d={arc(b.from, b.to)}
              stroke={b.ink}
              strokeOpacity={0.22}
              strokeWidth={10}
              fill="none"
            />
          ))}
          {score !== null && (
            <path
              d={arc(0, Math.max(0.5, Math.min(100, score)))}
              stroke={band!.ink}
              strokeWidth={10}
              fill="none"
              strokeLinecap="butt"
            />
          )}
          <text
            x="60"
            y="58"
            textAnchor="middle"
            className="figures"
            fontSize="22"
            fontWeight="800"
            fill="var(--ink)"
          >
            {score === null ? '–' : Math.round(score)}
          </text>
          <text x="60" y="69" textAnchor="middle" fontSize="8" fill="var(--ink-3)">
            of 100
          </text>
        </svg>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink-3">Compressor health</p>
          <p className="text-lg font-bold" style={{ color: band?.ink ?? 'var(--ink-3)' }}>
            {band?.label ?? 'Unknown'}
          </p>
          <p className="text-xs text-ink-3">80–100 good · 50–79 weakening · under 50 failing</p>
        </div>
      </div>
      {p.weakening && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-wash px-3 py-2 text-sm font-semibold text-warning"
        >
          <Wrench aria-hidden className="mt-0.5 size-4 shrink-0" />
          Weakening compressor – service recommended
        </p>
      )}
      <Trend fridgeId={fridgeId} />
      {factors.length > 0 && (
        <details className="group text-sm">
          <summary className="cursor-pointer font-semibold text-teal-strong">Why this score</summary>
          <ul className="mt-1.5 list-disc pl-5 text-ink-2">
            {factors.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
