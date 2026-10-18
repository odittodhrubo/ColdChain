import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { fridgeStatus } from '../dashboard/logic';
import { api, ApiError } from '../lib/api';
import { useFridges } from '../lib/queries';
import { serverNow } from '../lib/time';
import type { Batch } from '../lib/types';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { StatusChip } from '../ui/StatusChip';
import { useToast } from '../ui/Toast';

/** Move a batch: each target shows its capacity and current safety; an unsafe target is allowed but flagged. */
export function MoveDialog({ batch, open, onClose }: { batch: Batch; open: boolean; onClose: () => void }) {
  const { data } = useFridges();
  const [target, setTarget] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const now = serverNow();
  const move = useMutation({
    mutationFn: () =>
      api<{ batch: Batch }>(`/api/batches/${batch.id}/move`, {
        method: 'POST',
        body: { to_fridge_id: target },
      }),
    onSuccess: () => {
      toast({ tone: 'success', title: `${batch.name} moved`, body: `Its used heat budget moves with it.` });
      void qc.invalidateQueries({ queryKey: ['batches'] });
      void qc.invalidateQueries({ queryKey: ['fridges'] });
      onClose();
    },
  });
  const chosen = data?.fridges.find((f) => f.id === target);
  const chosenStatus = chosen ? fridgeStatus(chosen, now) : null;
  const err = move.error instanceof ApiError ? move.error : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Move ${batch.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={move.isPending}>
            Cancel
          </Button>
          <Button onClick={() => move.mutate()} disabled={!target} loading={move.isPending}>
            Move batch
          </Button>
        </>
      }
    >
      <fieldset>
        <legend className="mb-3 text-sm text-ink-2">
          Lot {batch.lot_number} is in {batch.fridge_id}. Move it to:
        </legend>
        <div className="flex flex-col gap-2">
          {data?.fridges.map((f) => {
            const status = fridgeStatus(f, now);
            const full = f.load >= f.capacity;
            const current = f.id === batch.fridge_id;
            return (
              <label
                key={f.id}
                className={`flex min-h-14 items-center gap-3 rounded-[var(--radius-label)] border px-3 py-2 ${
                  target === f.id ? 'border-teal bg-teal-wash' : 'border-rule'
                } ${current || full ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-panel-2'}`}
              >
                <input
                  type="radio"
                  name={`move-${batch.id}`}
                  value={f.id}
                  checked={target === f.id}
                  disabled={current || full}
                  onChange={() => setTarget(f.id)}
                  className="size-4 accent-[var(--teal)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{f.name}</span>
                  <span className="figures block text-xs text-ink-3">
                    {f.load}/{f.capacity} batches{current ? ' · current fridge' : full ? ' · full' : ''}
                  </span>
                </span>
                <StatusChip status={status} size="sm" />
              </label>
            );
          })}
        </div>
      </fieldset>
      {chosenStatus && chosenStatus !== 'SAFE' && (
        <p
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-md bg-warning-wash px-3 py-2 text-sm font-medium text-warning"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {chosen!.name} is {chosenStatus === 'OFFLINE' ? 'offline' : `in ${chosenStatus.toLowerCase()}`}{' '}
          right now. Move here only if you have to.
        </p>
      )}
      {err && (
        <p role="alert" className="mt-3 text-sm font-medium text-breach">
          {err.code === 'BATCH_DISCARDED' ? 'A discarded batch cannot be moved.' : err.message}
        </p>
      )}
    </Modal>
  );
}
