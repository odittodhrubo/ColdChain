import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Right-hand side panel on a native <dialog>: modal focus, Escape to close, focus returns on close. */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    // showModal where supported; a plain open attribute elsewhere (old browsers, jsdom)
    if (open && !d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    }
    if (!open && d.open) {
      if (typeof d.close === 'function') d.close();
      else d.removeAttribute('open');
    }
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
      className="m-0 ml-auto h-dvh max-h-dvh w-[min(36rem,100vw)] max-w-none border-l border-rule bg-panel p-0 text-ink shadow-[0_0_48px_rgb(15_27_42/0.25)] backdrop:bg-[rgb(10_18_28/0.4)]"
    >
      {open && (
        <div className="flex h-full flex-col">
          <header className="flex items-start justify-between gap-3 border-b border-rule px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="truncate text-lg font-bold">
                {title}
              </h2>
              {subtitle && <div className="figures text-sm text-ink-2">{subtitle}</div>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-md text-ink-2 hover:bg-panel-2 hover:text-ink"
            >
              <X aria-hidden className="size-5" />
            </button>
          </header>
          <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4">{children}</div>
        </div>
      )}
    </dialog>
  );
}
