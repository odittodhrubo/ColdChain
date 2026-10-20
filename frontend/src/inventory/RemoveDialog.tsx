import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { fmt, useT } from '../i18n';
import { api, ApiError } from '../lib/api';
import type { Batch } from '../lib/types';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

/**
 * Admin removes any batch from the inventory with a reason (recorded in the audit log). The batch leaves the
 * inventory and frees its fridge slot; its record stays, and a discarded batch's QR keeps answering "Discard".
 */
export function RemoveDialog({ batch, open, onClose }: { batch: Batch; open: boolean; onClose: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const discard = batch.status === 'DISCARD';
  const remove = useMutation({
    mutationFn: () => api(`/api/batches/${batch.id}`, { method: 'DELETE', body: { reason: reason.trim() } }),
    onSuccess: () => {
      toast({ tone: 'success', title: fmt(t('inv.removed'), { n: batch.name }) });
      void qc.invalidateQueries({ queryKey: ['batches'] });
      void qc.invalidateQueries({ queryKey: ['fridges'] });
      if (batch.fridge_id) void qc.invalidateQueries({ queryKey: ['fridge', batch.fridge_id] });
      onClose();
    },
  });
  const err = remove.error instanceof ApiError ? remove.error : null;
  const short = reason.trim().length < 3;
  return (
    <Modal
      open={open}
      onClose={() => !remove.isPending && onClose()}
      title={fmt(t('inv.removeTitle'), { n: batch.name, lot: batch.lot_number })}
      footer={
        <>
          <Button variant="secondary" disabled={remove.isPending} onClick={onClose}>
            {t('inv.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={short}
            loading={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {t('inv.removeConfirm')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-2">{discard ? t('inv.removeDiscardBody') : t('inv.removeBody')}</p>
      <div className="mt-4">
        <Field
          label={t('inv.removeReason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('inv.removeReasonHint')}
          error={err ? err.message : null}
          maxLength={500}
        />
      </div>
    </Modal>
  );
}
