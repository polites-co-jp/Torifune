import { redirect } from 'next/navigation';
import { normalizePage } from '@/domain/repository';
import { historyListHref } from '@/ui/social/social-tabs';

export const dynamic = 'force-dynamic';

/**
 * 旧 SNS 配信履歴の URL（055-social-pending-tab 設計 §9.7）。`/social` の配信履歴タブへ転送するだけ。
 *
 * ブックマーク・手順書・外部の資料のリンクを壊さないためにページを残す。
 * `status` は `published` / `failed` のときだけ `historyStatus` に、`page` は 2 以上のときだけ `historyPage` に写し、
 * それ以外の値は落とす（任意の値を転送先へ写さない）。
 * **セッションは見ない**（転送先がログインと `social.read` を見る）。
 */
export default async function SocialHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params['status'];
  const status = raw === 'published' || raw === 'failed' ? raw : null;
  const page = normalizePage(params['page']);

  redirect(historyListHref({ status, page }));
}
