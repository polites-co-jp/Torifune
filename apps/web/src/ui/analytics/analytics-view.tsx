'use client';

import Link from 'next/link';
import type { AnalyticsPoint } from '@/domain/analytics/analytics';
import type { TopPath } from '@/domain/analytics/analytics';
import { Alert, Card, EmptyState, Table, type Column } from '@/ui/components';

/**
 * アナリティクス画面（06_画面設計.md §15、018-analytics 設計 §5）。
 *
 * **チャートは出さない。** 共通のチャート部品は `014-dashboard` で作る。
 * 先に個別実装すると、あとで2つの描き方が残る。
 *
 * **Client Component にしている。** 共通の Table が Client Component であり、
 * 列定義の `render` は関数なので、Server Component から渡せない。
 * （渡すと「Functions cannot be passed directly to Client Components」で落ちる。）
 */

export interface SiteOption {
  readonly id: string;
  readonly name: string;
  readonly publicKey: string;
}

interface DailyRow {
  readonly date: string;
  readonly pageviews: number;
  readonly visitors: number;
}

/** 日次の点を「日 × 指標」の表へ畳む。 */
function toDailyRows(points: readonly AnalyticsPoint[]): readonly DailyRow[] {
  const byDate = new Map<string, { pageviews: number; visitors: number }>();

  for (const point of points) {
    const current = byDate.get(point.metricDate) ?? { pageviews: 0, visitors: 0 };
    if (point.metric === 'pageviews') current.pageviews += point.value;
    if (point.metric === 'visitors') current.visitors += point.value;
    byDate.set(point.metricDate, current);
  }

  return [...byDate.entries()]
    .map(([date, value]) => ({ date, ...value }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function AnalyticsView({
  points,
  topPaths,
  sites,
  selectedSiteId,
  from,
  to,
}: {
  readonly points: readonly AnalyticsPoint[];
  readonly topPaths: readonly TopPath[];
  readonly sites: readonly SiteOption[];
  readonly selectedSiteId: string | null;
  readonly from: string;
  readonly to: string;
}) {
  const rows = toDailyRows(points);
  const selected = sites.find((site) => site.id === selectedSiteId) ?? null;

  const totals = rows.reduce(
    (acc, row) => ({
      pageviews: acc.pageviews + row.pageviews,
      visitors: acc.visitors + row.visitors,
    }),
    { pageviews: 0, visitors: 0 },
  );

  const dailyColumns: readonly Column<DailyRow>[] = [
    { key: 'date', header: '日付', render: (row) => row.date },
    { key: 'pageviews', header: 'ページビュー', render: (row) => row.pageviews.toLocaleString() },
    { key: 'visitors', header: '訪問者', render: (row) => row.visitors.toLocaleString() },
  ];

  const pathColumns: readonly Column<TopPath>[] = [
    { key: 'path', header: 'ページ', render: (row) => row.path },
    { key: 'pageviews', header: 'ページビュー', render: (row) => row.pageviews.toLocaleString() },
  ];

  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-4)' }}>
      <h1 style={{ fontSize: '1.25rem', margin: 0 }}>アナリティクス</h1>

      <Card>
        <form method="get" style={{ display: 'flex', gap: 'var(--tf-space-3)', flexWrap: 'wrap' }}>
          <label>
            サイト
            <select name="siteId" defaultValue={selectedSiteId ?? ''}>
              <option value="">すべて</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            開始
            <input type="date" name="from" defaultValue={from} />
          </label>
          <label>
            終了
            <input type="date" name="to" defaultValue={to} />
          </label>
          <button type="submit">絞り込む</button>
        </form>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <EmptyState message="この期間のデータはありません。" />
          <Alert tone="info">
            数値が出るには、計測タグをサイトへ貼り、集計を実行する必要があります。 集計は{' '}
            <code>POST /api/v1/analytics/rollup</code> で行います（cron から
            APIトークンで叩けます）。
          </Alert>
        </Card>
      ) : (
        <>
          <Card>
            <p style={{ margin: 0 }}>
              期間合計：ページビュー {totals.pageviews.toLocaleString()} / 訪問者{' '}
              {totals.visitors.toLocaleString()}
            </p>
          </Card>

          <Card>
            <h2 style={{ fontSize: '1rem', marginTop: 0 }}>日次</h2>
            <Table columns={dailyColumns} rows={rows} rowKey={(row) => row.date} />
          </Card>
        </>
      )}

      <Card>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>上位ページ</h2>
        {topPaths.length === 0 ? (
          <EmptyState message="この期間のアクセスはありません。" />
        ) : (
          <Table columns={pathColumns} rows={topPaths} rowKey={(row) => row.path} />
        )}
      </Card>

      <Card>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>計測タグ</h2>
        {selected === null ? (
          <p style={{ margin: 0, color: 'var(--tf-color-text-muted)' }}>
            サイトを選ぶと、そのサイト用の計測タグを表示します。
          </p>
        ) : (
          <>
            <p style={{ marginTop: 0 }}>
              «{selected.name}» の計測タグです。測りたいページの
              <code>&lt;head&gt;</code> に貼ってください。
            </p>
            <pre
              data-tracking-snippet
              style={{
                background: 'var(--tf-color-surface)',
                border: '1px solid var(--tf-color-border)',
                borderRadius: 'var(--tf-radius-md)',
                padding: 'var(--tf-space-3)',
                overflowX: 'auto',
              }}
            >
              {`<script src="/t.js" data-site="${selected.publicKey}"></script>`}
            </pre>
            <p style={{ color: 'var(--tf-color-text-muted)', margin: 0 }}>
              Cookie は使いません。IPアドレスとブラウザ情報は保存せず、
              日ごとに変わるハッシュだけを記録します。
            </p>
          </>
        )}
      </Card>

      <p style={{ color: 'var(--tf-color-text-muted)' }}>
        Webサイトの登録は<Link href="/sites">Webサイト</Link>から行います。
      </p>
    </div>
  );
}
