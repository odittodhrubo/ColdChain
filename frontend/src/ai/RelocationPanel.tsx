import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, PackageX, ShieldAlert, Truck } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/permissions';
import { api, ApiError } from '../lib/api';
import { mmss } from '../lib/time';
import type { RelocationPlan } from '../lib/types';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { RISK } from './Forecast';

const URGENCY_LABEL = { HIGH: 'Move first', MEDIUM: 'Soon', LOW: 'When possible' } as const;

function replacePlan(qc: ReturnType<typeof useQueryClient>, plan: RelocationPlan) {
  qc.setQueriesData<RelocationPlan[]>({ queryKey: ['relocations'] }, (old) =>
    old?.map((p) => (p.id === plan.id ? plan : p)),
  );
}

function DismissDialog({ plan, onClose }: { plan: RelocationPlan; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const dismiss = useMutation({
    mutationFn: () =>
      api<{ plan: RelocationPlan }>(`/api/relocations/${plan.id}/dismiss`, {
        method: 'POST',
        body: { reason: reason.trim() },
      }),
    onSuccess: () => {
      toast({ tone: 'info', title: 'Plan dismissed', body: 'No new plan for this fridge for 15 minutes.' });
      void qc.invalidateQueries({ queryKey: ['relocations'] });
      onClose();
    },
  });
  const short = reason.trim().length < 3;
  return (
    <Modal
      open
      onClose={onClose}
      title="Dismiss this plan?"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={dismiss.isPending}>
            Keep it
          </Button>
          <Button
            variant="danger"
            disabled={short}
            loading={dismiss.isPending}
            onClick={() => dismiss.mutate()}
          >
            Dismiss plan
          </Button>
        </>
      }
    >
      <Field
        label="Why? (kept in the audit log)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={dismiss.error instanceof Error ? dismiss.error.message : null}
        hint="For example: batches already moved by hand, or the fridge has been repaired."
      />
    </Modal>
  );
}

/**
 * One relocation plan: why, which batch goes where, how safe the destination is, and the single confirm
 * click (Admin / Pharmacist; everyone else reads it). A 409 shows the refreshed plan and what changed.
 */
export function PlanCard({ plan, now }: { plan: RelocationPlan; now: number }) {
  const { user } = useAuth();
  const mayConfirm = can(user?.role, 'relocation:confirm');
  const qc = useQueryClient();
  const toast = useToast();
  const [changed, setChanged] = useState<string[] | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const none = plan.status === 'NO_SAFE_TARGET';
  const left = Math.max(0, Math.round((plan.expires_at - now) / 1000));

  const confirm = useMutation({
    mutationFn: () =>
      api<{ plan: RelocationPlan; already: boolean }>(`/api/relocations/${plan.id}/confirm`, {
        method: 'POST',
        body: { version: plan.version },
      }),
    onSuccess: ({ plan: done }) => {
      const n = done.moves.length;
      toast({
        tone: 'success',
        title: `Relocation confirmed: ${n} batch${n === 1 ? '' : 'es'} moved`,
        body: [...new Set(done.moves.map((m) => m.to_fridge_name))].join(', '),
        link: { to: '/audit?type=RELOCATION_CONFIRMED', label: 'View the audit entry' },
      });
      replacePlan(qc, done);
      for (const key of ['relocations', 'batches', 'batch', 'fridges', 'fridge', 'alerts'])
        void qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (err) => {
      const details =
        err instanceof ApiError
          ? (err.details as { plan?: RelocationPlan; problems?: string[] } | undefined)
          : undefined;
      if (err instanceof ApiError && err.status === 409 && details?.plan) {
        replacePlan(qc, details.plan); // show the refreshed plan in place of the one that went stale
        setChanged(details.problems?.length ? details.problems : [err.message]);
      } else
        toast({
          tone: 'error',
          title: 'Could not confirm',
          body: err instanceof Error ? err.message : undefined,
        });
      void qc.invalidateQueries({ queryKey: ['relocations'] });
    },
  });

  return (
    <article
      aria-labelledby={`plan-${plan.id}`}
      className={`overflow-hidden rounded-[var(--radius-label)] border bg-panel ${none ? 'border-breach' : 'border-warning/60'}`}
    >
      <header
        className={`flex flex-wrap items-start justify-between gap-3 px-4 py-3 ${none ? 'bg-breach-wash' : 'bg-warning-wash'}`}
      >
        <div className="flex min-w-0 items-start gap-3">
          {none ? (
            <ShieldAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-breach" />
          ) : (
            <Truck aria-hidden className="mt-0.5 size-5 shrink-0 text-warning" />
          )}
          <div className="min-w-0">
            <h2 id={`plan-${plan.id}`} className="text-base font-bold text-ink">
              {none
                ? `No safe fridge for the batches in ${plan.from_fridge_name}`
                : `Move batches out of ${plan.from_fridge_name}`}
            </h2>
            <p className="text-sm text-ink">
              {plan.from_fridge_name} may become unsafe because {plan.risk}.
            </p>
          </div>
        </div>
        {plan.status === 'PROPOSED' && (
          <span
            className="figures text-xs font-semibold text-ink-2"
            aria-label={`Plan expires in ${mmss(left)}`}
          >
            expires in {mmss(left)}
          </span>
        )}
      </header>

      <div className="flex flex-col gap-4 px-4 py-4">
        {changed && (
          <div
            role="alert"
            className="rounded-md border border-warning/50 bg-warning-wash px-3 py-2 text-sm text-ink"
          >
            <p className="font-semibold">
              The situation changed, so nothing was moved. Check the updated plan below.
            </p>
            <ul className="mt-1 list-disc pl-5 text-ink-2">
              {changed.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}

        {none ? (
          <div className="rounded-md border border-breach/50 bg-breach-wash px-3 py-3 text-sm">
            <p className="font-bold text-breach">{plan.advice}</p>
            {plan.rejected_targets.length > 0 && (
              <ul className="mt-2 text-ink-2">
                {plan.rejected_targets.map((r) => (
                  <li key={r.id}>
                    {r.name}: {r.why}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="figures w-full min-w-[32rem] border-collapse text-left text-sm">
              <caption className="sr-only">Proposed moves</caption>
              <thead>
                <tr className="text-xs tracking-wide text-ink-2 uppercase">
                  <th scope="col" className="border-b border-rule py-2 pr-3 font-semibold">
                    Batch
                  </th>
                  <th scope="col" className="border-b border-rule py-2 pr-3 font-semibold">
                    To
                  </th>
                  <th scope="col" className="border-b border-rule py-2 pr-3 font-semibold">
                    Budget left
                  </th>
                  <th scope="col" className="border-b border-rule py-2 font-semibold">
                    Urgency
                  </th>
                </tr>
              </thead>
              <tbody>
                {plan.moves.map((m) => (
                  <tr key={m.batch_id} className="border-b border-rule last:border-b-0">
                    <td className="py-2 pr-3">
                      <span className="block font-semibold text-ink">{m.batch_name}</span>
                      <span className="block text-xs text-ink-3">Lot {m.lot_number}</span>
                    </td>
                    <td className="py-2 pr-3 font-medium text-ink">
                      <span className="inline-flex items-center gap-1.5">
                        <ArrowRight aria-hidden className="size-3.5 text-ink-3" />
                        {m.to_fridge_name}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-ink">{Math.round(m.remaining_pct)} %</td>
                    <td className="py-2">
                      <span
                        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap"
                        style={{ color: RISK[m.urgency].ink, backgroundColor: RISK[m.urgency].wash }}
                      >
                        {URGENCY_LABEL[m.urgency]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(plan.shortfall.length > 0 || plan.unsaveable.length > 0) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {plan.shortfall.length > 0 && (
              <div className="rounded-md bg-panel-2 px-3 py-2 text-sm">
                <p className="font-semibold text-ink">No room for {plan.shortfall.length}</p>
                <p className="text-ink-2">
                  {plan.shortfall.map((s) => s.batch_name).join(', ')}: use a portable cooler.
                </p>
              </div>
            )}
            {plan.unsaveable.length > 0 && (
              <div className="rounded-md bg-panel-2 px-3 py-2 text-sm">
                <p className="flex items-center gap-1.5 font-semibold text-discard">
                  <PackageX aria-hidden className="size-4" />
                  Dispose, cannot be saved
                </p>
                <p className="text-ink-2">{plan.unsaveable.map((s) => s.batch_name).join(', ')}</p>
              </div>
            )}
          </div>
        )}

        {!none && plan.targets.length > 0 && (
          <p className="figures text-sm text-ink-2">
            <span className="font-semibold text-ink">Destination safety: </span>
            {plan.targets
              .map(
                (t) =>
                  `${t.name} forecast at most ${t.p90?.toFixed(1) ?? '?'} °C, health ${t.health === null ? '?' : Math.round(t.health)}, ${t.free} free`,
              )
              .join(' · ')}
          </p>
        )}
        <p className="text-xs text-ink-3">{plan.rationale}</p>

        {plan.status === 'PROPOSED' || plan.status === 'NO_SAFE_TARGET' ? (
          mayConfirm ? (
            <div className="flex flex-wrap items-center gap-3">
              {!none && (
                <Button
                  onClick={() => confirm.mutate()}
                  loading={confirm.isPending}
                  disabled={confirm.isPending}
                  icon={<Truck aria-hidden className="size-4" />}
                >
                  {confirm.isPending ? 'Moving batches…' : 'Confirm relocation'}
                </Button>
              )}
              <Button variant="ghost" onClick={() => setDismissing(true)} disabled={confirm.isPending}>
                Dismiss
              </Button>
              {!none && (
                <span className="text-xs text-ink-3">
                  The AI only suggests: nothing moves until you confirm.
                </span>
              )}
            </div>
          ) : (
            <p className="text-sm text-ink-2">Read only: an Admin or Pharmacist confirms relocations.</p>
          )
        ) : (
          <p className="text-sm font-semibold text-ink-2">
            {plan.status === 'CONFIRMED'
              ? 'Confirmed: the batches were moved.'
              : `This plan is ${plan.status.toLowerCase()}.`}
          </p>
        )}
      </div>
      {dismissing && <DismissDialog plan={plan} onClose={() => setDismissing(false)} />}
    </article>
  );
}
