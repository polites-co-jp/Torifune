import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Table, type Column, type TableProps } from './table';

/**
 * `Table` の列の見出しに要素を渡せる（054-bulk-post-actions 設計 §6・§9.1・§11、受け入れ条件 #79）。
 *
 * 投稿一覧の選択の列の見出しに「このページの投稿をすべて選択」のチェックボックスを置くため、
 * `Column.header` を `string` から `ReactNode` に**広げる**（文字列を渡す既存の使い方はそのまま通る）。
 *
 * * 描画：要素を渡すと `<th>` の中に描かれ、文字列はそのまま描かれる
 * * 型：`Column` の宣言の `header` が `ReactNode`（実装プラン T24）。描画は今の `{column.header}` のままでも
 *   要素を描けるので、広げたことは宣言で見る（実装プラン §8 の 50）
 *
 * まだ `header` は `string` なので、部品を**テストの中で写した props の型**として読む
 * （053 実装プラン §8 の 44。型検査を未実装の型に掛けない）。
 */

interface Row {
  readonly id: string;
  readonly name: string;
}

type NodeColumn<T> = Omit<Column<T>, 'header'> & { readonly header: ReactNode };

type NodeTableProps<T> = Omit<TableProps<T>, 'columns'> & {
  readonly columns: readonly NodeColumn<T>[];
};

const NodeTable = Table as unknown as ComponentType<NodeTableProps<Row>>;

const SELECT_ALL_LABEL = 'このページの投稿をすべて選択';

const ROWS: readonly Row[] = [
  { id: 'r1', name: '新製品のお知らせ' },
  { id: 'r2', name: '秋のセール' },
];

function render(columns: readonly NodeColumn<Row>[]): string {
  return renderToStaticMarkup(
    createElement(NodeTable, { columns, rows: ROWS, rowKey: (row: Row) => row.id }),
  );
}

/** `<th>` の中身（HTML）の並び。 */
function headerCells(html: string): string[] {
  return [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((match) => match[1] ?? '');
}

const COLUMNS: readonly NodeColumn<Row>[] = [
  {
    key: 'select',
    header: createElement('input', {
      type: 'checkbox',
      'aria-label': SELECT_ALL_LABEL,
      readOnly: true,
    }),
    width: '2.5rem',
    render: (row) =>
      createElement('input', {
        type: 'checkbox',
        'aria-label': `この投稿を選択：${row.name}`,
        readOnly: true,
      }),
  },
  { key: 'name', header: '本文', render: (row) => row.name },
];

describe('#79 Table の見出しに要素を渡せる', () => {
  it('#79 header にチェックボックスの要素を渡すと <th> の中に <input type="checkbox"> が描かれる', () => {
    const first = headerCells(render(COLUMNS))[0] ?? '';

    expect(first).toMatch(/^<input\b[^>]*type="checkbox"/);
    expect(first).toContain(`aria-label="${SELECT_ALL_LABEL}"`);
  });

  it('#79 header の文字列はそのまま <th> の文字として描かれる', () => {
    expect(headerCells(render(COLUMNS))[1]).toBe('本文');
  });

  it('#79 見出しは列の並びのとおり（要素の列も文字列の列も 1 つの <th>）', () => {
    expect(headerCells(render(COLUMNS))).toHaveLength(2);
  });

  it('#79 文字列だけの列（既存の使い方）は今までどおり描かれる', () => {
    const html = render([
      { key: 'account', header: 'アカウント', render: (row) => row.id },
      { key: 'name', header: '本文', render: (row) => row.name },
    ]);

    expect(headerCells(html)).toEqual(['アカウント', '本文']);
    expect(html).toContain('新製品のお知らせ');
  });
});

/* -------------------------------------------------------------------------- */
/* 宣言（実装プラン T24）                                                         */
/* -------------------------------------------------------------------------- */

const TABLE_SOURCE = join(import.meta.dirname, 'table.tsx');

/** `/* … *\/` と `// …` を外す（`https://` の `//` は外さない）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** `export interface Column<T> { … }` の中身（無ければ空）。 */
function columnInterfaceBody(source: string): string {
  return /export\s+interface\s+Column<T>\s*\{([\s\S]*?)\n\}/.exec(stripComments(source))?.[1] ?? '';
}

/** `header` が `ReactNode` で宣言されているか。 */
function declaresNodeHeader(source: string): boolean {
  return /(?:^|\s)(?:readonly\s+)?header\s*:\s*ReactNode\s*;/m.test(columnInterfaceBody(source));
}

describe('#79 Column.header の型が ReactNode', () => {
  it('#79 table.tsx の Column の header が ReactNode で宣言されている', () => {
    expect(declaresNodeHeader(readFileSync(TABLE_SOURCE, 'utf8'))).toBe(true);
  });

  it('#79 判別力：header が string の宣言は ReactNode と読まない', () => {
    const before = [
      'export interface Column<T> {',
      '  readonly key: string;',
      '  readonly header: string;',
      '  readonly render: (row: T) => ReactNode;',
      '}',
    ].join('\n');
    const after = before.replace('readonly header: string;', 'readonly header: ReactNode;');

    expect(declaresNodeHeader(before)).toBe(false);
    expect(declaresNodeHeader(after)).toBe(true);
  });

  it('#79 判別力：コメントの中の ReactNode は数えない', () => {
    const text = [
      'export interface Column<T> {',
      '  // readonly header: ReactNode;',
      '  readonly header: string;',
      '}',
    ].join('\n');

    expect(declaresNodeHeader(text)).toBe(false);
  });
});
