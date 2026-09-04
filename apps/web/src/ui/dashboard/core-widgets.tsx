'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import {
  Badge,
  Card,
  Chart,
  EmptyState,
  Meter,
  Stat,
  Table,
  type ChartSeries,
  type Column,
  type StatDelta,
} from '@/ui/components';

/**
 * Core の Widget（06_画面設計.md §9-10、014-dashboard、028-analytics-dashboard-redesign 設計 §7.2）。
 *
 * **Client Component にしている。** 共通の Table が Client Component で、
 * 列定義の `render` は関数なので Server Component から渡せない。
 *
 * 期間は直近7日に固定する。ダッシュボードは**開いてすぐ分かる**ことが役目で、
 * 細かく見るための画面は `/analytics` にある（014 設計 §3.5）。
 * 前の 7 日との比較・直帰率・サイト別の行・実施中のキャンペーンは `028` で足した。
 *
 * **数を計算しない。** 合計・前期間比・進行は Domain の純関数（`domain/analytics/summary.ts`）が
 * 出したものを受け取り、ここでは並べるだけ。
 */

export interface DailyAccess {
  /** `YYYY-MM-DD`。 */
  readonly date: string;
  readonly pageviews: number;
  readonly visitors: number;
}

export interface SiteAccessRow {
  readonly id: string;
  readonly name: string;
  readonly pageviews: number;
  readonly visitors: number;
  /** ページビューの前期間比。 */
  readonly delta: StatDelta;
}

export interface AccessOverviewProps {
  /** 当期の始まりと終わり（`YYYY-MM-DD`）。 */
  readonly from: string;
  readonly to: string;
  readonly pageviews: { readonly value: number; readonly delta: StatDelta };
  readonly visitors: { readonly value: number; readonly delta: StatDelta };
  /** 直帰率（0〜1）。セッションが無ければ null。 */
  readonly bounceRate: { readonly value: number | null; readonly delta: StatDelta };
  /** SNS 投稿の件数。`social.read` が無ければ null（枠ごと出さない）。 */
  readonly socialPosts: { readonly total: number; readonly published: number } | null;
  /** 当期の日次。7 日ぶん（記録の無い日は 0）。当期に記録が 1 つも無ければ空配列。 */
  readonly daily: readonly DailyAccess[];
  /** サイト別の行。`site.read` が無ければ null（枠ごと出さない）。 */
  readonly sites: readonly SiteAccessRow[] | null;
}

export interface ActiveCampaignRow {
  readonly id: string;
  readonly name: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly siteNames: readonly string[];
  /** 対象サイトのうち計測タグ未設置の数。`site.read` が無ければ 0。 */
  readonly untrackedCount: number;
  /** 進行。`percent` は 0〜100、終了日未定なら null。 */
  readonly progress: { readonly percent: number | null; readonly text: string };
  /** 対象サイトの直近 7 日のページビューと前期間比。 */
  readonly pageviews: number;
  readonly delta: StatDelta;
  /** SNS 投稿の状態別の数。`social.read` が無ければ null。 */
  readonly posts: {
    readonly published: number;
    readonly scheduled: number;
    readonly failed: number;
  } | null;
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

/** 分母 0 など、比を出せないときの表示。 */
const NO_VALUE = '—';
const MIDDLE_DOT = '·';

const TONE_COLOR: Record<StatDelta['tone'], string> = {
  success: 'var(--tf-color-success)',
  danger: 'var(--tf-color-danger)',
  muted: 'var(--tf-color-text-subtle)',
};

/** 数値は `ja-JP` の桁区切り（設計 §7.1）。 */
function formatCount(value: number): string {
  return value.toLocaleString('ja-JP');
}

/** 率は小数 1 桁の `%`（設計 §7.1）。分母 0 は `—`。 */
function formatRate(value: number | null): string {
  return value === null ? NO_VALUE : `${(value * 100).toFixed(1)}%`;
}

/** `YYYY-MM-DD` → `M/D`。期間の見出しに使う。 */
function shortDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}/${Number(day)}`;
}

const MONO: CSSProperties = {
  fontFamily: 'var(--tf-font-mono)',
  fontVariantNumeric: 'tabular-nums',
};

const CAPTION: CSSProperties = {
  fontSize: 'var(--tf-text-caption)',
  color: 'var(--tf-color-text-subtle)',
};

/** 前期間比。`Stat` と同じく `data-tone` を付け、色が見えなくても意味が取れるようにする。 */
function DeltaText({ delta }: { readonly delta: StatDelta }) {
  return (
    <span data-tone={delta.tone} style={{ ...MONO, color: TONE_COLOR[delta.tone] }}>
      {delta.text}
    </span>
  );
}

/** カードの見出し行。右に補足や導線を置く。 */
function CardHeader({ title, aside }: { readonly title: string; readonly aside?: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 'var(--tf-space-4)',
        flexWrap: 'wrap',
        marginBottom: 'var(--tf-space-6)',
      }}
    >
      <h2 style={{ fontSize: 'var(--tf-text-h2)', fontWeight: 600, margin: 0 }}>{title}</h2>
      {aside !== undefined && <div style={CAPTION}>{aside}</div>}
    </div>
  );
}

const LINK_STYLE: CSSProperties = {
  color: 'var(--tf-color-primary)',
  fontWeight: 600,
  textDecoration: 'none',
};

const ROW_CELL: CSSProperties = {
  padding: 'var(--tf-space-4) var(--tf-space-3)',
  borderBottom: '1px solid var(--tf-color-border-weak)',
  textAlign: 'left',
  verticalAlign: 'middle',
};

const NUMERIC_CELL: CSSProperties = {
  ...MONO,
  textAlign: 'right',
  fontWeight: 500,
};

interface LinkedTableProps<T> {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  /** 行のクリックで移る先。 */
  readonly rowHref: (row: T) => string;
}

/**
 * 行ごとに移動先を持つ表。
 *
 * 共通の `Table` は行を押せない。ここは「行のどこを押してもその先へ移る」ことが
 * 役目なので、`<tr>` の `onClick` で移る。最初の列にはリンクを描いておき、
 * キーボードからも同じ先へ行けるようにする（リンクの上で押したときは二重に移らない）。
 */
function LinkedTable<T>({ columns, rows, rowKey, rowHref }: LinkedTableProps<T>) {
  const router = useRouter();

  const onRowClick = (event: MouseEvent<HTMLTableRowElement>, row: T) => {
    if ((event.target as HTMLElement).closest('a') !== null) {
      return;
    }
    router.push(rowHref(row));
  };

  return (
    <div className="tf-table-scroll">
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={{
                  ...ROW_CELL,
                  padding: '0 var(--tf-space-3) var(--tf-space-3)',
                  borderBottom: '1px solid var(--tf-color-border)',
                  color: 'var(--tf-color-text-subtle)',
                  fontSize: 'var(--tf-text-label)',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  ...(column.width === undefined ? {} : { width: column.width }),
                  ...(column.align === 'right' ? { textAlign: 'right' } : {}),
                }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="tf-row-link"
              onClick={(event) => onRowClick(event, row)}
              style={{ cursor: 'pointer' }}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  style={{ ...ROW_CELL, ...(column.align === 'right' ? NUMERIC_CELL : {}) }}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 直近7日の KPI（`Stat` × 4）。SNS 投稿は `social.read` があるときだけ。 */
export function AccessSummary({
  pageviews,
  visitors,
  bounceRate,
  socialPosts,
}: Pick<AccessOverviewProps, 'pageviews' | 'visitors' | 'bounceRate' | 'socialPosts'>) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
        gap: 'var(--tf-space-6)',
      }}
    >
      <Stat label="ページビュー" value={formatCount(pageviews.value)} delta={pageviews.delta} />
      <Stat label="訪問者" value={formatCount(visitors.value)} delta={visitors.delta} />
      <Stat label="直帰率" value={formatRate(bounceRate.value)} delta={bounceRate.delta} />
      {socialPosts !== null && (
        <Stat
          label="SNS投稿（全体）"
          value={formatCount(socialPosts.total)}
          note={`配信済み ${formatCount(socialPosts.published)}`}
        />
      )}
    </div>
  );
}

/**
 * アクセス推移とサイト別の行。**同じ値を表としても出す**（014 設計 §3.1、028 設計 §7.4.1）。
 */
export function AccessTrend({
  from,
  to,
  daily,
  sites,
}: Pick<AccessOverviewProps, 'from' | 'to' | 'daily' | 'sites'>) {
  const series: readonly ChartSeries[] = [
    {
      key: 'pageviews',
      label: 'ページビュー',
      tone: 'chart-1',
      points: daily.map((row) => ({ label: shortDate(row.date), value: row.pageviews })),
    },
    {
      key: 'visitors',
      label: '訪問者',
      tone: 'chart-2',
      points: daily.map((row) => ({ label: shortDate(row.date), value: row.visitors })),
    },
  ];

  const dailyColumns: readonly Column<DailyAccess>[] = [
    { key: 'date', header: '日付', render: (row) => row.date },
    {
      key: 'pageviews',
      header: 'ページビュー',
      align: 'right',
      render: (row) => formatCount(row.pageviews),
    },
    {
      key: 'visitors',
      header: '訪問者',
      align: 'right',
      render: (row) => formatCount(row.visitors),
    },
  ];

  const siteColumns: readonly Column<SiteAccessRow>[] = [
    {
      key: 'name',
      header: 'サイト',
      render: (row) => (
        <Link
          href={`/analytics?siteId=${encodeURIComponent(row.id)}&period=7d`}
          style={{ color: 'inherit', fontWeight: 500, textDecoration: 'none' }}
        >
          {row.name}
        </Link>
      ),
    },
    {
      key: 'pageviews',
      header: 'ページビュー',
      align: 'right',
      width: '8rem',
      render: (row) => formatCount(row.pageviews),
    },
    {
      key: 'visitors',
      header: '訪問者',
      align: 'right',
      width: '8rem',
      render: (row) => formatCount(row.visitors),
    },
    {
      key: 'delta',
      header: '前期間比',
      align: 'right',
      width: '7rem',
      render: (row) => <DeltaText delta={row.delta} />,
    },
  ];

  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-6)' }}>
      <div style={{ display: 'grid', gap: 'var(--tf-space-3)' }}>
        <Chart
          title="直近7日のページビューと訪問者の推移"
          series={series}
          legend
          fallback={
            daily.length === 0 ? (
              <EmptyState message="アクセスの記録がありません。計測タグを貼ると数字が出ます。" />
            ) : (
              <Table columns={dailyColumns} rows={daily} rowKey={(row) => row.date} />
            )
          }
        />
        {daily.length > 0 && (
          // X 軸は両端の日付（設計 §7.2）。途中の目盛りは置かない。
          <div
            aria-hidden="true"
            style={{ ...CAPTION, ...MONO, display: 'flex', justifyContent: 'space-between' }}
          >
            <span>{shortDate(from)}</span>
            <span>{shortDate(to)}</span>
          </div>
        )}
      </div>

      {sites !== null &&
        (sites.length === 0 ? (
          <EmptyState message="Webサイトを登録すると、ここにサイト別のアクセスが出ます。" />
        ) : (
          <LinkedTable
            columns={siteColumns}
            rows={sites}
            rowKey={(row) => row.id}
            rowHref={(row) => `/analytics?siteId=${encodeURIComponent(row.id)}&period=7d`}
          />
        ))}

      <p style={{ margin: 0 }}>
        <Link href="/analytics" style={LINK_STYLE}>
          アナリティクスで詳しく見る →
        </Link>
      </p>
    </div>
  );
}

/** 「直近7日のアクセス」のカード（設計 §7.2）。 */
export function AccessOverview(props: AccessOverviewProps) {
  return (
    <Card>
      <CardHeader
        title="直近7日のアクセス"
        aside={`${shortDate(props.from)} 〜 ${shortDate(props.to)} ${MIDDLE_DOT} 前の7日と比較`}
      />
      <div style={{ display: 'grid', gap: 'var(--tf-space-6)' }}>
        <AccessSummary
          pageviews={props.pageviews}
          visitors={props.visitors}
          bounceRate={props.bounceRate}
          socialPosts={props.socialPosts}
        />
        <AccessTrend from={props.from} to={props.to} daily={props.daily} sites={props.sites} />
      </div>
    </Card>
  );
}

function postsText(posts: NonNullable<ActiveCampaignRow['posts']>): string {
  const parts = [`配信 ${formatCount(posts.published)}`, `予約 ${formatCount(posts.scheduled)}`];
  if (posts.failed > 0) {
    parts.push(`失敗 ${formatCount(posts.failed)}`);
  }
  return parts.join(` ${MIDDLE_DOT} `);
}

/** 実施中のキャンペーン（設計 §7.2）。行クリックでそのキャンペーンの分析へ。 */
export function ActiveCampaigns({
  campaigns,
}: {
  readonly campaigns: readonly ActiveCampaignRow[];
}) {
  const columns: readonly Column<ActiveCampaignRow>[] = [
    {
      key: 'campaign',
      header: 'キャンペーン',
      render: (row) => (
        <div style={{ display: 'grid', gap: 'var(--tf-space-1)', minWidth: 0 }}>
          <Link
            href={`/campaigns/${row.id}/analytics`}
            style={{ color: 'inherit', fontWeight: 500, textDecoration: 'none' }}
          >
            {row.name}
          </Link>
          <span style={{ ...CAPTION, ...MONO, fontSize: 'var(--tf-text-label)' }}>
            {row.startsOn} 〜 {row.endsOn ?? '（未定）'}
          </span>
          <span style={CAPTION}>
            {row.siteNames.length === 0 ? '対象サイトなし' : row.siteNames.join('、')}
            {row.untrackedCount > 0 && `（未計測 ${formatCount(row.untrackedCount)}）`}
          </span>
        </div>
      ),
    },
    {
      key: 'progress',
      header: '進行',
      width: '12rem',
      render: (row) => (
        <div style={{ display: 'grid', gap: 'var(--tf-space-2)', minWidth: 0 }}>
          {/* 終了日未定は棒を満たして「進み続けている」ことを示す。 */}
          <Meter value={row.progress.percent ?? 100} max={100} label={`${row.name} の進行`} />
          <span style={{ ...CAPTION, fontSize: 'var(--tf-text-label)', whiteSpace: 'nowrap' }}>
            {row.progress.text}
          </span>
        </div>
      ),
    },
    {
      key: 'pageviews',
      header: '対象サイトPV（7日）',
      align: 'right',
      width: '9rem',
      render: (row) => (
        <div style={{ display: 'grid', gap: 'var(--tf-space-1)' }}>
          <span>{formatCount(row.pageviews)}</span>
          <span style={{ fontSize: 'var(--tf-text-caption)' }}>
            <DeltaText delta={row.delta} />
          </span>
        </div>
      ),
    },
    {
      key: 'posts',
      header: 'SNS投稿',
      width: '11rem',
      render: (row) =>
        row.posts === null ? (
          <span style={CAPTION}>{NO_VALUE}</span>
        ) : (
          <span
            style={{
              fontSize: 'var(--tf-text-caption)',
              color: row.posts.failed > 0 ? 'var(--tf-color-danger)' : 'var(--tf-color-text-muted)',
            }}
          >
            {postsText(row.posts)}
          </span>
        ),
    },
  ];

  return (
    <Card>
      <CardHeader
        title="実施中のキャンペーン"
        aside={
          <Link href="/campaigns" style={LINK_STYLE}>
            すべて →
          </Link>
        }
      />
      {campaigns.length === 0 ? (
        <EmptyState message="実施中のキャンペーンはありません。" />
      ) : (
        <LinkedTable
          columns={columns}
          rows={campaigns}
          rowKey={(row) => row.id}
          rowHref={(row) => `/campaigns/${row.id}/analytics`}
        />
      )}
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
      render: (post) => (
        <Badge tone={post.status === 'failed' ? 'danger' : 'neutral'}>
          {POST_STATUS_LABEL[post.status] ?? post.status}
        </Badge>
      ),
    },
    {
      key: 'updatedAt',
      header: '更新',
      render: (post) => <span style={{ ...MONO, ...CAPTION }}>{post.updatedAt}</span>,
    },
  ];

  return (
    <Card>
      <CardHeader title="最近の投稿" />
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
    {
      key: 'occurredAt',
      header: '日時',
      render: (row) => <span style={{ ...MONO, ...CAPTION }}>{row.occurredAt}</span>,
    },
  ];

  return (
    <Card>
      <CardHeader title="最近の活動" />
      {activities.length === 0 ? (
        <EmptyState message="記録された操作はまだありません。" />
      ) : (
        <Table columns={columns} rows={activities} rowKey={(row) => row.id} />
      )}
    </Card>
  );
}
