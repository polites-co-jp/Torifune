import { listSocialAccounts, listSocialPostHistory } from '@/application/social/social-use-cases';
import { providerLabel } from '@/domain/social/social';
import { AppShell } from '@/ui/layout/app-shell';
import { requirePageSession } from '@/ui/server/page-session';
import { SocialHistory, type HistoryRow } from '@/ui/social/social-history';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/**
 * SNS の配信履歴（06_画面設計.md §13）。
 *
 * **読み取りは Server Component から UseCase を直接呼ぶ**（決定事項 D-06）。
 * 認可は UseCase 側で行われる。
 */
export default async function SocialHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { context, displayName, permissions } = await requirePageSession();

  if (!permissions.has('social.read')) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  const page = Math.max(1, Number(params['page'] ?? 1) || 1);
  const perPage = 20;

  // 知らない値は「すべて」に倒す。URL を書き換えられても壊れない。
  const raw = params['status'];
  const status = raw === 'published' || raw === 'failed' ? raw : null;

  const result = await listSocialPostHistory(context, { page, perPage, status });
  const accounts = await listSocialAccounts(context, { page: 1, perPage: 100, provider: null });

  const accountNames = Object.fromEntries(
    accounts.items.map((account) => [
      account.id,
      `${account.displayName}（${providerLabel(account.provider)}）`,
    ]),
  );

  const rows: readonly HistoryRow[] = result.items.map((post) => ({
    id: post.id,
    socialAccountId: post.socialAccountId,
    body: post.body,
    status: post.status,
    // 配信済みなら配信時刻、失敗なら失敗時刻。
    // `failedAt` を足す前の行は空になるので、その場合は最後に触った時刻で代える。
    resultAt: (post.publishedAt ?? post.failedAt ?? post.updatedAt).toISOString(),
    failureReason: post.failureReason,
  }));

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <SocialHistory
        rows={rows}
        accountNames={accountNames}
        total={result.total}
        page={page}
        perPage={perPage}
        status={status ?? ''}
      />
    </AppShell>
  );
}
