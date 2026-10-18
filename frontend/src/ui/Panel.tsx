import type { ReactNode } from 'react';

/** A label-stock panel: white stock, 1px rule, die-cut radius. Never nest panels inside panels. */
export function Panel({
  title,
  actions,
  children,
  className = '',
  bodyClassName = 'p-4',
  as: Tag = 'section',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  as?: 'section' | 'div' | 'article';
}) {
  return (
    <Tag
      className={`rounded-[var(--radius-label)] border border-rule bg-panel shadow-[0_1px_2px_rgb(15_27_42/0.05)] ${className}`}
    >
      {(title || actions) && (
        <header className="flex min-h-12 items-center justify-between gap-3 border-b border-rule px-4 py-2">
          {title && <h2 className="text-[0.95rem] font-semibold text-ink">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </Tag>
  );
}
