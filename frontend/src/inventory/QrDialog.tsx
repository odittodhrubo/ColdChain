import { useQuery } from '@tanstack/react-query';
import { Copy, Printer } from 'lucide-react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../lib/api';
import type { Batch } from '../lib/types';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { ErrorState, Skeleton } from '../ui/States';
import { useToast } from '../ui/Toast';

/** The QR image needs the bearer token, so the SVG is fetched and shown as a data URL (an <img> never runs it). */
function useQrImage(batchId: number, enabled: boolean) {
  const q = useQuery({
    queryKey: ['batch', batchId, 'qr'],
    enabled,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/batches/${batchId}/qr?format=svg`, {
        signal,
        credentials: 'same-origin', // the HttpOnly session cookie
      });
      if (!res.ok) throw new ApiError(res.status, `HTTP_${res.status}`, 'Could not load the QR code');
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(await res.text())}`;
    },
  });
  return { ...q, url: q.data ?? null };
}

/** QR for the public check page, a printable label (name, lot, expiry, QR) and the public link to copy. */
export function QrDialog({ batch, open, onClose }: { batch: Batch; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const qr = useQrImage(batch.id, open);
  const detail = useQuery({
    queryKey: ['batch', batch.id],
    enabled: open,
    queryFn: ({ signal }) => api<{ public_url: string }>(`/api/batches/${batch.id}`, { signal }),
  });
  const link = detail.data?.public_url;
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast({ tone: 'success', title: 'Public link copied' });
    } catch {
      toast({ tone: 'error', title: "Couldn't copy", body: link });
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`QR label · ${batch.name}`}
      footer={
        <>
          <Button
            variant="secondary"
            icon={<Copy aria-hidden className="size-4" />}
            onClick={() => void copy()}
            disabled={!link}
          >
            Copy public link
          </Button>
          <Button
            icon={<Printer aria-hidden className="size-4" />}
            onClick={() => window.print()}
            disabled={!qr.url}
          >
            Print label
          </Button>
        </>
      }
    >
      {qr.isPending ? (
        <Skeleton className="mx-auto aspect-square w-60" />
      ) : qr.error ? (
        <ErrorState error={qr.error} onRetry={() => void qr.refetch()} />
      ) : (
        <div className="flex flex-col items-center gap-3">
          <img
            src={qr.url ?? undefined}
            alt={`QR code for ${batch.name}, lot ${batch.lot_number}`}
            className="w-60 rounded-md border border-rule bg-white"
          />
          <p className="text-center text-sm text-ink-2">
            Anyone can scan it to see Safe / At risk / Discard and the expiry date. No login, no internal
            data.
          </p>
          {link && <p className="figures max-w-full truncate text-xs text-ink-3">{link}</p>}
        </div>
      )}
      {open &&
        qr.url &&
        createPortal(
          // Only this label prints (see @media print in index.css): quiet zone kept, fixed physical size.
          <div className="print-label" aria-hidden>
            <img src={qr.url} alt="" />
            <p className="print-label-name">{batch.name}</p>
            <p>Lot {batch.lot_number}</p>
            <p>Expires {batch.expiry_date}</p>
            <p>Scan to check status</p>
            {link && <p className="print-label-url">{link}</p>}
          </div>,
          document.body,
        )}
    </Modal>
  );
}
