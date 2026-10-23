import type { ReactNode } from 'react';
import { resolveAnalyticsTimeZone } from '@/application/analytics/timezone';
import { helpLinkOfPlugin } from '@/application/plugin/plugin-help-use-cases';
import { listSites } from '@/application/site/site-use-cases';
import {
  findPublisher,
  isManualOnlyProvider,
  listPublishers,
  publisherLabels,
} from '@/application/social/publisher-registry';
import { settleManualHandoff } from '@/application/social/manual-handoff-settle';
import {
  listSocialAccounts,
  listSocialPendingPosts,
  listSocialPostHistory,
  listSocialPostSources,
  listSocialPosts,
  resolveManualHandoff,
} from '@/application/social/social-use-cases';
import { dateInTimeZone } from '@/domain/analytics/day';
import { normalizePage } from '@/domain/repository';
import { canOpenManualHandoff, pendingKindOf } from '@/domain/social/pending';
import { postSourceOf } from '@/domain/social/post-source';
import { MANUAL_HANDOFF_BUDGET_MS } from '@/domain/social/publishing';
import { isManualPending, providerLabel, type SocialPost } from '@/domain/social/social';
import { Tabs } from '@/ui/components';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint, PluginActions } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';
import { SOCIAL_TAB_LABEL, SOCIAL_TABS_LABEL } from '@/ui/social/labels';
import { parsePendingListParams, pendingListHref } from '@/ui/social/pending-list-params';
import {
  parsePostListParams,
  postListHref,
  postSourceOptionsOf,
  postSourceViewOf,
  type PostListOption,
} from '@/ui/social/post-list-params';
import { buildProviderOptions } from '@/ui/social/provider-options';
import {
  SocialAccounts,
  type SiteOption,
  type SocialAccountsProps,
} from '@/ui/social/social-accounts';
import { SocialHistory, type HistoryRow } from '@/ui/social/social-history';
import { SocialPending, type PendingRow } from '@/ui/social/social-pending';
import {
  SocialPosts,
  type AccountProvider,
  type PostRow,
  type PublisherProvider,
} from '@/ui/social/social-posts';
import {
  parseSocialTab,
  SOCIAL_TAB_KEYS,
  socialTabHref,
  type SocialTabKey,
} from '@/ui/social/social-tabs';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/**
 * 承認待ちの行の支度の警告（048-social-post-approval 設計 §7.1.1）。
 *
 * 投稿一覧の Badge（`social-posts.tsx` の `unreadyOf`）と同じ判定を `auto` の行にだけ掛ける。
 * 承認しても支度待ちになることを承認の前に知らせる（承認は止めない）。
 */
function approvalWarningOf(
  deliveryMode: string,
  account: { readonly provider: string; readonly credentialConfigured: boolean } | undefined,
): PendingRow['warning'] {
  if (deliveryMode !== 'auto' || account === undefined) {
    return null;
  }
  const publisher = findPublisher(account.provider);
  if (publisher === null || publisher.registration.publish === undefined) {
    return 'no_publisher';
  }
  // 資格情報の要らない配信手段では「未設定」を警告しない（035 設計 §5.7）。
  if (publisher.registration.credentialFields.length > 0 && !account.credentialConfigured) {
    return 'credential_missing';
  }
  return null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 配信履歴タブの 1 ページの件数（今の `/social/history` と同じ）。 */
const HISTORY_PER_PAGE = 20;

/**
 * 予約時刻からの経過（035 設計 §7.1 の補足、2026-09-23）。
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
 * 投稿一覧の行に足す、一括操作のための判定（054-bulk-post-actions 設計 §9.8）。
 *
 * **「いま」は呼び出し側で 1 回だけ決めて渡す**（行ごとに `Date.now()` を見ると値がばらつき、
 * Client Component の中で見ると Server と Client で描画が食い違う）。
 */
function bulkFlagsOf(
  post: SocialPost,
  account: { readonly provider: string } | undefined,
  now: Date,
): Pick<PostRow, 'scheduledFuture' | 'publishing' | 'desiredPast' | 'manualOnly'> {
  return {
    scheduledFuture:
      post.status === 'scheduled' &&
      (post.scheduledAt === null || post.scheduledAt.getTime() > now.getTime()),
    publishing:
      post.status === 'scheduled' && post.deliveryMode === 'auto' && post.publishStartedAt !== null,
    desiredPast:
      post.status === 'awaiting_approval' &&
      post.scheduledAt !== null &&
      post.scheduledAt.getTime() <= now.getTime(),
    manualOnly: account === undefined ? false : isManualOnlyProvider(account.provider),
  };
}

/**
 * 投稿一覧（投稿タブ）と送信待ちの表（送信待ちタブ）の行の共通の項目（054 設計 §9.8）。
 * **トークンの ID は行に渡さない**（054 設計 §5.6・§9.8）。
 */
function postRowOf(
  post: SocialPost,
  account: { readonly provider: string } | undefined,
  sourceTokens: Parameters<typeof postSourceOf>[1],
  now: Date,
): PostRow {
  return {
    id: post.id,
    socialAccountId: post.socialAccountId,
    body: post.body,
    scheduledAt: post.scheduledAt?.toISOString() ?? null,
    status: post.status,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    deliveryMode: post.deliveryMode,
    failureReason: post.failureReason,
    attemptCount: post.attemptCount,
    // 飛ばされた回数（035 設計 §7.3。裁定 #15-a）。残りは画面が `PUBLISH_MAX_SKIPS` から引く。
    skipCount: post.skipCount,
    externalUrl: post.externalUrl,
    // 「手動投稿待ち」かどうかも Server Component 側で判定する（035 設計 §7.1 の補足）。
    manualPending: isManualPending(post, now),
    // 承認を経た予約か（048 設計 §7.3）。
    approvedAt: post.approvedAt?.toISOString() ?? null,
    // 一括操作の expectedUpdatedAt（054 設計 §9.8）。渡さない行は選べない。
    updatedAt: post.updatedAt.toISOString(),
    source: postSourceViewOf(postSourceOf(post, sourceTokens)),
    ...bulkFlagsOf(post, account, now),
  };
}

/**
 * SNS画面（06_画面設計.md §13、055-social-pending-tab 設計 §5.1・§9.1）。
 *
 * h1「SNS」・Plugin の操作・タブ（送信待ち〔既定〕／投稿／アカウント／配信履歴）の下に、選んだタブの中身を描く。
 * **読み込むのは選んだタブの分だけ**（アカウントの一覧は名前の表示にどのタブでも使うので常に読む）。
 * 読み取りは Server Component から UseCase を直接呼ぶ（決定事項 D-06）。認可は UseCase 側で行われる。
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

  const tab: SocialTabKey = parseSocialTab(params['tab']);

  const accounts = await listSocialAccounts(context, { page: 1, perPage: 100, provider: null });
  const accountsById = new Map(accounts.items.map((account) => [account.id, account]));

  // 登録された publisher（`activate()` で埋まる。無ければ空）。
  const publishers = listPublishers();
  const labels = publisherLabels();

  // 投稿はアカウントIDではなく人が読める名前で出す。
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

  /** 絞り込みの選択肢（送信待ち・投稿のタブ。054 設計 §9.2）。 */
  async function filterOptions() {
    // 登録元（054 設計 §8.8）。行の表示と絞り込みの選択肢の両方に使う。
    const postSources = await listSocialPostSources(context, undefined);
    // 登録元の「（発行 …）」の日付は基準のタイムゾーンで作る（054 実装プラン §8 の 18）。
    const timeZone = await resolveAnalyticsTimeZone();
    const sourceOptions = postSourceOptionsOf(postSources, (date) =>
      dateInTimeZone(date, timeZone),
    );
    // アカウントは読み込んだものを名前順に並べる（「すべて」は部品が足す）。
    const accountOptions: readonly PostListOption[] = accounts.items
      .map((account) => ({ value: account.id, label: accountNames[account.id] ?? account.id }))
      .sort((left, right) => left.label.localeCompare(right.label, 'ja'));
    return { postSources, sourceOptions, accountOptions };
  }

  let content: ReactNode;

  if (tab === 'pending') {
    // 送信待ちの条件は URL のクエリから読む。誤った値は無視して既定にする（設計 §9.2）。
    // ページは画面の `?page=` の共通の読み方で丸める（044）。
    const pendingFilters = {
      ...parsePendingListParams(params),
      page: normalizePage(params['pendingPage']),
    };
    // 「いま」はここで一度だけ決める。区分の判定・並び・経過・一括の判定に同じ値を使う（設計 §6）。
    const now = new Date();
    const pending = await listSocialPendingPosts(context, {
      page: pendingFilters.page,
      perPage: pendingFilters.perPage,
      kind: pendingFilters.status,
      socialAccountId: pendingFilters.accountId,
      source: pendingFilters.source,
      sort: pendingFilters.sort,
      now,
    });
    const { postSources, sourceOptions, accountOptions } = await filterOptions();

    /**
     * 1 回の描画で `manual()` に費やしてよい合計（035 設計 §6.6、検証レポート L-3。055 設計 §5.5）。
     *
     * **打ち切り時刻はここで 1 回だけ作り、すべての行へ渡す。** 行ごとの上限
     * （`MANUAL_TIMEOUT_MS`）だけでは、100 行 × 2 秒で最悪 200 秒かかり、
     * その間この画面はまっ白になる。**画面は必ず返る。**
     */
    const handoffDeadline = new Date(now.getTime() + MANUAL_HANDOFF_BUDGET_MS);
    // **手動の予約の行だけ** publisher へ問い合わせる（設計 §5.5）。承認待ちの行には URL を問い合わせない
    // （承認を経ずに SNS へ出す手がかりを HTML に残さない。048 §7.2）。
    const pendingRows: readonly PendingRow[] = await Promise.all(
      pending.items.flatMap((post) => {
        const kind = pendingKindOf(post, now);
        if (kind === null) return [];
        const account = accountsById.get(post.socialAccountId);
        return [
          (async (): Promise<PendingRow> => ({
            ...postRowOf(post, account, postSources.tokens, now),
            kind,
            ...(kind === 'manual_pending'
              ? { elapsedText: elapsedTextOf(post.scheduledAt ?? post.createdAt, now) }
              : {}),
            ...(canOpenManualHandoff(post)
              ? {
                  // 読んだ後に行が自動へ変わった・消されたときも、タブ全体は描きその行だけを
                  // `changed` の開けない行にする（設計 §8.3。検証 1 回目 S1）。
                  handoff: await settleManualHandoff(
                    resolveManualHandoff(context, {
                      id: post.id,
                      deadline: handoffDeadline,
                    }),
                  ),
                }
              : {}),
            link: post.link,
            media: post.media.map((item) => ({ url: item.url, alt: item.alt })),
            requestedAt: post.createdAt.toISOString(),
            warning:
              kind === 'awaiting_approval' ? approvalWarningOf(post.deliveryMode, account) : null,
          }))(),
        ];
      }),
    );

    content = (
      // `key` は行の中身ではなく条件とページから作る（実装プラン §7 の 7。054 実装プラン §8 の 56）。
      // 部品は行を props から導くので、1 件・一括の操作の後の `router.refresh()` では作り直さずに新しい行を映し、
      // 成功の Toast を残す。条件・ページを変えたときは作り直されて選択が消える。
      <SocialPending
        key={pendingListHref(pendingFilters)}
        rows={pendingRows}
        accountNames={accountNames}
        accountProviders={accountProviders}
        publisherProviders={publisherProviders}
        total={pending.total}
        page={pendingFilters.page}
        perPage={pendingFilters.perPage}
        permissions={[...permissions]}
        filters={pendingFilters}
        counts={pending.counts}
        sourceOptions={sourceOptions}
        accountOptions={accountOptions}
      />
    );
  } else if (tab === 'posts') {
    // 投稿一覧の条件は URL のクエリから読む。誤った値は無視して既定にする（054 設計 §9.2）。
    // ページは画面の `?page=` の共通の読み方で丸める（044。054 設計 §9.2 の表の `postPage`）。
    const postFilters = { ...parsePostListParams(params), page: normalizePage(params['postPage']) };
    const now = new Date();
    const posts = await listSocialPosts(context, {
      page: postFilters.page,
      perPage: postFilters.perPage,
      socialAccountId: postFilters.accountId,
      status: postFilters.status,
      source: postFilters.source,
    });
    const { postSources, sourceOptions, accountOptions } = await filterOptions();

    content = (
      // `key` は行の中身ではなく絞り込みとページから作る（054 実装プラン §8 の 56）。
      <SocialPosts
        key={postListHref(postFilters)}
        initialPosts={posts.items.map((post) =>
          postRowOf(post, accountsById.get(post.socialAccountId), postSources.tokens, now),
        )}
        accountNames={accountNames}
        accountProviders={accountProviders}
        publisherProviders={publisherProviders}
        total={posts.total}
        page={postFilters.page}
        perPage={postFilters.perPage}
        permissions={[...permissions]}
        filters={postFilters}
        sourceOptions={sourceOptions}
        accountOptions={accountOptions}
      />
    );
  } else if (tab === 'accounts') {
    // 「サービス」の選択肢は Core が知る provider ＋ publisher を登録した provider（035 設計 §7.5）。
    // publisher の有無と宣言の項目（説明を含む）も持たせる（039 設計 §7.1）。
    // publisher の Plugin の先頭の手順書へのリンクも持たせる（041 設計 §7.4。ヘルプボタン）。
    const providers = buildProviderOptions(publishers, helpLinkOfPlugin);

    // サイトの一覧（053-site-scoped-social 設計 §9.1.5）。`site.read` があるときだけ引く。
    // 既定（active / paused）とアーカイブを 2 回に分けて名前順で引き、この順で渡す（部品は並べ替えない）。
    const canReadSites = permissions.has('site.read');
    const sites: SiteOption[] = [];
    if (canReadSites) {
      for (const status of [null, 'archived'] as const) {
        const page = await listSites(context, {
          page: 1,
          perPage: 100,
          status,
          keyword: null,
          sort: [{ field: 'name', direction: 'asc' }],
        });
        sites.push(
          ...page.items.map((site) => ({ id: site.id, name: site.name, status: site.status })),
        );
      }
    }

    const accountProps: SocialAccountsProps = {
      initialAccounts: accounts.items.map((account) => ({
        id: account.id,
        provider: account.provider,
        displayName: account.displayName,
        handle: account.handle,
        status: account.status,
        credentialConfigured: account.credentialConfigured,
        siteId: account.siteId,
      })),
      permissions: [...permissions],
      providers,
      sites,
      canReadSites,
    };
    content = <SocialAccounts {...accountProps} />;
  } else {
    // 配信履歴（設計 §9.6）。クエリは `historyStatus`・`historyPage`（他のタブのクエリと混ざらない）。
    // 知らない値は「すべて」に倒す。URL を書き換えられても壊れない。
    const historyPage = normalizePage(params['historyPage']);
    const rawStatus = params['historyStatus'];
    const historyStatus = rawStatus === 'published' || rawStatus === 'failed' ? rawStatus : null;

    const result = await listSocialPostHistory(context, {
      page: historyPage,
      perPage: HISTORY_PER_PAGE,
      status: historyStatus,
    });
    const rows: readonly HistoryRow[] = result.items.map((post) => ({
      id: post.id,
      socialAccountId: post.socialAccountId,
      body: post.body,
      status: post.status,
      // 配信済みなら配信時刻、失敗なら失敗時刻。
      // `failedAt` を足す前の行は空になるので、その場合は最後に触った時刻で代える。
      resultAt: (post.publishedAt ?? post.failedAt ?? post.updatedAt).toISOString(),
      failureReason: post.failureReason,
      externalUrl: post.externalUrl,
    }));

    content = (
      <SocialHistory
        rows={rows}
        accountNames={accountNames}
        total={result.total}
        page={historyPage}
        perPage={HISTORY_PER_PAGE}
        status={historyStatus ?? ''}
      />
    );
  }

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
        <h1 style={{ fontSize: '1.25rem', marginTop: 0 }}>SNS</h1>
        {/*
          Plugin が足した操作（06_画面設計.md §26）。どのタブでもタブの上に描く（055 設計 §9.11）。
          `campaign.list.actions` / `site.list.actions` と同じ描画先を SNS にも置く。
        */}
        <PluginActions
          location="social.list.actions"
          resource="social_account"
          permissions={permissions}
          context={context}
        />
      </div>
      <ExtensionPoint point="social.list.actions" permissions={permissions} context={context} />
      <Tabs
        items={SOCIAL_TAB_KEYS.map((key) => ({ key, label: SOCIAL_TAB_LABEL[key] }))}
        current={tab}
        hrefFor={(key) => socialTabHref(parseSocialTab(key))}
        label={SOCIAL_TABS_LABEL}
      />
      {content}
    </AppShell>
  );
}
