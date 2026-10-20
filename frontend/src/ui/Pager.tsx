import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { fmt, useT } from '../i18n';
import { Button } from './Button';

export const PAGE_SIZE = 15;

/**
 * Client-side paging over an already-loaded list. The page clamps when the list shrinks, and goes back to the
 * first page whenever resetKey changes (a new filter or sort order).
 */
export function usePaged<T>(rows: T[], size = PAGE_SIZE, resetKey = '') {
  const [state, setState] = useState({ key: resetKey, page: 0 });
  const page = state.key === resetKey ? state.page : 0;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(page, pages - 1);
  return {
    page: current,
    pages,
    setPage: (p: number) => setState({ key: resetKey, page: p }),
    rows: rows.slice(current * size, current * size + size),
    from: rows.length ? current * size + 1 : 0,
    to: Math.min(rows.length, (current + 1) * size),
    total: rows.length,
  };
}

/** "16–30 of 120" with Previous / Next. Renders nothing for a single page. */
export function Pager({
  page,
  pages,
  setPage,
  from,
  to,
  total,
  label,
}: Pick<ReturnType<typeof usePaged>, 'page' | 'pages' | 'setPage' | 'from' | 'to' | 'total'> & {
  label: string; // names the list for screen readers
}) {
  const { t } = useT();
  if (pages <= 1) return null;
  return (
    <nav
      aria-label={fmt(t('pager.nav'), { list: label })}
      className="flex flex-wrap items-center justify-between gap-2 border-t border-rule px-4 py-2.5"
    >
      <p className="figures text-sm text-ink-2" aria-live="polite">
        {fmt(t('pager.range'), { from, to, total })}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
          icon={<ChevronLeft aria-hidden className="size-4" />}
        >
          {t('pager.prev')}
        </Button>
        <span className="figures min-w-16 text-center text-sm text-ink-2">
          {fmt(t('pager.page'), { n: page + 1, of: pages })}
        </span>
        <Button variant="secondary" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
          {t('pager.next')}
          <ChevronRight aria-hidden className="size-4" />
        </Button>
      </div>
    </nav>
  );
}
