/**
 * SNS 画面のタブと URL（055-social-pending-tab 設計 §5.1・§5.7・§9.1・§9.6・§9.12）。
 *
 * Server Component（`app/social/page.tsx`・投稿フォームの `page.tsx`）と部品で共有する純関数。
 * **`'use client'` にしない**（Server Component からも呼ぶ）。画面のクエリの誤りは 422 にせず既定に読む。
 */

/** タブのキー。並びはタブの表示順（設計 §5.1）。先頭が既定（`tab` を書かない）。 */
export const SOCIAL_TAB_KEYS = ['pending', 'posts', 'accounts', 'history'] as const;

export type SocialTabKey = (typeof SOCIAL_TAB_KEYS)[number];

type QueryValue = string | readonly string[] | undefined;

/**
 * `tab` のクエリを読む（設計 §5.1）。文字列で `posts` / `accounts` / `history` のどれかのときだけそのタブ。
 * 無い・知らない値・配列は送信待ち（設定画面の `toTab` の `String(value)` は写さない。配列を通さない）。
 */
export function parseSocialTab(value: QueryValue): SocialTabKey {
  if (typeof value !== 'string') return 'pending';
  return (SOCIAL_TAB_KEYS as readonly string[]).includes(value)
    ? (value as SocialTabKey)
    : 'pending';
}

/** タブの URL（設計 §9.1）。送信待ちは `/social`（`tab` を書かない）。他のタブの条件は落とす。 */
export function socialTabHref(key: SocialTabKey): string {
  return key === 'pending' ? '/social' : `/social?tab=${key}`;
}

/**
 * 投稿フォームの保存・キャンセルの戻り先（設計 §5.7）。`from=pending` だけ送信待ちタブ、他はすべて投稿タブ。
 * **許す値は 2 つだけ。** 任意の URL を受け取らない（オープンリダイレクトにしない）。
 */
export function postFormReturnTo(from: QueryValue): string {
  return from === 'pending' ? socialTabHref('pending') : socialTabHref('posts');
}

/**
 * 配信履歴タブの URL（設計 §9.6）。`status` は `''` と `null` をどちらも「すべて」と読む
 * （部品の props の `''` と Server Component の `null` の両方から呼ぶ。実装プラン §8 の 58）。
 * 1 ページ目は `historyPage` を書かない。
 */
export function historyListHref(input: {
  readonly status: string | null;
  readonly page: number;
}): string {
  const entries: [string, string][] = [['tab', 'history']];
  if (input.status !== null && input.status !== '') {
    entries.push(['historyStatus', input.status]);
  }
  if (input.page > 1) entries.push(['historyPage', String(input.page)]);
  const query = entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  return `/social?${query}`;
}
