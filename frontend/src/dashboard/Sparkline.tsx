import { useMemo } from 'react';
import { Line, LineChart, ReferenceArea, ResponsiveContainer, YAxis } from 'recharts';
import { useReadings, type HistoryPoint } from '../lib/queries';
import { SAFE_MAX_C, SAFE_MIN_C } from '../lib/constants';
import type { LiveState } from '../lib/types';
import { Skeleton } from '../ui/States';

/** The last 30 minutes at a glance, against the safe band. */
export function Sparkline({
  fridgeId,
  ink,
  live,
}: {
  fridgeId: string;
  ink: string;
  live?: LiveState | null;
}) {
  const { data, isPending } = useReadings(fridgeId, 30 * 60, 30);
  const points = useMemo(() => {
    const raw = data?.points ? [...data.points] : [];
    if (!live || live.temp === null || live.temp === undefined || !live.ts) return raw;
    const bucket = data?.bucket ?? 30;
    const liveTs = Math.floor(live.ts / bucket) * bucket;
    if (raw.length === 0) {
      return [{ ts: liveTs, temp: live.temp } as HistoryPoint];
    }
    const last = raw[raw.length - 1];
    if (liveTs > last.ts) {
      raw.push({ ...last, ts: liveTs, temp: live.temp });
    } else {
      raw[raw.length - 1] = { ...last, temp: live.temp };
    }
    return raw;
  }, [data, live]);

  if (isPending) return <Skeleton className="h-12 w-full" />;
  if (points.length < 2)
    return <p className="flex h-12 items-center text-xs text-ink-3">No readings in the last 30 minutes</p>;
  return (
    <div className="h-12" aria-label="Temperature over the last 30 minutes" role="img">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <YAxis
            hide
            domain={[(d: number) => Math.min(d, SAFE_MIN_C - 1), (d: number) => Math.max(d, SAFE_MAX_C + 1)]}
          />
          <ReferenceArea
            y1={SAFE_MIN_C}
            y2={SAFE_MAX_C}
            fill="var(--safe)"
            fillOpacity={0.09}
            stroke="none"
          />
          <Line
            type="monotone"
            dataKey="temp"
            stroke={ink}
            strokeWidth={1.75}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
