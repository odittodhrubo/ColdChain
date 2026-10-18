import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type Tone = 'info' | 'success' | 'error';
interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
}

const ToastContext = createContext<(t: Omit<ToastItem, 'id'>) => void>(() => undefined);

const TONES: Record<Tone, { icon: ReactNode; ink: string }> = {
  info: { icon: <Info aria-hidden className="size-4" />, ink: 'var(--teal)' },
  success: { icon: <CheckCircle2 aria-hidden className="size-4" />, ink: 'var(--safe)' },
  error: { icon: <TriangleAlert aria-hidden className="size-4" />, ink: 'var(--breach)' },
};

let next = 1;

/** Toasts announce through one polite live region and leave on their own after 6 s. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: Omit<ToastItem, 'id'>) => {
      const id = next++;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-20 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 lg:bottom-4"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-3 rounded-[var(--radius-label)] border border-rule bg-panel px-4 py-3 shadow-[0_8px_24px_rgb(15_27_42/0.14)]"
          >
            <span className="mt-0.5" style={{ color: TONES[t.tone].ink }}>
              {TONES[t.tone].icon}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">{t.title}</p>
              {t.body && <p className="mt-0.5 text-sm text-ink-2">{t.body}</p>}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="-m-1 grid size-8 cursor-pointer place-items-center rounded-md text-ink-3 hover:bg-panel-2 hover:text-ink"
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
