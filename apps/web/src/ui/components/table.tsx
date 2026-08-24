'use client';

import type { ReactNode } from 'react';

/**
 * 一覧表とページング。
 *
 * 列定義から描く。各画面で `<table>` を手書きすると、
 * デザインを詰めるときに全画面を触ることになる。
 */

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly render: (row: T) => ReactNode;
  readonly width?: string;
}

export interface TableProps<T> {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly caption?: string;
}

const CELL: React.CSSProperties = {
  padding: 'var(--tf-space-3)',
  borderBottom: '1px solid var(--tf-color-border)',
  textAlign: 'left',
};

export function Table<T>({ columns, rows, rowKey, caption }: TableProps<T>) {
  return (
    // 幅の広い表が画面全体を横スクロールさせないよう、表だけをスクロールさせる。
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        {caption !== undefined && (
          <caption style={{ textAlign: 'left', marginBottom: 'var(--tf-space-2)' }}>
            {caption}
          </caption>
        )}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={{
                  ...CELL,
                  color: 'var(--tf-color-text-muted)',
                  fontWeight: 600,
                  ...(column.width === undefined ? {} : { width: column.width }),
                }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} style={CELL}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface PaginationProps {
  readonly page: number;
  readonly perPage: number;
  readonly total: number;
  readonly onChange: (page: number) => void;
}

export function Pagination({ page, perPage, total, onChange }: PaginationProps) {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const isFirst = page <= 1;
  const isLast = page >= lastPage;

  const buttonStyle: React.CSSProperties = {
    padding: 'var(--tf-space-2) var(--tf-space-3)',
    border: '1px solid var(--tf-color-border)',
    borderRadius: 'var(--tf-radius-md)',
    background: 'var(--tf-color-bg)',
    color: 'var(--tf-color-text)',
    font: 'inherit',
  };

  return (
    <nav
      aria-label="ページ送り"
      style={{
        display: 'flex',
        gap: 'var(--tf-space-2)',
        alignItems: 'center',
        marginTop: 'var(--tf-space-4)',
      }}
    >
      <button
        type="button"
        disabled={isFirst}
        onClick={() => onChange(page - 1)}
        style={{ ...buttonStyle, opacity: isFirst ? 0.5 : 1 }}
      >
        前へ
      </button>
      <span style={{ color: 'var(--tf-color-text-muted)' }}>
        {page} / {lastPage}（全 {total} 件）
      </span>
      <button
        type="button"
        disabled={isLast}
        onClick={() => onChange(page + 1)}
        style={{ ...buttonStyle, opacity: isLast ? 0.5 : 1 }}
      >
        次へ
      </button>
    </nav>
  );
}
