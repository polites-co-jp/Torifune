import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Link from 'next/link';
import type { BulkEffect, BulkFailureReason } from '@/domain/social/bulk';
import {
  buttonsLabelled,
  change,
  click,
  findAll,
  flush,
  hookHarness,
  textOfNodes,
  type HostNode,
} from '@/test-support/hook-harness';
import type { ButtonProps, ConfirmDialogProps, PaginationProps } from '@/ui/components';
import * as bulkPlan from './bulk-plan';
import {
  APPROVAL_PENDING_GUIDE,
  MANUAL_HANDOFF_REASON_LABEL,
  MANUAL_PENDING_GUIDE,
} from './labels';

/**
 * 送信待ちの表（055-social-pending-tab 設計 §9.2〜§9.4・§9.10、受け入れ条件 #45〜#49・#51〜#53・
 * #54 の `SocialPending` 側・#77〜#79）。
 *
 * * #45 列見出しの順（選択の列が先頭）・区分の表示名・手動投稿待ちの「（n 分経過）」
 * * #46・#79 区分ごとの操作の並び（主な操作 → 記録・判断 → 編集 → 削除。「削除」は常に最後）と `flex-wrap: wrap`
 * * #47 権限による出し分け（表示制御であって認可ではない）
 * * #48 開けない行の `disabled` と理由、#49 「投稿画面を開く」で差し替えた `open` を 3 つの引数で 1 回
 * * #51 0 件の 2 つの表示、#52 状態の選択肢の順と件数、#53 一括の帯の 3 つのボタン
 * * #54 054 の一括の主要な条件（一括選択・帯の `disabled`・送信のダイアログの内訳・結果のダイアログ）
 * * #77 並び順の `Select`・並び順だけの 0 件・ページ送りと状態の選び直しが `pendingSort` を保つ
 * * #78 行の「削除」の確認・`DELETE` 1 回・成功と失敗（後の状態は純関数 `afterSingleDelete`。実装プラン §8 の 20）
 * * 見出し「送信待ち」・「+ 投稿を作成」・`MANUAL_PENDING_GUIDE` / `APPROVAL_PENDING_GUIDE` の出し分け（設計 §9.3.3）
 *
 * `manual-pending.test.ts`（035 #68）の行ごとの操作・子ウィンドウ・開けない行・`note`・`canWrite` の件と、
 * `approval-pending.test.ts`（048 #65・#66）の「承認待ちの手動投稿に投稿画面を開くを出さない」・ボタンの出し分けを
 * ここへ移す（実装プラン §8 の 7・11）。
 *
 * **props の形は設計が決めていない**（§9.3.5 は行の型だけ）。054 の `SocialPostsProps` に倣い、行を `rows`、
 * 区分ごとの件数を `counts`（UseCase の出力のまま。§8 の 44）、条件を `filters`（`pending-list-params.test.ts` の形。
 * §8 の 59）、子ウィンドウの差し替えを `open`（`manual-pending.tsx` と同じ）、テストの口を 054 の
 * `initialSelectedIds`・`initialDialog`・`initialResults` と `initialApprovingId`（§8 の 61）・`initialDeletingId`
 * （1 件の削除の確認を開いた状態。`social-accounts.tsx` の `initialEditingAccountId` と同じ形）と読んだ（実装プラン §8 の 62）。
 * 部品はまだ無いので、指定子を `string` の定数に置いた動的 import で読み、props の型をテストに写して `as` で渡す。
 *
 * 単体テストの環境には DOM が無い。`@/ui/components` を包んで `Button`・`ConfirmDialog`・`Pagination`・`Select` の
 * props を捕まえ、`onClick` / `onConfirm` / `onChange` を直接呼ぶ（`manual-pending.test.ts` の流儀）。
 * 描画の後の `setState` は何もしないので、見られるのは外への作用（`open`・`apiRequest`・`window.location.assign`）だけ。
 */

// 押した後の状態（行の「投稿した」のダイアログ・Toast）を見るために、描画器（`test-support/hook-harness.ts`）が
// 動いている間だけフックを差し替える（G12。実装プラン §8 の 78）。`renderToStaticMarkup` は本物のフックのまま。
vi.mock('react', async (importOriginal) => {
  const { withHookHarness } = await import('@/test-support/hook-harness');
  return withHookHarness(await importOriginal());
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const capture = vi.hoisted(() => ({
  buttons: [] as unknown[],
  confirms: [] as unknown[],
  paginations: [] as unknown[],
  selects: [] as unknown[],
  apiRequest: vi.fn(),
}));

vi.mock('@/ui/client/api-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/ui/client/api-client');
  return { ...actual, apiRequest: capture.apiRequest };
});

vi.mock('@/ui/components', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/ui/components');
  const Button = actual['Button'] as (props: ButtonProps) => ReactNode;
  const ConfirmDialog = actual['ConfirmDialog'] as (props: ConfirmDialogProps) => ReactNode;
  const Pagination = actual['Pagination'] as (props: PaginationProps) => ReactNode;
  const Select = actual['Select'] as (props: Record<string, unknown>) => ReactNode;
  return {
    ...actual,
    Button: (props: ButtonProps) => {
      capture.buttons.push(props);
      return Button(props);
    },
    ConfirmDialog: (props: ConfirmDialogProps) => {
      capture.confirms.push(props);
      return ConfirmDialog(props);
    },
    Pagination: (props: PaginationProps) => {
      capture.paginations.push(props);
      return Pagination(props);
    },
    Select: (props: Record<string, unknown>) => {
      capture.selects.push(props);
      return Select(props);
    },
  };
});

/* -------------------------------------------------------------------------- */
/* 型（設計 §9.3.5・§9.12 から写す）                                               */
/* -------------------------------------------------------------------------- */

type PendingKind = 'manual_pending' | 'awaiting_approval' | 'scheduled';
type PendingSort = 'action' | 'time';

type ManualHandoffOutcome =
  | { readonly ok: true; readonly url: string; readonly note: string | null }
  | {
      readonly ok: false;
      readonly reason: 'unsupported' | 'invalid_url' | 'plugin_error' | 'not_scheduled';
    };

type PostSourceView =
  | { readonly kind: 'screen' }
  | { readonly kind: 'token'; readonly label: string; readonly revoked: boolean }
  | { readonly kind: 'deleted_token'; readonly label: string };

type PostSourceFilter =
  | { readonly kind: 'screen' }
  | { readonly kind: 'token'; readonly tokenId: string }
  | { readonly kind: 'deleted_token' };

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
  readonly source: PostSourceFilter | null;
  readonly perPage: number;
  readonly sort: PendingSort;
  readonly page: number;
}

interface Option {
  readonly value: string;
  readonly label: string;
}

type ResultItem =
  | { readonly id: string; readonly ok: true; readonly effect: BulkEffect; readonly post: unknown }
  | {
      readonly id: string;
      readonly ok: false;
      readonly reason: BulkFailureReason;
      readonly message: string;
      readonly field: string | null;
    };

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
  readonly sourceOptions?: readonly Option[];
  readonly accountOptions?: readonly Option[];
  readonly open?: (url: string, name: string, features: string) => unknown;
  readonly initialSelectedIds?: readonly string[];
  readonly initialDialog?: 'send' | 'delete' | null;
  readonly initialResults?: {
    readonly results: readonly ResultItem[];
    readonly requestFailures?: readonly {
      readonly ids: readonly string[];
      readonly message: string;
    }[];
  };
  readonly initialApprovingId?: string;
  readonly initialDeletingId?: string;
}

const MODULE: string = '@/ui/social/social-pending';

async function loadComponent(): Promise<ComponentType<PendingProps>> {
  const module = (await import(/* @vite-ignore */ MODULE)) as Record<string, unknown>;
  const component = module['SocialPending'];
  if (typeof component !== 'function') {
    throw new Error('ui/social/social-pending.tsx に SocialPending が無い');
  }
  return component as ComponentType<PendingProps>;
}

/* -------------------------------------------------------------------------- */
/* 文言（設計 §9.3・§9.9。今の区画の定数のまま）                                      */
/* -------------------------------------------------------------------------- */

const OPEN_LABEL = '投稿画面を開く';
const FALLBACK_LABEL = '別のタブで開く';
const DONE_LABEL = '投稿した';
const CANCEL_LABEL = '取りやめ';
const EDIT_LABEL = '編集';
const DELETE_LABEL = '削除';
const APPROVE_OPEN_LABEL = '承認する…';
const REJECT_LABEL = '差し戻す';
const AWAITING_MANUAL_NOTE = '承認すると投稿画面を開けます';
const SEQUENCE_LABEL = '選んだ手動投稿を順に投稿';
const BULK_SEND_LABEL = '一括送信（承認）';
const BULK_DELETE_LABEL = '一括取り消し';
const SELECT_PAGE_LABEL = 'このページの投稿をすべて選択';
const PENDING_EMPTY = '送信待ちの投稿はありません。';
const FILTER_EMPTY = '条件に合う投稿がありません。';
const FILTER_CLEAR = '条件をクリア';
const WINDOW_NAME = 'torifune-manual-post';
const WINDOW_FEATURES = 'popup=yes,width=600,height=720,noopener=yes,noreferrer=yes';

/* -------------------------------------------------------------------------- */
/* データ                                                                       */
/* -------------------------------------------------------------------------- */

const ACCOUNT_ID = '01900000-0000-7000-8000-0000000055a1';
const ALL_PERMISSIONS = ['social.read', 'social.write', 'social.approve', 'social.delete'];

let sequence = 0;

function row(overrides: Partial<PendingRow> = {}): PendingRow {
  sequence += 1;
  const suffix = String(sequence).padStart(4, '0');
  return {
    id: `01900000-0000-7000-8000-00000055${suffix}`,
    socialAccountId: ACCOUNT_ID,
    body: `送信待ちの本文 ${suffix}`,
    scheduledAt: '2026-10-30T01:00:00.000Z',
    status: 'scheduled',
    publishedAt: null,
    deliveryMode: 'auto',
    failureReason: null,
    attemptCount: 0,
    skipCount: 0,
    externalUrl: null,
    approvedAt: null,
    updatedAt: `2026-10-23T00:00:00.${suffix.slice(1)}Z`,
    source: { kind: 'screen' },
    scheduledFuture: true,
    publishing: false,
    desiredPast: false,
    manualOnly: false,
    kind: 'scheduled',
    link: null,
    media: [],
    requestedAt: '2026-10-23T00:00:00.000Z',
    warning: null,
    ...overrides,
  };
}

/** 予約時刻を過ぎた手動の予約（手動投稿待ち）。 */
const MANUAL_PENDING = row({
  body: '予約時刻を過ぎた手動投稿',
  deliveryMode: 'manual',
  kind: 'manual_pending',
  manualPending: true,
  scheduledAt: '2026-10-24T00:00:00.000Z',
  scheduledFuture: false,
  elapsedText: '12 分',
  handoff: { ok: true, url: 'https://example.com/intent?text=pending', note: null },
});

/** 予約時刻前の手動の予約（ユーザー裁定 4）。 */
const MANUAL_FUTURE = row({
  body: '予約時刻前の手動投稿',
  deliveryMode: 'manual',
  kind: 'scheduled',
  handoff: { ok: true, url: 'https://example.com/intent?text=future', note: null },
});

/** 承認待ちの手動投稿（`handoff` を渡さない。設計 §9.3.5）。 */
const AWAITING_MANUAL = row({
  body: '承認待ちの手動投稿',
  status: 'awaiting_approval',
  deliveryMode: 'manual',
  kind: 'awaiting_approval',
  scheduledFuture: false,
});

const AWAITING_AUTO = row({
  body: '承認待ちの自動投稿',
  status: 'awaiting_approval',
  kind: 'awaiting_approval',
  scheduledFuture: false,
  link: 'https://example.com/news/1',
});

const AUTO_SCHEDULED = row({ body: '自動配信の予約', kind: 'scheduled' });

const ROWS: readonly PendingRow[] = [
  MANUAL_PENDING,
  AWAITING_MANUAL,
  AWAITING_AUTO,
  MANUAL_FUTURE,
  AUTO_SCHEDULED,
];

const COUNTS: Readonly<Record<PendingKind, number>> = {
  manual_pending: 1,
  awaiting_approval: 2,
  scheduled: 3,
};

const DEFAULT_FILTERS: PendingListFilters = {
  status: null,
  accountId: null,
  source: null,
  perPage: 20,
  sort: 'action',
  page: 1,
};

const BASE: PendingProps = {
  rows: ROWS,
  accountNames: { [ACCOUNT_ID]: '公式（テストSNS）' },
  accountProviders: { [ACCOUNT_ID]: { provider: 'testsns', credentialConfigured: true } },
  publisherProviders: {
    testsns: { label: 'テストSNS', manual: true, publish: true, credentialFieldKeys: [] },
  },
  total: ROWS.length,
  page: 1,
  perPage: 20,
  permissions: ALL_PERMISSIONS,
  filters: DEFAULT_FILTERS,
  counts: COUNTS,
  sourceOptions: [
    { value: '', label: 'すべて' },
    { value: 'screen', label: '管理画面' },
  ],
  accountOptions: [{ value: ACCOUNT_ID, label: '公式（テストSNS）' }],
};

/* -------------------------------------------------------------------------- */
/* 描画と HTML の読み方（`social-posts-bulk.test.ts` を写す）                          */
/* -------------------------------------------------------------------------- */

async function render(overrides: Partial<PendingProps> = {}): Promise<string> {
  const SocialPending = await loadComponent();
  return renderToStaticMarkup(createElement(SocialPending, { ...BASE, ...overrides }));
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

function headerCells(html: string): string[] {
  return [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((match) => match[1] ?? '');
}

function headers(html: string): string[] {
  return headerCells(html).map((cell) => textOf(cell).trim());
}

function bodyRows(html: string): string[] {
  return html
    .split('<tr')
    .slice(1)
    .map((piece) => {
      const end = piece.indexOf('</tr>');
      return `<tr${end === -1 ? piece : piece.slice(0, end + '</tr>'.length)}`;
    })
    .filter((tr) => !tr.includes('<th'));
}

function rowOf(html: string, body: string): string {
  const rows = bodyRows(html).filter((tr) => textOf(tr).includes(body));
  expect(rows, `本文「${body}」の行`).toHaveLength(1);
  return rows[0] as string;
}

/** 行の各セル（`<td>`）の HTML。 */
function cellHtmlsOf(tr: string): string[] {
  return [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((match) => match[1] as string);
}

/** 列見出しで選んだセルの HTML。 */
function cellOf(html: string, body: string, header: string): string {
  const index = headers(html).indexOf(header);
  expect(index, `「${header}」の見出し`).toBeGreaterThanOrEqual(0);
  return cellHtmlsOf(rowOf(html, body))[index] ?? '';
}

/**
 * 操作のセルの中の操作（ボタンとリンク）の見える文字を、HTML に現れる順に並べる。
 * `<a>` で包んだ `<button>`（`Link` の中の「編集」）は 1 つの操作として数える。
 */
function controlsOf(cell: string): string[] {
  return [...cell.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>|<button\b[^>]*>[\s\S]*?<\/button>/g)].map(
    (match) => textOf(match[0]).trim(),
  );
}

function opsOf(html: string, body: string): string[] {
  return controlsOf(cellOf(html, body, '操作'));
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

function isChecked(tag: string): boolean {
  return /\schecked(?:=""|\s|>|\/)/.test(tag);
}

function isDisabled(tag: string): boolean {
  return /\sdisabled(?:=""|\s|>|\/)/.test(tag);
}

function pageCheckbox(html: string): string | undefined {
  return checkboxes(html).find((tag) => ariaLabelOf(tag) === SELECT_PAGE_LABEL);
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

function buttonStartingWith(html: string, prefix: string): ButtonInfo | undefined {
  return buttons(html).find((button) => button.text.startsWith(prefix));
}

function anchors(html: string): { readonly openTag: string; readonly text: string }[] {
  return [...html.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/g)].map((match) => ({
    openTag: match[1] as string,
    text: textOf(match[2] as string).trim(),
  }));
}

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

function selectedValue(select: string): string | undefined {
  const options = optionsOf(select);
  return (options.find((option) => option.selected) ?? options[0])?.value;
}

function openTagOf(select: string): string {
  return /^<select\b[^>]*>/.exec(select)?.[0] ?? '';
}

/** ラベルで選んだ `<select>`（`social-posts-bulk.test.ts` を写す）。 */
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

/** 子要素から文字を拾う。 */
function textOfNode(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOfNode).join('');
  const props = (node as { props?: { children?: unknown } }).props;
  return props === undefined ? '' : textOfNode(props.children);
}

/** 子要素の `<option>` の値。 */
function optionValuesOfNode(node: unknown): string[] {
  if (node === null || node === undefined || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(optionValuesOfNode);
  const element = node as { type?: unknown; props?: { value?: unknown; children?: unknown } };
  if (element.type === 'option') return [String(element.props?.value ?? '')];
  return optionValuesOfNode(element.props?.children);
}

interface RecordedButton {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick?: (event: unknown) => unknown;
}

function recordedButtons(): readonly RecordedButton[] {
  return (capture.buttons as { children?: ReactNode; onClick?: unknown; disabled?: unknown }[]).map(
    (props) => ({
      label: textOfNode(props.children).trim(),
      disabled: props.disabled === true,
      ...(typeof props.onClick === 'function'
        ? { onClick: props.onClick as (event: unknown) => unknown }
        : {}),
    }),
  );
}

function recordedButton(label: string): RecordedButton | undefined {
  return recordedButtons().find((button) => button.label === label);
}

/** 状態の `Select`（選択肢に送信待ちの区分の値を持つもの）。 */
function recordedStatusSelect(): Record<string, unknown> | undefined {
  return (capture.selects as Record<string, unknown>[]).find((props) =>
    optionValuesOfNode(props['children']).includes('manual_pending'),
  );
}

function parseHref(href: string): Record<string, string> {
  return Object.fromEntries(new URL(href, 'http://127.0.0.1:3000').searchParams.entries());
}

const clickEvent = { preventDefault: () => {}, stopPropagation: () => {} };

beforeEach(() => {
  capture.buttons.length = 0;
  capture.confirms.length = 0;
  capture.paginations.length = 0;
  capture.selects.length = 0;
  capture.apiRequest.mockReset();
  capture.apiRequest.mockResolvedValue({ ok: true, data: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/* 見出しと案内（設計 §9.3.3）                                                     */
/* -------------------------------------------------------------------------- */

describe('見出しと案内（設計 §9.3.3）', () => {
  it('見出し h2「送信待ち」', async () => {
    expect(await render()).toMatch(/<h2\b[^>]*>送信待ち<\/h2>/);
  });

  it('social.write なら「+ 投稿を作成」が /social/posts/new?from=pending へのリンク', async () => {
    const link = anchors(await render()).find((anchor) => anchor.text.includes('投稿を作成'));

    expect(link, '「+ 投稿を作成」').toBeDefined();
    expect(link?.text).toContain('+ 投稿を作成');
    expect(link?.openTag).toContain('href="/social/posts/new?from=pending"');
  });

  it('social.write が無ければ「投稿を作成」を出さない', async () => {
    expect(textOf(await render({ permissions: ['social.read'] }))).not.toContain('投稿を作成');
  });

  it('手動投稿待ちの行があり social.write なら MANUAL_PENDING_GUIDE を出す', async () => {
    expect(textOf(await render())).toContain(MANUAL_PENDING_GUIDE);
  });

  it('social.write が無ければ MANUAL_PENDING_GUIDE を出さない', async () => {
    expect(textOf(await render({ permissions: ['social.read'] }))).not.toContain(
      MANUAL_PENDING_GUIDE,
    );
  });

  it('表示中の行に手動投稿待ちが無ければ MANUAL_PENDING_GUIDE を出さない', async () => {
    const rows = [MANUAL_FUTURE, AWAITING_AUTO];

    expect(textOf(await render({ rows, total: rows.length }))).not.toContain(MANUAL_PENDING_GUIDE);
  });

  it('表示中の行に承認待ちがあれば APPROVAL_PENDING_GUIDE を出す', async () => {
    expect(textOf(await render())).toContain(APPROVAL_PENDING_GUIDE);
  });

  it('表示中の行に承認待ちが無ければ APPROVAL_PENDING_GUIDE を出さない', async () => {
    const rows = [MANUAL_PENDING, AUTO_SCHEDULED];

    expect(textOf(await render({ rows, total: rows.length }))).not.toContain(
      APPROVAL_PENDING_GUIDE,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #45 列                                                                       */
/* -------------------------------------------------------------------------- */

describe('#45 列見出しと状態の列', () => {
  it('#45 先頭の見出しに「このページの投稿をすべて選択」のチェックボックスがある（選択の列が先頭）', async () => {
    const first = headerCells(await render())[0] ?? '';

    expect(checkboxes(first).map(ariaLabelOf)).toEqual([SELECT_PAGE_LABEL]);
  });

  it('#45 選択の列の後に「状態」「アカウント」「本文」「登録元」「日時」「配信方法」「操作」の順', async () => {
    expect(headers(await render()).slice(1)).toEqual([
      '状態',
      'アカウント',
      '本文',
      '登録元',
      '日時',
      '配信方法',
      '操作',
    ]);
  });

  it.each([
    [MANUAL_PENDING.body, '手動投稿待ち'],
    [AWAITING_MANUAL.body, '承認待ち'],
    [MANUAL_FUTURE.body, '予約済み'],
    [AUTO_SCHEDULED.body, '予約済み'],
  ])('#45 「%s」の状態の列に区分の表示名「%s」', async (body, label) => {
    expect(textOf(cellOf(await render(), body, '状態'))).toContain(label);
  });

  it('#45 手動投稿待ちの状態の列に「（12 分経過）」', async () => {
    expect(textOf(cellOf(await render(), MANUAL_PENDING.body, '状態'))).toContain('（12 分経過）');
  });

  it('#45 手動投稿待ちでない行に経過を出さない', async () => {
    expect(textOf(cellOf(await render(), MANUAL_FUTURE.body, '状態'))).not.toContain('経過');
  });

  it('#45 アカウントの列にアカウントの表示名', async () => {
    expect(textOf(cellOf(await render(), AUTO_SCHEDULED.body, 'アカウント'))).toContain(
      '公式（テストSNS）',
    );
  });

  it('#45 配信方法の列に自動／手動', async () => {
    const html = await render();

    expect(textOf(cellOf(html, AUTO_SCHEDULED.body, '配信方法'))).toContain('自動');
    expect(textOf(cellOf(html, MANUAL_FUTURE.body, '配信方法'))).toContain('手動');
  });

  it('#45 承認待ちの日時の列は希望日時に「希望」を添える（設計 §9.3.1）', async () => {
    expect(textOf(cellOf(await render(), AWAITING_AUTO.body, '日時'))).toContain('希望');
  });

  it('#45 承認待ちで希望日時が無ければ日時の列は「—」', async () => {
    const awaiting = row({
      body: '希望日時の無い承認待ち',
      status: 'awaiting_approval',
      kind: 'awaiting_approval',
      scheduledAt: null,
    });

    expect(
      textOf(cellOf(await render({ rows: [awaiting], total: 1 }), awaiting.body, '日時')),
    ).toContain('—');
  });

  it('#45 承認待ちで希望日時が過ぎていれば「（過ぎています）」', async () => {
    const awaiting = row({
      body: '希望日時を過ぎた承認待ち',
      status: 'awaiting_approval',
      kind: 'awaiting_approval',
      scheduledAt: '2026-10-20T00:00:00.000Z',
      desiredPast: true,
    });

    expect(
      textOf(cellOf(await render({ rows: [awaiting], total: 1 }), awaiting.body, '日時')),
    ).toContain('（過ぎています）');
  });

  it('#45 予約済みの日時の列に「希望」を添えない', async () => {
    expect(textOf(cellOf(await render(), AUTO_SCHEDULED.body, '日時'))).not.toContain('希望');
  });
});

/* -------------------------------------------------------------------------- */
/* #46・#79 行の操作の出し分けと並び                                                */
/* -------------------------------------------------------------------------- */

describe('#46・#79 区分ごとの操作の並び（管理者）', () => {
  it('#46 #79 手動投稿待ち：投稿画面を開く・別のタブで開く・投稿した・取りやめ・編集・削除の順', async () => {
    expect(opsOf(await render(), MANUAL_PENDING.body)).toEqual([
      OPEN_LABEL,
      FALLBACK_LABEL,
      DONE_LABEL,
      CANCEL_LABEL,
      EDIT_LABEL,
      DELETE_LABEL,
    ]);
  });

  it('#46 #79 予約時刻前の手動の予約にも同じ操作が同じ順で並ぶ（ユーザー裁定 4）', async () => {
    expect(opsOf(await render(), MANUAL_FUTURE.body)).toEqual([
      OPEN_LABEL,
      FALLBACK_LABEL,
      DONE_LABEL,
      CANCEL_LABEL,
      EDIT_LABEL,
      DELETE_LABEL,
    ]);
  });

  it('#46 #79 承認待ち：承認する…・差し戻す・編集・削除の順', async () => {
    expect(opsOf(await render(), AWAITING_AUTO.body)).toEqual([
      APPROVE_OPEN_LABEL,
      REJECT_LABEL,
      EDIT_LABEL,
      DELETE_LABEL,
    ]);
  });

  it('#46 #79 承認待ちの手動投稿にも承認する…・差し戻す・編集・削除（「投稿画面を開く」が無い）', async () => {
    expect(opsOf(await render(), AWAITING_MANUAL.body)).toEqual([
      APPROVE_OPEN_LABEL,
      REJECT_LABEL,
      EDIT_LABEL,
      DELETE_LABEL,
    ]);
  });

  it('#46 承認待ちの手動投稿の行に「承認すると投稿画面を開けます」が出る', async () => {
    expect(textOf(rowOf(await render(), AWAITING_MANUAL.body))).toContain(AWAITING_MANUAL_NOTE);
  });

  it('#46 承認待ちの手動投稿の行に handoff の URL が載らない（承認を経ずに出さない）', async () => {
    const tr = rowOf(await render(), AWAITING_MANUAL.body);

    expect(tr).not.toContain('target="_blank"');
    expect(textOf(tr)).not.toContain(OPEN_LABEL);
  });

  it('#46 承認待ちの自動投稿の行に「承認すると投稿画面を開けます」を出さない', async () => {
    expect(textOf(rowOf(await render(), AWAITING_AUTO.body))).not.toContain(AWAITING_MANUAL_NOTE);
  });

  it('#46 #79 自動の予約：編集・削除だけ', async () => {
    expect(opsOf(await render(), AUTO_SCHEDULED.body)).toEqual([EDIT_LABEL, DELETE_LABEL]);
  });

  it('#46 social.delete を渡すと、どの区分の行にも「削除」が最後の操作としてある（ユーザー裁定 8）', async () => {
    const html = await render();

    for (const target of ROWS) {
      expect(opsOf(html, target.body).at(-1), target.body).toBe(DELETE_LABEL);
    }
  });

  it('#46 「編集」は /social/posts/{id}/edit?from=pending を開く（設計 §5.7・§9.3.4）', async () => {
    const html = await render();

    for (const target of ROWS) {
      expect(rowOf(html, target.body), target.body).toContain(
        `href="/social/posts/${target.id}/edit?from=pending"`,
      );
    }
  });

  it('#79 操作のセルは flex-wrap: wrap（狭い画面ではボタンを折り返す）', async () => {
    const html = await render();

    for (const target of ROWS) {
      expect(cellOf(html, target.body, '操作'), target.body).toMatch(/flex-wrap:\s*wrap/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #47 権限                                                                     */
/* -------------------------------------------------------------------------- */

describe('#47 権限による出し分け（表示制御であって認可ではない）', () => {
  const viewer = (): Promise<string> => render({ permissions: ['social.read'] });

  it('#47 閲覧者：手動の行は「投稿画面を開く」（と別のタブで開く）だけ', async () => {
    const html = await viewer();

    expect(opsOf(html, MANUAL_PENDING.body)).toEqual([OPEN_LABEL, FALLBACK_LABEL]);
    expect(opsOf(html, MANUAL_FUTURE.body)).toEqual([OPEN_LABEL, FALLBACK_LABEL]);
  });

  it('#47 閲覧者：承認待ち・自動の予約の行に操作が無い', async () => {
    const html = await viewer();

    expect(opsOf(html, AWAITING_AUTO.body)).toEqual([]);
    expect(opsOf(html, AWAITING_MANUAL.body)).toEqual([]);
    expect(opsOf(html, AUTO_SCHEDULED.body)).toEqual([]);
  });

  it('#47 閲覧者：投稿した・取りやめ・編集・承認・差し戻す・削除のボタンが無い', async () => {
    const labels = buttons(await viewer()).map((button) => button.text);

    for (const label of [DONE_LABEL, CANCEL_LABEL, EDIT_LABEL, REJECT_LABEL, DELETE_LABEL]) {
      expect(labels, label).not.toContain(label);
    }
    expect(labels.some((label) => label.startsWith('承認する'))).toBe(false);
  });

  it('#47 閲覧者：選択の列（チェックボックス）と一括の帯が無い', async () => {
    const html = await viewer();

    expect(checkboxes(html)).toEqual([]);
    expect(buttonStartingWith(html, BULK_SEND_LABEL)).toBeUndefined();
    expect(buttonStartingWith(html, BULK_DELETE_LABEL)).toBeUndefined();
    expect(buttonStartingWith(html, SEQUENCE_LABEL)).toBeUndefined();
  });

  it('#47 閲覧者でも行そのものは見える', async () => {
    expect(textOf(await viewer())).toContain(AUTO_SCHEDULED.body);
  });

  it('#47 social.approve が無ければ「承認する…」が無い（差し戻す・編集は残る）', async () => {
    const html = await render({ permissions: ['social.read', 'social.write', 'social.delete'] });

    expect(opsOf(html, AWAITING_AUTO.body)).toEqual([REJECT_LABEL, EDIT_LABEL, DELETE_LABEL]);
  });

  it('#47 social.write が無くても social.approve なら「承認する…」は残る', async () => {
    const html = await render({ permissions: ['social.read', 'social.approve'] });

    expect(opsOf(html, AWAITING_AUTO.body)).toEqual([APPROVE_OPEN_LABEL]);
  });

  it('#47 social.delete が無ければどの行にも「削除」が無い', async () => {
    const html = await render({ permissions: ['social.read', 'social.write', 'social.approve'] });

    for (const target of ROWS) {
      expect(opsOf(html, target.body), target.body).not.toContain(DELETE_LABEL);
    }
  });

  it('#47 social.delete が無いときの手動の行：投稿画面を開く・別のタブで開く・投稿した・取りやめ・編集', async () => {
    const html = await render({ permissions: ['social.read', 'social.write', 'social.approve'] });

    expect(opsOf(html, MANUAL_PENDING.body)).toEqual([
      OPEN_LABEL,
      FALLBACK_LABEL,
      DONE_LABEL,
      CANCEL_LABEL,
      EDIT_LABEL,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* #48 開けない行                                                                */
/* -------------------------------------------------------------------------- */

describe('#48 handoff が開けない行', () => {
  function unavailable(
    reason: 'unsupported' | 'invalid_url' | 'plugin_error' | 'not_scheduled',
  ): PendingRow {
    return row({
      body: `開けない手動投稿 ${reason}`,
      deliveryMode: 'manual',
      kind: 'manual_pending',
      manualPending: true,
      scheduledFuture: false,
      elapsedText: '3 分',
      handoff: { ok: false, reason },
    });
  }

  it.each(['unsupported', 'invalid_url', 'plugin_error', 'not_scheduled'] as const)(
    '#48 %s：「投稿画面を開く」が disabled',
    async (reason) => {
      const target = unavailable(reason);
      const open = buttons(rowOf(await render({ rows: [target], total: 1 }), target.body)).find(
        (button) => button.text === OPEN_LABEL,
      );

      expect(open, OPEN_LABEL).toBeDefined();
      expect(isDisabled(open?.openTag ?? '')).toBe(true);
    },
  );

  it.each(['unsupported', 'invalid_url', 'plugin_error', 'not_scheduled'] as const)(
    '#48 %s：理由（MANUAL_HANDOFF_REASON_LABEL）を出す',
    async (reason) => {
      const target = unavailable(reason);

      expect(textOf(rowOf(await render({ rows: [target], total: 1 }), target.body))).toContain(
        MANUAL_HANDOFF_REASON_LABEL[reason],
      );
    },
  );

  it('#48 開ける行の「投稿画面を開く」は disabled にしない', async () => {
    const open = buttons(rowOf(await render(), MANUAL_PENDING.body)).find(
      (button) => button.text === OPEN_LABEL,
    );

    expect(isDisabled(open?.openTag ?? '')).toBe(false);
  });

  it('#48 開けない行にも「投稿した」「取りやめ」は押せる（人が別の手段で投稿した場合を閉ざさない）', async () => {
    const target = unavailable('plugin_error');
    const rowButtons = buttons(rowOf(await render({ rows: [target], total: 1 }), target.body));

    for (const label of [DONE_LABEL, CANCEL_LABEL]) {
      const button = rowButtons.find((candidate) => candidate.text === label);
      expect(button, label).toBeDefined();
      expect(isDisabled(button?.openTag ?? ''), label).toBe(false);
    }
  });

  it('#48 開けない行には別のタブで開くリンクを出さない', async () => {
    const target = unavailable('invalid_url');

    expect(rowOf(await render({ rows: [target], total: 1 }), target.body)).not.toContain(
      'target="_blank"',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #49 子ウィンドウ・note                                                         */
/* -------------------------------------------------------------------------- */

describe('#49 「投稿画面を開く」と別のタブで開く', () => {
  it('#49 「投稿画面を開く」の onClick で、差し替えた open が (url, 窓の名前, 開き方) で 1 回呼ばれる', async () => {
    const open = vi.fn();
    await render({ rows: [MANUAL_PENDING], total: 1, open });

    recordedButton(OPEN_LABEL)?.onClick?.(clickEvent);

    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]).toEqual([
      'https://example.com/intent?text=pending',
      WINDOW_NAME,
      WINDOW_FEATURES,
    ]);
  });

  it('#49 予約時刻前の手動の予約でも同じ引数で開く', async () => {
    const open = vi.fn();
    await render({ rows: [MANUAL_FUTURE], total: 1, open });

    recordedButton(OPEN_LABEL)?.onClick?.(clickEvent);

    expect(open.mock.calls).toEqual([
      ['https://example.com/intent?text=future', WINDOW_NAME, WINDOW_FEATURES],
    ]);
  });

  it('#49 描画しただけでは open を呼ばない', async () => {
    const open = vi.fn();
    await render({ open });

    expect(open).not.toHaveBeenCalled();
  });

  it('#49 別のタブで開くリンクは同じ URL・target="_blank"・rel="noopener noreferrer"', async () => {
    const link = anchors(rowOf(await render(), MANUAL_PENDING.body)).find(
      (anchor) => anchor.text === FALLBACK_LABEL,
    );

    expect(link, FALLBACK_LABEL).toBeDefined();
    expect(link?.openTag).toContain('href="https://example.com/intent?text=pending"');
    expect(link?.openTag).toContain('target="_blank"');
    expect(link?.openTag).toContain('rel="noopener noreferrer"');
  });

  it('#49 note（Plugin の補足）があれば本文の列の抜粋の下に出す（実装プラン §8 の 11）', async () => {
    const target = row({
      body: '注意書きのある手動投稿',
      deliveryMode: 'manual',
      kind: 'scheduled',
      handoff: {
        ok: true,
        url: 'https://example.com/intent?text=n',
        note: '画像は投稿画面で添付してください',
      },
    });
    const cell = textOf(cellOf(await render({ rows: [target], total: 1 }), target.body, '本文'));

    expect(cell).toContain(target.body);
    expect(cell).toContain('画像は投稿画面で添付してください');
    expect(cell.indexOf('画像は投稿画面で添付してください')).toBeGreaterThan(
      cell.indexOf(target.body),
    );
  });

  it('#49 note が null なら何も足さない', async () => {
    expect(textOf(await render())).not.toContain('画像は投稿画面で添付してください');
  });
});

/* -------------------------------------------------------------------------- */
/* 承認のダイアログ（initialApprovingId。実装プラン §8 の 61）                        */
/* -------------------------------------------------------------------------- */

describe('#50 initialApprovingId で承認のダイアログを開いた状態', () => {
  it('#50 承認待ちの行の全文を出したダイアログが開く', async () => {
    const long = row({
      body: `${'い'.repeat(200)}末尾まで確かめる本文`,
      status: 'awaiting_approval',
      kind: 'awaiting_approval',
    });
    const text = textOf(await render({ rows: [long], total: 1, initialApprovingId: long.id }));

    expect(text).toContain('投稿を承認する');
    expect(text).toContain(long.body);
  });

  it('#50 initialApprovingId が無ければダイアログは閉じている', async () => {
    expect(textOf(await render())).not.toContain('投稿を承認する');
  });
});

/* -------------------------------------------------------------------------- */
/* #51 0 件                                                                     */
/* -------------------------------------------------------------------------- */

describe('#51 0 件の表示', () => {
  const zero: Readonly<Record<PendingKind, number>> = {
    manual_pending: 0,
    awaiting_approval: 0,
    scheduled: 0,
  };

  it('#51 条件なし：「送信待ちの投稿はありません。」と /social?tab=posts への「投稿の一覧を見る」', async () => {
    const html = await render({ rows: [], total: 0, counts: zero });
    const link = anchors(html).find((anchor) => anchor.text.includes('投稿の一覧を見る'));

    expect(textOf(html)).toContain(PENDING_EMPTY);
    expect(link, '「投稿の一覧を見る」').toBeDefined();
    expect(link?.openTag).toContain('href="/social?tab=posts"');
    expect(textOf(html)).not.toContain(FILTER_EMPTY);
  });

  it('#51 条件なし・social.write：見出しのほかに 0 件の「投稿を作成」も /social/posts/new?from=pending（§8 の 36）', async () => {
    const links = anchors(await render({ rows: [], total: 0, counts: zero })).filter((anchor) =>
      anchor.text.includes('投稿を作成'),
    );

    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) {
      expect(link.openTag).toContain('href="/social/posts/new?from=pending"');
    }
  });

  it('#51 条件なし・閲覧者：「投稿を作成」が無い', async () => {
    const text = textOf(
      await render({ rows: [], total: 0, counts: zero, permissions: ['social.read'] }),
    );

    expect(text).toContain(PENDING_EMPTY);
    expect(text).not.toContain('投稿を作成');
  });

  it('#51 条件あり：「条件に合う投稿がありません。」と /social への「条件をクリア」', async () => {
    const html = await render({
      rows: [],
      total: 0,
      filters: { ...DEFAULT_FILTERS, status: 'manual_pending' },
    });
    const link = anchors(html).find((anchor) => anchor.text.includes(FILTER_CLEAR));

    expect(textOf(html)).toContain(FILTER_EMPTY);
    expect(textOf(html)).not.toContain(PENDING_EMPTY);
    expect(link, '「条件をクリア」').toBeDefined();
    expect(link?.openTag).toContain('href="/social"');
  });

  it.each([
    ['アカウント', { accountId: ACCOUNT_ID }],
    ['登録元', { source: { kind: 'screen' } }],
  ] as const)('#51 %s だけで絞っても「条件あり」の表示', async (_label, overrides) => {
    const text = textOf(
      await render({ rows: [], total: 0, filters: { ...DEFAULT_FILTERS, ...overrides } }),
    );

    expect(text).toContain(FILTER_EMPTY);
    expect(text).toContain(FILTER_CLEAR);
  });
});

/* -------------------------------------------------------------------------- */
/* #52 状態の選択肢                                                               */
/* -------------------------------------------------------------------------- */

describe('#52 絞り込みの帯の状態の選択肢', () => {
  it('#52 「すべて（合計）」「手動投稿待ち（n）」「承認待ち（n）」「予約済み（n）」の順', async () => {
    const options = optionsOf(selectByLabel(await render(), '状態') ?? '');

    expect(options.map((option) => option.text)).toEqual([
      'すべて（6）',
      '手動投稿待ち（1）',
      '承認待ち（2）',
      '予約済み（3）',
    ]);
  });

  it('#52 選択肢の値は空（すべて）と区分', async () => {
    const options = optionsOf(selectByLabel(await render(), '状態') ?? '');

    expect(options.map((option) => option.value)).toEqual([
      '',
      'manual_pending',
      'awaiting_approval',
      'scheduled',
    ]);
  });

  it('#52 件数は counts のまま（表示中の行の数ではない）', async () => {
    const options = optionsOf(
      selectByLabel(
        await render({ counts: { manual_pending: 7, awaiting_approval: 0, scheduled: 12 } }),
        '状態',
      ) ?? '',
    );

    expect(options.map((option) => option.text)).toEqual([
      'すべて（19）',
      '手動投稿待ち（7）',
      '承認待ち（0）',
      '予約済み（12）',
    ]);
  });

  it('#52 今の状態の条件が選ばれている', async () => {
    const html = await render({ filters: { ...DEFAULT_FILTERS, status: 'awaiting_approval' } });

    expect(selectedValue(selectByLabel(html, '状態') ?? '')).toBe('awaiting_approval');
  });

  it('#52 アカウント・登録元・表示件数の Select もある（054 の帯を使う）', async () => {
    const html = await render();

    for (const label of ['アカウント', '登録元', '表示件数']) {
      expect(selectByLabel(html, label), label).toBeDefined();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #53 一括の帯                                                                 */
/* -------------------------------------------------------------------------- */

describe('#53 一括の帯の 3 つのボタン', () => {
  it('#53 「一括送信（承認）…」「一括取り消し…」「選んだ手動投稿を順に投稿…」がある', async () => {
    const html = await render({ initialSelectedIds: [MANUAL_FUTURE.id] });

    expect(buttonStartingWith(html, BULK_SEND_LABEL)).toBeDefined();
    expect(buttonStartingWith(html, BULK_DELETE_LABEL)).toBeDefined();
    expect(buttonStartingWith(html, SEQUENCE_LABEL)?.text).toBe(`${SEQUENCE_LABEL}…`);
  });

  it('#53 選択に手動の予約（handoff.ok）があれば「選んだ手動投稿を順に投稿…」を押せる', async () => {
    const html = await render({ initialSelectedIds: [MANUAL_FUTURE.id, AUTO_SCHEDULED.id] });

    expect(isDisabled(buttonStartingWith(html, SEQUENCE_LABEL)?.openTag ?? '')).toBe(false);
  });

  it('#53 選択に手動の予約が無ければ「選んだ手動投稿を順に投稿…」が disabled', async () => {
    const html = await render({ initialSelectedIds: [AWAITING_MANUAL.id, AUTO_SCHEDULED.id] });
    const button = buttonStartingWith(html, SEQUENCE_LABEL);

    expect(button, SEQUENCE_LABEL).toBeDefined();
    expect(isDisabled(button?.openTag ?? '')).toBe(true);
  });

  it('#53 選択 0 件なら「選んだ手動投稿を順に投稿…」が disabled', async () => {
    expect(isDisabled(buttonStartingWith(await render(), SEQUENCE_LABEL)?.openTag ?? '')).toBe(
      true,
    );
  });

  it('#53 social.write が無ければ「選んだ手動投稿を順に投稿…」が無い', async () => {
    const html = await render({
      permissions: ['social.read', 'social.approve', 'social.delete'],
      initialSelectedIds: [MANUAL_FUTURE.id],
    });

    expect(buttonStartingWith(html, SEQUENCE_LABEL)).toBeUndefined();
    expect(buttonStartingWith(html, BULK_SEND_LABEL)).toBeDefined();
  });

  it('#53 social.delete が無ければ「一括取り消し…」が無い（054 の出し分けのまま）', async () => {
    const html = await render({
      permissions: ['social.read', 'social.write', 'social.approve'],
      initialSelectedIds: [AUTO_SCHEDULED.id],
    });

    expect(buttonStartingWith(html, BULK_DELETE_LABEL)).toBeUndefined();
  });

  it('#53 一括の帯のボタンの名前に「削除」を含まない（行の「削除」と取り違えない）', async () => {
    const html = await render({ initialSelectedIds: [MANUAL_FUTURE.id] });

    for (const prefix of [BULK_SEND_LABEL, BULK_DELETE_LABEL, SEQUENCE_LABEL]) {
      expect(buttonStartingWith(html, prefix)?.text, prefix).not.toContain('削除');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #54 054 の一括の主要な条件                                                     */
/* -------------------------------------------------------------------------- */

describe('#54 054 の一括の主要な条件が SocialPending でも成り立つ', () => {
  it('#54 一部だけ選んだ状態：見出しが indeterminate（data-indeterminate="true"）でチェックではない', async () => {
    const tag = pageCheckbox(await render({ initialSelectedIds: [AWAITING_AUTO.id] })) ?? '';

    expect(tag).toContain('data-indeterminate="true"');
    expect(isChecked(tag)).toBe(false);
  });

  it('#54 全行を選んだ状態：見出しがチェックで indeterminate でない', async () => {
    const tag =
      pageCheckbox(await render({ initialSelectedIds: ROWS.map((item) => item.id) })) ?? '';

    expect(isChecked(tag)).toBe(true);
    expect(tag).not.toContain('data-indeterminate="true"');
  });

  it('#54 行のチェックボックスは「この投稿を選択：<本文の抜粋>」', async () => {
    const html = await render();
    const labels = checkboxes(rowOf(html, AUTO_SCHEDULED.body)).map(ariaLabelOf);

    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(new RegExp(`^この投稿を選択：${escapeRegExp(AUTO_SCHEDULED.body)}`));
  });

  it('#54 選択 0 件なら一括送信・一括取り消しが disabled', async () => {
    const html = await render();

    expect(isDisabled(buttonStartingWith(html, BULK_SEND_LABEL)?.openTag ?? '')).toBe(true);
    expect(isDisabled(buttonStartingWith(html, BULK_DELETE_LABEL)?.openTag ?? '')).toBe(true);
  });

  it('#54 承認待ちを選べば一括送信・一括取り消しを押せる', async () => {
    const html = await render({ initialSelectedIds: [AWAITING_AUTO.id] });

    expect(isDisabled(buttonStartingWith(html, BULK_SEND_LABEL)?.openTag ?? '')).toBe(false);
    expect(isDisabled(buttonStartingWith(html, BULK_DELETE_LABEL)?.openTag ?? '')).toBe(false);
  });

  it('#54 「n 件を選択中」に選んだ件数が出る', async () => {
    const text = textOf(
      await render({ initialSelectedIds: [AWAITING_AUTO.id, AUTO_SCHEDULED.id] }),
    );

    expect(text).toMatch(/2\s*件を選択中/);
  });

  it('#54 initialDialog: send で一括送信のダイアログが開き、承認待ち 2 件・予約済み 1 件の内訳', async () => {
    const html = await render({
      initialSelectedIds: [AWAITING_MANUAL.id, AWAITING_AUTO.id, AUTO_SCHEDULED.id],
      initialDialog: 'send',
    });
    const dialog = dialogWhere(html, (label) => label.includes('一括送信')) ?? '';

    expect(dialog).not.toBe('');
    expect(textOf(dialog)).toMatch(/承認待ち\s*2\s*件/);
    expect(textOf(dialog)).toMatch(/予約済み\s*1\s*件/);
  });

  it('#54 initialDialog: delete で一括取り消しのダイアログが開く', async () => {
    const html = await render({
      initialSelectedIds: [AWAITING_AUTO.id, AUTO_SCHEDULED.id],
      initialDialog: 'delete',
    });
    const dialog = dialogWhere(html, (label) => label === '投稿を一括で取り消しますか？') ?? '';

    expect(dialog).not.toBe('');
    expect(textOf(dialog)).toMatch(/2\s*件を削除/);
  });

  it('#54 initialResults で結果のダイアログが開き、成功と処理されなかった件数を出す', async () => {
    const html = await render({
      initialResults: {
        results: [
          { id: AWAITING_AUTO.id, ok: true, effect: 'approved_now', post: null },
          {
            id: AUTO_SCHEDULED.id,
            ok: false,
            reason: 'publishing',
            message: '配信中です。',
            field: null,
          },
        ],
      },
    });
    const dialog = textOf(dialogWhere(html, (label) => label === '一括操作の結果') ?? '');

    expect(dialog).toMatch(/1\s*件を処理しました/);
    expect(dialog).toMatch(/1\s*件は処理されませんでした/);
    expect(dialog).toContain(AUTO_SCHEDULED.body);
  });

  it('#54 ダイアログは閉じている間は描かない', async () => {
    expect([
      ...(await render({ initialSelectedIds: [AWAITING_AUTO.id] })).matchAll(/role="dialog"/g),
    ]).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* #77 並び順                                                                    */
/* -------------------------------------------------------------------------- */

describe('#77 並び順の Select と pendingSort の持ち回り', () => {
  it('#77 「並び順」の Select の選択肢が「手が要るもの順」「予定の時刻順」の順', async () => {
    const options = optionsOf(selectByLabel(await render(), '並び順') ?? '');

    expect(options.map((option) => [option.value, option.text])).toEqual([
      ['action', '手が要るもの順'],
      ['time', '予定の時刻順'],
    ]);
  });

  it('#77 既定は「手が要るもの順」が選ばれている', async () => {
    expect(selectedValue(selectByLabel(await render(), '並び順') ?? '')).toBe('action');
  });

  it('#77 今の sort（time）が選ばれている', async () => {
    const html = await render({ filters: { ...DEFAULT_FILTERS, sort: 'time' } });

    expect(selectedValue(selectByLabel(html, '並び順') ?? '')).toBe('time');
  });

  it('#77 並び順だけを time にした 0 件は「条件なし」の表示（条件をクリアが無い）', async () => {
    const text = textOf(
      await render({ rows: [], total: 0, filters: { ...DEFAULT_FILTERS, sort: 'time' } }),
    );

    expect(text).toContain(PENDING_EMPTY);
    expect(text).not.toContain(FILTER_EMPTY);
    expect(text).not.toContain(FILTER_CLEAR);
  });

  it('#77 表示件数だけを 50 にした 0 件も「条件なし」の表示', async () => {
    const text = textOf(
      await render({
        rows: [],
        total: 0,
        perPage: 50,
        filters: { ...DEFAULT_FILTERS, perPage: 50 },
      }),
    );

    expect(text).toContain(PENDING_EMPTY);
    expect(text).not.toContain(FILTER_CLEAR);
  });

  it('#77 「条件をクリア」は並び順も既定に戻す /social', async () => {
    const html = await render({
      rows: [],
      total: 0,
      filters: { ...DEFAULT_FILTERS, status: 'scheduled', sort: 'time' },
    });
    const link = anchors(html).find((anchor) => anchor.text.includes(FILTER_CLEAR));

    expect(link?.openTag).toContain('href="/social"');
  });

  it('#77 ページ送りの onChange が pendingSort=time を保った URL を window.location.assign で開く', async () => {
    await render({ total: 45, filters: { ...DEFAULT_FILTERS, sort: 'time' } });
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    const pagination = (capture.paginations as PaginationProps[])[0];

    expect(pagination, 'Pagination').toBeDefined();
    pagination?.onChange(2);

    expect(assign).toHaveBeenCalledTimes(1);
    expect(parseHref(String(assign.mock.calls[0]?.[0]))).toEqual({
      pendingSort: 'time',
      pendingPage: '2',
    });
  });

  it('#77 ページ送りは絞り込みも保つ', async () => {
    await render({
      total: 45,
      filters: { ...DEFAULT_FILTERS, status: 'scheduled', perPage: 50, sort: 'time' },
      perPage: 50,
    });
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });

    (capture.paginations as PaginationProps[])[0]?.onChange(3);

    expect(parseHref(String(assign.mock.calls[0]?.[0]))).toEqual({
      pendingStatus: 'scheduled',
      pendingPerPage: '50',
      pendingSort: 'time',
      pendingPage: '3',
    });
  });

  it('#77 状態の選び直しが pendingSort=time を保った 1 ページ目の URL を開く', async () => {
    await render({ total: 45, page: 2, filters: { ...DEFAULT_FILTERS, sort: 'time', page: 2 } });
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    const select = recordedStatusSelect();
    const onChange = select?.['onChange'];

    expect(typeof onChange, '状態の Select の onChange').toBe('function');
    (onChange as (event: unknown) => void)({
      target: { value: 'scheduled' },
      currentTarget: { value: 'scheduled' },
    });

    expect(assign).toHaveBeenCalledTimes(1);
    expect(parseHref(String(assign.mock.calls[0]?.[0]))).toEqual({
      pendingStatus: 'scheduled',
      pendingSort: 'time',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* #78 行の削除                                                                  */
/* -------------------------------------------------------------------------- */

describe('#78 送信待ちの行の「削除」', () => {
  function deleteConfirm(): ConfirmDialogProps | undefined {
    return (capture.confirms as ConfirmDialogProps[]).find(
      (props) => props.open && props.title === '投稿を削除しますか？',
    );
  }

  it('#78 「削除」のボタンに onClick がある（確認を開く）', async () => {
    await render({ rows: [AUTO_SCHEDULED], total: 1 });

    expect(typeof recordedButton(DELETE_LABEL)?.onClick).toBe('function');
  });

  it('#78 確認ダイアログ：「投稿を削除しますか？」・本文の抜粋・「この操作は取り消せません。」・「削除する」', async () => {
    const html = await render({ initialDeletingId: AUTO_SCHEDULED.id });
    const dialog = dialogWhere(html, (label) => label === '投稿を削除しますか？') ?? '';
    const confirm = deleteConfirm();

    expect(confirm, '開いた削除の確認').toBeDefined();
    expect(confirm?.message).toContain(AUTO_SCHEDULED.body);
    expect(textOf(dialog)).toContain('この操作は取り消せません。');
    expect(buttons(dialog).some((button) => button.text === '削除する')).toBe(true);
  });

  it('#78 initialDeletingId が無ければ削除の確認は開いていない', async () => {
    await render();

    expect(deleteConfirm()).toBeUndefined();
  });

  it('#78 「削除する」で DELETE /api/v1/social/posts/{id} を 1 回送る', async () => {
    await render({ initialDeletingId: AUTO_SCHEDULED.id });

    await deleteConfirm()?.onConfirm();

    expect(capture.apiRequest).toHaveBeenCalledTimes(1);
    expect(capture.apiRequest.mock.calls[0]?.[0]).toBe(`/api/v1/social/posts/${AUTO_SCHEDULED.id}`);
    expect(capture.apiRequest.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('#78 手動投稿待ちの行も同じ確認と DELETE で消す', async () => {
    await render({ initialDeletingId: MANUAL_PENDING.id });

    await deleteConfirm()?.onConfirm();

    expect(capture.apiRequest.mock.calls.map((call) => call[0])).toEqual([
      `/api/v1/social/posts/${MANUAL_PENDING.id}`,
    ]);
  });

  describe('#78 削除の後の状態（afterSingleDelete。実装プラン §8 の 20・62）', () => {
    type DeleteState = {
      readonly hiddenIds: ReadonlySet<string>;
      readonly selectedIds: ReadonlySet<string>;
    };
    type AfterSingleDelete = (
      state: DeleteState,
      id: string,
      result: unknown,
    ) => {
      readonly hiddenIds: Iterable<string>;
      readonly selectedIds: Iterable<string>;
      readonly toast: { readonly text: string; readonly tone: string };
    };

    function afterSingleDelete(): AfterSingleDelete {
      const fn = (bulkPlan as unknown as Record<string, unknown>)['afterSingleDelete'];
      if (typeof fn !== 'function') {
        throw new Error('ui/social/bulk-plan.ts に afterSingleDelete が無い');
      }
      return fn as AfterSingleDelete;
    }

    const state: DeleteState = {
      hiddenIds: new Set(['01900000-0000-7000-8000-000000005599']),
      selectedIds: new Set([AUTO_SCHEDULED.id, AWAITING_AUTO.id]),
    };

    it('#78 成功：行を隠し、選択から外し、Toast「削除しました。」', () => {
      const next = afterSingleDelete()(state, AUTO_SCHEDULED.id, { ok: true, data: {} });

      expect([...next.hiddenIds].sort()).toEqual(
        ['01900000-0000-7000-8000-000000005599', AUTO_SCHEDULED.id].sort(),
      );
      expect([...next.selectedIds]).toEqual([AWAITING_AUTO.id]);
      expect(next.toast).toMatchObject({ text: '削除しました。', tone: 'success' });
    });

    it('#78 失敗：行は残り（隠さない）、サーバの文言の Toast', () => {
      const message = '投稿が見つかりません。';
      const next = afterSingleDelete()(state, AUTO_SCHEDULED.id, {
        ok: false,
        error: { code: 'NOT_FOUND', message, status: 404 },
      });

      expect([...next.hiddenIds]).toEqual(['01900000-0000-7000-8000-000000005599']);
      expect([...next.hiddenIds]).not.toContain(AUTO_SCHEDULED.id);
      expect(next.toast).toMatchObject({ text: message, tone: 'danger' });
    });

    it('#78 渡した状態を書き換えない（新しい集合を返す）', () => {
      afterSingleDelete()(state, AUTO_SCHEDULED.id, { ok: true, data: {} });

      expect([...state.hiddenIds]).toEqual(['01900000-0000-7000-8000-000000005599']);
      expect([...state.selectedIds].sort()).toEqual([AUTO_SCHEDULED.id, AWAITING_AUTO.id].sort());
    });
  });
});

/* -------------------------------------------------------------------------- */
/* G12 行の「投稿した」の経路（検証 1 回目 spec 中-1。変異 M1・M2）                        */
/* -------------------------------------------------------------------------- */

/**
 * 行の「投稿した」は確認のダイアログ（URL は任意）を開き、「記録する」で
 * `POST /social/posts/{id}/manual-outcome { outcome: 'posted', expectedUpdatedAt: row.updatedAt, externalUrl? }` を送る
 * （設計 §9.3.4・冒頭の裁定の記録「行の 1 件の『投稿した』もこれに替える」）。409 の Toast は部品の文言
 * `MANUAL_OUTCOME_STALE_MESSAGE`、他の失敗はサーバの文言（§9.9）。
 *
 * ダイアログを開くのも Toast も描画の後の状態なので、描画器（`test-support/hook-harness.ts`）で部品を関数として呼び、
 * 押して描き直す（実装プラン §8 の 78）。`next/link` は辿らない（葉）。
 */
describe('G12 中-1 行の「投稿した」は manual-outcome で記録する（設計 §9.3.4）', () => {
  let SocialPending: ComponentType<PendingProps>;
  const DONE_CONFIRM_LABEL = '記録する';
  const STALE_TOAST = '内容が変わっています。読み込み直してから操作してください。';

  beforeEach(async () => {
    hookHarness.reset();
    hookHarness.leaves.add(Link);
    SocialPending = await loadComponent();
  });

  function draw(overrides: Partial<PendingProps> = {}): readonly HostNode[] {
    return hookHarness.render(
      createElement(SocialPending, { ...BASE, rows: [MANUAL_PENDING], total: 1, ...overrides }),
    );
  }

  function only(nodes: readonly HostNode[], label: string): HostNode {
    const found = buttonsLabelled(nodes, label);
    expect(found, `「${label}」のボタン`).toHaveLength(1);
    return found[0] as HostNode;
  }

  function toastText(nodes: readonly HostNode[]): string {
    return findAll(nodes, (node) => node.props['aria-live'] === 'polite')
      .map((node) => node.text)
      .join('');
  }

  /** 行の「投稿した」→ ダイアログを描き直して返す。 */
  function openDone(): readonly HostNode[] {
    click(only(draw(), DONE_LABEL));
    return draw();
  }

  it('G12 中-1：行の「投稿した」で確認のダイアログ（「記録する」）が開く（押す前は無い）', () => {
    expect(buttonsLabelled(draw(), DONE_CONFIRM_LABEL)).toHaveLength(0);
    expect(buttonsLabelled(openDone(), DONE_CONFIRM_LABEL)).toHaveLength(1);
  });

  it('G12 中-1（M1）：「記録する」→ manual-outcome に { outcome: posted, expectedUpdatedAt } を 1 回送る', async () => {
    click(only(openDone(), DONE_CONFIRM_LABEL));
    await flush();

    expect(capture.apiRequest).toHaveBeenCalledTimes(1);
    expect(capture.apiRequest).toHaveBeenCalledWith(
      `/api/v1/social/posts/${MANUAL_PENDING.id}/manual-outcome`,
      {
        method: 'POST',
        body: { outcome: 'posted', expectedUpdatedAt: MANUAL_PENDING.updatedAt },
      },
    );
  });

  it('G12 中-1（M1）：PATCH /social/posts/{id} を送らない', async () => {
    click(only(openDone(), DONE_CONFIRM_LABEL));
    await flush();

    for (const call of capture.apiRequest.mock.calls) {
      expect((call[1] as { method?: string } | undefined)?.method).not.toBe('PATCH');
      expect(call[0]).not.toBe(`/api/v1/social/posts/${MANUAL_PENDING.id}`);
    }
  });

  it('G12 中-1：URL を入れると externalUrl も送る', async () => {
    const dialog = openDone();
    const input = findAll(
      dialog,
      (node) => node.type === 'input' && node.props['name'] === 'externalUrl',
    )[0];
    change(input, 'https://x.com/i/status/55');
    click(only(draw(), DONE_CONFIRM_LABEL));
    await flush();

    expect(capture.apiRequest).toHaveBeenCalledWith(
      `/api/v1/social/posts/${MANUAL_PENDING.id}/manual-outcome`,
      {
        method: 'POST',
        body: {
          outcome: 'posted',
          expectedUpdatedAt: MANUAL_PENDING.updatedAt,
          externalUrl: 'https://x.com/i/status/55',
        },
      },
    );
  });

  it('G12 中-1（M2）：409 → Toast は MANUAL_OUTCOME_STALE_MESSAGE（サーバの文言ではない）', async () => {
    capture.apiRequest.mockResolvedValue({
      ok: false,
      error: { code: 'CONFLICT', message: 'サーバの 409 の文言です。', status: 409 },
    });

    click(only(openDone(), DONE_CONFIRM_LABEL));
    await flush();
    const text = toastText(draw());

    expect(text).toBe(STALE_TOAST);
    expect(text).not.toContain('サーバの 409 の文言です。');
  });

  it('G12 中-1 対照：409 以外の失敗（422）はサーバの文言の Toast', async () => {
    capture.apiRequest.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: '手動投稿の予約ではありません。', status: 422 },
    });

    click(only(openDone(), DONE_CONFIRM_LABEL));
    await flush();

    expect(toastText(draw())).toBe('手動投稿の予約ではありません。');
  });

  it('G12 中-1 対照：成功 → 行を隠し、成功の Toast', async () => {
    click(only(openDone(), DONE_CONFIRM_LABEL));
    await flush();
    const after = draw();

    expect(textOfNodes(after)).not.toContain(MANUAL_PENDING.body);
    expect(toastText(after)).toBe('投稿したことを記録しました。');
  });
});

/* -------------------------------------------------------------------------- */
/* #83 描画の途中で行が変わった手動の予約（検証 1 回目 security S1。設計 §8.3・§9.3.4）        */
/* -------------------------------------------------------------------------- */

describe('#83 handoff が changed の行（設計 §8.3・§9.3.4）', () => {
  const CHANGED_LABEL = '投稿が変わりました。読み込み直してください';
  const CHANGED = row({
    body: '描画の途中で自動へ変わった手動の予約',
    deliveryMode: 'manual',
    kind: 'manual_pending',
    manualPending: true,
    scheduledAt: '2026-10-24T00:00:00.000Z',
    scheduledFuture: false,
    elapsedText: '5 分',
    // `changed` は G12 で足す理由（設計 §8.3）。テストの写しの型には無いので `as` で渡す。
    handoff: { ok: false, reason: 'changed' } as unknown as ManualHandoffOutcome,
  });

  it('#83 changed の行：「投稿画面を開く」が disabled', async () => {
    const html = await render({ rows: [CHANGED, ...ROWS], total: ROWS.length + 1 });
    const open = buttons(rowOf(html, CHANGED.body)).find((button) => button.text === OPEN_LABEL);

    expect(open, OPEN_LABEL).toBeDefined();
    expect(isDisabled(open?.openTag ?? '')).toBe(true);
  });

  it('#83 changed の行：理由「投稿が変わりました。読み込み直してください」を出す', async () => {
    const html = await render({ rows: [CHANGED, ...ROWS], total: ROWS.length + 1 });

    expect(textOf(rowOf(html, CHANGED.body))).toContain(CHANGED_LABEL);
  });

  it('#83 同じ表の他の行（開ける手動の予約・承認待ち・自動の予約）は今までどおり描かれる', async () => {
    const html = await render({ rows: [CHANGED, ...ROWS], total: ROWS.length + 1 });

    for (const other of ROWS) {
      expect(textOf(rowOf(html, other.body)), other.body).toContain(other.body);
    }
    const open = buttons(rowOf(html, MANUAL_PENDING.body)).find(
      (button) => button.text === OPEN_LABEL,
    );
    expect(isDisabled(open?.openTag ?? '')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 検証 2 回目 軽微-B 順に投稿を閉じたときの後始末（設計 §9.5.2。変異 M23）                    */
/* -------------------------------------------------------------------------- */

/**
 * 順に投稿を閉じたとき、「投稿した」「投稿しなかった」で 1 件でも保存していれば Toast・読み込み直し・選択を空にする。
 * **「飛ばした」だけで閉じたときは何もしない**（Toast も読み込み直しも出さず、選択もそのまま。設計 §9.5.2）。
 *
 * 描画器で `SocialPending` を描き、一括の帯の「選んだ手動投稿を順に投稿…」→ ダイアログの中の「投稿した」（409 なら
 * 「飛ばして次へ」）→ 終わりの表示の「閉じる」と押す。読み込み直しは `RefreshOnMount` を描くことなので
 * （`bulk-post-actions.tsx`。`useEffect` は描画器では走らない）、それを葉にして描かれたかを見る。
 */
describe('検証 2 回目 軽微-B 順に投稿を閉じたときの後始末（設計 §9.5.2）', () => {
  let SocialPending: ComponentType<PendingProps>;
  let RefreshOnMount: unknown;
  const TARGETS: readonly PendingRow[] = [MANUAL_PENDING, MANUAL_FUTURE];
  const SKIP_LABEL = '飛ばして次へ';
  const CLOSE_LABEL = '閉じる';
  const STALE = {
    ok: false,
    error: { code: 'CONFLICT', message: 'サーバの 409 の文言です。', status: 409 },
  } as const;

  beforeEach(async () => {
    hookHarness.reset();
    hookHarness.leaves.clear();
    hookHarness.leaves.add(Link);
    RefreshOnMount = ((await import('./bulk-post-actions')) as Record<string, unknown>)[
      'RefreshOnMount'
    ];
    hookHarness.leaves.add(RefreshOnMount);
    SocialPending = await loadComponent();
  });

  function draw(): readonly HostNode[] {
    return hookHarness.render(
      createElement(SocialPending, {
        ...BASE,
        rows: TARGETS,
        total: TARGETS.length,
        initialSelectedIds: TARGETS.map((item) => item.id),
      }),
    );
  }

  function dialogOf(nodes: readonly HostNode[]): readonly HostNode[] {
    return findAll(nodes, (node) => node.props['role'] === 'dialog');
  }

  function only(nodes: readonly HostNode[], label: string): HostNode {
    const found = buttonsLabelled(nodes, label);
    expect(found, `「${label}」のボタン`).toHaveLength(1);
    return found[0] as HostNode;
  }

  function toastText(nodes: readonly HostNode[]): string {
    return findAll(nodes, (node) => node.props['aria-live'] === 'polite')
      .map((node) => node.text)
      .join('');
  }

  function reloaded(nodes: readonly HostNode[]): boolean {
    return findAll(nodes, (node) => node.type === 'leaf:RefreshOnMount').length > 0;
  }

  /** 選ばれている行の数（「このページの投稿をすべて選択」のチェックは数えない）。 */
  function checkedRows(nodes: readonly HostNode[]): number {
    return findAll(
      nodes,
      (node) =>
        node.type === 'input' &&
        node.props['type'] === 'checkbox' &&
        node.props['aria-label'] !== SELECT_PAGE_LABEL &&
        node.props['checked'] === true,
    ).length;
  }

  /** 帯の「選んだ手動投稿を順に投稿…」でダイアログを開く。 */
  function start(): void {
    click(only(draw(), `${SEQUENCE_LABEL}…`));
    expect(dialogOf(draw()), '順に投稿のダイアログ').toHaveLength(1);
  }

  /** 今の件をダイアログの「投稿した」で保存する（409 なら「飛ばして次へ」まで押す）。 */
  async function post(): Promise<void> {
    click(only(dialogOf(draw()), DONE_LABEL));
    await flush();
  }

  async function skip(): Promise<void> {
    await post();
    click(only(dialogOf(draw()), SKIP_LABEL));
  }

  function closeFinished(): readonly HostNode[] {
    const dialog = dialogOf(draw());
    expect(textOfNodes(dialog)).toContain('すべての手動投稿を記録しました');
    click(only(dialog, CLOSE_LABEL));
    return draw();
  }

  it('軽微-B：「飛ばした」だけで閉じたら Toast を出さない', async () => {
    capture.apiRequest.mockResolvedValue(STALE);
    start();
    await skip();
    await skip();
    const after = closeFinished();

    expect(dialogOf(after)).toHaveLength(0);
    expect(toastText(after)).toBe('');
  });

  it('軽微-B：「飛ばした」だけで閉じたら読み込み直さない', async () => {
    capture.apiRequest.mockResolvedValue(STALE);
    start();
    await skip();
    await skip();

    expect(reloaded(closeFinished())).toBe(false);
  });

  it('軽微-B：「飛ばした」だけで閉じたら選択はそのまま', async () => {
    capture.apiRequest.mockResolvedValue(STALE);
    start();
    await skip();
    await skip();
    const after = closeFinished();

    expect(checkedRows(after)).toBe(TARGETS.length);
    expect(textOfNodes(after)).toContain(`${TARGETS.length} 件を選択中`);
  });

  it('軽微-B：途中で「飛ばした」後に「やめる」で閉じても何もしない', async () => {
    capture.apiRequest.mockResolvedValue(STALE);
    start();
    await skip();
    click(only(dialogOf(draw()), 'やめる'));
    const after = draw();

    expect(dialogOf(after)).toHaveLength(0);
    expect(toastText(after)).toBe('');
    expect(reloaded(after)).toBe(false);
    expect(checkedRows(after)).toBe(TARGETS.length);
  });

  it('軽微-B 対照：「投稿した」を 1 件含めて閉じたら Toast・読み込み直し・選択を空にする', async () => {
    capture.apiRequest.mockResolvedValueOnce({ ok: true, data: {} }).mockResolvedValue(STALE);
    start();
    await post();
    await skip();
    const after = closeFinished();

    expect(toastText(after)).toBe('1 件を記録しました（投稿した 1・投稿しなかった 0）。');
    expect(reloaded(after)).toBe(true);
    expect(checkedRows(after)).toBe(0);
  });

  it('軽微-B 対照：閉じる前（ダイアログを開いた直後）は読み込み直していない', () => {
    start();

    expect(reloaded(draw())).toBe(false);
  });
});
