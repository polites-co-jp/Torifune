import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Table, type Column, type TableProps } from './table';

/**
 * `Table` の任意の `detail`（行の下の全幅の段。056-social-row-layout 設計 §5.1、受け入れ条件 #1〜#5）。
 *
 * * 渡さない：今と同じ出力（`<tbody>` 1 つに 1 行 1 `<tr>`。`colspan` なし。全セルに下線）
 * * 渡す：行ごとに `<tbody>` 1 つ（`rowKey` の順）。1 段目の `<tr>` に列のセル（下線なし）、
 *   2 段目の `<tr>` に `colspan`＝列の数の `<td>` 1 つで `detail(row)`（下線あり）
 * * `<thead>` の `<th>` は列の数だけ（2 段目の見出しは作らない）
 *
 * `detail` はまだ `TableProps` に無いので、部品を**テストの中で写した props の型**として読む
 * （`table-header.test.ts` と同じ形。053 実装プラン §8 の 44）。`colspan` は大文字小文字を問わずに見る、
 * 下線は `<td>` の style の `border-bottom` で見る（056 実装プラン §8 の 1・2）。
 */

interface Row {
  readonly id: string;
  readonly name: string;
  readonly count: number;
}

type DetailTableProps<T> = TableProps<T> & {
  readonly detail?: (row: T) => ReactNode;
};

const DetailTable = Table as unknown as ComponentType<DetailTableProps<Row>>;

const ROWS: readonly Row[] = [
  { id: 'r1', name: '新製品のお知らせ', count: 3 },
  { id: 'r2', name: '秋のセール', count: 12 },
  { id: 'r3', name: '週末のイベント', count: 7 },
];

const COLUMNS: readonly Column<Row>[] = [
  { key: 'id', header: 'ID', render: (row) => `識別子-${row.id}`, width: '2.5rem' },
  { key: 'name', header: '名前', render: (row) => row.name },
  { key: 'count', header: '件数', render: (row) => `件数-${row.count}`, align: 'right' },
];

function detailOf(row: Row): ReactNode {
  return createElement('span', { className: 'detail-content' }, `詳細-${row.id}`);
}

function render(withDetail: boolean): string {
  return renderToStaticMarkup(
    createElement(DetailTable, {
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (row: Row) => row.id,
      ...(withDetail ? { detail: detailOf } : {}),
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* HTML の読み方                                                                 */
/* -------------------------------------------------------------------------- */

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/** `<tbody>…</tbody>` の並び。 */
function tbodies(html: string): string[] {
  return [...html.matchAll(/<tbody\b[^>]*>[\s\S]*?<\/tbody>/g)].map((match) => match[0]);
}

/** `<thead>…</thead>`。 */
function theadOf(html: string): string {
  return /<thead\b[^>]*>[\s\S]*?<\/thead>/.exec(html)?.[0] ?? '';
}

/** `<tr>…</tr>` の並び。 */
function trs(html: string): string[] {
  return [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map((match) => match[0]);
}

interface Cell {
  readonly openTag: string;
  readonly inner: string;
}

/** `<td>` の開始タグと中身の並び。 */
function tds(html: string): Cell[] {
  return [...html.matchAll(/(<td\b[^>]*>)([\s\S]*?)<\/td>/g)].map((match) => ({
    openTag: match[1] as string,
    inner: match[2] as string,
  }));
}

function styleOf(openTag: string): string {
  return /\bstyle="([^"]*)"/.exec(openTag)?.[1] ?? '';
}

/** `colspan` の値（大文字小文字を問わない。実装プラン §8 の 1）。 */
function colspanOf(openTag: string): string | undefined {
  return /\bcolspan="(\d+)"/i.exec(openTag)?.[1];
}

/** 今のセルの下線（`table.tsx` の `CELL`。実装プラン §8 の 2）。 */
const UNDERLINE = /border-bottom:\s*1px solid var\(--tf-color-border-weak\)/;

/** 下線が引かれているか（`border-bottom` が無い・`none`・`0` なら引かれていない）。 */
function hasUnderline(openTag: string): boolean {
  const value = /(?:^|;)\s*border-bottom\s*:\s*([^;]*)/.exec(styleOf(openTag))?.[1]?.trim();
  if (value === undefined) return false;
  return !/^(?:none|0(?:px)?)(?:\s|$)/.test(value);
}

/* -------------------------------------------------------------------------- */
/* #1 detail なし                                                                */
/* -------------------------------------------------------------------------- */

describe('#1 detail を渡さないときの出力は今のまま', () => {
  it('#1 <tbody> が 1 つ', () => {
    expect(tbodies(render(false))).toHaveLength(1);
  });

  it('#1 <tbody> の中に行ごとに <tr> が 1 つ（行の数だけ）', () => {
    const body = tbodies(render(false))[0] ?? '';

    expect(trs(body)).toHaveLength(ROWS.length);
    ROWS.forEach((row, index) => {
      expect(textOf(trs(body)[index] ?? ''), row.id).toContain(row.name);
    });
  });

  it('#1 colspan が無い', () => {
    expect(render(false)).not.toMatch(/colspan=/i);
  });

  it('#1 各 <tr> に列の数だけ <td> がある', () => {
    for (const tr of trs(tbodies(render(false))[0] ?? '')) {
      expect(tds(tr)).toHaveLength(COLUMNS.length);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #2 detail あり：行グループ                                                     */
/* -------------------------------------------------------------------------- */

describe('#2 detail を渡すと行ごとに <tbody> が 1 つ', () => {
  it('#2 <tbody> が行の数だけある', () => {
    expect(tbodies(render(true))).toHaveLength(ROWS.length);
  });

  it('#2 <tbody> は rowKey の順（行の並び）に並ぶ', () => {
    const groups = tbodies(render(true));

    ROWS.forEach((row, index) => {
      const text = textOf(groups[index] ?? '');
      expect(text, row.id).toContain(row.name);
      expect(text, row.id).toContain(`詳細-${row.id}`);
    });
  });

  it('#2 それぞれの <tbody> に <tr> がちょうど 2 つ', () => {
    for (const group of tbodies(render(true))) {
      expect(trs(group)).toHaveLength(2);
    }
  });

  it('#2 1 つの <tbody> には 1 行分の中身だけが入る（他の行の中身が混ざらない）', () => {
    const groups = tbodies(render(true));

    ROWS.forEach((row, index) => {
      const text = textOf(groups[index] ?? '');
      for (const other of ROWS.filter((candidate) => candidate.id !== row.id)) {
        expect(text, `${row.id} に ${other.id}`).not.toContain(other.name);
        expect(text, `${row.id} に ${other.id}`).not.toContain(`詳細-${other.id}`);
      }
    });
  });
});

/* -------------------------------------------------------------------------- */
/* #3 1 段目と 2 段目                                                            */
/* -------------------------------------------------------------------------- */

describe('#3 1 段目は列のセル、2 段目は全幅の detail', () => {
  it('#3 1 段目の <tr> に列の数だけ <td> がある', () => {
    for (const group of tbodies(render(true))) {
      expect(tds(trs(group)[0] ?? '')).toHaveLength(COLUMNS.length);
    }
  });

  it('#3 1 段目の各 <td> に各列の render の中身が列の順で入る', () => {
    const groups = tbodies(render(true));

    ROWS.forEach((row, index) => {
      const cells = tds(trs(groups[index] ?? '')[0] ?? '').map((cell) => textOf(cell.inner));
      expect(cells, row.id).toEqual([`識別子-${row.id}`, row.name, `件数-${row.count}`]);
    });
  });

  it('#3 1 段目に detail の中身が入らない', () => {
    for (const group of tbodies(render(true))) {
      expect(trs(group)[0] ?? '').not.toContain('detail-content');
    }
  });

  it('#3 2 段目の <tr> は <td> 1 つで、colspan が列の数', () => {
    for (const group of tbodies(render(true))) {
      const cells = tds(trs(group)[1] ?? '');
      expect(cells).toHaveLength(1);
      expect(colspanOf(cells[0]?.openTag ?? '')).toBe(String(COLUMNS.length));
    }
  });

  it('#3 2 段目の <td> に detail(row) の中身が入る', () => {
    const groups = tbodies(render(true));

    ROWS.forEach((row, index) => {
      const cell = tds(trs(groups[index] ?? '')[1] ?? '')[0]?.inner ?? '';
      expect(cell, row.id).toContain('<span class="detail-content">');
      expect(textOf(cell), row.id).toBe(`詳細-${row.id}`);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* #4 見出し                                                                     */
/* -------------------------------------------------------------------------- */

describe('#4 <thead> の見出しは列だけ', () => {
  it('#4 detail を渡しても <th> は列の数だけ', () => {
    const thead = theadOf(render(true));

    expect([...thead.matchAll(/<th\b/g)]).toHaveLength(COLUMNS.length);
    expect([...render(true).matchAll(/<th\b/g)]).toHaveLength(COLUMNS.length);
  });

  it('#4 <thead> の <tr> は 1 つで、見出しの文字は列の header の順', () => {
    const thead = theadOf(render(true));

    expect(trs(thead)).toHaveLength(1);
    expect(
      [...thead.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((match) => textOf(match[1] ?? '')),
    ).toEqual(['ID', '名前', '件数']);
  });
});

/* -------------------------------------------------------------------------- */
/* #5 下線                                                                       */
/* -------------------------------------------------------------------------- */

describe('#5 セルの下線', () => {
  it('#5 detail を渡すと 1 段目のセルに下線が無い', () => {
    for (const group of tbodies(render(true))) {
      for (const cell of tds(trs(group)[0] ?? '')) {
        expect(hasUnderline(cell.openTag), cell.openTag).toBe(false);
      }
    }
  });

  it('#5 detail を渡すと 2 段目のセルに今のセルと同じ下線がある', () => {
    for (const group of tbodies(render(true))) {
      const cell = tds(trs(group)[1] ?? '')[0];
      expect(cell, '2 段目の <td>').toBeDefined();
      expect(styleOf(cell?.openTag ?? '')).toMatch(UNDERLINE);
    }
  });

  it('#5 detail を渡さないときは全セルに今の下線がある', () => {
    const cells = tds(render(false));

    expect(cells).toHaveLength(ROWS.length * COLUMNS.length);
    for (const cell of cells) {
      expect(styleOf(cell.openTag), cell.openTag).toMatch(UNDERLINE);
    }
  });

  it('#5 判別力：border-bottom の無い style・none の style は下線なしと読み、1px solid は下線ありと読む', () => {
    expect(hasUnderline('<td style="padding:var(--tf-space-3);text-align:left">')).toBe(false);
    expect(hasUnderline('<td style="padding:0;border-bottom:none">')).toBe(false);
    expect(hasUnderline('<td style="border-bottom:0">')).toBe(false);
    expect(
      hasUnderline('<td style="padding:0;border-bottom:1px solid var(--tf-color-border-weak)">'),
    ).toBe(true);
  });
});
