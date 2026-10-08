import { normalizePage } from '@/domain/repository';
import {
  parsePostSourceParam,
  postSourceParamOf,
  type PostSource,
  type PostSourceFilter,
  type SocialPostSources,
} from '@/domain/social/post-source';
import { isPostStatus, type PostStatus } from '@/domain/social/social';
import {
  POST_FILTER_ALL,
  POST_SOURCE_DELETED_OPTION,
  POST_SOURCE_ISSUED_SUFFIX,
  POST_SOURCE_REVOKED_SUFFIX,
  POST_SOURCE_SCREEN_LABEL,
  POSTS_ANCHOR,
} from './labels';

/**
 * 投稿一覧の URL のクエリと登録元の選択肢（054-bulk-post-actions 設計 §5.6・§9.2・§9.8）。
 *
 * Server Component（`app/social/page.tsx`）と部品（`social-posts.tsx`）で共有する純関数。
 * **`'use client'` にしない**（Server Component からも呼ぶ）。画面のクエリの誤りは 422 にせず無視する。
 */

/** 表示件数の選択肢（ユーザー裁定 8）。先頭が既定。 */
export const POST_PER_PAGE_OPTIONS = [20, 50, 100] as const;

/** 表示件数の既定。 */
export const DEFAULT_POST_PER_PAGE: number = POST_PER_PAGE_OPTIONS[0];

/** 一覧の条件（解釈したクエリ）。 */
export interface PostListFilters {
  readonly status: PostStatus | null;
  readonly accountId: string | null;
  readonly source: PostSourceFilter | null;
  readonly perPage: number;
  readonly page: number;
}

/** `Select` の選択肢。 */
export interface PostListOption {
  readonly value: string;
  readonly label: string;
}

/** 行の登録元の表示（トークンの ID を持たない。設計 §5.6・§9.8）。 */
export type PostSourceView =
  | { readonly kind: 'screen' }
  | { readonly kind: 'token'; readonly label: string; readonly revoked: boolean }
  | { readonly kind: 'deleted_token'; readonly label: string };

type SearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** クエリの値が 1 つの文字列のときだけ返す（配列・無しは null）。 */
function single(value: string | readonly string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/** URL のクエリを一覧の条件に読む（設計 §9.2 の表）。範囲外・形の誤りは無視して既定にする。 */
export function parsePostListParams(params: SearchParams): PostListFilters {
  const status = single(params['postStatus']);
  const accountId = single(params['postAccount']);
  const perPage = Number(single(params['postPerPage']) ?? Number.NaN);
  const page = params['postPage'];
  return {
    status: status !== null && isPostStatus(status) ? status : null,
    accountId: accountId !== null && UUID_PATTERN.test(accountId) ? accountId : null,
    source: parsePostSourceParam(params['postSource']),
    perPage: (POST_PER_PAGE_OPTIONS as readonly number[]).includes(perPage)
      ? perPage
      : DEFAULT_POST_PER_PAGE,
    page: normalizePage(Array.isArray(page) ? undefined : page),
  };
}

/** クエリの値を書く。値は検査済みの形だけなので、`:`（`token:<id>`）は読みやすさのためそのまま残す。 */
function encodeValue(value: string): string {
  return encodeURIComponent(value).replaceAll('%3A', ':');
}

/**
 * 一覧の条件の URL（設計 §9.2）。既定値（すべて・20 件・1 ページ目）は書かず、末尾に `#posts` を付ける。
 */
export function postListHref(filters: PostListFilters): string {
  const entries: [string, string][] = [];
  if (filters.status !== null) entries.push(['postStatus', filters.status]);
  if (filters.accountId !== null) entries.push(['postAccount', filters.accountId]);
  if (filters.source !== null) entries.push(['postSource', postSourceParamOf(filters.source)]);
  if (filters.perPage !== DEFAULT_POST_PER_PAGE) {
    entries.push(['postPerPage', String(filters.perPage)]);
  }
  if (filters.page > 1) entries.push(['postPage', String(filters.page)]);
  const query = entries.map(([key, value]) => `${key}=${encodeValue(value)}`).join('&');
  return `/social${query === '' ? '' : `?${query}`}#${POSTS_ANCHOR}`;
}

/** 絞り込みを保ったまま、指定のページを開く（ページ全体を読み込み直す。設計 §9.2）。 */
export function openPostListPage(filters: PostListFilters, page: number): void {
  window.location.assign(postListHref({ ...filters, page }));
}

/**
 * 登録元の絞り込みの選択肢（設計 §9.2）。
 *
 * 「すべて」→「管理画面」→ トークン（渡した順）→「削除されたトークン」（`hasDeletedTokenPosts` のときだけ）。
 * 「管理画面」は設計 §9.2 のとおり常に出す。
 * 名前が重なるトークンにだけ「（発行 …）」を添え、失効は「（失効）」を添える。発行日の書式は呼び出し側が決める
 * （Server Component は基準のタイムゾーンで作る）。
 */
export function postSourceOptionsOf(
  sources: SocialPostSources,
  formatIssuedDate: (date: Date) => string,
): readonly PostListOption[] {
  const nameCounts = new Map<string, number>();
  for (const token of sources.tokens) {
    nameCounts.set(token.name, (nameCounts.get(token.name) ?? 0) + 1);
  }
  const tokenOptions = sources.tokens.map((token) => {
    const issued =
      (nameCounts.get(token.name) ?? 0) > 1
        ? POST_SOURCE_ISSUED_SUFFIX.replace('{date}', formatIssuedDate(token.createdAt))
        : '';
    const revoked = token.revoked ? POST_SOURCE_REVOKED_SUFFIX : '';
    return {
      value: postSourceParamOf({ kind: 'token', tokenId: token.id }),
      label: `${token.name}${issued}${revoked}`,
    };
  });
  return [
    { value: '', label: POST_FILTER_ALL },
    { value: postSourceParamOf({ kind: 'screen' }), label: POST_SOURCE_SCREEN_LABEL },
    ...tokenOptions,
    ...(sources.hasDeletedTokenPosts
      ? [{ value: postSourceParamOf({ kind: 'deleted_token' }), label: POST_SOURCE_DELETED_OPTION }]
      : []),
  ];
}

/** 行の登録元の表示用の値（トークンの ID を落とす。設計 §5.6・§9.8）。 */
export function postSourceViewOf(source: PostSource): PostSourceView {
  switch (source.kind) {
    case 'screen':
      return { kind: 'screen' };
    case 'token':
      return { kind: 'token', label: source.name, revoked: source.revoked };
    case 'deleted_token':
      return { kind: 'deleted_token', label: source.name };
  }
}
