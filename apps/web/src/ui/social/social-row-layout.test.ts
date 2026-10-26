import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { POST_BODY_MAX_LENGTH } from '@/domain/social/social';
import { excerptOf } from './bulk-plan';
import { POST_STATUS_LABEL } from './labels';
import type { PostListFilters, PostListOption, PostSourceView } from './post-list-params';
import { SocialPending } from './social-pending';
import { SocialPosts, type PostRow, type SocialPostsProps } from './social-posts';

/**
 * 送信待ちタブ・投稿タブの 2 段表示（056-social-row-layout 設計 §5.2〜§5.5、受け入れ条件 #10〜#21）。
 *
 * * 送信待ち（`SocialPending`）：#10 見出しの並び（「本文」なし）、#11 投稿ごとに `<tbody>`・`<tr>` 2 つ、
 *   #12 長い本文・改行が 2 段目に全文、#13 `handoff.note` が本文の要素の後・外、#14 チェックボックスが 1 段目、
 *   #15 `width` は選択の列だけ、#16 操作のセルの `flex-wrap: wrap` と並び（055 #46・#79）
 * * 投稿（`SocialPosts`）：#17 見出しの並び（「状態」が先頭。ユーザー裁定 3）、#18 投稿ごとに `<tbody>`・`<tr>` 2 つ、
 *   #19 「投稿を見る ↗」が本文の要素の後・外、#20 操作のセルの `flex-wrap: wrap`、#21 `width` とチェックボックス
 *
 * 行の作り方・props は `social-pending.test.ts`（`row()`・`BASE`）と `social-posts-bulk.test.ts`（`post()`・`BASE`）を写す
 * （056 実装プラン §3 T4）。props の型はテストの中で写して `as` で渡す（053 実装プラン §8 の 44）。
 *
 * 「本文の要素」は 2 段目の中の `white-space: pre-wrap` を持つ要素（056 設計 §5.3、実装プラン §8 の 7・8）。
 * 「本文の要素の外」は、その要素の閉じタグより後にあること（§8 の 8）。
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

/* -------------------------------------------------------------------------- */
/* 送信待ちの型（055 設計 §9.3.5 から写す。`social-pending.test.ts` と同じ）           */
/* -------------------------------------------------------------------------- */

type PendingKind = 'manual_pending' | 'awaiting_approval' | 'scheduled';

type ManualHandoffOutcome =
  | { readonly ok: true; readonly url: string; readonly note: string | null }
  | {
      readonly ok: false;
      readonly reason: 'unsupported' | 'invalid_url' | 'plugin_error' | 'not_scheduled';
    };

interface PendingRow {
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
  readonly manualPending?: boolean;
  readonly approvedAt?: string | null;
  readonly updatedAt?: string;
  readonly source?: PostSourceView;
  readonly scheduledFuture?: boolean;
  readonly publishing?: boolean;
  readonly desiredPast?: boolean;
  readonly manualOnly?: boolean;
  readonly kind: PendingKind;
  readonly elapsedText?: string;
  readonly handoff?: ManualHandoffOutcome;
  readonly link: string | null;
  readonly media: readonly { readonly url: string; readonly alt: string | null }[];
  readonly requestedAt: string;
  readonly warning: 'no_publisher' | 'credential_missing' | null;
}

interface PendingListFilters {
  readonly status: PendingKind | null;
  readonly accountId: string | null;
  readonly source: null;
  readonly perPage: number;
  readonly sort: 'action' | 'time';
  readonly page: number;
}

interface PendingProps {
  readonly rows: readonly PendingRow[];
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
  readonly filters: PendingListFilters;
  readonly counts: Readonly<Record<PendingKind, number>>;
  readonly sourceOptions?: readonly { readonly value: string; readonly label: string }[];
  readonly accountOptions?: readonly { readonly value: string; readonly label: string }[];
  readonly open?: (url: string, name: string, features: string) => unknown;
}

const Pending = SocialPending as unknown as ComponentType<PendingProps>;

/* -------------------------------------------------------------------------- */
/* 投稿の型（054 設計 §9.8 から写す。`social-posts-bulk.test.ts` と同じ）              */
/* -------------------------------------------------------------------------- */

type BulkPostRow = PostRow & {
  readonly updatedAt?: string;
  readonly source?: PostSourceView;
  readonly scheduledFuture?: boolean;
  readonly publishing?: boolean;
  readonly desiredPast?: boolean;
  readonly manualOnly?: boolean;
};

type PostsProps = Omit<SocialPostsProps, 'initialPosts'> & {
  readonly initialPosts: readonly BulkPostRow[];
  readonly filters?: PostListFilters;
  readonly sourceOptions?: readonly PostListOption[];
  readonly accountOptions?: readonly PostListOption[];
};

const Posts = SocialPosts as unknown as ComponentType<PostsProps>;

/* -------------------------------------------------------------------------- */
/* 文言（055 設計 §9.3.4・054 設計 §9.1。今の定数のまま）                              */
/* -------------------------------------------------------------------------- */

const SELECT_PAGE_LABEL = 'このページの投稿をすべて選択';
const SELECT_ROW_PREFIX = 'この投稿を選択：';
const OPEN_LABEL = '投稿画面を開く';
const FALLBACK_LABEL = '別のタブで開く';
const DONE_LABEL = '投稿した';
const CANCEL_LABEL = '取りやめ';
const EDIT_LABEL = '編集';
const DELETE_LABEL = '削除';
const APPROVE_OPEN_LABEL = '承認する…';
const REJECT_LABEL = '差し戻す';
const VIEW_POST_LABEL = '投稿を見る';
const NOTE = '画像は投稿画面で添付してください';

/* -------------------------------------------------------------------------- */
/* 送信待ちのデータ                                                               */
/* -------------------------------------------------------------------------- */

const ACCOUNT_ID = '01900000-0000-7000-8000-0000000056a1';
const ALL_PERMISSIONS = ['social.read', 'social.write', 'social.approve', 'social.delete'];
const PUBLISHER_PROVIDERS = {
  testsns: { label: 'テストSNS', manual: true, publish: true, credentialFieldKeys: [] },
} as const;

let sequence = 0;

function nextSuffix(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
}

function pendingRow(overrides: Partial<PendingRow> = {}): PendingRow {
  const suffix = nextSuffix();
  return {
    id: `01900000-0000-7000-8000-00000056${suffix}`,
    socialAccountId: ACCOUNT_ID,
    body: `送信待ちの二段の本文 ${suffix}`,
    scheduledAt: '2026-10-30T01:00:00.000Z',
    status: 'scheduled',
    publishedAt: null,
    deliveryMode: 'auto',
    failureReason: null,
    attemptCount: 0,
    skipCount: 0,
    externalUrl: null,
    approvedAt: null,
    updatedAt: `2026-10-26T00:00:00.${suffix.slice(1)}Z`,
    source: { kind: 'screen' },
    scheduledFuture: true,
    publishing: false,
    desiredPast: false,
    manualOnly: false,
    kind: 'scheduled',
    link: null,
    media: [],
    requestedAt: '2026-10-26T00:00:00.000Z',
    warning: null,
    ...overrides,
  };
}

const MANUAL_PENDING = pendingRow({
  body: '予約時刻を過ぎた手動投稿の二段',
  deliveryMode: 'manual',
  kind: 'manual_pending',
  manualPending: true,
  scheduledAt: '2026-10-24T00:00:00.000Z',
  scheduledFuture: false,
  elapsedText: '12 分',
  handoff: { ok: true, url: 'https://example.com/intent?text=pending', note: null },
});

const AWAITING_AUTO = pendingRow({
  body: '承認を待つ自動投稿の二段',
  status: 'awaiting_approval',
  kind: 'awaiting_approval',
  scheduledFuture: false,
});

const AUTO_SCHEDULED = pendingRow({ body: '自動配信の予約の二段' });

const PENDING_ROWS: readonly PendingRow[] = [MANUAL_PENDING, AWAITING_AUTO, AUTO_SCHEDULED];

/** 区分の表示名（055 設計 §9.3.1）。 */
const KIND_LABEL: Readonly<Record<string, string>> = {
  [MANUAL_PENDING.body]: '手動投稿待ち',
  [AWAITING_AUTO.body]: '承認待ち',
  [AUTO_SCHEDULED.body]: '予約済み',
};

/** 区分ごとの操作の並び（055 #46・#79）。 */
const PENDING_OPS: Readonly<Record<string, readonly string[]>> = {
  [MANUAL_PENDING.body]: [
    OPEN_LABEL,
    FALLBACK_LABEL,
    DONE_LABEL,
    CANCEL_LABEL,
    EDIT_LABEL,
    DELETE_LABEL,
  ],
  [AWAITING_AUTO.body]: [APPROVE_OPEN_LABEL, REJECT_LABEL, EDIT_LABEL, DELETE_LABEL],
  [AUTO_SCHEDULED.body]: [EDIT_LABEL, DELETE_LABEL],
};

const PENDING_BASE: PendingProps = {
  rows: PENDING_ROWS,
  accountNames: { [ACCOUNT_ID]: '公式（テストSNS）' },
  accountProviders: { [ACCOUNT_ID]: { provider: 'testsns', credentialConfigured: true } },
  publisherProviders: PUBLISHER_PROVIDERS,
  total: PENDING_ROWS.length,
  page: 1,
  perPage: 20,
  permissions: ALL_PERMISSIONS,
  filters: { status: null, accountId: null, source: null, perPage: 20, sort: 'action', page: 1 },
  counts: { manual_pending: 1, awaiting_approval: 1, scheduled: 1 },
  sourceOptions: [
    { value: '', label: 'すべて' },
    { value: 'screen', label: '管理画面' },
  ],
  accountOptions: [{ value: ACCOUNT_ID, label: '公式（テストSNS）' }],
};

function renderPending(overrides: Partial<PendingProps> = {}): string {
  return renderToStaticMarkup(createElement(Pending, { ...PENDING_BASE, ...overrides }));
}

function renderPendingRows(rows: readonly PendingRow[]): string {
  return renderPending({ rows, total: rows.length });
}

/* -------------------------------------------------------------------------- */
/* 投稿のデータ                                                                   */
/* -------------------------------------------------------------------------- */

function post(overrides: Partial<BulkPostRow> = {}): BulkPostRow {
  const suffix = nextSuffix();
  return {
    id: `01900000-0000-7000-8000-00000056${suffix}`,
    socialAccountId: ACCOUNT_ID,
    body: `投稿タブの二段の本文 ${suffix}`,
    scheduledAt: '2026-10-30T01:00:00.000Z',
    status: 'scheduled',
    publishedAt: null,
    deliveryMode: 'auto',
    failureReason: null,
    attemptCount: 0,
    externalUrl: null,
    skipCount: 0,
    approvedAt: null,
    updatedAt: `2026-10-26T00:00:00.${suffix.slice(1)}Z`,
    source: { kind: 'screen' },
    scheduledFuture: true,
    publishing: false,
    desiredPast: false,
    manualOnly: false,
    ...overrides,
  };
}

const POST_SCHEDULED = post({ body: '秋のセールの告知の二段' });
const POST_DRAFT = post({ status: 'draft', body: '週末のイベントの二段', scheduledFuture: false });
const POST_PUBLISHED = post({
  status: 'published',
  body: '年末のご挨拶の二段',
  publishedAt: '2026-10-25T00:00:00.000Z',
  externalUrl: 'https://sns.example.com/posts/56',
  scheduledFuture: false,
});

const POST_ROWS: readonly BulkPostRow[] = [POST_SCHEDULED, POST_DRAFT, POST_PUBLISHED];

const POSTS_BASE: PostsProps = {
  initialPosts: POST_ROWS,
  accountNames: { [ACCOUNT_ID]: '公式（テストSNS）' },
  accountProviders: { [ACCOUNT_ID]: { provider: 'testsns', credentialConfigured: true } },
  publisherProviders: PUBLISHER_PROVIDERS,
  total: POST_ROWS.length,
  page: 1,
  perPage: 20,
  permissions: ALL_PERMISSIONS,
  filters: { status: null, accountId: null, source: null, perPage: 20, page: 1 },
  sourceOptions: [
    { value: '', label: 'すべて' },
    { value: 'screen', label: '管理画面' },
  ],
  accountOptions: [{ value: ACCOUNT_ID, label: '公式（テストSNS）' }],
};

function renderPosts(initialPosts: readonly BulkPostRow[] = POST_ROWS): string {
  return renderToStaticMarkup(
    createElement(Posts, { ...POSTS_BASE, initialPosts, total: initialPosts.length }),
  );
}

/* -------------------------------------------------------------------------- */
/* 本文                                                                         */
/* -------------------------------------------------------------------------- */

/** 改行・空行・全角の空白・連続した空白を含む、61 字以上の本文。 */
const MULTILINE_BODY = `複数行の本文の一行目${'あ'.repeat(60)}\n二行目  連続した空白\n\n四行目\u3000全角の空白の後`;

/** 改行を含む `POST_BODY_MAX_LENGTH` 字ちょうどの本文。 */
function maxLengthBody(label: string): string {
  const line = 'とりふねの投稿の本文の一行。\n';
  const head = `${label}\n`;
  const tail = '末尾まで確かめる本文';
  const middle = line
    .repeat(Math.ceil(POST_BODY_MAX_LENGTH / line.length))
    .slice(0, POST_BODY_MAX_LENGTH - head.length - tail.length);
  return `${head}${middle}${tail}`;
}

/* -------------------------------------------------------------------------- */
/* HTML の読み方                                                                 */
/* -------------------------------------------------------------------------- */

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

function styleOf(openTag: string): string {
  return /\bstyle="([^"]*)"/.exec(openTag)?.[1] ?? '';
}

/** 見出しの開始タグと中身。 */
function headerCells(html: string): { readonly openTag: string; readonly inner: string }[] {
  return [...html.matchAll(/(<th\b[^>]*>)([\s\S]*?)<\/th>/g)].map((match) => ({
    openTag: match[1] as string,
    inner: match[2] as string,
  }));
}

function headers(html: string): string[] {
  return headerCells(html).map((cell) => textOf(cell.inner).trim());
}

/** 本体の投稿の行グループ（`<tbody>`）。 */
function groups(html: string): string[] {
  return [...html.matchAll(/<tbody\b[^>]*>[\s\S]*?<\/tbody>/g)].map((match) => match[0]);
}

/** 本文を含む行グループ。ちょうど 1 つあることも確かめる。 */
function groupOf(html: string, body: string): string {
  const found = groups(html).filter((group) => textOf(group).includes(body));
  expect(found, `本文「${body.slice(0, 20)}」の行グループ`).toHaveLength(1);
  return found[0] as string;
}

function trsOf(group: string): string[] {
  return [...group.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map((match) => match[0]);
}

/** 行グループの 1 段目・2 段目。 */
function tiersOf(html: string, body: string): { readonly first: string; readonly second: string } {
  const rows = trsOf(groupOf(html, body));
  expect(rows, `本文「${body.slice(0, 20)}」の行グループの <tr>`).toHaveLength(2);
  return { first: rows[0] as string, second: rows[1] as string };
}

/** `<tr>` の各 `<td>` の中身の HTML。 */
function cellHtmlsOf(tr: string): string[] {
  return [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((match) => match[1] as string);
}

/** セルの中の `white-space: nowrap` を持つ要素の見える文字（056 設計 §5.5 の日時の値）。 */
function nowrapTextsOf(cell: string): string[] {
  return [
    ...cell.matchAll(/<(\w+)\b[^>]*style="[^"]*white-space:\s*nowrap[^"]*"[^>]*>([^<]*)<\/\1>/g),
  ].map((match) => textOf(match[2] as string).trim());
}

/** 1 段目の、見出しで選んだセルの HTML。 */
function firstTierCell(html: string, body: string, header: string): string {
  const index = headers(html).indexOf(header);
  expect(index, `「${header}」の見出し`).toBeGreaterThanOrEqual(0);
  return cellHtmlsOf(tiersOf(html, body).first)[index] ?? '';
}

/** 操作（ボタンとリンク）の見える文字を HTML に現れる順に並べる（`Link` で包んだ `<button>` は 1 つ）。 */
function controlsOf(cell: string): string[] {
  return [...cell.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>|<button\b[^>]*>[\s\S]*?<\/button>/g)].map(
    (match) => textOf(match[0]).trim(),
  );
}

function checkboxes(html: string): string[] {
  return [...html.matchAll(/<input\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /\btype="checkbox"/.test(tag));
}

function ariaLabelOf(tag: string): string | undefined {
  const value = /\baria-label="([^"]*)"/.exec(tag)?.[1];
  return value === undefined ? undefined : textOf(value);
}

interface MarkupElement {
  readonly openTag: string;
  readonly start: number;
  readonly end: number;
  readonly inner: string;
}

/** `start` の位置の開始タグの要素を、対応する閉じタグまで切り出す。 */
function elementAt(html: string, start: number): MarkupElement | undefined {
  const open = /^<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/.exec(html.slice(start));
  if (open === null) return undefined;
  const name = open[1] as string;
  const tag = new RegExp(`<${name}\\b[^>]*>|</${name}>`, 'g');
  tag.lastIndex = start;
  let depth = 0;
  for (let match = tag.exec(html); match !== null; match = tag.exec(html)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) {
      return {
        openTag: open[0],
        start,
        end: match.index + match[0].length,
        inner: html.slice(start + open[0].length, match.index),
      };
    }
  }
  return undefined;
}

/** 2 段目の中の本文の要素（`white-space: pre-wrap`）。ちょうど 1 つあることも確かめる。 */
function bodyElementOf(second: string): MarkupElement {
  const found = [...second.matchAll(/<[a-zA-Z][a-zA-Z0-9]*\b[^>]*>/g)]
    .filter((match) => /white-space:\s*pre-wrap/.test(styleOf(match[0])))
    .map((match) => elementAt(second, match.index))
    .filter((element): element is MarkupElement => element !== undefined);
  expect(found, '2 段目の white-space: pre-wrap の要素').toHaveLength(1);
  return found[0] as MarkupElement;
}

/** 本文の要素の閉じタグより後の HTML（2 段目の `<td>` の中で）。 */
function afterBodyElement(second: string): string {
  const element = bodyElementOf(second);
  return second.slice(element.end);
}

/** 見出しの style が `width` を持つか（`min-width`・`max-width` は数えない）。 */
function hasWidth(openTag: string): boolean {
  return /(?:^|;)\s*width\s*:/.test(styleOf(openTag));
}

/* ========================================================================== */
/* 送信待ちタブ（§10.3）                                                          */
/* ========================================================================== */

describe('#10 送信待ちの見出しの並び', () => {
  it('#10 先頭の見出しは「このページの投稿をすべて選択」のチェックボックス（選択の列）', () => {
    const first = headerCells(renderPending())[0]?.inner ?? '';

    expect(checkboxes(first).map(ariaLabelOf)).toEqual([SELECT_PAGE_LABEL]);
  });

  it('#10 選択の列の後に「状態」「アカウント」「登録元」「日時」「配信方法」「操作」の順', () => {
    expect(headers(renderPending()).slice(1)).toEqual([
      '状態',
      'アカウント',
      '登録元',
      '日時',
      '配信方法',
      '操作',
    ]);
  });

  it('#10 「本文」の見出しが無い', () => {
    expect(headers(renderPending())).not.toContain('本文');
  });
});

describe('#11 送信待ちの各投稿が <tbody> 1 つ・<tr> 2 つ', () => {
  it('#11 行グループ（<tbody>）が投稿の数だけある', () => {
    expect(groups(renderPending())).toHaveLength(PENDING_ROWS.length);
  });

  it.each(PENDING_ROWS.map((row) => [row.body]))(
    '#11 「%s」の行グループに <tr> がちょうど 2 つ',
    (body) => {
      expect(trsOf(groupOf(renderPending(), body))).toHaveLength(2);
    },
  );

  it.each(PENDING_ROWS.map((row) => [row.body]))(
    '#11 「%s」の 1 段目に状態の表示名と操作がある',
    (body) => {
      const html = renderPending();
      const { first } = tiersOf(html, body);

      expect(textOf(first)).toContain(KIND_LABEL[body]);
      expect(controlsOf(firstTierCell(html, body, '操作'))).toEqual(PENDING_OPS[body]);
    },
  );

  it.each(PENDING_ROWS.map((row) => [row.body]))('#11 「%s」の 1 段目に本文を含まない', (body) => {
    expect(textOf(tiersOf(renderPending(), body).first)).not.toContain(body);
  });

  it.each(PENDING_ROWS.map((row) => [row.body]))(
    '#11 「%s」の 2 段目に本文の全文がある',
    (body) => {
      expect(textOf(tiersOf(renderPending(), body).second)).toContain(body);
    },
  );

  it('#11 2 段目の <td> は 1 つで、状態・操作を含まない', () => {
    const { second } = tiersOf(renderPending(), AUTO_SCHEDULED.body);

    expect(cellHtmlsOf(second)).toHaveLength(1);
    expect(controlsOf(second)).toEqual([]);
    expect(textOf(second)).not.toContain('予約済み');
  });
});

describe('#12 送信待ちの長い本文・改行が 2 段目に全文で出る', () => {
  it('#12 改行を含む 61 字以上の本文が、本文の要素にそのまま入る（60 字の抜粋で切らない・空白に畳まない）', () => {
    const target = pendingRow({ body: MULTILINE_BODY });
    const html = renderPendingRows([target]);

    expect(MULTILINE_BODY.length).toBeGreaterThan(60);
    expect(textOf(bodyElementOf(tiersOf(html, '複数行の本文の一行目').second).inner)).toBe(
      MULTILINE_BODY,
    );
  });

  it('#12 本文の要素に 60 字の抜粋（「…」付き）を出さない', () => {
    const target = pendingRow({ body: MULTILINE_BODY });
    const { second } = tiersOf(renderPendingRows([target]), '複数行の本文の一行目');

    expect(textOf(bodyElementOf(second).inner)).not.toBe(excerptOf(MULTILINE_BODY));
    expect(textOf(second)).not.toContain('…');
  });

  it('#12 10,000 字（POST_BODY_MAX_LENGTH）の本文が改行ごと全文で入る', () => {
    const body = maxLengthBody('一万字の送信待ち');
    const target = pendingRow({ body });
    const { second } = tiersOf(renderPendingRows([target]), '一万字の送信待ち');

    expect(body).toHaveLength(POST_BODY_MAX_LENGTH);
    expect(textOf(bodyElementOf(second).inner)).toBe(body);
  });
});

describe('#13 送信待ちの handoff.note は 2 段目の本文の要素の後', () => {
  const withNote = pendingRow({
    body: '注意書きのある手動投稿の二段',
    deliveryMode: 'manual',
    kind: 'scheduled',
    handoff: { ok: true, url: 'https://example.com/intent?text=n', note: NOTE },
  });

  it('#13 note が 2 段目にある', () => {
    expect(textOf(tiersOf(renderPendingRows([withNote]), withNote.body).second)).toContain(NOTE);
  });

  it('#13 note は本文の要素の閉じタグより後にあり、本文の要素の中に無い', () => {
    const { second } = tiersOf(renderPendingRows([withNote]), withNote.body);

    expect(textOf(bodyElementOf(second).inner)).toBe(withNote.body);
    expect(textOf(afterBodyElement(second))).toContain(NOTE);
  });

  it('#13 note は 1 段目に無い', () => {
    expect(textOf(tiersOf(renderPendingRows([withNote]), withNote.body).first)).not.toContain(NOTE);
  });

  it('#13 note が null なら 2 段目の本文の要素の後に何も足さない', () => {
    const withoutNote = pendingRow({
      body: '注意書きの無い手動投稿の二段',
      deliveryMode: 'manual',
      kind: 'scheduled',
      handoff: { ok: true, url: 'https://example.com/intent?text=m', note: null },
    });
    const { second } = tiersOf(renderPendingRows([withoutNote]), withoutNote.body);

    expect(textOf(afterBodyElement(second)).trim()).toBe('');
  });
});

describe('#14 送信待ちの行のチェックボックスは 1 段目', () => {
  it.each(PENDING_ROWS.map((row) => [row.body]))(
    '#14 「%s」の 1 段目の先頭のセルに「この投稿を選択：<抜粋>」のチェックボックス',
    (body) => {
      const first = cellHtmlsOf(tiersOf(renderPending(), body).first)[0] ?? '';

      expect(checkboxes(first).map(ariaLabelOf)).toEqual([`${SELECT_ROW_PREFIX}${body}`]);
    },
  );

  it('#14 長い本文のチェックボックスのラベルは 60 字の抜粋のまま', () => {
    const target = pendingRow({ body: MULTILINE_BODY });
    const first = tiersOf(renderPendingRows([target]), '複数行の本文の一行目').first;

    expect(checkboxes(first).map(ariaLabelOf)).toEqual([
      `${SELECT_ROW_PREFIX}${excerptOf(MULTILINE_BODY)}`,
    ]);
  });

  it('#14 2 段目にチェックボックスが無い', () => {
    for (const row of PENDING_ROWS) {
      expect(checkboxes(tiersOf(renderPending(), row.body).second), row.body).toEqual([]);
    }
  });
});

describe('#15 送信待ちの列の幅', () => {
  it('#15 選択の列の見出しが width: 2.5rem を持つ', () => {
    expect(styleOf(headerCells(renderPending())[0]?.openTag ?? '')).toMatch(
      /(?:^|;)\s*width:\s*2\.5rem/,
    );
  });

  it('#15 選択の列の他の見出しに width が無い', () => {
    for (const cell of headerCells(renderPending()).slice(1)) {
      expect(hasWidth(cell.openTag), textOf(cell.inner)).toBe(false);
    }
  });

  it.each(PENDING_ROWS.map((row) => [row.body]))(
    '#15 「%s」の日時の値が white-space: nowrap の要素に入る（設計 §5.5）',
    (body) => {
      const cell = firstTierCell(renderPending(), body, '日時');
      const texts = nowrapTextsOf(cell);

      expect(texts, '日時のセルの nowrap の要素').toHaveLength(1);
      expect(texts[0]).toMatch(/\d/);
      expect(
        textOf(cell)
          .trim()
          .startsWith(texts[0] as string),
      ).toBe(true);
    },
  );

  it('#15 判別力：min-width・max-width は width と数えない', () => {
    expect(hasWidth('<th style="min-width:2rem;max-width:4rem">')).toBe(false);
    expect(hasWidth('<th style="white-space:nowrap;width:12rem">')).toBe(true);
  });
});

describe('#16 送信待ちの操作のセル', () => {
  it.each(PENDING_ROWS.map((row) => [row.body]))(
    '#16 「%s」の操作のセルが flex-wrap: wrap',
    (body) => {
      expect(firstTierCell(renderPending(), body, '操作')).toMatch(/flex-wrap:\s*wrap/);
    },
  );

  it.each(PENDING_ROWS.map((row) => [row.body]))('#16 「%s」の操作の並びが 055 のまま', (body) => {
    expect(controlsOf(firstTierCell(renderPending(), body, '操作'))).toEqual(PENDING_OPS[body]);
  });
});

/* ========================================================================== */
/* 投稿タブ（§10.4）                                                              */
/* ========================================================================== */

describe('#17 投稿タブの見出しの並び', () => {
  it('#17 先頭の見出しは「このページの投稿をすべて選択」のチェックボックス（選択の列）', () => {
    const first = headerCells(renderPosts())[0]?.inner ?? '';

    expect(checkboxes(first).map(ariaLabelOf)).toEqual([SELECT_PAGE_LABEL]);
  });

  it('#17 選択の列の後に「状態」「アカウント」「登録元」「予約日時」「配信方法」「操作」の順', () => {
    expect(headers(renderPosts()).slice(1)).toEqual([
      '状態',
      'アカウント',
      '登録元',
      '予約日時',
      '配信方法',
      '操作',
    ]);
  });

  it('#17 「本文」の見出しが無い', () => {
    expect(headers(renderPosts())).not.toContain('本文');
  });
});

describe('#18 投稿タブの各投稿が <tbody> 1 つ・<tr> 2 つ', () => {
  it('#18 行グループ（<tbody>）が投稿の数だけある', () => {
    expect(groups(renderPosts())).toHaveLength(POST_ROWS.length);
  });

  it.each(POST_ROWS.map((row) => [row.body]))(
    '#18 「%s」の行グループに <tr> がちょうど 2 つ',
    (body) => {
      expect(trsOf(groupOf(renderPosts(), body))).toHaveLength(2);
    },
  );

  it.each(POST_ROWS.map((row) => [row.body, row.status]))(
    '#18 「%s」の 1 段目の状態の列に状態の表示名',
    (body, status) => {
      expect(textOf(firstTierCell(renderPosts(), body, '状態'))).toContain(
        POST_STATUS_LABEL[status as keyof typeof POST_STATUS_LABEL],
      );
    },
  );

  it.each([[POST_SCHEDULED.body], [POST_DRAFT.body]])(
    '#18 「%s」の 1 段目の操作に「編集」「削除」がこの順である',
    (body) => {
      const controls = controlsOf(firstTierCell(renderPosts(), body, '操作'));

      expect(controls).toContain(EDIT_LABEL);
      expect(controls.at(-1)).toBe(DELETE_LABEL);
      expect(controls.indexOf(EDIT_LABEL)).toBeLessThan(controls.indexOf(DELETE_LABEL));
    },
  );

  it.each(POST_ROWS.map((row) => [row.body]))('#18 「%s」の 1 段目に本文を含まない', (body) => {
    expect(textOf(tiersOf(renderPosts(), body).first)).not.toContain(body);
  });

  it.each(POST_ROWS.map((row) => [row.body]))('#18 「%s」の 2 段目に本文の全文がある', (body) => {
    const { second } = tiersOf(renderPosts(), body);

    expect(cellHtmlsOf(second)).toHaveLength(1);
    expect(textOf(bodyElementOf(second).inner)).toBe(body);
  });

  it('#18 改行を含む 61 字以上の本文が 2 段目の本文の要素にそのまま入る', () => {
    const target = post({ body: MULTILINE_BODY });
    const { second } = tiersOf(renderPosts([target]), '複数行の本文の一行目');

    expect(textOf(bodyElementOf(second).inner)).toBe(MULTILINE_BODY);
  });

  it('#18 10,000 字の本文が 2 段目に全文で入る', () => {
    const body = maxLengthBody('一万字の投稿');
    const { second } = tiersOf(renderPosts([post({ body })]), '一万字の投稿');

    expect(textOf(bodyElementOf(second).inner)).toBe(body);
  });
});

describe('#19 投稿タブの「投稿を見る ↗」は 2 段目の本文の要素の後', () => {
  function viewLinkOf(
    html: string,
  ): { readonly openTag: string; readonly text: string } | undefined {
    return [...html.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/g)]
      .map((match) => ({ openTag: match[1] as string, text: textOf(match[2] as string).trim() }))
      .find((anchor) => anchor.text.includes(VIEW_POST_LABEL));
  }

  it('#19 配信済みで externalUrl がある投稿の 2 段目に「投稿を見る ↗」がある', () => {
    const link = viewLinkOf(tiersOf(renderPosts(), POST_PUBLISHED.body).second);

    expect(link, '「投稿を見る ↗」').toBeDefined();
    expect(link?.text).toBe('投稿を見る ↗');
  });

  it('#19 「投稿を見る ↗」は本文の要素の閉じタグより後にあり、本文の要素の中に無い', () => {
    const { second } = tiersOf(renderPosts(), POST_PUBLISHED.body);

    expect(bodyElementOf(second).inner).not.toContain(VIEW_POST_LABEL);
    expect(viewLinkOf(afterBodyElement(second)), '本文の要素の後の「投稿を見る ↗」').toBeDefined();
  });

  it('#19 「投稿を見る ↗」は externalUrl へ target="_blank"・rel="noopener noreferrer" のまま', () => {
    const link = viewLinkOf(tiersOf(renderPosts(), POST_PUBLISHED.body).second);

    expect(link?.openTag).toContain(`href="${POST_PUBLISHED.externalUrl ?? ''}"`);
    expect(link?.openTag).toContain('target="_blank"');
    expect(link?.openTag).toContain('rel="noopener noreferrer"');
  });

  it('#19 「投稿を見る ↗」は 1 段目に無い', () => {
    expect(textOf(tiersOf(renderPosts(), POST_PUBLISHED.body).first)).not.toContain(
      VIEW_POST_LABEL,
    );
  });

  it('#19 externalUrl の無い投稿には「投稿を見る」を出さない', () => {
    expect(textOf(tiersOf(renderPosts(), POST_SCHEDULED.body).second)).not.toContain(
      VIEW_POST_LABEL,
    );
  });
});

describe('#20 投稿タブの操作のセル', () => {
  it.each(POST_ROWS.map((row) => [row.body]))(
    '#20 「%s」の操作のセルが flex-wrap: wrap',
    (body) => {
      expect(firstTierCell(renderPosts(), body, '操作')).toMatch(/flex-wrap:\s*wrap/);
    },
  );
});

describe('#21 投稿タブの列の幅とチェックボックス', () => {
  it('#21 選択の列の見出しが width: 2.5rem を持つ', () => {
    expect(styleOf(headerCells(renderPosts())[0]?.openTag ?? '')).toMatch(
      /(?:^|;)\s*width:\s*2\.5rem/,
    );
  });

  it('#21 選択の列の他の見出しに width が無い', () => {
    for (const cell of headerCells(renderPosts()).slice(1)) {
      expect(hasWidth(cell.openTag), textOf(cell.inner)).toBe(false);
    }
  });

  it.each(POST_ROWS.map((row) => [row.body]))(
    '#21 「%s」の予約日時の値が white-space: nowrap の要素に入る（設計 §5.5）',
    (body) => {
      const cell = firstTierCell(renderPosts(), body, '予約日時');
      const texts = nowrapTextsOf(cell);

      expect(texts, '予約日時のセルの nowrap の要素').toHaveLength(1);
      expect(texts[0]).toMatch(/\d/);
      expect(textOf(cell).trim()).toBe(texts[0]);
    },
  );

  it.each(POST_ROWS.map((row) => [row.body]))(
    '#21 「%s」の 1 段目の先頭のセルに「この投稿を選択：<抜粋>」のチェックボックス',
    (body) => {
      const first = cellHtmlsOf(tiersOf(renderPosts(), body).first)[0] ?? '';
      const labels = checkboxes(first).map(ariaLabelOf);

      expect(labels).toHaveLength(1);
      expect(labels[0]).toMatch(
        new RegExp(`^${escapeRegExp(SELECT_ROW_PREFIX)}${escapeRegExp(body)}`),
      );
    },
  );

  it('#21 長い本文のチェックボックスのラベルは 60 字の抜粋のまま', () => {
    const target = post({ body: MULTILINE_BODY });
    const first = tiersOf(renderPosts([target]), '複数行の本文の一行目').first;

    expect(checkboxes(first).map(ariaLabelOf)).toEqual([
      `${SELECT_ROW_PREFIX}${excerptOf(MULTILINE_BODY)}`,
    ]);
  });

  it('#21 2 段目にチェックボックスが無い', () => {
    for (const row of POST_ROWS) {
      expect(checkboxes(tiersOf(renderPosts(), row.body).second), row.body).toEqual([]);
    }
  });
});
