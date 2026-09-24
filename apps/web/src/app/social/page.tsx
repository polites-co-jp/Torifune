import Link from 'next/link';
import { helpLinkOfPlugin } from '@/application/plugin/plugin-help-use-cases';
import { listPublishers, publisherLabels } from '@/application/social/publisher-registry';
import {
  listManualPendingPosts,
  listSocialAccounts,
  listSocialPosts,
  resolveManualHandoff,
} from '@/application/social/social-use-cases';
import { MANUAL_HANDOFF_BUDGET_MS } from '@/domain/social/publishing';
import { isManualPending, providerLabel } from '@/domain/social/social';
import { Button } from '@/ui/components';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint, PluginActions } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';
import { ManualPending, type ManualPendingRow } from '@/ui/social/manual-pending';
import { buildProviderOptions } from '@/ui/social/provider-options';
import { SocialAccounts, type SocialAccountsProps } from '@/ui/social/social-accounts';
import {
  SocialPosts,
  type AccountProvider,
  type PublisherProvider,
} from '@/ui/social/social-posts';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/** 手動投稿待ちの区画に並べる上限（設計 §6.6）。溢れた分は投稿一覧に「手動」として見える。 */
const MANUAL_PENDING_LIMIT = 50;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * 予約時刻からの経過（設計 §7.1 の補足、2026-09-23）。
 *
 * **「いま」を見るのは Server Component の側。** 文字列にして部品へ渡す。
 * Client Component の中で `Date.now()` を見ると、Server と Client で描画が食い違う。
 */
function elapsedTextOf(scheduledAt: Date, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - scheduledAt.getTime());
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)} 分`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)} 時間`;
  }
  return `${Math.floor(elapsed / DAY_MS)} 日`;
}

/**
 * SNS画面（06_画面設計.md §13）。
 *
 * アカウントと投稿を1枚に並べる。**読み取りは Server Component から
 * UseCase を直接呼ぶ**（決定事項 D-06）。認可は UseCase 側で行われる。
 *
 * 手動投稿待ちの区画は投稿一覧の上に置く（035-social-publishing 設計 §7.1）。
 * 行ごとの「投稿画面を開く」の URL は**描画時に確定させる**。
 */
export default async function SocialPage({
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

  const postPage = Math.max(1, Number(params['postPage'] ?? 1) || 1);
  const postPerPage = 20;

  const accounts = await listSocialAccounts(context, { page: 1, perPage: 100, provider: null });
  const posts = await listSocialPosts(context, {
    page: postPage,
    perPage: postPerPage,
    socialAccountId: null,
    status: null,
  });

  // 登録された publisher（`activate()` で埋まる。無ければ空）。
  const publishers = listPublishers();
  const labels = publisherLabels();

  // 投稿一覧はアカウントIDではなく人が読める名前で出す。
  const accountNames = Object.fromEntries(
    accounts.items.map((account) => [
      account.id,
      `${account.displayName}（${providerLabel(account.provider, labels)}）`,
    ]),
  );
  const accountProviders: Record<string, AccountProvider> = Object.fromEntries(
    accounts.items.map((account) => [
      account.id,
      { provider: account.provider, credentialConfigured: account.credentialConfigured },
    ]),
  );
  const publisherProviders: Record<string, PublisherProvider> = Object.fromEntries(
    publishers.map((publisher) => [
      publisher.registration.provider,
      {
        label: publisher.registration.label,
        manual: publisher.registration.manual !== undefined,
        publish: publisher.registration.publish !== undefined,
        credentialFieldKeys: publisher.registration.credentialFields.map((field) => field.key),
      },
    ]),
  );

  // 「サービス」の選択肢は Core が知る provider ＋ publisher を登録した provider（035 設計 §7.5）。
  // publisher の有無と宣言の項目（説明を含む）も持たせる（039 設計 §7.1）。
  // publisher の Plugin の先頭の手順書へのリンクも持たせる（041 設計 §7.4。ヘルプボタン）。
  const providers = buildProviderOptions(publishers, helpLinkOfPlugin);

  // 「いま」はここで一度だけ決める。行ごとに `Date.now()` を見ると値がばらつく。
  const now = new Date();

  const manualPending = await listManualPendingPosts(context, { limit: MANUAL_PENDING_LIMIT });
  /**
   * 1 回の描画で `manual()` に費やしてよい合計（設計 §6.6、検証レポート L-3）。
   *
   * **打ち切り時刻はここで 1 回だけ作り、すべての行へ渡す。** 行ごとの上限
   * （`MANUAL_TIMEOUT_MS`）だけでは、50 行 × 2 秒で最悪 100 秒かかり、
   * その間この画面はまっ白になる。**画面は必ず返る。**
   */
  const handoffDeadline = new Date(now.getTime() + MANUAL_HANDOFF_BUDGET_MS);
  // **行ごとに publisher へ問い合わせる**（設計 §7.1）。上限 50 件で、`manual()` は URL の組み立て。
  const manualRows: readonly ManualPendingRow[] = await Promise.all(
    manualPending.items.map(async (post) => ({
      post: {
        id: post.id,
        accountName: accountNames[post.socialAccountId] ?? post.socialAccountId,
        body: post.body,
        scheduledAt: (post.scheduledAt ?? post.createdAt).toISOString(),
        elapsedText: elapsedTextOf(post.scheduledAt ?? post.createdAt, now),
      },
      handoff: await resolveManualHandoff(context, { id: post.id, deadline: handoffDeadline }),
    })),
  );

  const accountProps: SocialAccountsProps = {
    initialAccounts: accounts.items.map((account) => ({
      id: account.id,
      provider: account.provider,
      displayName: account.displayName,
      handle: account.handle,
      status: account.status,
      credentialConfigured: account.credentialConfigured,
    })),
    permissions: [...permissions],
    providers,
  };

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 'var(--tf-space-3)',
          flexWrap: 'wrap',
        }}
      >
        {/*
          Plugin が足した操作（06_画面設計.md §26）。
          `campaign.list.actions` / `site.list.actions` と同じ描画先を SNS にも置く。
        */}
        <PluginActions
          location="social.list.actions"
          resource="social_account"
          permissions={permissions}
          context={context}
        />
        {/* 配信結果は別画面にまとめる（06_画面設計.md §13「履歴」）。 */}
        <Link href="/social/history">
          <Button variant="secondary">配信履歴</Button>
        </Link>
      </div>
      <ExtensionPoint point="social.list.actions" permissions={permissions} context={context} />
      <SocialAccounts {...accountProps} />
      <ManualPending rows={manualRows} canWrite={permissions.has('social.write')} />
      <SocialPosts
        initialPosts={posts.items.map((post) => ({
          id: post.id,
          socialAccountId: post.socialAccountId,
          body: post.body,
          scheduledAt: post.scheduledAt?.toISOString() ?? null,
          status: post.status,
          publishedAt: post.publishedAt?.toISOString() ?? null,
          deliveryMode: post.deliveryMode,
          failureReason: post.failureReason,
          attemptCount: post.attemptCount,
          // 飛ばされた回数（設計 §7.3。裁定 #15-a）。残りは画面が `PUBLISH_MAX_SKIPS` から引く。
          skipCount: post.skipCount,
          externalUrl: post.externalUrl,
          // 「手動投稿待ち」かどうかも Server Component 側で判定する（設計 §7.1 の補足）。
          manualPending: isManualPending(post, now),
        }))}
        accountNames={accountNames}
        accountProviders={accountProviders}
        publisherProviders={publisherProviders}
        total={posts.total}
        page={postPage}
        perPage={postPerPage}
        permissions={[...permissions]}
      />
    </AppShell>
  );
}
