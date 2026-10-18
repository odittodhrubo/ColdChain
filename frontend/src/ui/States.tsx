import { Lock, RotateCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { Button } from './Button';

/** Loading placeholder that keeps the final layout's size (no layout shift). */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`skeleton rounded-md bg-panel-2 ${className}`} />;
}

/** An empty state teaches: what will appear here and what makes it appear. */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 px-1 py-8 sm:items-center sm:text-center">
      {icon && <div className="text-ink-3">{icon}</div>}
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      {children && <div className="max-w-prose text-sm text-ink-2">{children}</div>}
      {action}
    </div>
  );
}

/** Errors name the problem and the recovery; a 403 reads as "no permission", never as a crash. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const api = error instanceof ApiError ? error : null;
  if (api?.status === 403)
    return (
      <EmptyState icon={<Lock aria-hidden className="size-6" />} title="You don't have permission for this">
        Your role can't open this data. Ask an administrator if you need access.
      </EmptyState>
    );
  return (
    <div role="alert" className="flex flex-col items-start gap-3 py-6">
      <p className="flex items-center gap-2 text-sm font-semibold text-breach">
        <TriangleAlert aria-hidden className="size-4" />
        {api?.status === 0 ? "Can't reach the ColdChain server" : 'Something went wrong loading this'}
      </p>
      <p className="text-sm text-ink-2">
        {api?.message ?? 'Unexpected error.'} {api?.status === 0 && 'Check that the backend is running.'}
      </p>
      {onRetry && (
        <Button variant="secondary" icon={<RotateCw aria-hidden className="size-4" />} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
