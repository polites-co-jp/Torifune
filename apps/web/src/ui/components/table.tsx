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
  /** 列の見出し。文字列も渡せる（要素は一括選択のチェックボックスなどに使う）。 */
  readonly header: ReactNode;
  readonly render: (row: T) => ReactNode;
  readonly width?: string;
  /** 数値の列は右寄せ・等幅にして桁を揃える。 */
  readonly align?: 'right';
  /**
   * セル全体のクリック（任意）。渡すと `<td>` に `onClick` と `cursor: pointer` を付ける。
   * セルの中の操作できる要素（`CELL_CLICK_IGNORE_SELECTOR`）からのクリックでは呼ばない（中の部品の操作を奪わない）。
   * ポインタで押しやすくするための補助で、キーボードの操作は中の部品に持たせる（セルに `tabindex`・`role` を足さない）。
   * `detail` の 2 段目には付かない。
   */
  readonly onCellClick?: (row: T) => void;
}

export interface TableProps<T> {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly caption?: string;
  /**
   * 行の下の全幅の段（任意）。渡すと 1 行を `<tbody>` 1 つ（`<tr>` 2 つ）で描き、
   * 1 段目に列のセル、2 段目に `detail(row)` を表の幅いっぱいで置く。
   * 渡さないときの出力は変わらない。
   */
  readonly detail?: (row: T) => ReactNode;
}

const CELL: React.CSSProperties = {
  padding: 'var(--tf-space-3)',
  borderBottom: '1px solid var(--tf-color-border-weak)',
  textAlign: 'left',
};

/** 右寄せの列に足す。数字は等幅で並べると桁が揃う。 */
const NUMERIC_CELL: React.CSSProperties = {
  textAlign: 'right',
  fontFamily: 'var(--tf-font-mono)',
  fontVariantNumeric: 'tabular-nums',
};

/** `detail` ありの 1 段目のセル。下線を引かず、2 段目と 1 つの行に見せる。 */
const FIRST_TIER_CELL: React.CSSProperties = { ...CELL, borderBottom: 'none' };

/** `detail` の段。上の余白を詰め、下線は今のセルと同じ。 */
const DETAIL_CELL: React.CSSProperties = { ...CELL, paddingTop: 0 };

/**
 * `detail` の中身を包む。全幅の段の中身（長い本文など）の幅が 1 段目の列の幅の配分に効くと、
 * 表の自動の列幅で 1 段目の列が最小の幅まで縮む（操作のボタンが縦に積まれる）。
 * 中身の幅を配分に数えさせず（`width: 0`）、描くときはセルの幅いっぱいに広げる（`min-width: 100%`）。
 */
const DETAIL_CONTENT: React.CSSProperties = { width: 0, minWidth: '100%' };

function alignStyle<T>(column: Column<T>): React.CSSProperties {
  return column.align === 'right' ? NUMERIC_CELL : {};
}

/** `onCellClick` のある列のセル。見た目は指の形だけを変える（色・枠は変えない）。 */
const CLICKABLE_CELL: React.CSSProperties = { cursor: 'pointer' };

/**
 * セルのクリックを `onCellClick` に回さない、セルの中の操作できる要素。
 * チェックボックス自身を押したときはブラウザの既定（`change`）だけが切り替え、セルは何もしない（二重に切り替えない）。
 * `label` を含めるので、セルの中に `<label>` を置いてもクリックが 2 回に数えられない。
 */
export const CELL_CLICK_IGNORE_SELECTOR =
  'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="checkbox"], [contenteditable="true"]';

/**
 * 押した要素（`target`）からセル（`cell`）までの間に操作できる要素があるか。
 * `closest` で探し、見つかった要素がセルの中にあるときだけ真（表を包むリンクなど、セルの外の要素は数えない）。
 * `target` が `closest` を持たなければ偽。`Element` を参照しない（DOM の無い環境でも読み込める）。
 */
export function isCellClickIgnored(target: unknown, cell: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const closest = (target as { closest?: unknown }).closest;
  if (typeof closest !== 'function') return false;
  const found: unknown = (closest as (selector: string) => unknown).call(
    target,
    CELL_CLICK_IGNORE_SELECTOR,
  );
  if (found === null || found === undefined) return false;
  const contains = (cell as { contains?: unknown } | null)?.contains;
  return (
    typeof contains === 'function' && (contains as (node: unknown) => boolean).call(cell, found)
  );
}

/** `onCellClick` のある列の `<td>` に足す props。無い列は何も足さない（出力を今のまま保つ）。 */
function cellClickProps<T>(column: Column<T>, row: T) {
  const onCellClick = column.onCellClick;
  if (onCellClick === undefined) return {};
  return {
    onClick: (event: React.MouseEvent<HTMLTableCellElement>) => {
      if (!isCellClickIgnored(event.target, event.currentTarget)) onCellClick(row);
    },
  };
}

function clickableStyle<T>(column: Column<T>): React.CSSProperties {
  return column.onCellClick === undefined ? {} : CLICKABLE_CELL;
}

export function Table<T>({ columns, rows, rowKey, caption, detail }: TableProps<T>) {
  return (
    // 幅の広い表が画面全体を横スクロールさせないよう、表だけをスクロールさせる。
    // クラスは globals.css（.tf-table-scroll）。**画面ごとに書くと新しい表で忘れる。**
    <div className="tf-table-scroll">
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
                  color: 'var(--tf-color-text-subtle)',
                  fontSize: 'var(--tf-text-label)',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  ...(column.width === undefined ? {} : { width: column.width }),
                  ...(column.align === 'right' ? { textAlign: 'right' } : {}),
                }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        {detail === undefined ? (
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    style={{ ...CELL, ...alignStyle(column), ...clickableStyle(column) }}
                    {...cellClickProps(column, row)}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ) : (
          // 1 行を行グループ（<tbody>）1 つにまとめ、2 段が同じ行のものだと DOM で分かるようにする。
          rows.map((row) => (
            <tbody key={rowKey(row)}>
              <tr>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    style={{ ...FIRST_TIER_CELL, ...alignStyle(column), ...clickableStyle(column) }}
                    {...cellClickProps(column, row)}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
              <tr>
                <td colSpan={columns.length} style={DETAIL_CELL}>
                  <div style={DETAIL_CONTENT}>{detail(row)}</div>
                </td>
              </tr>
            </tbody>
          ))
        )}
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
    padding: 'var(--tf-space-2) var(--tf-space-4)',
    border: '1px solid var(--tf-color-border)',
    borderRadius: 'var(--tf-radius-pill)',
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
