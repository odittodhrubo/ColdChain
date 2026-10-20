import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, Copy, Info, ShieldCheck } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useSearchParams } from 'react-router';
import { fmt, useT } from '../i18n';
import { PageHeader } from '../layout/AppShell';
import { api, ApiError } from '../lib/api';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Pager } from '../ui/Pager';
import { Panel } from '../ui/Panel';
import { Select } from '../ui/Select';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { useToast } from '../ui/Toast';

const PAGE = 20; // rows per page, like the fridge recordings
const TYPES = [
  'AUTH_LOGIN', 'AUTH_FAIL', 'USER_CREATED', 'USER_UPDATED', 'USER_DISABLED', 'BATCH_CREATED', 'BATCH_UPDATED',
  'BATCH_MOVED', 'BATCH_STATUS_CHANGED', 'LATCH_RESET', 'DISCARD_ACK', 'ALERT_RAISED', 'ALERT_ACKED', 'ALERT_RESOLVED',
  'SECURITY_REJECT', 'RELOCATION_PROPOSED', 'RELOCATION_CONFIRMED', 'RELOCATION_DISMISSED', 'DEVICE_EVENT', 'BREACH_START', 'BREACH_END', 'TELEMETRY_CHECKPOINT', 'AUDIT_VERIFY', 'READINGS_RETIRED',
]; // prettier-ignore

interface Entry {
  id: number;
  ts: number;
  actor: string;
  event_type: string;
  payload: Record<string, unknown> | string; // raw text when the stored payload is no longer JSON (tampered)
  payload_invalid?: boolean;
  prev_hash: string;
  hash: string;
}
export interface VerifyResult {
  valid: boolean;
  checked: number;
  headId: number;
  headHash: string;
  firstBrokenId?: number;
  reason?: string;
  externalAnchor?: { headId: number; at: number; url: string } | null; // S8: signed by a Time-Stamp Authority
  expected?: string | number;
  actual?: string | number | null;
}

/** Streams GET /api/audit/verify?stream=1 (NDJSON): progress lines, then the result. */
export async function verifyStream(
  onProgress: (checked: number, total: number) => void,
): Promise<VerifyResult> {
  const res = await fetch('/api/audit/verify?stream=1', {
    credentials: 'same-origin', // the HttpOnly session cookie
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      res.status,
      body?.error?.code ?? `HTTP_${res.status}`,
      body?.error?.message ?? 'Verification failed',
    );
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as {
        progress?: { checked: number; total: number };
        result?: VerifyResult;
      };
      if (msg.progress) onProgress(msg.progress.checked, msg.progress.total);
      if (msg.result) return msg.result;
    }
    if (done) throw new ApiError(0, 'STREAM_ENDED', 'The verification stream ended without a result');
  }
}

const short = (h: string) => `${h.slice(0, 10)}…`;

export function AuditPage() {
  const { t } = useT();
  const toast = useToast();
  const [params] = useSearchParams(); // deep links, e.g. ?type=RELOCATION_CONFIRMED from a toast
  const [type, setType] = useState(() =>
    TYPES.includes(params.get('type') ?? '') ? params.get('type')! : '',
  );
  const [actor, setActor] = useState('');
  const [page, setPage] = useState(1);
  const [verify, setVerify] = useState<
    | { state: 'idle' }
    | { state: 'running'; checked: number; total: number }
    | { state: 'done'; result: VerifyResult }
    | { state: 'error'; error: unknown }
  >({ state: 'idle' });
  const list = useQuery({
    queryKey: ['audit', type, actor, page],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(PAGE) });
      if (type) qs.set('type', type);
      if (actor.trim()) qs.set('actor', actor.trim());
      return api<{ entries: Entry[]; total: number }>(`/api/audit?${qs}`, { signal });
    },
  });
  const [detail, setDetail] = useState<Entry | null>(null);
  const broken = verify.state === 'done' && !verify.result.valid ? verify.result.firstBrokenId : undefined;

  async function run() {
    setVerify({ state: 'running', checked: 0, total: 0 });
    try {
      const result = await verifyStream((checked, total) => setVerify({ state: 'running', checked, total }));
      setVerify({ state: 'done', result });
      const refetched = await list.refetch();
      if (!result.valid && result.firstBrokenId && !type && !actor) {
        const headId =
          refetched.data?.entries[0]?.id ??
          refetched.data?.total ??
          list.data?.entries[0]?.id ??
          list.data?.total ??
          result.firstBrokenId;
        setPage(Math.max(1, Math.floor((headId - result.firstBrokenId) / PAGE) + 1)); // jump to the broken row
      }
    } catch (error) {
      setVerify({ state: 'error', error });
    }
  }
  const copy = (h: string) =>
    void navigator.clipboard?.writeText(h).then(
      () => toast({ tone: 'success', title: t('audit.hashCopied') }),
      () => toast({ tone: 'error', title: t('audit.copyFail') }),
    );
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE));

  return (
    <>
      <PageHeader
        title={t('page.audit.title')}
        subtitle={t('page.audit.subtitle')}
        actions={
          <Button
            icon={<ShieldCheck aria-hidden className="size-4" />}
            loading={verify.state === 'running'}
            onClick={() => void run()}
          >
            {t('audit.verify')}
          </Button>
        }
      />
      {verify.state === 'running' && (
        <div role="status" className="mb-5 rounded-[var(--radius-label)] border border-rule bg-panel p-4">
          <p className="figures text-sm font-semibold text-ink">
            {fmt(t('audit.verifying'), { c: verify.checked, t: verify.total || '…' })}
          </p>
          <span className="mt-2 block h-2 overflow-hidden rounded-full bg-panel-2">
            <span
              className="block h-full bg-teal transition-[width]"
              style={{ width: `${verify.total ? (verify.checked / verify.total) * 100 : 5}%` }}
            />
          </span>
        </div>
      )}
      {verify.state === 'done' &&
        (verify.result.valid ? (
          <div
            role="status"
            className="mb-5 flex items-start gap-3 rounded-[var(--radius-label)] border border-safe/40 bg-safe-wash p-4"
          >
            <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-safe" />
            <div className="figures min-w-0 text-sm">
              <p className="font-bold text-safe">{fmt(t('audit.intact'), { n: verify.result.checked })}</p>
              <p className="truncate text-ink-2">{fmt(t('audit.headHash'), { h: verify.result.headHash })}</p>
              {verify.result.externalAnchor && (
                <p className="text-ink-2">
                  {fmt(t('audit.alsoTimestamped'), {
                    id: verify.result.externalAnchor.headId,
                    host: new URL(verify.result.externalAnchor.url).host,
                    date: new Date(verify.result.externalAnchor.at).toLocaleString(),
                  })}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div
            role="alert"
            className="mb-5 flex items-start gap-3 rounded-[var(--radius-label)] border border-breach/50 bg-breach-wash p-4"
          >
            <CircleX aria-hidden className="mt-0.5 size-5 shrink-0 text-breach" />
            <div className="figures min-w-0 text-sm">
              <p className="font-bold text-breach">
                {fmt(t('audit.tampering'), {
                  id: verify.result.firstBrokenId ?? '',
                  reason: verify.result.reason ?? '',
                })}
              </p>
              <p className="text-ink">
                {verify.result.reason
                  ? t(`audit.reason.${verify.result.reason}` as 'audit.reason.ID_GAP')
                  : ''}
              </p>
              {verify.result.expected !== undefined && (
                <p className="mt-1 break-all text-xs text-ink-2">
                  {fmt(t('audit.expected'), { v: String(verify.result.expected) })}
                  <br />
                  {fmt(t('audit.actual'), { v: String(verify.result.actual) })}
                </p>
              )}
            </div>
          </div>
        ))}
      {verify.state === 'error' && (
        <Panel className="mb-5">
          <ErrorState error={verify.error} onRetry={() => void run()} />
        </Panel>
      )}

      <Panel bodyClassName="">
        <div className="flex flex-wrap items-end gap-3 border-b border-rule p-4">
          <Select
            label={t('audit.eventType')}
            hideLabel
            value={type}
            onChange={(e) => (setType(e.target.value), setPage(1))}
            className="w-60"
          >
            <option value="">{t('audit.allEvents')}</option>
            {TYPES.map((code) => (
              <option key={code}>{code}</option>
            ))}
          </Select>
          <label className="flex min-h-10 items-center rounded-[var(--radius-label)] border border-rule-strong bg-panel px-3 focus-within:border-teal">
            <span className="sr-only">{t('audit.actor')}</span>
            <input
              value={actor}
              onChange={(e) => (setActor(e.target.value), setPage(1))}
              placeholder={t('audit.actorPlaceholder')}
              className="w-72 bg-transparent py-2 text-sm text-ink outline-none placeholder:text-ink-3"
            />
          </label>
        </div>
        {list.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        ) : list.error ? (
          <div className="px-4">
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : list.data.entries.length === 0 ? (
          <EmptyState title={t('audit.noMatch')}>{t('audit.noMatchBody')}</EmptyState>
        ) : (
          <>
            <div className="relative overflow-x-auto">
              <table className="figures w-full min-w-[60rem] border-collapse text-left text-sm">
                <caption className="sr-only">Hash-chained audit log, newest first</caption>
                <thead className="bg-panel-2">
                  <tr>
                    {[
                      '#',
                      t('audit.colTime'),
                      t('audit.colActor'),
                      t('audit.colEvent'),
                      t('audit.colPayload'),
                      t('audit.colPrevHash'),
                      t('audit.colHash'),
                    ].map((h) => (
                      <th
                        key={h}
                        scope="col"
                        className="border-b border-rule px-3 py-2.5 text-xs font-semibold tracking-wide text-ink-2 uppercase"
                      >
                        {h}
                      </th>
                    ))}
                    <th scope="col" className="border-b border-rule px-3 py-2.5">
                      <span className="sr-only">{t('audit.details')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.entries.map((e) => {
                    const isBroken = broken === e.id;
                    return (
                      <tr
                        key={e.id}
                        aria-current={isBroken ? 'true' : undefined}
                        className={`border-b border-rule last:border-b-0 ${isBroken ? 'bg-breach-wash outline-2 -outline-offset-2 outline-breach' : ''}`}
                      >
                        <td className="px-3 py-2 font-semibold text-ink">{e.id}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-ink-2">
                          {new Date(e.ts).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-ink">{e.actor}</td>
                        <td className="px-3 py-2 font-medium text-ink">{e.event_type}</td>
                        <td
                          className="max-w-[18rem] truncate px-3 py-2 font-mono text-xs text-ink-2"
                          title={JSON.stringify(e.payload)}
                        >
                          {JSON.stringify(e.payload)}
                        </td>
                        {[e.prev_hash, e.hash].map((h, i) => (
                          <td key={i} className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => copy(h)}
                              title={h}
                              aria-label={`Copy ${i ? 'hash' : 'previous hash'} of record ${e.id}`}
                              className="inline-flex cursor-pointer items-center gap-1 font-mono text-xs text-ink-2 hover:text-ink"
                            >
                              {short(h)}
                              <Copy aria-hidden className="size-3" />
                            </button>
                          </td>
                        ))}
                        <td className="px-3 py-2 text-right">
                          <Button
                            variant="secondary"
                            className="min-h-8 px-2.5"
                            icon={<Info aria-hidden className="size-4" />}
                            onClick={() => setDetail(e)}
                          >
                            {t('audit.details')}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager
              page={page - 1}
              pages={pages}
              setPage={(p) => setPage(p + 1)}
              from={list.data.total ? (page - 1) * PAGE + 1 : 0}
              to={Math.min(list.data.total, page * PAGE)}
              total={list.data.total}
              label={t('page.audit.title')}
            />
          </>
        )}
      </Panel>
      {detail && (
        <Modal
          open
          onClose={() => setDetail(null)}
          title={fmt(t('audit.detailsTitle'), { id: detail.id })}
          footer={
            <>
              <Button
                variant="secondary"
                icon={<Copy aria-hidden className="size-4" />}
                onClick={() => copy(JSON.stringify(detail, null, 2))}
              >
                {t('audit.copyRow')}
              </Button>
              <Button onClick={() => setDetail(null)}>{t('audit.close')}</Button>
            </>
          }
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {[
              [t('audit.record'), String(detail.id)],
              [t('audit.colTime'), new Date(detail.ts).toLocaleString()],
              [t('audit.colActor'), detail.actor],
              [t('audit.colEvent'), detail.event_type],
            ].map(([k, v]) => (
              <Fragment key={k}>
                <dt className="font-semibold text-ink-2">{k}</dt>
                <dd className="figures break-all text-ink">{v}</dd>
              </Fragment>
            ))}
            <dt className="font-semibold text-ink-2">{t('audit.colPrevHash')}</dt>
            <dd className="font-mono text-xs break-all text-ink-2">{detail.prev_hash}</dd>
            <dt className="font-semibold text-ink-2">{t('audit.colHash')}</dt>
            <dd className="font-mono text-xs break-all text-ink-2">{detail.hash}</dd>
          </dl>
          {detail.payload_invalid && (
            <p className="mt-4 text-sm font-semibold text-breach">{t('audit.payloadInvalid')}</p>
          )}
          <p className="mt-4 mb-1 text-sm font-semibold text-ink-2">{t('audit.colPayload')}</p>
          <pre className="max-h-80 overflow-auto rounded-md bg-panel-2 p-3 font-mono text-xs text-ink">
            {typeof detail.payload === 'string' ? detail.payload : JSON.stringify(detail.payload, null, 2)}
          </pre>
        </Modal>
      )}
    </>
  );
}
