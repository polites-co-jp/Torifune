import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BulkEffect, BulkFailureReason } from '@/domain/social/bulk';
import { POST_STATUSES } from '@/domain/social/social';
import {
  BULK_SEND_WARN_DESIRED_PAST,
  BULK_SEND_WARN_NO_DESIRED,
  POST_STATUS_LABEL,
} from './labels';
import type { PostListFilters, PostListOption, PostSourceView } from './post-list-params';
import { SocialPosts, type PostRow, type SocialPostsProps } from './social-posts';

// 部品は一括操作の後に `router.refresh()` を呼ぶ（設計 §9.7）。
// `useRouter` は App Router の外では例外を投げるので差し替える（`approval-pending.test.ts` と同じ）。
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

/**
 * 投稿一覧の選択・登録元・絞り込み・一括操作（054-bulk-post-actions 設計 §9.1〜§9.8、
 * 受け入れ条件 #62〜#66・#69・#70・#73・#74 の部品・#77・#78）。
 *
 * * #62 選択の列（先頭）・見出しと行のチェックボックスの `aria-label`・「登録元」の見出し
 * * #63 登録元の表示 4 種
 * * #64 閲覧者は選択の列・一括の帯が無く、登録元の列（と絞り込み）はある
 * * #65 見出しの一括選択の状態（`indeterminate` は `data-indeterminate="true"`。実装プラン §8 の 16）・件数・「（全 N 件）」
 * * #66 一括の帯のボタンの出し分けと `disabled`
 * * #69・#70 一括送信・一括取り消しのダイアログ（`initialDialog`）
 * * #73 結果のダイアログ（`initialResults`）
 * * #74 絞り込みの帯の 4 つの `Select`・表示件数・「条件をクリア」・登録元の選択肢の「（発行 …）」
 * * #77 0 件の表示（表示件数だけでは「条件」にしない）、#78 既存の locator と帯のボタンの名前
 *
 * 足す props（設計 §9.8。すべて任意）と行の項目はまだ型に無いので、部品を**テストの中で写した props の型**として読む
 * （053 実装プラン §8 の 44）。`initialResults` の形は設計が決めていないので、実装プラン §8 の 52 で読んだ
 * `summarizeBulkResults` の引数と同じ形（応答の `results` と要求ごとの失敗）にする。
 *
 * 単体テストの環境には DOM が無く、ボタンを押せない。押したときの選択の切り替えは `bulk-plan.test.ts`
 * （`toggleAllSelection`）、ページ送りは `post-list-params.test.ts`（`openPostListPage`）と
 * `bulk-labels-static-checks.test.ts` が見る（実装プラン §8 の 16）。
 */

/* -------------------------------------------------------------------------- */
/* 型（設計 §9.8 から写す）                                                       */
/* -------------------------------------------------------------------------- */

type BulkPostRow = PostRow & {
  readonly updatedAt?: string;
  readonly source?: PostSourceView;
  readonly scheduledFuture?: boolean;
  readonly publishing?: boolean;
  readonly desiredPast?: boolean;
  readonly manualOnly?: boolean;
};

type ResultItem =
  | { readonly id: string; readonly ok: true; readonly effect: BulkEffect; readonly post: unknown }
  | {
      readonly id: string;
      readonly ok: false;
      readonly reason: BulkFailureReason;
      readonly message: string;
      readonly field: string | null;
    };

interface InitialResults {
  readonly results: readonly ResultItem[];
  readonly requestFailures?: readonly {
    readonly ids: readonly string[];
    readonly message: string;
  }[];
}

type BulkProps = Omit<SocialPostsProps, 'initialPosts'> & {
  readonly initialPosts: readonly BulkPostRow[];
  readonly filters?: PostListFilters;
  readonly sourceOptions?: readonly PostListOption[];
  readonly accountOptions?: readonly PostListOption[];
  readonly initialSelectedIds?: readonly string[];
  readonly initialDialog?: 'send' | 'delete' | null;
  readonly initialResults?: InitialResults;
};

const Component = SocialPosts as unknown as ComponentType<BulkProps>;

/* -------------------------------------------------------------------------- */
/* 文言（設計 §9.1〜§9.7・§9.10）                                                  */
/* -------------------------------------------------------------------------- */

const SELECT_PAGE_LABEL = 'このページの投稿をすべて選択';
const SELECT_ROW_PREFIX = 'この投稿を選択：';
const SOURCE_HEADER = '登録元';
const SCREEN_LABEL = '管理画面';
const REVOKED_SUFFIX = '（失効）';
const DELETED_SUFFIX = '（削除済み）';
const BULK_SEND_LABEL = '一括送信（承認）';
const BULK_DELETE_LABEL = '一括取り消し';
const SEND_CONFIRM = '送る';
const DESIRED_OPTION = 'それぞれの希望日時に投稿';
const NOW_OPTION = '即投稿';
const DELETE_TITLE = '投稿を一括で取り消しますか？';
const RESULT_TITLE = '一括操作の結果';
const RETRY_HINT = '処理されなかった投稿は、絞り込みで探して選び直せます。';
const CAMPAIGN_NOTE = 'キャンペーンとの紐づけ';
const IRREVERSIBLE = 'この操作は取り消せません。';
const FILTER_STATUS = '状態';
const FILTER_ACCOUNT = 'アカウント';
const FILTER_SOURCE = '登録元';
const FILTER_PER_PAGE = '表示件数';
const FILTER_ALL = 'すべて';
const FILTER_CLEAR = '条件をクリア';
const FILTER_EMPTY = '条件に合う投稿がありません。';
const EMPTY = '投稿が登録されていません。';

/* -------------------------------------------------------------------------- */
/* データ                                                                       */
/* -------------------------------------------------------------------------- */

const ACCOUNT_ID = '01900000-0000-7000-8000-0000000054a1';
const OTHER_ACCOUNT_ID = '01900000-0000-7000-8000-0000000054a2';
const TOKEN_ID = '01900000-0000-7000-8000-0000000054t1';
const SAME_NAME_TOKEN_ID = '01900000-0000-7000-8000-0000000054t2';

const ALL_PERMISSIONS = ['social.read', 'social.write', 'social.approve', 'social.delete'];

let sequence = 0;

function post(overrides: Partial<BulkPostRow> = {}): BulkPostRow {
  sequence += 1;
  const suffix = String(sequence).padStart(4, '0');
  return {
    id: `01900000-0000-7000-8000-00000054${suffix}`,
    socialAccountId: ACCOUNT_ID,
    body: `投稿の本文 ${suffix}`,
    scheduledAt: '2026-10-20T01:00:00.000Z',
    status: 'scheduled',
    publishedAt: null,
    deliveryMode: 'auto',
    failureReason: null,
    attemptCount: 0,
    externalUrl: null,
    skipCount: 0,
    approvedAt: null,
    updatedAt: `2026-10-17T00:00:00.${suffix.slice(1)}Z`,
    source: { kind: 'screen' },
    scheduledFuture: true,
    publishing: false,
    desiredPast: false,
    manualOnly: false,
    ...overrides,
  };
}

const AWAITING = post({ status: 'awaiting_approval', body: '新製品のお知らせ' });
const SCHEDULED = post({ status: 'scheduled', body: '秋のセールの告知' });
const DRAFT = post({ status: 'draft', body: '週末のイベント', scheduledFuture: false });
const PUBLISHED = post({
  status: 'published',
  body: '年末のご挨拶',
  publishedAt: '2026-10-15T00:00:00.000Z',
  scheduledFuture: false,
});

const ROWS: readonly BulkPostRow[] = [AWAITING, SCHEDULED, DRAFT, PUBLISHED];

const DEFAULT_FILTERS: PostListFilters = {
  status: null,
  accountId: null,
  source: null,
  perPage: 20,
  page: 1,
};

const SOURCE_OPTIONS: readonly PostListOption[] = [
  { value: '', label: FILTER_ALL },
  { value: 'screen', label: SCREEN_LABEL },
  { value: `token:${TOKEN_ID}`, label: 'ブログ連携（発行 2026-10-01）' },
  { value: `token:${SAME_NAME_TOKEN_ID}`, label: 'ブログ連携（発行 2026-10-05）' },
  { value: 'token:01900000-0000-7000-8000-0000000054t3', label: 'ショップ連携（失効）' },
  { value: 'deleted', label: '削除されたトークン' },
];

const ACCOUNT_OPTIONS: readonly PostListOption[] = [
  { value: ACCOUNT_ID, label: '公式（テストSNS）' },
  { value: OTHER_ACCOUNT_ID, label: '広報（X）' },
];

const BASE: BulkProps = {
  initialPosts: ROWS,
  accountNames: { [ACCOUNT_ID]: '公式（テストSNS）', [OTHER_ACCOUNT_ID]: '広報（X）' },
  accountProviders: {
    [ACCOUNT_ID]: { provider: 'testsns', credentialConfigured: true },
    [OTHER_ACCOUNT_ID]: { provider: 'testsns', credentialConfigured: true },
  },
  publisherProviders: {
    testsns: { label: 'テストSNS', manual: true, publish: true, credentialFieldKeys: [] },
  },
  total: ROWS.length,
  page: 1,
  perPage: 20,
  permissions: ALL_PERMISSIONS,
  filters: DEFAULT_FILTERS,
  sourceOptions: SOURCE_OPTIONS,
  accountOptions: ACCOUNT_OPTIONS,
};

/* -------------------------------------------------------------------------- */
/* 描画と HTML の読み方（`social-accounts-site.test.ts` を写す）                     */
/* -------------------------------------------------------------------------- */

function render(overrides: Partial<BulkProps> = {}): string {
  const props: BulkProps = { ...BASE, ...overrides };
  return renderToStaticMarkup(createElement(Component, props));
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 見出し（`<th>`）の中身の HTML の並び。 */
function headerCells(html: string): string[] {
  return [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((match) => match[1] ?? '');
}

/** 見出しのテキストの並び。 */
function headers(html: string): string[] {
  return headerCells(html).map((cell) => textOf(cell).trim());
}

/** 本体の行（見出しの行を除く）の HTML。 */
function bodyRows(html: string): string[] {
  return html
    .split('<tr')
    .slice(1)
    .map((piece) => {
      const end = piece.indexOf('</tr>');
      return `<tr${end === -1 ? piece : piece.slice(0, end + '</tr>'.length)}`;
    })
    .filter((row) => !row.includes('<th'));
}

/** 本文で選んだ行の HTML。ちょうど 1 行あることも確かめる。 */
function rowOf(html: string, body: string): string {
  const rows = bodyRows(html).filter((row) => textOf(row).includes(body));
  expect(rows, `本文「${body}」の行`).toHaveLength(1);
  return rows[0] as string;
}

/** 行の各セル（`<td>`）のテキスト。 */
function cellsOf(row: string): string[] {
  return [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((match) =>
    textOf(match[1] as string).trim(),
  );
}

/** 「登録元」の列のセルのテキスト。 */
function sourceCellOf(html: string, body: string): string {
  const index = headers(html).indexOf(SOURCE_HEADER);
  expect(index, '「登録元」の見出し').toBeGreaterThanOrEqual(0);
  return cellsOf(rowOf(html, body))[index] ?? '';
}

/** チェックボックスの `<input>` の開始タグ。 */
function checkboxes(html: string): string[] {
  return [...html.matchAll(/<input\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /\btype="checkbox"/.test(tag));
}

function ariaLabelOf(tag: string): string | undefined {
  const value = /\baria-label="([^"]*)"/.exec(tag)?.[1];
  return value === undefined ? undefined : textOf(value);
}

function isChecked(tag: string): boolean {
  return /\schecked(?:=""|\s|>|\/)/.test(tag);
}

function isDisabled(tag: string): boolean {
  return /\sdisabled(?:=""|\s|>|\/)/.test(tag);
}

/** 見出しの一括選択のチェックボックス（無ければ undefined）。 */
function pageCheckbox(html: string): string | undefined {
  return checkboxes(html).find((tag) => ariaLabelOf(tag) === SELECT_PAGE_LABEL);
}

/** 本文で選んだ行のチェックボックス（無ければ undefined）。 */
function rowCheckbox(html: string, body: string): string | undefined {
  return checkboxes(rowOf(html, body))[0];
}

interface ButtonInfo {
  readonly openTag: string;
  readonly text: string;
}

function buttons(html: string): ButtonInfo[] {
  return [...html.matchAll(/(<button\b[^>]*>)([\s\S]*?)<\/button>/g)].map((match) => ({
    openTag: match[1] as string,
    text: textOf(match[2] as string).trim(),
  }));
}

/** 見える文字が `prefix` で始まるボタン（「一括送信（承認）…」の「…」に頼らない）。 */
function buttonStartingWith(html: string, prefix: string): ButtonInfo | undefined {
  return buttons(html).find((button) => button.text.startsWith(prefix));
}

/** `start` の位置で始まる `<div …>` を、対応する `</div>` まで切り出す。 */
function balancedDiv(html: string, start: number): string {
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let match = tag.exec(html); match !== null; match = tag.exec(html)) {
    depth += match[0] === '</div>' ? -1 : 1;
    if (depth === 0) {
      return html.slice(start, match.index + '</div>'.length);
    }
  }
  return html.slice(start);
}

/** `aria-label` が条件に合う `role="dialog"` の中身（無ければ undefined）。 */
function dialogWhere(html: string, accept: (label: string) => boolean): string | undefined {
  for (const match of html.matchAll(/<div\b[^>]*>/g)) {
    const tag = match[0];
    if (!/\brole="dialog"/.test(tag)) continue;
    const label = ariaLabelOf(tag);
    if (label !== undefined && accept(label)) {
      return balancedDiv(html, match.index);
    }
  }
  return undefined;
}

function dialogs(html: string): string[] {
  return [...html.matchAll(/<div\b[^>]*\brole="dialog"[^>]*>/g)].map((match) => match[0]);
}

/** 一括送信のダイアログ（`BULK_SEND_TITLE` の字面は設計が決めていないので「一括送信」を含むもの）。 */
function sendDialog(html: string): string | undefined {
  return dialogWhere(html, (label) => label.includes('一括送信'));
}

function radios(html: string): { value: string; checked: boolean }[] {
  return [...html.matchAll(/<input\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /\btype="radio"/.test(tag))
    .map((tag) => ({ value: /\bvalue="([^"]*)"/.exec(tag)?.[1] ?? '', checked: isChecked(tag) }));
}

interface OptionInfo {
  readonly value: string;
  readonly text: string;
  readonly selected: boolean;
}

function optionsOf(select: string): OptionInfo[] {
  return [...select.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map((match) => {
    const attributes = match[1] as string;
    const text = textOf(match[2] as string).trim();
    const value = /\bvalue="([^"]*)"/.exec(attributes)?.[1];
    return {
      value: value === undefined ? text : textOf(value),
      text,
      selected: /\sselected(?:=""|\s|$)/.test(attributes),
    };
  });
}

/** 選ばれている値。`selected` の付いた選択肢が無ければ先頭（単一選択の `<select>` の既定）。 */
function selectedValue(select: string): string | undefined {
  const options = optionsOf(select);
  return (options.find((option) => option.selected) ?? options[0])?.value;
}

function openTagOf(select: string): string {
  return /^<select\b[^>]*>/.exec(select)?.[0] ?? '';
}

/**
 * ラベルで選んだ `<select>`（無ければ undefined）。
 *
 * `<label for="X">ラベル</label>` と `id="X"` の対応（`FormField`）、`<label>` で囲んだ形、
 * または `aria-label` で引く。`useId` の値は決め打ちしない。
 */
function selectByLabel(html: string, label: string): string | undefined {
  const selects = [...html.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g)].map((match) => match[0]);
  for (const match of html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)) {
    const inner = match[2] as string;
    const wrapped = /<select\b[^>]*>[\s\S]*?<\/select>/.exec(inner)?.[0];
    const text = textOf(inner.replace(/<select\b[^>]*>[\s\S]*?<\/select>/g, ''))
      .replace(/\*\s*$/, '')
      .trim();
    if (text !== label) continue;
    if (wrapped !== undefined) return wrapped;
    const forId = /\bfor="([^"]+)"/.exec(match[1] as string)?.[1];
    if (forId === undefined) continue;
    const found = selects.find((select) =>
      new RegExp(`\\bid="${escapeRegExp(forId)}"`).test(openTagOf(select)),
    );
    if (found !== undefined) return found;
  }
  return selects.find((select) => ariaLabelOf(openTagOf(select)) === label);
}

function countOf(text: string, pattern: RegExp): number {
  return [...text.matchAll(new RegExp(pattern.source, 'g'))].length;
}

/* -------------------------------------------------------------------------- */
/* #62 選択の列と登録元の見出し                                                   */
/* -------------------------------------------------------------------------- */

describe('#62 選択の列と「登録元」の見出し', () => {
  it('#62 先頭の見出しに「このページの投稿をすべて選択」のチェックボックスがある', () => {
    const first = headerCells(render())[0] ?? '';

    expect(checkboxes(first).map(ariaLabelOf)).toEqual([SELECT_PAGE_LABEL]);
  });

  it('#62 各行の先頭のセルに「この投稿を選択：<本文の抜粋>」のチェックボックスがある', () => {
    const html = render();

    for (const target of ROWS) {
      const firstCell = /<td\b[^>]*>([\s\S]*?)<\/td>/.exec(rowOf(html, target.body))?.[1] ?? '';
      const labels = checkboxes(firstCell).map(ariaLabelOf);
      expect(labels, target.body).toHaveLength(1);
      expect(labels[0], target.body).toMatch(
        new RegExp(`^${escapeRegExp(SELECT_ROW_PREFIX)}${escapeRegExp(target.body)}`),
      );
    }
  });

  it('#62 「登録元」の列見出しが「本文」と「予約日時」の間にある', () => {
    const list = headers(render());
    const index = list.indexOf(SOURCE_HEADER);

    expect(index).toBeGreaterThan(list.indexOf('本文'));
    expect(index).toBe(list.indexOf('予約日時') - 1);
  });

  it('#62 選択の列の後に既存の列が並ぶ（アカウント・本文・登録元・予約日時・配信方法・状態・操作）', () => {
    expect(headers(render()).slice(1)).toEqual([
      'アカウント',
      '本文',
      SOURCE_HEADER,
      '予約日時',
      '配信方法',
      '状態',
      '操作',
    ]);
  });

  it('#62 updatedAt の無い行にはチェックボックスを描かない（実装プラン §8 の 17）', () => {
    const legacy = post({ body: '古い行の投稿', updatedAt: undefined });
    const html = render({ initialPosts: [AWAITING, legacy], total: 2 });

    expect(checkboxes(rowOf(html, '古い行の投稿'))).toEqual([]);
    expect(rowCheckbox(html, AWAITING.body)).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* #63 登録元の表示                                                              */
/* -------------------------------------------------------------------------- */

describe('#63 登録元の表示', () => {
  const screen = post({ body: '画面で書いた投稿', source: { kind: 'screen' } });
  const token = post({
    body: 'ブログから来た投稿',
    source: { kind: 'token', label: 'ブログ連携', revoked: false },
  });
  const revoked = post({
    body: 'ショップから来た投稿',
    source: { kind: 'token', label: 'ショップ連携', revoked: true },
  });
  const deleted = post({
    body: '消えたトークンの投稿',
    source: { kind: 'deleted_token', label: '旧連携' },
  });

  function html(): string {
    return render({ initialPosts: [screen, token, revoked, deleted], total: 4 });
  }

  it('#63 screen は「管理画面」', () => {
    expect(sourceCellOf(html(), '画面で書いた投稿')).toBe(SCREEN_LABEL);
  });

  it('#63 token はトークンの名前', () => {
    expect(sourceCellOf(html(), 'ブログから来た投稿')).toBe('ブログ連携');
  });

  it('#63 失効したトークンは名前と「（失効）」', () => {
    const cell = sourceCellOf(html(), 'ショップから来た投稿');

    expect(cell).toContain('ショップ連携');
    expect(cell).toContain(REVOKED_SUFFIX);
  });

  it('#63 deleted_token は名前と「（削除済み）」', () => {
    const cell = sourceCellOf(html(), '消えたトークンの投稿');

    expect(cell).toContain('旧連携');
    expect(cell).toContain(DELETED_SUFFIX);
  });

  it('#63 有効なトークンには「（失効）」「（削除済み）」を添えない', () => {
    const cell = sourceCellOf(html(), 'ブログから来た投稿');

    expect(cell).not.toContain(REVOKED_SUFFIX);
    expect(cell).not.toContain(DELETED_SUFFIX);
  });

  it('#63 長い名前は全体を title に持つ（1 行で省略。設計 §9.1）', () => {
    const name = 'とても長い名前の外部アプリの連携トークン（本番環境・夜間バッチ）';
    const rendered = render({
      initialPosts: [
        post({ body: '長い名前の投稿', source: { kind: 'token', label: name, revoked: false } }),
      ],
      total: 1,
    });

    expect(rowOf(rendered, '長い名前の投稿')).toContain(`title="${name}"`);
  });
});

/* -------------------------------------------------------------------------- */
/* #64 閲覧者                                                                   */
/* -------------------------------------------------------------------------- */

describe('#64 閲覧者（social.read だけ）', () => {
  const viewer = (): string => render({ permissions: ['social.read'] });

  it('#64 チェックボックスが 1 つも無い（選択の列が無い）', () => {
    expect(checkboxes(viewer())).toEqual([]);
  });

  it('#64 一括の帯のボタンが無い', () => {
    const html = viewer();

    expect(buttonStartingWith(html, BULK_SEND_LABEL)).toBeUndefined();
    expect(buttonStartingWith(html, BULK_DELETE_LABEL)).toBeUndefined();
  });

  it('#64 「登録元」の列はある', () => {
    expect(headers(viewer())).toContain(SOURCE_HEADER);
  });

  it('#64 見出しの先頭は「アカウント」（選択の列が無い）', () => {
    expect(headers(viewer())[0]).toBe('アカウント');
  });

  it('#64 絞り込みの 4 つの Select はある（設計 §10.1「登録元の列・絞り込み」は social.read）', () => {
    const html = viewer();

    for (const label of [FILTER_STATUS, FILTER_ACCOUNT, FILTER_SOURCE, FILTER_PER_PAGE]) {
      expect(selectByLabel(html, label), label).toBeDefined();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #65 一括選択の描画                                                             */
/* -------------------------------------------------------------------------- */

describe('#65 一括選択の描画', () => {
  it('#65 未選択：見出しは未チェックで indeterminate でない', () => {
    const found = pageCheckbox(render());
    const tag = found ?? '';

    expect(found, '見出しのチェックボックス').toBeDefined();
    expect(isChecked(tag)).toBe(false);
    expect(tag).not.toContain('data-indeterminate="true"');
  });

  it('#65 一部だけ選んだ状態：見出しが indeterminate（data-indeterminate="true"）でチェックではない', () => {
    const tag = pageCheckbox(render({ initialSelectedIds: [AWAITING.id] })) ?? '';

    expect(tag).toContain('data-indeterminate="true"');
    expect(isChecked(tag)).toBe(false);
  });

  it('#65 全行を選んだ状態：見出しがチェックで indeterminate でない', () => {
    const tag = pageCheckbox(render({ initialSelectedIds: ROWS.map((row) => row.id) })) ?? '';

    expect(isChecked(tag)).toBe(true);
    expect(tag).not.toContain('data-indeterminate="true"');
  });

  it('#65 選んだ行のチェックボックスだけがチェックされる', () => {
    const html = render({ initialSelectedIds: [AWAITING.id, DRAFT.id] });

    expect(isChecked(rowCheckbox(html, AWAITING.body) ?? '')).toBe(true);
    expect(isChecked(rowCheckbox(html, DRAFT.body) ?? '')).toBe(true);
    expect(isChecked(rowCheckbox(html, SCHEDULED.body) ?? '')).toBe(false);
    expect(isChecked(rowCheckbox(html, PUBLISHED.body) ?? '')).toBe(false);
  });

  it('#65 「n 件を選択中」に選んだ件数が出る', () => {
    const text = textOf(render({ initialSelectedIds: [AWAITING.id, DRAFT.id] }));

    expect(text).toMatch(/2\s*件を選択中/);
  });

  it('#65 表示中の行が total より少なく全行を選んでいると「（全 N 件）」が出る', () => {
    // ページ送りも「（全 N 件）」を出すので、出る回数で見分ける（帯の分だけ 1 つ増える）。
    const all = ROWS.map((row) => row.id);
    const withAll = textOf(render({ total: 45, initialSelectedIds: all }));
    const withSome = textOf(render({ total: 45, initialSelectedIds: [AWAITING.id] }));

    expect(countOf(withAll, /全\s*45\s*件/)).toBe(countOf(withSome, /全\s*45\s*件/) + 1);
    expect(withAll).toMatch(/このページの\s*4\s*件を選択中/);
  });

  it('#65 表示中の行が total と同じなら全行を選んでも「（全 N 件）」は足さない', () => {
    const all = ROWS.map((row) => row.id);
    const withAll = textOf(render({ total: ROWS.length, initialSelectedIds: all }));
    const without = textOf(render({ total: ROWS.length }));

    expect(countOf(withAll, /全\s*4\s*件/)).toBe(countOf(without, /全\s*4\s*件/));
  });
});

/* -------------------------------------------------------------------------- */
/* #66 一括の帯                                                                 */
/* -------------------------------------------------------------------------- */

describe('#66 一括の帯のボタン', () => {
  it('#66 管理者：「一括送信（承認）」と「一括取り消し」がある', () => {
    const html = render({ initialSelectedIds: [AWAITING.id] });

    expect(buttonStartingWith(html, BULK_SEND_LABEL)).toBeDefined();
    expect(buttonStartingWith(html, BULK_DELETE_LABEL)).toBeDefined();
  });

  it('#66 canDelete が無ければ「一括取り消し」が無い', () => {
    const html = render({
      permissions: ['social.read', 'social.write', 'social.approve'],
      initialSelectedIds: [AWAITING.id],
    });

    expect(buttonStartingWith(html, BULK_DELETE_LABEL)).toBeUndefined();
    expect(buttonStartingWith(html, BULK_SEND_LABEL)).toBeDefined();
  });

  it('#66 canApprove も canWrite も無ければ「一括送信（承認）」が無い', () => {
    const html = render({
      permissions: ['social.read', 'social.delete'],
      initialSelectedIds: [DRAFT.id],
    });

    expect(buttonStartingWith(html, BULK_SEND_LABEL)).toBeUndefined();
    expect(buttonStartingWith(html, BULK_DELETE_LABEL)).toBeDefined();
  });

  it('#66 social.delete だけでも選択の列はある（canApprove || canWrite || canDelete）', () => {
    expect(pageCheckbox(render({ permissions: ['social.read', 'social.delete'] }))).toBeDefined();
  });

  it('#66 選択 0 件なら両方 disabled', () => {
    const html = render();

    expect(isDisabled(buttonStartingWith(html, BULK_SEND_LABEL)?.openTag ?? '')).toBe(true);
    expect(isDisabled(buttonStartingWith(html, BULK_DELETE_LABEL)?.openTag ?? '')).toBe(true);
  });

  it('#66 選択が配信済みだけなら両方 disabled', () => {
    const html = render({ initialSelectedIds: [PUBLISHED.id] });

    expect(isDisabled(buttonStartingWith(html, BULK_SEND_LABEL)?.openTag ?? '')).toBe(true);
    expect(isDisabled(buttonStartingWith(html, BULK_DELETE_LABEL)?.openTag ?? '')).toBe(true);
  });

  it('#66 判別力：承認待ちを選べば両方押せる', () => {
    const html = render({ initialSelectedIds: [AWAITING.id] });
    const send = buttonStartingWith(html, BULK_SEND_LABEL);
    const remove = buttonStartingWith(html, BULK_DELETE_LABEL);

    expect(send, BULK_SEND_LABEL).toBeDefined();
    expect(remove, BULK_DELETE_LABEL).toBeDefined();
    expect(isDisabled(send?.openTag ?? '')).toBe(false);
    expect(isDisabled(remove?.openTag ?? '')).toBe(false);
  });

  it('#66 下書きだけなら「一括送信（承認）」は disabled、「一括取り消し」は押せる', () => {
    const html = render({ initialSelectedIds: [DRAFT.id] });

    expect(isDisabled(buttonStartingWith(html, BULK_SEND_LABEL)?.openTag ?? '')).toBe(true);
    expect(isDisabled(buttonStartingWith(html, BULK_DELETE_LABEL)?.openTag ?? '')).toBe(false);
  });

  it('#66 ダイアログは閉じている間は描かない', () => {
    expect(dialogs(render({ initialSelectedIds: [AWAITING.id] }))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* #69 一括送信のダイアログ                                                       */
/* -------------------------------------------------------------------------- */

describe('#69 一括送信（承認）のダイアログ', () => {
  const awaiting2 = post({ status: 'awaiting_approval', body: '冬の新作の案内' });
  const manualOnly = post({
    status: 'awaiting_approval',
    body: '冬の限定セットの案内',
    manualOnly: true,
  });
  const manualScheduled = post({
    status: 'scheduled',
    body: '手動で出す予約',
    deliveryMode: 'manual',
  });
  const rows = [AWAITING, awaiting2, SCHEDULED, PUBLISHED, manualOnly, manualScheduled];

  function dialog(): string {
    const html = render({
      initialPosts: rows,
      total: rows.length,
      initialSelectedIds: rows.map((row) => row.id),
      initialDialog: 'send',
    });
    return sendDialog(html) ?? '';
  }

  it('#69 initialDialog: send で一括送信のダイアログが開く', () => {
    expect(dialog()).not.toBe('');
  });

  it('#69 時機の 2 択（即投稿・それぞれの希望日時に投稿）がある', () => {
    const text = textOf(dialog());

    expect(radios(dialog())).toHaveLength(2);
    expect(text).toContain(NOW_OPTION);
    expect(text).toContain(DESIRED_OPTION);
  });

  it('#69 時機はどちらも選ばれていない（ユーザー裁定 2）', () => {
    expect(radios(dialog()).map((radio) => radio.checked)).toEqual([false, false]);
  });

  it('#69 「送る」が disabled', () => {
    const send = buttons(dialog()).find((button) => button.text === SEND_CONFIRM);

    expect(send, '「送る」のボタン').toBeDefined();
    expect(isDisabled(send?.openTag ?? '')).toBe(true);
  });

  it('#69 内訳：承認待ち 3 件を承認・予約済み 2 件を今すぐ送る（時機を選ぶ前は即投稿の内訳）', () => {
    const text = textOf(dialog());

    expect(text).toMatch(/承認待ち\s*3\s*件/);
    expect(text).toMatch(/予約済み\s*2\s*件/);
  });

  it('#69 対象外の件数（配信済み 1）', () => {
    const text = textOf(dialog());

    expect(text).toMatch(/対象外\s*1\s*件/);
    expect(text).toMatch(/配信済み\s*1/);
  });

  it('#69 警告：手動投稿のみの SNS の件と、手動投稿が「手動投稿待ち」に並ぶこと', () => {
    const text = textOf(dialog());

    expect(text).toContain('手動投稿のみ');
    expect(text).toContain('手動投稿待ち');
  });

  it('#69 キャンセルのボタンがある', () => {
    expect(buttons(dialog()).some((button) => button.text === 'キャンセル')).toBe(true);
  });

  describe('#69 時機を選ぶ前は希望日時の 2 つの警告が出ない（即投稿の内訳。設計 §9.5。検証 1 回目 spec 中-1）', () => {
    // 「それぞれの希望日時」なら警告に数えられる 2 行（希望日時を過ぎた承認待ち・希望日時の無い承認待ち）を選ぶ。
    // 選んだ後に警告が出ることは E2E #82 が見る（静的な描画では時機を選べない）。
    const desiredPast = post({
      status: 'awaiting_approval',
      body: '希望日時を過ぎた案内',
      scheduledAt: '2026-10-16T00:00:00.000Z',
      desiredPast: true,
    });
    const noDesired = post({
      status: 'awaiting_approval',
      body: '希望日時の無い案内',
      scheduledAt: null,
    });
    const warnRows = [desiredPast, noDesired, AWAITING];

    function warnDialog(): string {
      const html = render({
        initialPosts: warnRows,
        total: warnRows.length,
        initialSelectedIds: warnRows.map((row) => row.id),
        initialDialog: 'send',
      });
      return sendDialog(html) ?? '';
    }

    it('#69 希望日時を過ぎた・無い承認待ちを選んでも、ダイアログは開き 3 件を承認の内訳に数える', () => {
      const text = textOf(warnDialog());

      expect(warnDialog()).not.toBe('');
      expect(text).toMatch(/承認待ち\s*3\s*件/);
    });

    it('#69 「希望日時を過ぎている n 件」の警告（BULK_SEND_WARN_DESIRED_PAST）が出ない', () => {
      const text = textOf(warnDialog());

      expect(text).not.toContain(BULK_SEND_WARN_DESIRED_PAST(1));
      expect(text).not.toMatch(/希望日時を過ぎている\s*\d+\s*件/);
    });

    it('#69 「希望日時が無い n 件」の警告（BULK_SEND_WARN_NO_DESIRED）が出ない', () => {
      const text = textOf(warnDialog());

      expect(text).not.toContain(BULK_SEND_WARN_NO_DESIRED(1));
      expect(text).not.toMatch(/希望日時が無い\s*\d+\s*件/);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* #70 一括取り消しのダイアログ                                                   */
/* -------------------------------------------------------------------------- */

describe('#70 一括取り消しのダイアログ', () => {
  function dialog(): string {
    const html = render({
      initialSelectedIds: ROWS.map((row) => row.id),
      initialDialog: 'delete',
    });
    return dialogWhere(html, (label) => label === DELETE_TITLE) ?? '';
  }

  it('#70 initialDialog: delete で「投稿を一括で取り消しますか？」が開く', () => {
    expect(dialog()).not.toBe('');
  });

  it('#70 対象の件数（3 件を削除）と状態ごとの内訳', () => {
    const text = textOf(dialog());

    expect(text).toMatch(/3\s*件を削除/);
    expect(text).toMatch(/下書き\s*1/);
    expect(text).toMatch(/承認待ち\s*1/);
    expect(text).toMatch(/予約済み\s*1/);
  });

  it('#70 対象外の件数（対象外 1 件（配信済み 1））', () => {
    expect(textOf(dialog())).toMatch(/対象外\s*1\s*件（配信済み\s*1）/);
  });

  it('#70 キャンペーンの紐づけも消えることの注意', () => {
    expect(textOf(dialog())).toContain(CAMPAIGN_NOTE);
  });

  it('#70 「この操作は取り消せません。」', () => {
    expect(textOf(dialog())).toContain(IRREVERSIBLE);
  });

  it('#70 確定ボタンは「削除する」', () => {
    expect(buttons(dialog()).some((button) => button.text === '削除する')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #73 結果のダイアログ                                                           */
/* -------------------------------------------------------------------------- */

describe('#73 結果のダイアログ', () => {
  const desiredPassed = '指定の日時を過ぎています。即投稿を選ぶか、未来の日時を指定してください。';

  function dialog(): string {
    const html = render({
      initialResults: {
        results: [
          { id: AWAITING.id, ok: true, effect: 'approved_now', post: null },
          { id: SCHEDULED.id, ok: true, effect: 'queued', post: null },
          {
            id: DRAFT.id,
            ok: false,
            reason: 'desired_time_passed',
            message: desiredPassed,
            field: 'scheduledAt',
          },
        ],
      },
    });
    return dialogWhere(html, (label) => label === RESULT_TITLE) ?? '';
  }

  it('#73 initialResults で「一括操作の結果」が開く', () => {
    expect(dialog()).not.toBe('');
  });

  it('#73 成功の件数（2 件を処理しました）', () => {
    expect(textOf(dialog())).toMatch(/2\s*件を処理しました/);
  });

  it('#73 処理されなかった件数（1 件は処理されませんでした）', () => {
    expect(textOf(dialog())).toMatch(/1\s*件は処理されませんでした/);
  });

  it('#73 処理されなかった項目の一覧：本文の抜粋・理由の表示名・サーバの文言', () => {
    const text = textOf(dialog());

    expect(text).toContain(DRAFT.body);
    expect(text).toContain('希望日時を過ぎています');
    expect(text).toContain(desiredPassed);
  });

  it('#73 成功した項目は一覧に出さない', () => {
    const text = textOf(dialog());

    expect(text).toContain(DRAFT.body);
    expect(text).not.toContain(AWAITING.body);
    expect(text).not.toContain(SCHEDULED.body);
  });

  it('#73 選び直しの案内', () => {
    expect(textOf(dialog())).toContain(RETRY_HINT);
  });

  it('#73 「閉じる」のボタンがある', () => {
    expect(buttons(dialog()).some((button) => button.text === '閉じる')).toBe(true);
  });

  it('#73 要求ごとの失敗の項目も一覧に入る（「要求が失敗しました」とエラーの文言）', () => {
    const message = '操作の回数が多すぎます。しばらく待ってからやり直してください。';
    const html = render({
      initialResults: {
        results: [{ id: AWAITING.id, ok: true, effect: 'approved_now', post: null }],
        requestFailures: [{ ids: [SCHEDULED.id], message }],
      },
    });
    const text = textOf(dialogWhere(html, (label) => label === RESULT_TITLE) ?? '');

    expect(text).toContain(SCHEDULED.body);
    expect(text).toContain('要求が失敗しました');
    expect(text).toContain(message);
  });
});

/* -------------------------------------------------------------------------- */
/* #74 絞り込みの帯                                                              */
/* -------------------------------------------------------------------------- */

describe('#74 絞り込みの帯', () => {
  const filtered: PostListFilters = {
    status: 'awaiting_approval',
    accountId: OTHER_ACCOUNT_ID,
    source: { kind: 'token', tokenId: SAME_NAME_TOKEN_ID },
    perPage: 50,
    page: 1,
  };

  it('#74 4 つの Select（状態・アカウント・登録元・表示件数）にラベルがある', () => {
    const html = render();

    for (const label of [FILTER_STATUS, FILTER_ACCOUNT, FILTER_SOURCE, FILTER_PER_PAGE]) {
      expect(selectByLabel(html, label), label).toBeDefined();
    }
  });

  it('#74 今の条件が選ばれている', () => {
    const html = render({ filters: filtered, perPage: 50 });

    expect(selectedValue(selectByLabel(html, FILTER_STATUS) ?? '')).toBe('awaiting_approval');
    expect(selectedValue(selectByLabel(html, FILTER_ACCOUNT) ?? '')).toBe(OTHER_ACCOUNT_ID);
    expect(selectedValue(selectByLabel(html, FILTER_SOURCE) ?? '')).toBe(
      `token:${SAME_NAME_TOKEN_ID}`,
    );
    expect(selectedValue(selectByLabel(html, FILTER_PER_PAGE) ?? '')).toBe('50');
  });

  it('#74 条件が無ければ「すべて」と 20 が選ばれている', () => {
    const html = render();

    expect(selectedValue(selectByLabel(html, FILTER_STATUS) ?? '')).toBe('');
    expect(selectedValue(selectByLabel(html, FILTER_ACCOUNT) ?? '')).toBe('');
    expect(selectedValue(selectByLabel(html, FILTER_SOURCE) ?? '')).toBe('');
    expect(selectedValue(selectByLabel(html, FILTER_PER_PAGE) ?? '')).toBe('20');
  });

  it('#74 状態の選択肢は「すべて」と POST_STATUSES の表示名', () => {
    const options = optionsOf(selectByLabel(render(), FILTER_STATUS) ?? '');

    expect(options.map((option) => option.value)).toEqual(['', ...POST_STATUSES]);
    expect(options.map((option) => option.text)).toEqual([
      FILTER_ALL,
      ...POST_STATUSES.map((status) => POST_STATUS_LABEL[status]),
    ]);
  });

  it('#74 アカウントの選択肢は「すべて」と渡したアカウント（渡した順）', () => {
    const options = optionsOf(selectByLabel(render(), FILTER_ACCOUNT) ?? '');

    expect(options.map((option) => [option.value, option.text])).toEqual([
      ['', FILTER_ALL],
      ...ACCOUNT_OPTIONS.map((option) => [option.value, option.label]),
    ]);
  });

  it('#74 表示件数の選択肢が 20・50・100', () => {
    const options = optionsOf(selectByLabel(render(), FILTER_PER_PAGE) ?? '');

    expect(options.map((option) => option.value)).toEqual(['20', '50', '100']);
  });

  it('#74 登録元の選択肢は渡したもの（同じ名前のトークンの「（発行 …）」も含めてそのまま）', () => {
    const options = optionsOf(selectByLabel(render(), FILTER_SOURCE) ?? '');

    expect(options.map((option) => [option.value, option.text])).toEqual(
      SOURCE_OPTIONS.map((option) => [option.value, option.label]),
    );
  });

  // 055-social-pending-tab 設計 §9.8：投稿一覧の URL は `/social?tab=posts…`（アンカーなし）になった。
  // 「条件をクリア」は条件の無い投稿タブ（`postListHref` の既定値）へ向ける（055 設計 §14・実装プラン §8 の 4）。
  it('#74 「条件をクリア」は条件があるとき /social?tab=posts へのリンクとして出る', () => {
    const html = render({ filters: { ...DEFAULT_FILTERS, status: 'draft' } });
    const link = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].find((match) =>
      textOf(match[2] as string).includes(FILTER_CLEAR),
    );

    expect(link, '「条件をクリア」のリンク').toBeDefined();
    expect(link?.[1]).toContain('href="/social?tab=posts"');
  });

  it('#74 条件が無ければ「条件をクリア」を出さない', () => {
    expect(textOf(render())).not.toContain(FILTER_CLEAR);
  });

  it('#74 登録元だけで絞っていても「条件をクリア」が出る', () => {
    const text = textOf(render({ filters: { ...DEFAULT_FILTERS, source: { kind: 'screen' } } }));

    expect(text).toContain(FILTER_CLEAR);
  });
});

/* -------------------------------------------------------------------------- */
/* #77 0 件                                                                     */
/* -------------------------------------------------------------------------- */

describe('#77 0 件の表示', () => {
  it('#77 条件あり：「条件に合う投稿がありません。」と「条件をクリア」', () => {
    const text = textOf(
      render({
        initialPosts: [],
        total: 0,
        filters: { ...DEFAULT_FILTERS, status: 'awaiting_approval' },
      }),
    );

    expect(text).toContain(FILTER_EMPTY);
    expect(text).toContain(FILTER_CLEAR);
    expect(text).not.toContain(EMPTY);
  });

  it('#77 条件なし：今までどおり「投稿が登録されていません。」と作成ボタン', () => {
    const text = textOf(render({ initialPosts: [], total: 0 }));

    expect(text).toContain(EMPTY);
    expect(text).toContain('投稿を作成');
    expect(text).not.toContain(FILTER_EMPTY);
  });

  describe('#77 表示件数は「条件」に数えない（設計 §9.2。検証 2 回目 spec 軽微-1）', () => {
    it('#77 表示件数だけを 50 にした 0 件：今までどおり「投稿が登録されていません。」で、「条件をクリア」が無い', () => {
      const text = textOf(
        render({
          initialPosts: [],
          total: 0,
          perPage: 50,
          filters: { ...DEFAULT_FILTERS, perPage: 50 },
        }),
      );

      expect(text).toContain(EMPTY);
      expect(text).toContain('投稿を作成');
      expect(text).not.toContain(FILTER_EMPTY);
      expect(text).not.toContain(FILTER_CLEAR);
    });

    it('#77 判別力：同じ表示件数 50 でも状態で絞れば「条件に合う投稿がありません。」と「条件をクリア」が出る', () => {
      const text = textOf(
        render({
          initialPosts: [],
          total: 0,
          perPage: 50,
          filters: { ...DEFAULT_FILTERS, perPage: 50, status: 'awaiting_approval' },
        }),
      );

      expect(text).toContain(FILTER_EMPTY);
      expect(text).toContain(FILTER_CLEAR);
      expect(text).not.toContain(EMPTY);
    });
  });

  it('#77 filters を渡さない（既存の呼び出し）なら今までどおり', () => {
    const text = textOf(render({ filters: undefined, initialPosts: [], total: 0 }));

    expect(text).toContain(EMPTY);
    expect(text).not.toContain(FILTER_EMPTY);
  });
});

/* -------------------------------------------------------------------------- */
/* #78 既存の locator                                                            */
/* -------------------------------------------------------------------------- */

describe('#78 既存の locator を壊さない', () => {
  function full(): string {
    return render({ initialSelectedIds: [AWAITING.id] });
  }

  it('#78 見出し「投稿」の h2 に id="posts" がある', () => {
    expect(full()).toMatch(/<h2\b[^>]*\bid="posts"[^>]*>投稿<\/h2>/);
  });

  it('#78 本文の抜粋・行の「編集」「削除」がある', () => {
    const html = full();
    const row = rowOf(html, AWAITING.body);

    expect(buttons(row).some((button) => button.text === '編集')).toBe(true);
    expect(buttons(row).some((button) => button.text === '削除')).toBe(true);
  });

  it('#78 一括の帯のボタンの名前に「削除」を含まない', () => {
    const html = full();

    for (const prefix of [BULK_SEND_LABEL, BULK_DELETE_LABEL]) {
      const button = buttonStartingWith(html, prefix);
      expect(button, prefix).toBeDefined();
      expect(button?.text).not.toContain('削除');
    }
  });

  it('#78 名前に「削除」を含むボタンは行の「削除」だけ（行の数と同じ）', () => {
    // E2E の `getByRole('button', { name: '削除' })` は部分一致で引く。
    const html = full();
    const named = buttons(html).filter((button) => button.text.includes('削除'));

    expect(named.map((button) => button.text)).toEqual(ROWS.map(() => '削除'));
  });
});
