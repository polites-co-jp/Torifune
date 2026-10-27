import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findAll, hookHarness, type HostNode } from '@/test-support/hook-harness';
import { Table, type Column, type TableProps } from './table';

/**
 * `Table` の列の任意の `onCellClick`（セル全体のクリック。057-social-bulk-post 設計 §5.1、受け入れ条件 #1〜#5）。
 *
 * * #1 どの列にも `onCellClick` を渡さない出力は今と同じ（`detail` の有無の両方。`cursor` の指定が無い）
 * * #2 `onCellClick` を渡した列の `<td>` だけが `cursor: pointer`（`detail` ありの 1 段目も。2 段目には付かない）
 * * #3 描画器で `<td>` の `onClick` を、操作できる要素の無い `target` で呼ぶと `onCellClick(row)` が 1 回。他の列の `<td>` に `onClick` が無い
 * * #4 `target.closest(CELL_CLICK_IGNORE_SELECTOR)` がセルの中の要素を返すときは呼ばない。セルの外なら呼ぶ（`isCellClickIgnored`）
 * * #5 `CELL_CLICK_IGNORE_SELECTOR` の中身
 *
 * `onCellClick` はまだ `Column` に無いので、列の型を**テストの中で写す**（`table-header.test.ts` と同じ形）。
 * `CELL_CLICK_IGNORE_SELECTOR`・`isCellClickIgnored` はまだ無いので、指定子を `string` の定数に置いた動的 import で読む。
 * 偽のイベントは実装プラン §8 の 3 の形（`target.closest`・`currentTarget.contains`）。
 * `Table` はフックを使わないので、描画器は `react` を差し替えずにそのまま辿れる。
 */

interface Row {
  readonly id: string;
  readonly name: string;
}

type ClickColumn<T> = Column<T> & { readonly onCellClick?: (row: T) => void };

type ClickTableProps<T> = Omit<TableProps<T>, 'columns'> & {
  readonly columns: readonly ClickColumn<T>[];
};

const ClickTable = Table as unknown as ComponentType<ClickTableProps<Row>>;

const ROWS: readonly Row[] = [
  { id: 'r1', name: '新製品のお知らせ' },
  { id: 'r2', name: '秋のセール' },
];

/** 今の `Table` と同じ 3 列（選択・状態・本文）。`onCellClick` を足すかは引数で決める。 */
function columns(
  handlers: { readonly select?: (row: Row) => void; readonly status?: (row: Row) => void } = {},
): readonly ClickColumn<Row>[] {
  return [
    {
      key: 'select',
      header: '選択',
      width: '2.5rem',
      render: (row) => `選-${row.id}`,
      ...(handlers.select === undefined ? {} : { onCellClick: handlers.select }),
    },
    {
      key: 'status',
      header: '状態',
      render: (row) => `状-${row.id}`,
      ...(handlers.status === undefined ? {} : { onCellClick: handlers.status }),
    },
    { key: 'name', header: '本文', render: (row) => row.name, align: 'right' },
  ];
}

function detailOf(row: Row): ReactNode {
  return `詳-${row.id}`;
}

function props(
  cols: readonly ClickColumn<Row>[],
  withDetail: boolean,
): ClickTableProps<Row> & Record<string, unknown> {
  return {
    columns: cols,
    rows: ROWS,
    rowKey: (row: Row) => row.id,
    ...(withDetail ? { detail: detailOf } : {}),
  };
}

function html(cols: readonly ClickColumn<Row>[], withDetail: boolean): string {
  return renderToStaticMarkup(createElement(ClickTable, props(cols, withDetail)));
}

function draw(cols: readonly ClickColumn<Row>[], withDetail: boolean): readonly HostNode[] {
  return hookHarness.render(createElement(ClickTable, props(cols, withDetail)));
}

/** `<td>` の開始タグの並び。 */
function tdTags(markup: string): string[] {
  return [...markup.matchAll(/<td\b[^>]*>/g)].map((match) => match[0]);
}

function styleOf(openTag: string): string {
  return /\bstyle="([^"]*)"/.exec(openTag)?.[1] ?? '';
}

function hasPointer(openTag: string): boolean {
  return /(?:^|;)\s*cursor\s*:\s*pointer\s*(?:;|$)/.test(styleOf(openTag));
}

/** 描画器の `<td>`（1 段目は列の数ずつ、`detail` ありなら 2 段目の `<td>` が行ごとに挟まる）。 */
function tdNodes(nodes: readonly HostNode[]): HostNode[] {
  return findAll(nodes, (node) => node.type === 'td');
}

/** 1 段目の `<td>`（`colSpan` を持たないもの）を行ごとに列の数で切る。 */
function firstTierCells(nodes: readonly HostNode[]): HostNode[][] {
  const cells = tdNodes(nodes).filter((node) => node.props['colSpan'] === undefined);
  const out: HostNode[][] = [];
  for (let index = 0; index < cells.length; index += 3) out.push(cells.slice(index, index + 3));
  return out;
}

/** 操作できる要素の無いところ（`closest` が `null`）を押した偽のイベント（実装プラン §8 の 3）。 */
const PLAIN_EVENT = {
  target: { closest: () => null },
  currentTarget: { contains: () => true },
  preventDefault: () => undefined,
  stopPropagation: () => undefined,
};

/** セルの中の操作できる要素（`found`）を押した偽のイベント。 */
function insideEvent(found: object): unknown {
  return {
    target: { closest: () => found },
    currentTarget: { contains: (node: unknown) => node === found },
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  };
}

/** `closest` はセルの外の要素を返す（セルの中には操作できる要素が無い）偽のイベント。 */
function outsideEvent(found: object): unknown {
  return {
    target: { closest: () => found },
    currentTarget: { contains: () => false },
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  };
}

function callOnClick(node: HostNode | undefined, event: unknown): void {
  const onClick = node?.props['onClick'];
  if (typeof onClick !== 'function') throw new Error('<td> に onClick が無い');
  (onClick as (value: unknown) => void)(event);
}

interface CellClickModule {
  readonly CELL_CLICK_IGNORE_SELECTOR: string;
  readonly isCellClickIgnored: (target: unknown, cell: unknown) => boolean;
}

const MODULE: string = '@/ui/components/table';

async function loadModule(): Promise<CellClickModule> {
  const module = (await import(/* @vite-ignore */ MODULE)) as Record<string, unknown>;
  if (typeof module['CELL_CLICK_IGNORE_SELECTOR'] !== 'string') {
    throw new Error('ui/components/table.tsx に CELL_CLICK_IGNORE_SELECTOR が無い');
  }
  if (typeof module['isCellClickIgnored'] !== 'function') {
    throw new Error('ui/components/table.tsx に isCellClickIgnored が無い');
  }
  return module as unknown as CellClickModule;
}

beforeEach(() => {
  hookHarness.reset();
  hookHarness.leaves.clear();
});

/* -------------------------------------------------------------------------- */
/* #1 onCellClick なし                                                           */
/* -------------------------------------------------------------------------- */

/** 057 の前（`754da38`）の `Table` が同じ列・行で描いた HTML。 */
const EXPECTED_WITHOUT_DETAIL =
  '<div class="tf-table-scroll"><table style="width:100%;border-collapse:collapse"><thead><tr><th scope="col" style="padding:var(--tf-space-3);border-bottom:1px solid var(--tf-color-border-weak);text-align:left;color:var(--tf-color-text-subtle);font-size:var(--tf-text-label);font-weight:600;white-space:nowrap;width:2.5rem">選択</th><th scope="col" style="padding:var(--tf-space-3);border-bottom:1px solid var(--tf-color-border-weak);text-align:left;color:var(--tf-color-text-subtle);font-size:var(--tf-text-label);font-weight:600;white-space:nowrap">状態</th><th scope="col" style="padding:var(--tf-space-3);border-bottom:1px solid var(--tf-color-border-weak);text-align:right;color:var(--tf-color-text-subtle);font-size:var(--tf-text-label);font-weight:600;white-space:nowrap">本文</th></tr></thead><tbody><tr><td style="padding:var(--tf-space-3);border-bottom:1px solid var(--tf-color-border-weak);text-align:left">選-r1</td><td style="padding:var(--tf-space-3);border-bottom:1px solid var(--tf-color-border-weak);text-align:left">状-r1</td><td style="padding:var(--tf-space-3);border-bottom:1px solid var(--tf-color-border-weak);text-align:right;font-family:var(--tf-font-mono);font-variant-numeric:tabular-nums">新製品のお知らせ</td></tr><tr><td style="padding:var(--tf-space-3);border-bottom:1px solid var(--tf-color-border-weak);text-align:left">選-r2</td><td style="padding:var(--tf-space-3);border-bottom:1px solid var(--tf-color-border-weak);text-align:left">状-r2</td><td style="padding:var(--tf-space-3);border-bottom:1px solid var(--tf-color-border-weak);text-align:right;font-family:var(--tf-font-mono);font-variant-numeric:tabular-nums">秋のセール</td></tr></tbody></table></div>';

const EXPECTED_WITH_DETAIL =
  '<div class="tf-table-scroll"><table style="width:100%;border-collapse:collapse"><thead><tr><th scope="col" style="padding:var(--tf-space-3);border-bottom:1px solid var(--tf-color-border-weak);text-align:left;color:var(--tf-color-text-subtle);font-size:var(--tf-text-label);font-weight:600;white-space:nowrap;width:2.5rem">選択</th><th scope="col" style="padding:var(--tf-space-3);border-bottom:1px solid var(--tf-color-border-weak);text-align:left;color:var(--tf-color-text-subtle);font-size:var(--tf-text-label);font-weight:600;white-space:nowrap">状態</th><th scope="col" style="padding:var(--tf-space-3);border-bottom:1px solid var(--tf-color-border-weak);text-align:right;color:var(--tf-color-text-subtle);font-size:var(--tf-text-label);font-weight:600;white-space:nowrap">本文</th></tr></thead><tbody><tr><td style="padding:var(--tf-space-3);border-bottom:none;text-align:left">選-r1</td><td style="padding:var(--tf-space-3);border-bottom:none;text-align:left">状-r1</td><td style="padding:var(--tf-space-3);border-bottom:none;text-align:right;font-family:var(--tf-font-mono);font-variant-numeric:tabular-nums">新製品のお知らせ</td></tr><tr><td colSpan="3" style="padding:var(--tf-space-3);border-bottom:1px solid var(--tf-color-border-weak);text-align:left;padding-top:0"><div style="width:0;min-width:100%">詳-r1</div></td></tr></tbody><tbody><tr><td style="padding:var(--tf-space-3);border-bottom:none;text-align:left">選-r2</td><td style="padding:var(--tf-space-3);border-bottom:none;text-align:left">状-r2</td><td style="padding:var(--tf-space-3);border-bottom:none;text-align:right;font-family:var(--tf-font-mono);font-variant-numeric:tabular-nums">秋のセール</td></tr><tr><td colSpan="3" style="padding:var(--tf-space-3);border-bottom:1px solid var(--tf-color-border-weak);text-align:left;padding-top:0"><div style="width:0;min-width:100%">詳-r2</div></td></tr></tbody></table></div>';

describe('#1 onCellClick を渡さない Table の出力は今と同じ', () => {
  it('#1 detail なし：057 の前と同じ HTML', () => {
    expect(html(columns(), false)).toBe(EXPECTED_WITHOUT_DETAIL);
  });

  it('#1 detail あり：057 の前と同じ HTML', () => {
    expect(html(columns(), true)).toBe(EXPECTED_WITH_DETAIL);
  });

  it('#1 どの <td> にも cursor の指定が無い（detail の有無の両方）', () => {
    for (const withDetail of [false, true]) {
      for (const tag of tdTags(html(columns(), withDetail))) {
        expect(styleOf(tag), tag).not.toMatch(/cursor/);
      }
    }
  });

  it('#1 どの <td> にも onClick が無い（描画器）', () => {
    for (const withDetail of [false, true]) {
      for (const cell of tdNodes(draw(columns(), withDetail))) {
        expect(cell.props['onClick'], cell.text).toBeUndefined();
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #2 cursor: pointer                                                           */
/* -------------------------------------------------------------------------- */

describe('#2 onCellClick を渡した列の <td> だけが cursor: pointer', () => {
  it('#2 detail なし：状態の列の <td> だけが cursor: pointer', () => {
    const tags = tdTags(html(columns({ status: () => undefined }), false));

    expect(tags).toHaveLength(ROWS.length * 3);
    tags.forEach((tag, index) => {
      expect(hasPointer(tag), tag).toBe(index % 3 === 1);
    });
  });

  it('#2 detail あり：1 段目の状態の列の <td> が cursor: pointer で、2 段目の <td> には付かない', () => {
    const markup = html(columns({ status: () => undefined }), true);
    const groups = [...markup.matchAll(/<tbody\b[^>]*>[\s\S]*?<\/tbody>/g)].map((m) => m[0]);

    expect(groups).toHaveLength(ROWS.length);
    for (const group of groups) {
      const tags = tdTags(group);
      expect(tags).toHaveLength(4);
      expect(tags.map(hasPointer)).toEqual([false, true, false, false]);
      expect(tags[3]).toMatch(/colSpan="3"/i);
    }
  });

  it('#2 2 つの列に渡せば 2 つの列の <td> が cursor: pointer（本文の列には付かない）', () => {
    const tags = tdTags(html(columns({ select: () => undefined, status: () => undefined }), false));

    tags.forEach((tag, index) => {
      expect(hasPointer(tag), tag).toBe(index % 3 !== 2);
    });
  });

  it('#2 onCellClick を渡した列も今のセルの style（余白・下線）を保つ', () => {
    const tag = tdTags(html(columns({ status: () => undefined }), false))[1] ?? '';

    expect(styleOf(tag)).toContain('padding:var(--tf-space-3)');
    expect(styleOf(tag)).toContain('border-bottom:1px solid var(--tf-color-border-weak)');
  });

  it('#2 判別力：cursor の読み方（pointer だけを真と読む）', () => {
    expect(hasPointer('<td style="padding:0;cursor:pointer">')).toBe(true);
    expect(hasPointer('<td style="cursor:pointer;padding:0">')).toBe(true);
    expect(hasPointer('<td style="cursor:default">')).toBe(false);
    expect(hasPointer('<td style="padding:0">')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #3 onClick で onCellClick(row)                                               */
/* -------------------------------------------------------------------------- */

describe('#3 <td> の onClick で onCellClick(row) が呼ばれる', () => {
  it('#3 操作できる要素の無い target で、その行を引数に onCellClick が 1 回呼ばれる', () => {
    const onStatus = vi.fn<(row: Row) => void>();
    const rows = firstTierCells(draw(columns({ status: onStatus }), false));

    callOnClick(rows[1]?.[1], PLAIN_EVENT);

    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(ROWS[1]);
  });

  it('#3 detail ありの 1 段目のセルでも同じ', () => {
    const onStatus = vi.fn<(row: Row) => void>();
    const rows = firstTierCells(draw(columns({ status: onStatus }), true));

    callOnClick(rows[0]?.[1], PLAIN_EVENT);

    expect(onStatus.mock.calls).toEqual([[ROWS[0]]]);
  });

  it('#3 onCellClick の無い列の <td> と detail の 2 段目の <td> には onClick が無い', () => {
    const nodes = draw(columns({ status: () => undefined }), true);

    for (const cells of firstTierCells(nodes)) {
      expect(cells[0]?.props['onClick'], '選択の列').toBeUndefined();
      expect(typeof cells[1]?.props['onClick'], '状態の列').toBe('function');
      expect(cells[2]?.props['onClick'], '本文の列').toBeUndefined();
    }
    for (const cell of tdNodes(nodes).filter((node) => node.props['colSpan'] !== undefined)) {
      expect(cell.props['onClick'], '2 段目').toBeUndefined();
    }
  });

  it('#3 列ごとの onCellClick は自分の列のクリックでだけ呼ばれる', () => {
    const onSelect = vi.fn<(row: Row) => void>();
    const onStatus = vi.fn<(row: Row) => void>();
    const rows = firstTierCells(draw(columns({ select: onSelect, status: onStatus }), false));

    callOnClick(rows[0]?.[0], PLAIN_EVENT);

    expect(onSelect.mock.calls).toEqual([[ROWS[0]]]);
    expect(onStatus).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* #4 操作できる要素からのクリック                                                  */
/* -------------------------------------------------------------------------- */

describe('#4 セルの中の操作できる要素からのクリックでは onCellClick を呼ばない', () => {
  it.each(['チェックボックス', 'リンク', 'ボタン'])(
    '#4 closest がセルの中の要素（%s）を返すとき onCellClick を呼ばない',
    (name) => {
      const onStatus = vi.fn<(row: Row) => void>();
      const rows = firstTierCells(draw(columns({ status: onStatus }), false));

      callOnClick(rows[0]?.[1], insideEvent({ name }));

      expect(onStatus).not.toHaveBeenCalled();
    },
  );

  it('#4 closest がセルの外の要素を返すとき（表を包むリンクなど）は呼ぶ', () => {
    const onStatus = vi.fn<(row: Row) => void>();
    const rows = firstTierCells(draw(columns({ status: onStatus }), false));

    callOnClick(rows[0]?.[1], outsideEvent({ name: 'セルの外のリンク' }));

    expect(onStatus.mock.calls).toEqual([[ROWS[0]]]);
  });

  it('#4 isCellClickIgnored：closest がセルの中の要素を返せば真', async () => {
    const { isCellClickIgnored } = await loadModule();
    const found = { name: 'checkbox' };

    expect(
      isCellClickIgnored({ closest: () => found }, { contains: (node: unknown) => node === found }),
    ).toBe(true);
  });

  it('#4 isCellClickIgnored：closest がセルの外の要素を返せば偽', async () => {
    const { isCellClickIgnored } = await loadModule();

    expect(isCellClickIgnored({ closest: () => ({}) }, { contains: () => false })).toBe(false);
  });

  it('#4 isCellClickIgnored：closest が null を返せば偽', async () => {
    const { isCellClickIgnored } = await loadModule();

    expect(isCellClickIgnored({ closest: () => null }, { contains: () => true })).toBe(false);
  });

  it('#4 isCellClickIgnored：target が closest を持たなければ偽（設計 §5.1。実装プラン §8 の 2）', async () => {
    const { isCellClickIgnored } = await loadModule();

    expect(isCellClickIgnored({}, { contains: () => true })).toBe(false);
    expect(isCellClickIgnored(null, { contains: () => true })).toBe(false);
    expect(isCellClickIgnored('text', { contains: () => true })).toBe(false);
  });

  it('#4 isCellClickIgnored：closest に CELL_CLICK_IGNORE_SELECTOR を渡す', async () => {
    const { isCellClickIgnored, CELL_CLICK_IGNORE_SELECTOR } = await loadModule();
    const closest = vi.fn(() => null);

    isCellClickIgnored({ closest }, { contains: () => true });

    expect(closest).toHaveBeenCalledWith(CELL_CLICK_IGNORE_SELECTOR);
  });
});

/* -------------------------------------------------------------------------- */
/* #5 選択子                                                                     */
/* -------------------------------------------------------------------------- */

describe('#5 CELL_CLICK_IGNORE_SELECTOR', () => {
  const EXPECTED = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'label',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[contenteditable="true"]',
  ];

  it.each(EXPECTED)('#5 「%s」を含む', async (selector) => {
    const { CELL_CLICK_IGNORE_SELECTOR } = await loadModule();
    const parts = CELL_CLICK_IGNORE_SELECTOR.split(',').map((part) => part.trim());

    expect(parts).toContain(selector);
  });
});
