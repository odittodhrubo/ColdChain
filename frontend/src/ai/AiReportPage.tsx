import { useQuery } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import type { ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { session } from '../auth/session';
import { PageHeader } from '../layout/AppShell';
import { api, ApiError } from '../lib/api';
import { Panel } from '../ui/Panel';
import { ErrorState, Skeleton } from '../ui/States';

interface Reg {
  mae: number;
  rmse: number;
  r2: number;
}
interface Metrics {
  trained_at: string;
  dataset: {
    profiles: { profile: { name: string; held_out: boolean }; days: number }[];
    raw_rows: number;
    features: number;
    health_features: number;
    held_out_profiles: string[];
    by_split: Record<string, { forecast_rows: number; breach_rate: number | null }>;
  };
  forecast: {
    models: Record<'hgb' | 'random_forest' | 'persistence' | 'linear' | 'physics', Reg>;
    interval: { coverage: number };
    breach: { precision: number; recall: number; f1: number; false_alarms_per_fridge_day: number };
    lead_time: { median_min: number | null; warned_share: number | null; episodes: number };
  };
  health: {
    final: Reg;
    spearman: number;
    weakening: { detected: number; arcs_in_test: number; median_delay_days: number | null };
  };
  importance: {
    forecast: { feature: string; mae_increase: number }[];
    health: { feature: string; mae_increase: number }[];
  };
}
interface Report {
  metrics: Metrics;
  report_md: string;
  figures: { name: string; url: string }[];
  model_card: { trained_at: string; versions: Record<string, string> } | null;
}

/** Figures need the bearer token, so they are fetched and shown as data URLs. */
function useFigure(url: string | undefined) {
  return useQuery({
    queryKey: ['ml-report', 'figure', url],
    enabled: !!url,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const res = await fetch(url!, {
        signal,
        headers: { Authorization: `Bearer ${session.get()?.token ?? ''}` },
      });
      if (!res.ok) throw new ApiError(res.status, `HTTP_${res.status}`, 'Could not load the figure');
      const blob = await res.blob();
      return await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
    },
  });
}

function Figure({ url, alt }: { url?: string; alt: string }) {
  const { data, isPending, error } = useFigure(url);
  if (!url) return null;
  if (isPending) return <Skeleton className="my-3 h-56 w-full" />;
  if (error) return <p className="my-3 text-sm text-ink-3">Figure not available: {alt}</p>;
  return (
    <img
      src={data}
      alt={alt}
      className="my-3 max-h-[26rem] w-auto max-w-full rounded-md border border-rule bg-white"
      loading="lazy"
    />
  );
}

function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub: ReactNode }) {
  return (
    <Panel bodyClassName="p-4">
      <p className="text-xs font-semibold text-ink-3">{label}</p>
      <p className="figures mt-1 text-2xl font-bold text-ink">{value}</p>
      <p className="figures mt-1 text-xs text-ink-2">{sub}</p>
    </Panel>
  );
}

const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v * 100)} %`);

function Importance({ title, items }: { title: string; items: { feature: string; mae_increase: number }[] }) {
  const max = Math.max(...items.map((i) => i.mae_increase), 1e-9);
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-ink">{title}</h3>
      <ul className="flex flex-col gap-1.5">
        {items.slice(0, 8).map((i) => (
          <li key={i.feature} className="grid grid-cols-[minmax(0,11rem)_1fr] items-center gap-2 text-xs">
            <code className="truncate text-ink-2">{i.feature}</code>
            <span
              className="h-2.5 rounded-sm bg-teal"
              style={{ width: `${Math.max(2, (100 * i.mae_increase) / max)}%` }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AiReportPage() {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['ml-report'],
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) => api<Report>('/api/ml/report', { signal }),
  });
  const figureUrl = (src: string | undefined) => data?.figures.find((f) => src?.endsWith(f.name))?.url;
  const components: Components = {
    img: ({ src, alt }) => (
      <Figure url={figureUrl(typeof src === 'string' ? src : undefined)} alt={alt ?? ''} />
    ),
    a: ({ href, children }) =>
      href?.startsWith('http') ? (
        <a href={href} target="_blank" rel="noreferrer" className="text-teal-strong underline">
          {children}
        </a>
      ) : (
        <span className="font-medium">{children}</span> // repository paths: not routes in this app
      ),
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto">
        <table className="figures w-full border-collapse text-left text-sm">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-b border-rule bg-panel-2 px-3 py-2 text-xs font-semibold text-ink-2">
        {children}
      </th>
    ),
    td: ({ children }) => <td className="border-b border-rule px-3 py-1.5 text-ink">{children}</td>,
    h1: ({ children }) => <h2 className="mt-2 mb-2 text-xl font-bold text-ink">{children}</h2>,
    h2: ({ children }) => <h3 className="mt-6 mb-2 text-lg font-bold text-ink">{children}</h3>,
    p: ({ children }) => <p className="my-2 leading-relaxed text-ink">{children}</p>,
    ul: ({ children }) => <ul className="my-2 list-disc pl-6 text-ink">{children}</ul>,
    code: ({ children }) => <code className="rounded bg-panel-2 px-1 text-[0.9em]">{children}</code>,
    pre: ({ children }) => (
      <pre className="my-3 overflow-x-auto rounded-md bg-panel-2 p-3 text-xs">{children}</pre>
    ),
  };

  return (
    <>
      <PageHeader
        title="AI Report"
        subtitle="How the forecast and the compressor health score were built and how well they do"
      />
      {isPending ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-96" />
        </div>
      ) : error ? (
        <Panel>
          <ErrorState error={error} onRetry={() => void refetch()} />
          {error instanceof ApiError && error.code === 'ML_UNAVAILABLE' && (
            <p className="px-4 pb-4 text-sm text-ink-2">
              The AI service is not running, so its report cannot be shown.
            </p>
          )}
        </Panel>
      ) : (
        <ReportBody data={data} components={components} />
      )}
    </>
  );
}

function ReportBody({ data, components }: { data: Report; components: Components }) {
  const m = data.metrics;
  const f = m.forecast;
  const days = m.dataset.profiles[0]?.days;
  return (
    <div className="flex flex-col gap-5">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/50 bg-warning-wash px-2.5 py-1 font-semibold text-warning">
          <FlaskConical aria-hidden className="size-4" />
          Trained on synthetic data
        </span>
        <span className="figures rounded-full bg-panel-2 px-2.5 py-1 text-ink-2">
          model {data.model_card?.trained_at ?? m.trained_at} · scikit-learn{' '}
          {data.model_card?.versions?.['scikit-learn'] ?? '?'}
        </span>
      </p>
      <section aria-label="Key results" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Forecast error, 30 min ahead"
          value={`${f.models.hgb.mae.toFixed(2)} °C`}
          sub={`MAE · persistence ${f.models.persistence.mae.toFixed(2)}, linear ${f.models.linear.mae.toFixed(2)}, physics ${f.models.physics.mae.toFixed(2)} · RMSE ${f.models.hgb.rmse.toFixed(2)}`}
        />
        <Kpi
          label="Breach warnings"
          value={`${pct(f.breach.recall)} caught`}
          sub={`precision ${pct(f.breach.precision)} · ${f.breach.false_alarms_per_fridge_day.toFixed(1)} false alarms per fridge-day`}
        />
        <Kpi
          label="Warning lead time"
          value={f.lead_time.median_min == null ? '–' : `${Math.round(f.lead_time.median_min)} min`}
          sub={`median before 8 °C · ${pct(f.lead_time.warned_share)} of ${f.lead_time.episodes} breaches warned`}
        />
        <Kpi
          label="Compressor health error"
          value={`${m.health.final.mae.toFixed(1)} points`}
          sub={`Spearman ${m.health.spearman.toFixed(2)} · ${m.health.weakening.detected}/${m.health.weakening.arcs_in_test} degradations flagged`}
        />
      </section>
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Dataset">
          <p className="figures text-sm text-ink">
            {m.dataset.profiles.length} simulated fridges × {days} days ({m.dataset.raw_rows.toLocaleString()}{' '}
            one-minute rows), from the same physics as the device simulator: door openings, door left ajar,
            power cuts, compressor wear and faults, sensor noise and gaps. Held out for testing:{' '}
            {m.dataset.held_out_profiles.join(', ')}.
          </p>
          <p className="figures mt-2 text-sm text-ink-2">
            Interval coverage {pct(f.interval.coverage)} (target 80 %) · {m.dataset.features} forecast
            features, {m.dataset.health_features} health features
          </p>
        </Panel>
        <Panel title="What the models look at">
          <div className="grid gap-5 sm:grid-cols-2">
            <Importance title="Forecast" items={m.importance.forecast} />
            <Importance title="Compressor health" items={m.importance.health} />
          </div>
          <p className="mt-3 text-xs text-ink-3">
            Bar = how much the error grows when that input is shuffled.
          </p>
        </Panel>
      </div>
      <Panel title="Full report">
        <article className="max-w-[72ch]">
          <Markdown remarkPlugins={[remarkGfm]} components={components}>
            {data.report_md}
          </Markdown>
        </article>
      </Panel>
    </div>
  );
}
