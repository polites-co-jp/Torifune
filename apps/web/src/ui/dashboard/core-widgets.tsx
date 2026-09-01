'use client';

import Link from 'next/link';
import { Card, Chart, EmptyState, Table, type ChartPoint, type Column } from '@/ui/components';

/**
 * Core の Widget（06_画面設計.md §9-10）。
 *
 * **Client Component にしている。** 共通の Table が Client Component で、
 * 列定義の `render` は関数なので Server Component から渡せない。
 *
 * 期間は直近7日に固定する。ダッシュボードは**開いてすぐ分かる**ことが役目で、
 * 細かく見るための画面は `/analytics` にある（設計 §3.5）。
 */

export interface DailyAccess {
  readonly date: string;
  readonly pageviews: number;
  readonly visitors: number;
}

export interface RecentPost {
  readonly id: string;
  readonly body: string;
  readonly status: string;
  readonly updatedAt: string;
}

export interface RecentActivity {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly resourceType: string;
  readonly occurredAt: string;
}

const ACTION_LABEL: Record<string, string> = {
  created: '作成',
  updated: '更新',
  deleted: '削除',
  enabled: '有効化',
  disabled: '無効化',
  installed: '導入',
  uninstalled: '削除',
};

const RESOURCE_LABEL: Record<string, string> = {
  site: 'Webサイト',
  campaign: 'キャンペーン',
  social_account: 'SNSアカウント',
  social_post: 'SNS投稿',
  plugin: 'プラグイン',
  plugin_settings: 'プラグイン設定',
  api_token: 'APIトークン',
  system_settings: 'システム設定',
};

const POST_STATUS_LABEL: Record<string, string> = {
  draft: '下書き',
  scheduled: '予約',
  published: '配信済み',
  failed: '失敗',
};

/** 直近7日の KPI。 */
export function AccessSummary({
  daily,
  postCount,
}: {
  readonly daily: readonly DailyAccess[];
  readonly postCount: number;
}) {
  const totals = daily.reduce(
    (acc, row) => ({
      pageviews: acc.pageviews + row.pageviews,
      visitors: acc.visitors + row.visitors,
    }),
    { pageviews: 0, visitors: 0 },
  );

  const stats = [
    { label: 'ページビュー（7日）', value: totals.pageviews },
    { label: '訪問者（7日）', value: totals.visitors },
    { label: 'SNS投稿（全体）', value: postCount },
  ];

  return (
    <Card>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>直近7日</h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
          gap: 'var(--tf-space-4)',
        }}
      >
        {stats.map((stat) => (
          <div key={stat.label}>
            <div style={{ color: 'var(--tf-color-text-muted)', fontSize: '0.875rem' }}>
              {stat.label}
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: 600 }}>{stat.value.toLocaleString()}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** アクセス推移。**同じ値を表としても出す**（設計 §3.1）。 */
export function AccessTrend({ daily }: { readonly daily: readonly DailyAccess[] }) {
  const points: readonly ChartPoint[] = daily.map((row) => ({
    label: row.date,
    value: row.pageviews,
  }));

  const columns: readonly Column<DailyAccess>[] = [
    { key: 'date', header: '日付', render: (row) => row.date },
    { key: 'pageviews', header: 'ページビュー', render: (row) => row.pageviews.toLocaleString() },
    { key: 'visitors', header: '訪問者', render: (row) => row.visitors.toLocaleString() },
  ];

  return (
    <Card>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>アクセス推移</h2>
      <Chart
        title="直近7日のページビューの推移"
        points={points}
        fallback={
          daily.length === 0 ? (
            <EmptyState message="アクセスの記録がありません。計測タグを貼ると数字が出ます。" />
          ) : (
            <Table columns={columns} rows={daily} rowKey={(row) => row.date} />
          )
        }
      />
      <p style={{ margin: 0 }}>
        <Link href="/analytics">アナリティクスで詳しく見る</Link>
      </p>
    </Card>
  );
}

export function RecentPosts({ posts }: { readonly posts: readonly RecentPost[] }) {
  const columns: readonly Column<RecentPost>[] = [
    {
      key: 'body',
      header: '本文',
      // 一覧に全文を出さない。長い投稿で表が崩れる。
      render: (post) => (post.body.length > 40 ? `${post.body.slice(0, 40)}…` : post.body),
    },
    {
      key: 'status',
      header: '状態',
      render: (post) => POST_STATUS_LABEL[post.status] ?? post.status,
    },
    { key: 'updatedAt', header: '更新', render: (post) => post.updatedAt },
  ];

  return (
    <Card>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>最近の投稿</h2>
      {posts.length === 0 ? (
        <EmptyState message="投稿はまだありません。" />
      ) : (
        <Table columns={columns} rows={posts} rowKey={(post) => post.id} />
      )}
    </Card>
  );
}

/**
 * 最近の活動。
 *
 * 監査ログ（`audit_logs`）から作る。**専用のテーブルを作らない。**
 * 出すのは「誰が・何を・いつ」だけ。監査ログは操作の記録であって、
 * 活動の要約ではない。
 */
export function RecentActivities({
  activities,
}: {
  readonly activities: readonly RecentActivity[];
}) {
  const columns: readonly Column<RecentActivity>[] = [
    { key: 'actor', header: '操作者', render: (row) => row.actor },
    {
      key: 'what',
      header: '内容',
      render: (row) =>
        `${RESOURCE_LABEL[row.resourceType] ?? row.resourceType}を${
          ACTION_LABEL[row.action] ?? row.action
        }`,
    },
    { key: 'occurredAt', header: '日時', render: (row) => row.occurredAt },
  ];

  return (
    <Card>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>最近の活動</h2>
      {activities.length === 0 ? (
        <EmptyState message="記録された操作はまだありません。" />
      ) : (
        <Table columns={columns} rows={activities} rowKey={(row) => row.id} />
      )}
    </Card>
  );
}
