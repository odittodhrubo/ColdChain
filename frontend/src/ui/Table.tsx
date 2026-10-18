import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
}

/** Semantic data table: sticky head, tabular figures, row hover; scrolls sideways inside its panel. */
export function Table<T>({
  columns,
  rows,
  rowKey,
  caption,
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  caption: string; // read by screen readers
  onRowClick?: (row: T) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="figures w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-panel-2">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`border-b border-rule px-4 py-2.5 text-xs font-semibold tracking-wide text-ink-2 uppercase ${
                  c.align === 'right' ? 'text-right' : ''
                }`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b border-rule last:border-b-0 ${onRowClick ? 'cursor-pointer hover:bg-panel-2' : ''}`}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-4 py-3 text-ink ${c.align === 'right' ? 'text-right' : ''} ${c.className ?? ''}`}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
