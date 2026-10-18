import { useQuery } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { api } from '../lib/api';

/** Accelerated heat exposure is disclosed on every screen, never applied silently. */
export function DemoBanner() {
  const { data } = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api<{ demoScale: number }>('/api/health', { signal, auth: false }),
    staleTime: 60_000,
  });
  if (!data || data.demoScale === 1) return null;
  return (
    <div
      role="note"
      className="flex items-center justify-center gap-2 bg-demo px-4 py-1.5 text-sm font-semibold text-on-demo"
    >
      <FlaskConical aria-hidden className="size-4" />
      <span className="sr-only sm:not-sr-only">DEMO MODE — heat exposure accelerated ×{data.demoScale}</span>
      <span aria-hidden className="sm:hidden">
        DEMO MODE — heat ×{data.demoScale}
      </span>
    </div>
  );
}
