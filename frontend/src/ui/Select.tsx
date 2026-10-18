import { ChevronDown } from 'lucide-react';
import { useId, type SelectHTMLAttributes } from 'react';

/** Native select (keyboard, screen readers and mobile pickers for free) in the label-stock style. */
export function Select({
  label,
  hideLabel = false,
  error,
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hideLabel?: boolean; error?: string | null }) {
  const id = useId();
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-sm font-semibold text-ink'}>
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          aria-invalid={error ? true : undefined}
          className={`min-h-10 w-full cursor-pointer appearance-none rounded-[var(--radius-label)] border bg-panel py-2 pr-9 pl-3 text-sm text-ink outline-none focus:border-teal ${
            error ? 'border-breach' : 'border-rule-strong hover:border-ink-3'
          }`}
          {...rest}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-ink-3"
        />
      </div>
      {error && <p className="text-sm font-medium text-breach">{error}</p>}
    </div>
  );
}
