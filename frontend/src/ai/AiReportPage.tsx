import { useQuery } from '@tanstack/react-query';
import { FlaskConical, Printer } from 'lucide-react';
import type { ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fmt, useT } from '../i18n';
import { PageHeader } from '../layout/AppShell';
import { api, ApiError } from '../lib/api';
import { Button } from '../ui/Button';
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
interface Accuracy {
  test_mae: number;
  drift_factor: number;
  horizon_min: number;
  fridges: { fridge_id: string; name: string; mae_24h: number | null; n_24h: number; drift: boolean }[];
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
        credentials: 'same-origin', // the HttpOnly session cookie
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
  const { t } = useT();
  const { data, isPending, error } = useFigure(url);
  if (!url) return null;
  if (isPending) return <Skeleton className="my-3 h-56 w-full" />;
  if (error) return <p className="my-3 text-sm text-ink-3">{fmt(t('ai.figureNa'), { alt })}</p>;
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

/** A1: live rolling forecast error per fridge, measured against what actually happened 30 min later. */
function LiveAccuracy({ offlineMae }: { offlineMae: number }) {
  const { t } = useT();
  const { data } = useQuery({
    queryKey: ['ml-accuracy'],
    staleTime: 60_000,
    queryFn: ({ signal }) => api<Accuracy>('/api/ml/accuracy', { signal }),
  });
  if (!data) return null;
  return (
    <Panel title={t('ai.live.title')}>
      <p className="figures text-sm text-ink-2">
        {fmt(t('ai.live.intro'), {
          m: data.horizon_min,
          mae: offlineMae.toFixed(2),
          f: data.drift_factor,
        })}
      </p>
      <table className="figures mt-3 w-full border-collapse text-left text-sm">
        <caption className="sr-only">{t('ai.live.title')}</caption>
        <thead className="bg-panel-2">
          <tr>
            {[
              t('ai.live.colFridge'),
              t('ai.live.colMae'),
              t('ai.live.colScored'),
              t('ai.live.colStatus'),
            ].map((h) => (
              <th
                key={h}
                scope="col"
                className="border-b border-rule px-3 py-2 text-xs font-semibold text-ink-2"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.fridges.map((f) => (
            <tr key={f.fridge_id} className="border-b border-rule last:border-b-0">
              <td className="px-3 py-2 font-semibold text-ink">{f.name}</td>
              <td className="px-3 py-2 text-ink">
                {f.mae_24h === null ? '–' : `${f.mae_24h.toFixed(2)} °C`}
              </td>
              <td className="px-3 py-2 text-ink-2">{f.n_24h}</td>
              <td className="px-3 py-2">
                {f.mae_24h === null ? (
                  <span className="text-ink-3">{t('ai.live.noData')}</span>
                ) : f.drift ? (
                  <span className="font-semibold text-warning">{t('ai.live.drifting')}</span>
                ) : (
                  <span className="font-semibold text-safe">{t('ai.live.inRange')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

export function AiReportPage() {
  const { t } = useT();
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

  // Print the report: drop the app chrome (print:hidden + body.printing-report), restore it when done.
  const printReport = () => {
    document.body.classList.add('printing-report');
    const cleanup = () => {
      document.body.classList.remove('printing-report');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
  };
  return (
    <>
      <PageHeader
        title={t('page.aiReport.title')}
        subtitle={t('page.aiReport.subtitle')}
        actions={
          !isPending &&
          !error && (
            <Button
              variant="secondary"
              className="print:hidden"
              icon={<Printer aria-hidden className="size-4" />}
              onClick={printReport}
            >
              {t('ai.print')}
            </Button>
          )
        }
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
            <p className="px-4 pb-4 text-sm text-ink-2">{t('ai.unavailable')}</p>
          )}
        </Panel>
      ) : (
        <ReportBody data={data} components={components} />
      )}
    </>
  );
}

function ReportBody({ data, components }: { data: Report; components: Components }) {
  const { t } = useT();
  const m = data.metrics;
  const f = m.forecast;
  const days = m.dataset.profiles[0]?.days;
  return (
    <div className="flex flex-col gap-5">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/50 bg-warning-wash px-2.5 py-1 font-semibold text-warning">
          <FlaskConical aria-hidden className="size-4" />
          {t('ai.synthetic')}
        </span>
        <span className="figures rounded-full bg-panel-2 px-2.5 py-1 text-ink-2">
          model {data.model_card?.trained_at ?? m.trained_at} · scikit-learn{' '}
          {data.model_card?.versions?.['scikit-learn'] ?? '?'}
        </span>
      </p>
      <section aria-label="Key results" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label={t('ai.kpiForecast')}
          value={`${f.models.hgb.mae.toFixed(2)} °C`}
          sub={fmt(t('ai.kpiForecastSub'), {
            p: f.models.persistence.mae.toFixed(2),
            l: f.models.linear.mae.toFixed(2),
            ph: f.models.physics.mae.toFixed(2),
            r: f.models.hgb.rmse.toFixed(2),
          })}
        />
        <Kpi
          label={t('ai.kpiBreach')}
          value={fmt(t('ai.kpiBreachVal'), { pct: pct(f.breach.recall) })}
          sub={fmt(t('ai.kpiBreachSub'), {
            p: pct(f.breach.precision),
            fa: f.breach.false_alarms_per_fridge_day.toFixed(1),
          })}
        />
        <Kpi
          label={t('ai.kpiLead')}
          value={f.lead_time.median_min == null ? '–' : `${Math.round(f.lead_time.median_min)} min`}
          sub={fmt(t('ai.kpiLeadSub'), { share: pct(f.lead_time.warned_share), n: f.lead_time.episodes })}
        />
        <Kpi
          label={t('ai.kpiHealth')}
          value={fmt(t('ai.kpiHealthVal'), { v: m.health.final.mae.toFixed(1) })}
          sub={fmt(t('ai.kpiHealthSub'), {
            s: m.health.spearman.toFixed(2),
            d: m.health.weakening.detected,
            a: m.health.weakening.arcs_in_test,
          })}
        />
      </section>
      <LiveAccuracy offlineMae={f.models.hgb.mae} />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title={t('ai.datasetTitle')}>
          <p className="figures text-sm text-ink">
            {fmt(t('ai.datasetBody'), {
              n: m.dataset.profiles.length,
              days: days ?? '',
              rows: m.dataset.raw_rows.toLocaleString(),
              held: m.dataset.held_out_profiles.join(', '),
            })}
          </p>
          <p className="figures mt-2 text-sm text-ink-2">
            {fmt(t('ai.datasetBody2'), {
              cov: pct(f.interval.coverage),
              ff: m.dataset.features,
              hf: m.dataset.health_features,
            })}
          </p>
        </Panel>
        <Panel title={t('ai.modelsTitle')}>
          <div className="grid gap-5 sm:grid-cols-2">
            <Importance title={t('ai.modelsForecast')} items={m.importance.forecast} />
            <Importance title={t('ai.modelsHealth')} items={m.importance.health} />
          </div>
          <p className="mt-3 text-xs text-ink-3">{t('ai.modelsBar')}</p>
        </Panel>
      </div>
      <Panel title={t('ai.fullReport')}>
        <article className="mx-auto max-w-[72ch]">
          <Markdown remarkPlugins={[remarkGfm]} components={components}>
            {data.report_md}
          </Markdown>
        </article>
      </Panel>
    </div>
  );
}
