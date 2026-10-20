import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ArrowUpDown, List, Package, Plus, Search } from 'lucide-react';
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/permissions';
import { BudgetBar } from '../dashboard/BudgetPanel';
import { BatchForm } from '../inventory/BatchForm';
import { DetailsDrawer } from '../inventory/DetailsDrawer';
import { MoveDialog } from '../inventory/MoveDialog';
import { QrDialog } from '../inventory/QrDialog';
import { RemoveDialog } from '../inventory/RemoveDialog';
import { ResetLatchButton } from '../dashboard/ResetLatch';
import { fmt, useT } from '../i18n';
import { PageHeader } from '../layout/AppShell';
import { api } from '../lib/api';
import { useFridges } from '../lib/queries';
import type { Batch, BatchList } from '../lib/types';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { PAGE_SIZE, Pager, usePaged } from '../ui/Pager';
import { Panel } from '../ui/Panel';
import { Select } from '../ui/Select';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { StatusChip } from '../ui/StatusChip';

type SortKey = 'name' | 'lot_number' | 'quantity' | 'expiry_date' | 'fridge_id' | 'remaining_pct' | 'status';
const STATUS_ORDER = { DISCARD: 0, AT_RISK: 1, SAFE: 2 } as const;
type Dialog = { kind: 'add' } | { kind: 'edit' | 'move' | 'qr' | 'details' | 'remove'; batch: Batch } | null;

function SortHeader({
  k,
  sort,
  setSort,
  children,
}: {
  k: SortKey;
  sort: { key: SortKey; dir: 1 | -1 };
  setSort: (s: { key: SortKey; dir: 1 | -1 }) => void;
  children: ReactNode;
}) {
  const active = sort.key === k;
  const Icon = !active ? ArrowUpDown : sort.dir === 1 ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
      className="border-b border-rule px-3 py-2 text-left"
    >
      <button
        type="button"
        onClick={() => setSort({ key: k, dir: active ? (sort.dir === 1 ? -1 : 1) : 1 })}
        className="inline-flex min-h-8 cursor-pointer items-center gap-1 rounded text-xs font-semibold tracking-wide text-ink-2 uppercase hover:text-ink"
      >
        {children}
        <Icon aria-hidden className={`size-3.5 ${active ? 'text-teal-strong' : 'text-ink-3'}`} />
      </button>
    </th>
  );
}

export function InventoryPage() {
  const { t } = useT();
  const { user } = useAuth();
  const canWrite = can(user?.role, 'batch:write');
  const isAdmin = can(user?.role, 'latch:reset');
  const canDelete = can(user?.role, 'batch:delete');
  const fridges = useFridges();
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const [fridge, setFridge] = useState('');
  const [status, setStatus] = useState('');
  const [expiring, setExpiring] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'remaining_pct', dir: 1 });
  const [dialog, setDialog] = useState<Dialog>(null);

  const filters = { q: query, fridge_id: fridge, status, expiring_within_days: expiring ? 30 : '' };
  const list = useQuery({
    queryKey: ['batches', filters],
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => {
      const qs = new URLSearchParams({ pageSize: '200' });
      for (const [k, v] of Object.entries(filters)) if (v !== '') qs.set(k, String(v));
      return api<BatchList>(`/api/batches?${qs}`, { signal });
    },
  });
  const rows = useMemo(() => {
    const out = [...(list.data?.batches ?? [])];
    const val = (b: Batch) => (sort.key === 'status' ? STATUS_ORDER[b.status] : (b[sort.key] ?? ''));
    return out.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir);
  }, [list.data, sort]);
  const paged = usePaged(rows, PAGE_SIZE, JSON.stringify([filters, sort])); // back to page 1 on a new filter/sort
  const [all, setAll] = useState(false);
  const fridgeName = (id: string | null) => fridges.data?.fridges.find((f) => f.id === id)?.name ?? id ?? '–';
  const close = () => setDialog(null);
  const today = new Date().toISOString().slice(0, 10);

  // The batch table: the current page inline, every loaded batch in the "View all" dialog. Row actions open
  // their own dialogs, which stack above the full list and return to it when closed.
  const table = (list: Batch[]) => (
    <div className="relative overflow-x-auto">
      <table className="figures w-full min-w-[60rem] border-collapse text-left text-sm">
        <caption className="sr-only">Vaccine batches</caption>
        <thead className="bg-panel-2">
          <tr>
            <SortHeader k="name" sort={sort} setSort={setSort}>
              {t('inv.colName')}
            </SortHeader>
            <SortHeader k="lot_number" sort={sort} setSort={setSort}>
              {t('inv.colLot')}
            </SortHeader>
            <SortHeader k="quantity" sort={sort} setSort={setSort}>
              {t('inv.colQty')}
            </SortHeader>
            <SortHeader k="expiry_date" sort={sort} setSort={setSort}>
              {t('inv.colExpiry')}
            </SortHeader>
            <SortHeader k="fridge_id" sort={sort} setSort={setSort}>
              {t('inv.colFridge')}
            </SortHeader>
            <SortHeader k="remaining_pct" sort={sort} setSort={setSort}>
              {t('inv.colBudget')}
            </SortHeader>
            <SortHeader k="status" sort={sort} setSort={setSort}>
              {t('inv.colStatus')}
            </SortHeader>
            <th
              scope="col"
              className="border-b border-rule px-3 py-2 text-right text-xs font-semibold tracking-wide text-ink-2 uppercase"
            >
              <span className="sr-only">{t('inv.colActions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((b) => {
            const discard = b.status === 'DISCARD';
            return (
              <tr
                key={b.id}
                className={`border-b border-rule last:border-b-0 ${discard ? 'strike-pattern' : 'hover:bg-panel-2'}`}
              >
                <td className="px-3 py-2.5">
                  <span
                    className={`block font-semibold text-ink ${discard ? 'line-through decoration-2' : ''}`}
                  >
                    {b.name}
                  </span>
                  <span className="block text-xs text-ink-3">{b.manufacturer}</span>
                  {discard && (
                    <span
                      className={`mt-1 block text-xs font-bold ${b.acknowledged_at ? 'text-ink-3' : 'text-discard'}`}
                    >
                      {b.acknowledged_at ? t('inv.disposed') : t('inv.disposalRequired')}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-ink">{b.lot_number}</td>
                <td className="px-3 py-2.5 text-ink">{b.quantity}</td>
                <td className="px-3 py-2.5 whitespace-nowrap text-ink">
                  {b.expiry_date}
                  {b.expiry_date < today && (
                    <span className="ml-2 text-xs font-bold text-breach">{t('inv.expired')}</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-ink">{fridgeName(b.fridge_id)}</td>
                <td className="w-44 px-3 py-2.5">
                  <BudgetBar remaining={b.remaining_pct} />
                  <span className="mt-1 block text-xs text-ink-2">{Math.round(b.remaining_pct)} %</span>
                </td>
                <td className="px-3 py-2.5">
                  <StatusChip status={b.status} used={1 - b.remaining_pct / 100} size="sm" />
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex justify-end gap-1">
                    {canWrite && !discard && (
                      <>
                        <Button
                          variant="ghost"
                          className="min-h-9 px-2.5"
                          onClick={() => setDialog({ kind: 'edit', batch: b })}
                          aria-label={fmt(t('inv.editAria'), { n: b.name })}
                        >
                          {t('inv.edit')}
                        </Button>
                        <Button
                          variant="ghost"
                          className="min-h-9 px-2.5"
                          onClick={() => setDialog({ kind: 'move', batch: b })}
                          aria-label={fmt(t('inv.moveAria'), { n: b.name })}
                        >
                          {t('inv.move')}
                        </Button>
                      </>
                    )}
                    {isAdmin && discard && !b.acknowledged_at && b.fridge_id && (
                      <ResetLatchButton
                        fridgeId={b.fridge_id}
                        fridgeName={fridgeName(b.fridge_id)}
                        label={t('inv.ackDisposal')}
                        variant="secondary"
                        className="min-h-9 px-2.5"
                      />
                    )}
                    {canDelete && (
                      <Button
                        variant="ghost"
                        className="min-h-9 px-2.5 text-breach hover:text-breach"
                        onClick={() => setDialog({ kind: 'remove', batch: b })}
                        aria-label={fmt(t('inv.removeAria'), { n: b.name })}
                      >
                        {t('inv.remove')}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      className="min-h-9 px-2.5"
                      onClick={() => setDialog({ kind: 'qr', batch: b })}
                      aria-label={fmt(t('inv.qrAria'), { n: b.name })}
                    >
                      {t('inv.qr')}
                    </Button>
                    <Button
                      variant="secondary"
                      className="min-h-9 px-2.5"
                      onClick={() => setDialog({ kind: 'details', batch: b })}
                      aria-label={fmt(t('inv.detailsAria'), { n: b.name })}
                    >
                      {t('inv.details')}
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <PageHeader
        title={t('page.inventory.title')}
        subtitle={t('page.inventory.subtitle')}
        actions={
          canWrite && (
            <Button icon={<Plus aria-hidden className="size-4" />} onClick={() => setDialog({ kind: 'add' })}>
              {t('inv.addBatch')}
            </Button>
          )
        }
      />
      <Panel bodyClassName="">
        <div role="search" className="flex flex-wrap items-end gap-3 border-b border-rule p-4">
          <label className="flex min-h-10 min-w-56 flex-1 items-center gap-2 rounded-[var(--radius-label)] border border-rule-strong bg-panel px-3 focus-within:border-teal">
            <Search aria-hidden className="size-4 text-ink-3" />
            <span className="sr-only">{t('inv.searchSr')}</span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('inv.search')}
              className="min-w-0 flex-1 bg-transparent py-2 text-sm text-ink outline-none placeholder:text-ink-3"
            />
          </label>
          <Select
            label={t('inv.fridge')}
            hideLabel
            value={fridge}
            onChange={(e) => setFridge(e.target.value)}
            className="w-44"
          >
            <option value="">{t('inv.allFridges')}</option>
            {fridges.data?.fridges.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
          <Select
            label={t('inv.status')}
            hideLabel
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-36"
          >
            <option value="">{t('inv.allStatuses')}</option>
            <option value="SAFE">{t('status.SAFE')}</option>
            <option value="AT_RISK">{t('status.AT_RISK')}</option>
            <option value="DISCARD">{t('status.DISCARD')}</option>
          </Select>
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm font-medium text-ink">
            <input
              type="checkbox"
              checked={expiring}
              onChange={(e) => setExpiring(e.target.checked)}
              className="size-4 accent-[var(--teal)]"
            />
            {t('inv.expiring')}
          </label>
          {rows.length > 0 && (
            <Button
              variant="ghost"
              className="ml-auto"
              onClick={() => setAll(true)}
              icon={<List aria-hidden className="size-4" />}
            >
              {fmt(t('pager.viewAll'), { n: rows.length })}
            </Button>
          )}
        </div>
        {list.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : list.error ? (
          <div className="px-4">
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Package aria-hidden className="size-6" />}
            title={query || fridge || status || expiring ? t('inv.emptyMatch') : t('inv.emptyYet')}
          >
            {query || fridge || status || expiring
              ? t('inv.emptyMatchBody')
              : canWrite
                ? t('inv.emptyAddBody')
                : t('inv.emptyViewBody')}
          </EmptyState>
        ) : (
          <>
            {table(paged.rows)}
            <Pager {...paged} label={t('page.inventory.title')} />
          </>
        )}
      </Panel>
      <Modal
        wide
        open={all}
        onClose={() => setAll(false)}
        title={fmt(t('pager.allTitle'), { list: t('page.inventory.title'), n: rows.length })}
      >
        {table(rows)}
      </Modal>
      {dialog?.kind === 'add' && <BatchForm open onClose={close} />}
      {dialog?.kind === 'edit' && <BatchForm open batch={dialog.batch} onClose={close} />}
      {dialog?.kind === 'move' && <MoveDialog open batch={dialog.batch} onClose={close} />}
      {dialog?.kind === 'qr' && <QrDialog open batch={dialog.batch} onClose={close} />}
      {dialog?.kind === 'remove' && <RemoveDialog open batch={dialog.batch} onClose={close} />}
      <DetailsDrawer batch={dialog?.kind === 'details' ? dialog.batch : null} onClose={close} />
    </>
  );
}
