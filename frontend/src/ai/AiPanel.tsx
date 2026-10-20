import { BrainCircuit } from 'lucide-react';
import { useT } from '../i18n';
import { Panel } from '../ui/Panel';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { forecastSentence, PredictionMeta, RiskBadge } from './Forecast';
import { HealthGauge } from './HealthGauge';
import { usePrediction } from './queries';

/** Fridge detail: the 30-minute forecast with its range and the compressor health, each with its why. */
export function AiPanel({ fridgeId, now }: { fridgeId: string; now: number }) {
  const { data, isPending, error, refetch } = usePrediction(fridgeId);
  const { t } = useT();
  const p = data?.latest;
  return (
    <Panel title="AI forecast and compressor health">
      {isPending ? (
        <Skeleton className="h-56" />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : !p ? (
        <EmptyState icon={<BrainCircuit aria-hidden className="size-6" />} title="No forecast yet">
          The forecast starts once the node has sent about 20 minutes of readings, and refreshes every 30
          seconds.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-5">
          <section aria-label="30-minute forecast" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <RiskBadge level={p.breach_level} />
              <span key={p.created_at} className="value-flash figures text-sm font-semibold text-ink">
                {forecastSentence(p, t)}
              </span>
            </div>
            {p.p10 !== null && p.p90 !== null && (
              <p className="figures text-sm text-ink-2">
                80 % likely between {p.p10.toFixed(1)} and {p.p90.toFixed(1)} °C
                {p.breach_prob !== null && ` · breach probability ${Math.round(p.breach_prob * 100)} %`}
              </p>
            )}
            <PredictionMeta p={p} now={now} />
          </section>
          <HealthGauge p={p} fridgeId={fridgeId} />
        </div>
      )}
    </Panel>
  );
}
