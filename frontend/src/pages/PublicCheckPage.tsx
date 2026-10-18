import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, SearchX, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Logo } from '../layout/Logo';
import { api, ApiError } from '../lib/api';
import { VvmMark } from '../ui/VvmMark';

interface PublicBatch {
  name: string;
  lot_number: string;
  expiry_date: string;
  status: 'SAFE' | 'AT_RISK' | 'DISCARD';
  expired: boolean;
  last_checked: string;
}

// Plain guidance for whoever holds the vial: staff and the public read a colour very differently.
const VERDICT = {
  SAFE: {
    word: 'SAFE',
    icon: CircleCheck,
    ink: 'var(--safe)',
    wash: 'var(--safe-wash)',
    guidance: 'Safe to use. This batch stayed within its storage limits.',
  },
  AT_RISK: {
    word: 'AT RISK',
    icon: TriangleAlert,
    ink: 'var(--atrisk)',
    wash: 'var(--atrisk-wash)',
    guidance:
      'Use only on a pharmacist’s instruction. This batch was warm for a while; ask staff to verify it first.',
  },
  DISCARD: {
    word: 'DISCARD',
    icon: CircleX,
    ink: 'var(--discard)',
    wash: 'var(--discard-wash)',
    guidance: 'Do not use. Report this vial to the pharmacist.',
  },
} as const;

/** Keep this page out of search engines while it is open. */
function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    const title = document.title;
    document.title = 'Batch check · ColdChain';
    return () => {
      meta.remove();
      document.title = title;
    };
  }, []);
}

/**
 * Public QR check (/check/:token): no login and no app chrome, one card. Calls only the public endpoint, which
 * returns a fixed whitelist (name, lot, expiry, status, last checked); nothing internal is on this page.
 */
export function PublicCheckPage() {
  useNoIndex();
  const { token = '' } = useParams();
  const { data, error, isPending } = useQuery({
    queryKey: ['public-batch', token],
    retry: false,
    queryFn: ({ signal }) =>
      api<PublicBatch>(`/api/public/batch/${encodeURIComponent(token)}`, { signal, auth: false }),
  });
  const err = error instanceof ApiError ? error : null;

  return (
    <main className="flex min-h-dvh flex-col items-center bg-ground px-4 py-6">
      <div className="w-full max-w-sm">
        <div className="mb-5 flex justify-center">
          <Logo />
        </div>
        {isPending ? (
          <div
            className="h-96 animate-pulse rounded-[var(--radius-label)] bg-panel"
            aria-label="Checking the batch"
          />
        ) : err?.status === 404 || (!data && !err) ? (
          <section className="rounded-[var(--radius-label)] border border-rule bg-panel p-6 text-center">
            <SearchX aria-hidden className="mx-auto size-10 text-ink-3" />
            <h1 className="mt-3 text-xl font-bold text-ink">Batch not found</h1>
            <p className="mt-2 text-sm text-ink-2">
              This code doesn’t match any batch. Check that you scanned the whole label, or ask the
              pharmacist.
            </p>
          </section>
        ) : err ? (
          <section
            role="alert"
            className="rounded-[var(--radius-label)] border border-rule bg-panel p-6 text-center"
          >
            <h1 className="text-xl font-bold text-ink">Can’t check right now</h1>
            <p className="mt-2 text-sm text-ink-2">
              {err.status === 429
                ? 'Too many checks from this connection. Wait a minute and try again.'
                : 'The service did not answer. Try again in a moment.'}
            </p>
          </section>
        ) : (
          <Verdict batch={data!} />
        )}
        <p className="mt-5 text-center text-xs text-ink-3">
          ColdChain batch check · vaccines must stay between 2 and 8 °C
        </p>
      </div>
    </main>
  );
}

function Verdict({ batch }: { batch: PublicBatch }) {
  const v = VERDICT[batch.status];
  const Icon = v.icon;
  const checked = new Date(batch.last_checked);
  return (
    <section
      aria-labelledby="verdict"
      className="overflow-hidden rounded-[var(--radius-label)] border bg-panel"
      style={{ borderColor: `color-mix(in oklab, ${v.ink} 45%, transparent)` }}
    >
      <div
        className={`flex flex-col items-center gap-2 px-6 pt-7 pb-6 text-center ${batch.status === 'DISCARD' ? 'strike-pattern' : ''}`}
        style={{ backgroundColor: v.wash }}
      >
        <Icon aria-hidden className="size-14" style={{ color: v.ink }} strokeWidth={2.25} />
        <h1
          id="verdict"
          className="text-[2.6rem] leading-none font-extrabold tracking-[-0.02em]"
          style={{ color: v.ink }}
        >
          {v.word}
        </h1>
        <p className="mt-1 text-base font-semibold text-ink">{v.guidance}</p>
      </div>
      <dl className="figures divide-y divide-rule px-6 text-sm">
        <div className="flex justify-between gap-4 py-3">
          <dt className="text-ink-2">Vaccine</dt>
          <dd className="text-right font-semibold text-ink">{batch.name}</dd>
        </div>
        <div className="flex justify-between gap-4 py-3">
          <dt className="text-ink-2">Lot</dt>
          <dd className="text-right font-semibold text-ink">{batch.lot_number}</dd>
        </div>
        <div className="flex justify-between gap-4 py-3">
          <dt className="text-ink-2">Expiry date</dt>
          <dd
            className="text-right font-semibold"
            style={{ color: batch.expired ? 'var(--breach)' : 'var(--ink)' }}
          >
            {batch.expiry_date}
            {batch.expired && <span className="ml-2 font-bold">Expired</span>}
          </dd>
        </div>
        <div className="flex justify-between gap-4 py-3">
          <dt className="text-ink-2">Last checked</dt>
          <dd className="text-right text-ink">
            {checked.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
          </dd>
        </div>
      </dl>
      <div className="flex items-center justify-center gap-2 border-t border-rule px-6 py-3 text-xs text-ink-3">
        <VvmMark status={batch.status} size={16} />
        Heat budget read like a vial monitor label
      </div>
    </section>
  );
}
