import type { PostStatus, SocialPost } from '@/domain/social/social';
import { POST_STATUS_LABEL } from '@/ui/social/labels';

/**
 * キャンペーンの画面でSNS投稿を選ばせるための表示名。
 *
 * **本文をそのまま出さない。** 1万文字まで入るので、そのままではチェックボックスの
 * 一覧が読めなくなる。1行に収まる長さで切り、状態を添える
 * （下書きなのか配信済みなのかで、選ぶ判断が変わる）。
 */

const EXCERPT_LENGTH = 40;

export function postExcerpt(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length <= EXCERPT_LENGTH ? oneLine : `${oneLine.slice(0, EXCERPT_LENGTH)}…`;
}

export function postOptions(
  posts: readonly SocialPost[],
): readonly { id: string; label: string }[] {
  return posts.map((post) => ({
    id: post.id,
    label: `${postExcerpt(post.body)}（${POST_STATUS_LABEL[post.status as PostStatus] ?? post.status}）`,
  }));
}
