import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Native <dialog>: real modality, focus containment, Escape to close and focus return come from the browser.
 * For confirmations that need protected focus only (reset latch, delete); everything else stays inline.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close?.();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-[var(--radius-label)] border border-rule bg-panel p-0 text-ink shadow-[0_18px_48px_rgb(15_27_42/0.22)] backdrop:bg-[rgb(10_18_28/0.45)]"
    >
      {open && (
        <>
          <header className="flex items-center justify-between gap-3 border-b border-rule px-5 py-3">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid size-9 cursor-pointer place-items-center rounded-md text-ink-2 hover:bg-panel-2 hover:text-ink"
            >
              <X aria-hidden className="size-4" />
            </button>
          </header>
          <div className="px-5 py-4">{children}</div>
          {footer && (
            <footer className="flex justify-end gap-2 border-t border-rule px-5 py-3">{footer}</footer>
          )}
        </>
      )}
    </dialog>
  );
}
