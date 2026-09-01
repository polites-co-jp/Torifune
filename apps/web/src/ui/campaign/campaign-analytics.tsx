'use client';

import Link from 'next/link';
import type { PostStatus } from '@/domain/social/social';
import { Alert, Card, EmptyState, Table, type Column } from '@/ui/components';
import { POST_STATUS_LABEL } from '@/ui/social/labels';

/**
 * キャンペーンの分析（06_画面設計.md §14、026-screen-completion 設計 §3.2）。
 *
 * **新しい集計は作らない。** アクセスは `listAnalytics`、投稿は
 * SNS の UseCase が返したものを、ここでは並べるだけ。
 *
 * **Client Component にしている。** 共通の Table が Client Component であり、
 * 列定義の `render` は関数なので Server Component から渡せない
 * （`analytics-view.tsx` と同じ事情）。
 */

export interface CampaignSiteRow {
  readonly id: string;
  readonly name: string;
  readonly pageviews: number;
  readonly visitors: number;
}

export interface CampaignPostRow {
  readonly id: string;
  readonly excerpt: string;
  readonly status: PostStatus;
  /** 配信済みなら配信時刻、失敗なら失敗時刻。まだなら null。 */
  readonly resultAt: string | null;
  readonly failureReason: string | null;
}

export interface CampaignAnalyticsProps {
  readonly campaignId: string;
  readonly name: string;
  readonly statusLabel: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  /** 実際に集計した期間。キャンペーンの期間と一致しないことがある。 */
  readonly from: string;
  readonly to: string;
  readonly truncated: boolean;
  readonly sites: readonly CampaignSiteRow[];
  readonly posts: readonly CampaignPostRow[];
  readonly postCounts: Record<PostStatus, number>;
  /** 権限が無くて出せない区画。画面ごと落とさず、そこだけ理由を出す。 */
  readonly canReadAnalytics: boolean;
  readonly canReadSocial: boolean;
}

function formatDateTime(value: string | null): string {
  if (value === null) {
    return '—';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP');
}

export function CampaignAnalytics(props: CampaignAnalyticsProps) {
  const totals = props.sites.reduce(
    (acc, row) => ({
      pageviews: acc.pageviews + row.pageviews,
      visitors: acc.visitors + row.visitors,
    }),
    { pageviews: 0, visitors: 0 },
  );

  const siteColumns: readonly Column<CampaignSiteRow>[] = [
    { key: 'name', header: 'サイト', render: (row) => row.name },
    { key: 'pageviews', header: 'ページビュー', render: (row) => row.pageviews.toLocaleString() },
    { key: 'visitors', header: '訪問者', render: (row) => row.visitors.toLocaleString() },
  ];

  const postColumns: readonly Column<CampaignPostRow>[] = [
    { key: 'body', header: '投稿', render: (row) => row.excerpt },
    {
      key: 'status',
      header: '状態',
      width: '8rem',
      render: (row) => POST_STATUS_LABEL[row.status] ?? row.status,
    },
    {
      key: 'resultAt',
      header: '結果の日時',
      width: '12rem',
      render: (row) => formatDateTime(row.resultAt),
    },
    {
      key: 'failureReason',
      header: '失敗の理由',
      // 失敗した投稿は理由が見えないと直しようがない。
      render: (row) => row.failureReason ?? '—',
    },
  ];

  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-4)' }}>
      <div>
        <h1 style={{ fontSize: '1.25rem', margin: 0 }}>{props.name} の分析</h1>
        <p style={{ color: 'var(--tf-color-text-muted)', margin: 'var(--tf-space-2) 0 0' }}>
          {props.statusLabel} ／ {props.startsOn} 〜 {props.endsOn ?? '（未定）'}
        </p>
      </div>

      <Card>
        <p style={{ margin: 0 }}>
          集計期間：{props.from} 〜 {props.to}
        </p>
        {props.truncated && (
          <div style={{ marginTop: 'var(--tf-space-3)' }}>
            <Alert tone="info">
              期間が長いため、直近の分だけを集計しています。全期間の数値が必要な場合は
              <Link href="/analytics">アナリティクス</Link>で期間を分けて確認してください。
            </Alert>
          </div>
        )}
      </Card>

      <Card>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>対象サイトのアクセス</h2>
        {!props.canReadAnalytics ? (
          <Alert tone="info">アクセス情報を見る権限がありません。</Alert>
        ) : props.sites.length === 0 ? (
          <EmptyState message="対象のWebサイトが設定されていません。" />
        ) : (
          <>
            <p style={{ marginTop: 0 }}>
              期間合計：ページビュー {totals.pageviews.toLocaleString()} ／ 訪問者{' '}
              {totals.visitors.toLocaleString()}
            </p>
            <Table columns={siteColumns} rows={props.sites} rowKey={(row) => row.id} />
          </>
        )}
      </Card>

      <Card>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>関連するSNS投稿</h2>
        {!props.canReadSocial ? (
          <Alert tone="info">SNSの情報を見る権限がありません。</Alert>
        ) : (
          <>
            <p style={{ marginTop: 0 }}>
              {/* 0件の状態も欄を残す。消すと「無い」のか「見えない」のか分からない。 */}
              {(Object.keys(props.postCounts) as PostStatus[])
                .map((status) => `${POST_STATUS_LABEL[status]} ${props.postCounts[status]}`)
                .join(' ／ ')}
            </p>
            {props.posts.length === 0 ? (
              <EmptyState message="関連づけられたSNS投稿がありません。" />
            ) : (
              <Table columns={postColumns} rows={props.posts} rowKey={(row) => row.id} />
            )}
          </>
        )}
      </Card>

      <p style={{ color: 'var(--tf-color-text-muted)' }}>
        対象サイトと投稿の関連づけは
        <Link href={`/campaigns/${props.campaignId}/edit`}>キャンペーンの編集</Link>で行います。
      </p>
    </div>
  );
}
