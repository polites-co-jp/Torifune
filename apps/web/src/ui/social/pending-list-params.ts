import { normalizePage } from '@/domain/repository';
import {
  DEFAULT_PENDING_SORT,
  isPendingKind,
  PENDING_SORTS,
  type PendingKind,
  type PendingSort,
} from '@/domain/social/pending';
import {
  parsePostSourceParam,
  postSourceParamOf,
  type PostSourceFilter,
} from '@/domain/social/post-source';
import { DEFAULT_POST_PER_PAGE, POST_PER_PAGE_OPTIONS } from './post-list-params';

/**
 * 送信待ちタブの URL のクエリ（055-social-pending-tab 設計 §9.2）。
 *
 * Server Component（`app/social/page.tsx`）と部品（`social-pending.tsx`）で共有する純関数。
 * **`'use client'` にしない**（Server Component からも呼ぶ）。画面のクエリの誤りは 422 にせず無視する。
 * クエリの名前は `pending` で始める（投稿タブ・配信履歴タブのクエリと混ざらない。設計 §5.1）。
 * 登録元・表示件数の読み方は投稿タブ（`post-list-params.ts`）と同じ。
 */

/** 送信待ちの条件（解釈したクエリ）。`status` は送信待ちの区分（実装プラン §8 の 59）。 */
export interface PendingListFilters {
  readonly status: PendingKind | null;
  readonly accountId: string | null;
  readonly source: PostSourceFilter | null;
  readonly perPage: number;
  readonly sort: PendingSort;
  readonly page: number;
}

type SearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** クエリの値が 1 つの文字列のときだけ返す（配列・無しは null）。 */
function single(value: string | readonly string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function isPendingSort(value: string | null): value is PendingSort {
  return value !== null && (PENDING_SORTS as readonly string[]).includes(value);
}

/** URL のクエリを送信待ちの条件に読む（設計 §9.2 の表）。範囲外・形の誤りは無視して既定にする。 */
export function parsePendingListParams(params: SearchParams): PendingListFilters {
  const status = single(params['pendingStatus']);
  const accountId = single(params['pendingAccount']);
  const perPage = Number(single(params['pendingPerPage']) ?? Number.NaN);
  const sort = single(params['pendingSort']);
  const page = params['pendingPage'];
  return {
    status: isPendingKind(status) ? status : null,
    accountId: accountId !== null && UUID_PATTERN.test(accountId) ? accountId : null,
    source: parsePostSourceParam(params['pendingSource']),
    perPage: (POST_PER_PAGE_OPTIONS as readonly number[]).includes(perPage)
      ? perPage
      : DEFAULT_POST_PER_PAGE,
    sort: isPendingSort(sort) ? sort : DEFAULT_PENDING_SORT,
    page: normalizePage(Array.isArray(page) ? undefined : page),
  };
}

/** クエリの値を書く。値は検査済みの形だけなので、`:`（`token:<id>`）は読みやすさのためそのまま残す。 */
function encodeValue(value: string): string {
  return encodeURIComponent(value).replaceAll('%3A', ':');
}

/**
 * 送信待ちの条件の URL（設計 §9.2）。既定値（すべて・20 件・手が要るもの順・1 ページ目）は書かない。
 * **`tab` もアンカーも書かない**（送信待ちは既定のタブで、表はタブのすぐ下にある）。
 */
export function pendingListHref(filters: PendingListFilters): string {
  const entries: [string, string][] = [];
  if (filters.status !== null) entries.push(['pendingStatus', filters.status]);
  if (filters.accountId !== null) entries.push(['pendingAccount', filters.accountId]);
  if (filters.source !== null) {
    entries.push(['pendingSource', postSourceParamOf(filters.source)]);
  }
  if (filters.perPage !== DEFAULT_POST_PER_PAGE) {
    entries.push(['pendingPerPage', String(filters.perPage)]);
  }
  if (filters.sort !== DEFAULT_PENDING_SORT) entries.push(['pendingSort', filters.sort]);
  if (filters.page > 1) entries.push(['pendingPage', String(filters.page)]);
  const query = entries.map(([key, value]) => `${key}=${encodeValue(value)}`).join('&');
  return `/social${query === '' ? '' : `?${query}`}`;
}
