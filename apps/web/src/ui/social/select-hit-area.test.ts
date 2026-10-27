import { createElement, type ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Link from 'next/link';
import { findAll, hookHarness, textOfNodes, type HostNode } from '@/test-support/hook-harness';

/**
 * 選択の当たり判定（057-social-bulk-post 設計 §5.1・ユーザー裁定 2、受け入れ条件 #6〜#12）。
 *
 * * #6 送信待ちタブ：状態のセルの `onClick` で、その行のチェックボックスが `checked`・「1 件を選択中」。もう一度で外れ「0 件を選択中」
 * * #7 送信待ちタブ：選択の列のセル（チェックボックスの外）の `onClick` で切り替わる
 * * #8 送信待ちタブ：チェックボックスの `onChange` で 1 回だけ切り替わる。同じクリックを受けたセルの `onClick`（`target` がチェックボックス）では変わらない
 * * #9 送信待ちタブ：アカウント・登録元・日時・配信方法・操作のセルと 2 段目のセルに `onClick` が無い
 * * #10 投稿タブ：6〜9 と同じ。状態のセルの補足のリンク（「（送信待ちで承認）」）が `target` のときは変わらない
 * * #11 閲覧者（`social.read` だけ）：両タブとも状態のセルに `onClick` も `cursor: pointer` も無い
 * * #12 `updatedAt` の無い行の状態のセルの `onClick` では選ばれない
 *
 * 描画器（`test-support/hook-harness.ts`）で `SocialPending`・`SocialPosts` を描き、`<td>` の `onClick` を実装プラン §8 の 3 の
 * 偽のイベント（`target.closest`・`currentTarget.contains`）で呼んで描き直す。部品の props は 057 で変わる（G4）ので、
 * 指定子を `string` の定数に置いた動的 import で読み、props の型をテストに写して `as` で渡す（055・056 と同じ）。
 */

vi.mock('react', async (importOriginal) => {
  const { withHookHarness } = await import('@/test-support/hook-harness');
  return withHookHarness(await importOriginal());
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

/* -------------------------------------------------------------------------- */
/* 型（055 設計 §9.3.5・054 設計 §9.8 から写す）                                     */
/* -------------------------------------------------------------------------- */

type ManualHandoffOutcome =
  | { readonly ok: true; readonly url: string; readonly note: string | null }
  | {
      readonly ok: false;
      readonly reason: 'unsupported' | 'invalid_url' | 'plugin_error' | 'not_scheduled';
    };

interface BaseRow {
  readonly id: string;
  readonly socialAccountId: string;
  readonly body: string;
  readonly scheduledAt: string | null;
  readonly status: string;
  readonly publishedAt: string | null;
  readonly deliveryMode: 'auto' | 'manual';
  readonly failureReason: string | null;
  readonly attemptCount: number;
  readonly skipCount: number;
  readonly externalUrl: string | null;
  readonly approvedAt?: string | null;
  readonly updatedAt?: string;
  readonly source?: { readonly kind: 'screen' };
  readonly scheduledFuture?: boolean;
  readonly publishing?: boolean;
  readonly desiredPast?: boolean;
  readonly manualOnly?: boolean;
}

interface PendingRow extends BaseRow {
  readonly kind: 'manual_pending' | 'awaiting_approval' | 'scheduled';
  readonly elapsedText?: string;
  readonly handoff?: ManualHandoffOutcome;
  readonly link: string | null;
  readonly media: readonly { readonly url: string; readonly alt: string | null }[];
  readonly requestedAt: string;
  readonly warning: 'no_publisher' | 'credential_missing' | null;
}

interface CommonProps {
  readonly accountNames: Readonly<Record<string, string>>;
  readonly accountProviders: Readonly<
    Record<string, { readonly provider: string; readonly credentialConfigured: boolean }>
  >;
  readonly publisherProviders: Readonly<
    Record<
      string,
      {
        readonly label: string;
        readonly manual: boolean;
        readonly publish: boolean;
        readonly credentialFieldKeys: readonly string[];
      }
    >
  >;
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly permissions: readonly string[];
}

interface PendingProps extends CommonProps {
  readonly rows: readonly PendingRow[];
  readonly filters: {
    readonly status: null;
    readonly accountId: null;
    readonly source: null;
    readonly perPage: number;
    readonly sort: 'action';
    readonly page: number;
  };
  readonly counts: Readonly<Record<PendingRow['kind'], number>>;
}

interface PostsProps extends CommonProps {
  readonly initialPosts: readonly BaseRow[];
  readonly filters: {
    readonly status: null;
    readonly accountId: null;
    readonly source: null;
    readonly perPage: number;
    readonly page: number;
  };
}

const PENDING_MODULE: string = '@/ui/social/social-pending';
const POSTS_MODULE: string = '@/ui/social/social-posts';

async function loadExport<P>(specifier: string, name: string): Promise<ComponentType<P>> {
  const module = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  const component = module[name];
  if (typeof component !== 'function') throw new Error(`${specifier} に ${name} が無い`);
  return component as ComponentType<P>;
}

/* -------------------------------------------------------------------------- */
/* データ                                                                       */
/* -------------------------------------------------------------------------- */

const ACCOUNT_ID = '01900000-0000-7000-8000-0000000057a1';
const ALL_PERMISSIONS = ['social.read', 'social.write', 'social.approve', 'social.delete'];
const SELECT_PAGE_LABEL = 'このページの投稿をすべて選択';
const SELECT_ROW_PREFIX = 'この投稿を選択：';
const APPROVAL_NOTE = '（送信待ちで承認）';

let sequence = 0;

function base(overrides: Partial<BaseRow> = {}): BaseRow {
  sequence += 1;
  const suffix = String(sequence).padStart(4, '0');
  return {
    id: `01900000-0000-7000-8000-00000057${suffix}`,
    socialAccountId: ACCOUNT_ID,
    body: `当たり判定の本文 ${suffix}`,
    scheduledAt: '2026-10-30T01:00:00.000Z',
    status: 'scheduled',
    publishedAt: null,
    deliveryMode: 'auto',
    failureReason: null,
    attemptCount: 0,
    skipCount: 0,
    externalUrl: null,
    approvedAt: null,
    updatedAt: `2026-10-27T00:00:00.${suffix.slice(1)}Z`,
    source: { kind: 'screen' },
    scheduledFuture: true,
    publishing: false,
    desiredPast: false,
    manualOnly: false,
    ...overrides,
  };
}

function pending(overrides: Partial<PendingRow> = {}): PendingRow {
  return {
    ...base(overrides),
    kind: 'scheduled',
    link: null,
    media: [],
    requestedAt: '2026-10-27T00:00:00.000Z',
    warning: null,
    ...overrides,
  };
}

const P_AUTO = pending({ body: '送信待ちの自動の予約' });
const P_AWAITING = pending({
  body: '送信待ちの承認待ち',
  status: 'awaiting_approval',
  kind: 'awaiting_approval',
  scheduledFuture: false,
});
const P_ROWS: readonly PendingRow[] = [P_AUTO, P_AWAITING];

const COMMON: CommonProps = {
  accountNames: { [ACCOUNT_ID]: '公式（テストSNS）' },
  accountProviders: { [ACCOUNT_ID]: { provider: 'testsns', credentialConfigured: true } },
  publisherProviders: {
    testsns: { label: 'テストSNS', manual: true, publish: true, credentialFieldKeys: [] },
  },
  total: 2,
  page: 1,
  perPage: 20,
  permissions: ALL_PERMISSIONS,
};

const PENDING_BASE: PendingProps = {
  ...COMMON,
  rows: P_ROWS,
  filters: { status: null, accountId: null, source: null, perPage: 20, sort: 'action', page: 1 },
  counts: { manual_pending: 0, awaiting_approval: 1, scheduled: 1 },
};

const T_AWAITING = base({ body: '投稿タブの承認待ち', status: 'awaiting_approval' });
const T_SCHEDULED = base({ body: '投稿タブの予約' });
const T_ROWS: readonly BaseRow[] = [T_AWAITING, T_SCHEDULED];

const POSTS_BASE: PostsProps = {
  ...COMMON,
  initialPosts: T_ROWS,
  filters: { status: null, accountId: null, source: null, perPage: 20, page: 1 },
};

/* -------------------------------------------------------------------------- */
/* 描画器の読み方                                                                 */
/* -------------------------------------------------------------------------- */

/** 見出しの文字の並び。 */
function headersOf(nodes: readonly HostNode[]): string[] {
  return findAll(nodes, (node) => node.type === 'th').map((node) => node.text.trim());
}

/** 本文で選んだ行グループ（056 で 1 投稿 = `<tbody>` 1 つ）。 */
function groupOf(nodes: readonly HostNode[], body: string): HostNode {
  const groups = findAll(nodes, (node) => node.type === 'tbody').filter((node) =>
    node.text.includes(body),
  );
  expect(groups, `本文「${body}」の行`).toHaveLength(1);
  return groups[0] as HostNode;
}

/** 行の 1 段目の `<td>`（見出しの順）。 */
function firstTier(nodes: readonly HostNode[], body: string): HostNode[] {
  const tr = findAll([groupOf(nodes, body)], (node) => node.type === 'tr')[0];
  return (tr?.children ?? []).filter((node) => node.type === 'td');
}

/** 行の 2 段目の `<td>`。 */
function secondTier(nodes: readonly HostNode[], body: string): HostNode | undefined {
  const trs = findAll([groupOf(nodes, body)], (node) => node.type === 'tr');
  return trs[1]?.children.find((node) => node.type === 'td');
}

function cellOf(nodes: readonly HostNode[], body: string, header: string): HostNode {
  const headers = headersOf(nodes);
  // 選択の列の見出しはチェックボックスだけで文字が無い（空文字）。
  const index = header === '' ? 0 : headers.indexOf(header);
  expect(index, `「${header}」の見出し`).toBeGreaterThanOrEqual(0);
  const cell = firstTier(nodes, body)[index];
  expect(cell, `「${body}」の「${header}」のセル`).toBeDefined();
  return cell as HostNode;
}

function rowCheckbox(nodes: readonly HostNode[], body: string): HostNode | undefined {
  return findAll(
    [groupOf(nodes, body)],
    (node) =>
      node.type === 'input' &&
      node.props['type'] === 'checkbox' &&
      String(node.props['aria-label'] ?? '').startsWith(SELECT_ROW_PREFIX),
  )[0];
}

function isRowChecked(nodes: readonly HostNode[], body: string): boolean {
  return rowCheckbox(nodes, body)?.props['checked'] === true;
}

/**
 * 件数の文の要素（「件を選択中」を含み、子にそれを含むものが無い要素）を引いてから読む。描画の全文に当てると、
 * 投稿タブでは直前の表示件数の選択肢（20・50・100）の文字とつながって「20501001 件を選択中」と読む（057 実装プラン §8 の 30）。
 */
function selectedCountText(nodes: readonly HostNode[]): string {
  const holds = (node: HostNode): boolean => node.text.includes('件を選択中');
  const own = findAll(nodes, (node) => holds(node) && !node.children.some(holds));
  return /(\d+)\s*件を選択中/.exec(textOfNodes(own))?.[0] ?? '';
}

function styleOf(node: HostNode): Record<string, unknown> {
  return (node.props['style'] ?? {}) as Record<string, unknown>;
}

/** 操作できる要素の無いところを押した偽のイベント（実装プラン §8 の 3）。 */
const PLAIN_EVENT = {
  target: { closest: () => null },
  currentTarget: { contains: () => true },
  preventDefault: () => undefined,
  stopPropagation: () => undefined,
};

/** セルの中の操作できる要素（`found`）を押した偽のイベント。 */
function insideEvent(found: unknown): unknown {
  return {
    target: { closest: () => found },
    currentTarget: { contains: (node: unknown) => node === found },
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  };
}

function cellClick(cell: HostNode, event: unknown): void {
  const onClick = cell.props['onClick'];
  if (typeof onClick !== 'function') throw new Error('セルに onClick が無い');
  (onClick as (value: unknown) => void)(event);
}

function checkboxChange(node: HostNode | undefined): void {
  const onChange = node?.props['onChange'];
  if (typeof onChange !== 'function') throw new Error('チェックボックスに onChange が無い');
  const checked = node?.props['checked'] !== true;
  (onChange as (event: unknown) => void)({
    target: { checked },
    currentTarget: { checked },
  });
}

beforeEach(() => {
  hookHarness.reset();
  hookHarness.leaves.clear();
  hookHarness.leaves.add(Link);
});

/* -------------------------------------------------------------------------- */
/* 両タブで同じ条件（#6〜#9・#10）                                                  */
/* -------------------------------------------------------------------------- */

interface TabCase {
  readonly name: string;
  readonly target: string;
  readonly other: string;
  readonly otherHeaders: readonly string[];
  readonly draw: (overrides?: Record<string, unknown>) => Promise<readonly HostNode[]>;
}

async function drawPending(overrides: Record<string, unknown> = {}): Promise<readonly HostNode[]> {
  const SocialPending = await loadExport<PendingProps>(PENDING_MODULE, 'SocialPending');
  return hookHarness.render(createElement(SocialPending, { ...PENDING_BASE, ...overrides }));
}

async function drawPosts(overrides: Record<string, unknown> = {}): Promise<readonly HostNode[]> {
  const SocialPosts = await loadExport<PostsProps>(POSTS_MODULE, 'SocialPosts');
  return hookHarness.render(createElement(SocialPosts, { ...POSTS_BASE, ...overrides }));
}

const TABS: readonly TabCase[] = [
  {
    name: '送信待ちタブ',
    target: P_AUTO.body,
    other: P_AWAITING.body,
    otherHeaders: ['アカウント', '登録元', '日時', '配信方法', '操作'],
    draw: drawPending,
  },
  {
    name: '投稿タブ',
    target: T_SCHEDULED.body,
    other: T_AWAITING.body,
    otherHeaders: ['アカウント', '登録元', '予約日時', '配信方法', '操作'],
    draw: drawPosts,
  },
];

describe.each(TABS)('$name のチェックの当たり判定（管理者）', (tab) => {
  const num = tab.name === '送信待ちタブ' ? '' : '#10 ';

  it(`${num}#6 状態のセルの onClick でその行のチェックが付き「1 件を選択中」、もう一度で外れ「0 件を選択中」`, async () => {
    const before = await tab.draw();
    expect(isRowChecked(before, tab.target)).toBe(false);

    cellClick(cellOf(before, tab.target, '状態'), PLAIN_EVENT);
    const once = await tab.draw();

    expect(isRowChecked(once, tab.target)).toBe(true);
    expect(isRowChecked(once, tab.other)).toBe(false);
    expect(selectedCountText(once)).toBe('1 件を選択中');

    cellClick(cellOf(once, tab.target, '状態'), PLAIN_EVENT);
    const twice = await tab.draw();

    expect(isRowChecked(twice, tab.target)).toBe(false);
    expect(selectedCountText(twice)).toBe('0 件を選択中');
  });

  it(`${num}#6 状態のセルは cursor: pointer`, async () => {
    expect(styleOf(cellOf(await tab.draw(), tab.target, '状態'))['cursor']).toBe('pointer');
  });

  it(`${num}#7 選択の列のセル（チェックボックスの外）の onClick で切り替わる`, async () => {
    const before = await tab.draw();
    const selectCell = cellOf(before, tab.target, '');

    expect(findAll([selectCell], (node) => node.type === 'input')).toHaveLength(1);
    expect(styleOf(selectCell)['cursor']).toBe('pointer');

    cellClick(selectCell, PLAIN_EVENT);
    const once = await tab.draw();
    expect(isRowChecked(once, tab.target)).toBe(true);

    cellClick(cellOf(once, tab.target, ''), PLAIN_EVENT);
    expect(isRowChecked(await tab.draw(), tab.target)).toBe(false);
  });

  it(`${num}#8 チェックボックスの onChange で 1 回だけ切り替わり、同じクリックを受けたセルの onClick（target がチェックボックス）では変わらない`, async () => {
    const before = await tab.draw();
    const checkbox = rowCheckbox(before, tab.target);
    const selectCell = cellOf(before, tab.target, '');

    // ブラウザでは、チェックボックスの change の後に同じクリックがセルへ泡立つ。
    checkboxChange(checkbox);
    cellClick(selectCell, insideEvent(checkbox));
    const after = await tab.draw();

    expect(isRowChecked(after, tab.target)).toBe(true);
    expect(selectedCountText(after)).toBe('1 件を選択中');
  });

  it(`${num}#9 ${tab.otherHeaders.join('・')} のセルと 2 段目のセルに onClick が無い`, async () => {
    const nodes = await tab.draw();

    for (const header of tab.otherHeaders) {
      expect(cellOf(nodes, tab.target, header).props['onClick'], header).toBeUndefined();
    }
    expect(secondTier(nodes, tab.target)?.props['onClick'], '2 段目').toBeUndefined();
  });

  it(`${num}#9 ${tab.otherHeaders.join('・')} のセルと 2 段目のセルは cursor: pointer でない`, async () => {
    const nodes = await tab.draw();

    for (const header of tab.otherHeaders) {
      expect(styleOf(cellOf(nodes, tab.target, header))['cursor'], header).not.toBe('pointer');
    }
    const second = secondTier(nodes, tab.target);
    expect(second === undefined ? undefined : styleOf(second)['cursor']).not.toBe('pointer');
  });
});

/* -------------------------------------------------------------------------- */
/* #10 投稿タブの補足のリンク                                                       */
/* -------------------------------------------------------------------------- */

describe('#10 投稿タブ：状態のセルの補足のリンク', () => {
  it('#10 承認待ちの状態のセルに「（送信待ちで承認）」のリンクがある（前提）', async () => {
    const cell = cellOf(await drawPosts(), T_AWAITING.body, '状態');
    const links = findAll([cell], (node) => node.type === 'a' && node.text.includes(APPROVAL_NOTE));

    expect(links).toHaveLength(1);
  });

  it('#10 リンクが target のときは状態のセルの onClick で切り替わらない', async () => {
    const before = await drawPosts();
    const cell = cellOf(before, T_AWAITING.body, '状態');
    const link = findAll([cell], (node) => node.type === 'a')[0];

    cellClick(cell, insideEvent(link));
    const after = await drawPosts();

    expect(isRowChecked(after, T_AWAITING.body)).toBe(false);
    expect(selectedCountText(after)).toBe('0 件を選択中');
  });

  it('#10 対照：同じ承認待ちの状態のセルを、リンクの外で押せば切り替わる', async () => {
    cellClick(cellOf(await drawPosts(), T_AWAITING.body, '状態'), PLAIN_EVENT);

    expect(isRowChecked(await drawPosts(), T_AWAITING.body)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #11 閲覧者                                                                    */
/* -------------------------------------------------------------------------- */

describe('#11 閲覧者（social.read だけ）', () => {
  const viewer = { permissions: ['social.read'] };

  it.each([
    ['送信待ちタブ', drawPending, P_AUTO.body],
    ['投稿タブ', drawPosts, T_SCHEDULED.body],
  ] as const)(
    '#11 %s：状態のセルに onClick も cursor: pointer も無い',
    async (_name, draw, body) => {
      const nodes = await draw(viewer);
      const cell = cellOf(nodes, body, '状態');

      expect(cell.props['onClick']).toBeUndefined();
      expect(styleOf(cell)['cursor']).not.toBe('pointer');
    },
  );

  it.each([
    ['送信待ちタブ', drawPending, P_AUTO.body],
    ['投稿タブ', drawPosts, T_SCHEDULED.body],
  ] as const)('#11 %s：どのセルにも onClick が無い', async (_name, draw, body) => {
    const nodes = await draw(viewer);

    for (const cell of findAll([groupOf(nodes, body)], (node) => node.type === 'td')) {
      expect(cell.props['onClick']).toBeUndefined();
    }
  });

  it('#11 前提：閲覧者の表には選択の列が無い（見出しの先頭は「状態」）', async () => {
    expect(headersOf(await drawPending(viewer))[0]).toBe('状態');
    expect(
      findAll(
        await drawPending(viewer),
        (node) => node.type === 'input' && node.props['aria-label'] === SELECT_PAGE_LABEL,
      ),
    ).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* #12 選べない行                                                                 */
/* -------------------------------------------------------------------------- */

describe('#12 updatedAt の無い行', () => {
  const { updatedAt: _omit, ...withoutUpdatedAt } = pending({ body: 'updatedAt の無い行' });
  const UNSELECTABLE = withoutUpdatedAt as PendingRow;

  async function draw(): Promise<readonly HostNode[]> {
    return drawPending({ rows: [UNSELECTABLE, P_AUTO], total: 2 });
  }

  it('#12 状態のセルの onClick では選ばれない（「0 件を選択中」のまま）', async () => {
    cellClick(cellOf(await draw(), UNSELECTABLE.body, '状態'), PLAIN_EVENT);
    const after = await draw();

    expect(rowCheckbox(after, UNSELECTABLE.body)).toBeUndefined();
    expect(selectedCountText(after)).toBe('0 件を選択中');
  });

  it('#12 対照：同じ表の選べる行は状態のセルの onClick で選ばれる', async () => {
    cellClick(cellOf(await draw(), P_AUTO.body, '状態'), PLAIN_EVENT);

    expect(selectedCountText(await draw())).toBe('1 件を選択中');
  });
});
