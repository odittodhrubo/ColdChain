import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-teal text-on-teal border-teal hover:bg-teal-strong hover:border-teal-strong active:translate-y-px',
  secondary: 'bg-panel text-ink border-rule-strong hover:bg-panel-2 hover:border-ink-3 active:translate-y-px',
  ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-panel-2 hover:text-ink',
  danger: 'bg-breach text-on-breach border-breach hover:brightness-95 active:translate-y-px',
};

export function Button({
  variant = 'primary',
  loading = false,
  icon,
  children,
  className = '',
  disabled,
  type = 'button', // never submit a form by accident: a submit button says type="submit"
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  loading?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-label)] border px-3.5 text-sm font-semibold transition-[background-color,border-color,color,transform] duration-150 disabled:cursor-not-allowed disabled:opacity-55 ${VARIANTS[variant]} ${className}`}
    >
      {loading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}
