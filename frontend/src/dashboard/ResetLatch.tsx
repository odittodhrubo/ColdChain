import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

/**
 * Admin acknowledges the discarded batches and clears the device's red latch. The server sends the signed
 * RESET_LATCH and waits for the node to confirm (up to 3 x 15 s), so this can take a while.
 */
export function ResetLatchButton({ fridgeId, fridgeName }: { fridgeId: string; fridgeName: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const reset = useMutation({
    mutationFn: () =>
      api<{ attempts?: number; acknowledged_batches?: number[] }>(
        `/api/fridges/${encodeURIComponent(fridgeId)}/reset-latch`,
        { method: 'POST', body: { reason: reason.trim() } },
      ),
    onSuccess: (r) => {
      setOpen(false);
      setReason('');
      toast({
        tone: 'success',
        title: `${fridgeName}: latch cleared`,
        body: r.acknowledged_batches?.length
          ? `${r.acknowledged_batches.length} discarded batch(es) acknowledged. They stay Discard.`
          : 'The node confirmed the reset.',
      });
      void qc.invalidateQueries({ queryKey: ['fridges'] });
      void qc.invalidateQueries({ queryKey: ['batches'] });
    },
  });
  const err = reset.error instanceof ApiError ? reset.error : null;
  return (
    <>
      <Button
        variant="danger"
        icon={<RotateCcw aria-hidden className="size-4" />}
        onClick={() => setOpen(true)}
      >
        Reset
      </Button>
      <Modal
        open={open}
        onClose={() => !reset.isPending && setOpen(false)}
        title={`Reset the discard latch on ${fridgeName}`}
        footer={
          <>
            <Button variant="secondary" disabled={reset.isPending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={reset.isPending}
              disabled={reason.trim().length < 3}
              onClick={() => reset.mutate()}
            >
              {reset.isPending ? 'Waiting for the node' : 'Acknowledge and reset'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">
          This records that the discarded batches were disposed of and turns the red LED off. Discarded
          batches stay Discard: the QR page keeps saying so.
        </p>
        <label htmlFor={`reason-${fridgeId}`} className="mt-4 block text-sm font-semibold text-ink">
          Reason (recorded in the audit log)
        </label>
        <textarea
          id={`reason-${fridgeId}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={500}
          placeholder="e.g. 3 vials of lot L-2231 destroyed per SOP 7.2"
          className="mt-1.5 w-full rounded-[var(--radius-label)] border border-rule-strong bg-panel px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-teal"
        />
        {reset.isPending && (
          <p role="status" className="mt-3 text-sm text-ink-2">
            Sent the signed reset. Waiting for the fridge node to confirm (up to 45 s)…
          </p>
        )}
        {err && (
          <p role="alert" className="mt-3 text-sm font-medium text-breach">
            {err.code === 'DEVICE_TIMEOUT'
              ? "The node didn't confirm, so the latch stays on. Check that it is online, then try again."
              : err.message}
          </p>
        )}
      </Modal>
    </>
  );
}
