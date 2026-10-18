import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

/** Visible label, input, helper or error text right under it (wired with aria-describedby). */
export function Field({
  label,
  error,
  hint,
  trailing,
  className = '',
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string | null;
  hint?: string;
  trailing?: ReactNode; // e.g. a show / hide password button
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
      </label>
      <div
        className={`flex min-h-11 items-center rounded-[var(--radius-label)] border bg-panel transition-colors focus-within:border-teal ${
          error ? 'border-breach' : 'border-rule-strong hover:border-ink-3'
        }`}
      >
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className="h-full min-w-0 flex-1 bg-transparent px-3 py-2 text-[0.95rem] text-ink outline-none placeholder:text-ink-3"
          {...input}
        />
        {trailing}
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-sm font-medium text-breach">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-sm text-ink-3">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
