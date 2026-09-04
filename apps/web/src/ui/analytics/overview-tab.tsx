'use client';

import Link from 'next/link';
import { botsOnlyInPeriod } from '@/domain/analytics/reception';
import type { DeviceRow } from '@/domain/analytics/summary';
import {
  Alert,
  Card,
  Chart,
  EmptyState,
  Stat,
  Table,
  type ChartSeries,
  type Column,
  type StatDelta,
} from '@/ui/components';
import { formatCount, formatDuration, formatRate, rangeText, shortDate } from './labels';
import {
  BOTS_EXCLUDED_NOTE,
  DeviceBreakdown,
  HourlyPageviews,
  Note,
  RankedList,
  SectionHeader,
  StatGrid,
  Tile,
  type RankedItem,
} from './parts';

/**
 * 概要タブ（028-analytics-dashboard-redesign 設計 §7.3.6）。
 *
 * **数を計算しない。** 合計・前期間比は Domain の純関数（`domain/analytics/summary.ts`）が
 * 出したものを `app/analytics/page.tsx` が組み立て、ここでは並べるだけ。
 */

export interface CountStat {
  readonly value: number;
  readonly delta: StatDelta;
}

/** 率や平均。分母 0 は null。 */
export interface RatioStat {
  readonly value: number | null;
  readonly delta: StatDelta;
}

export interface DailyRow {
  /** `YYYY-MM-DD`。 */
  readonly date: string;
  readonly pageviews: number;
  readonly visitors: number;
}

export interface OverviewData {
  readonly pageviews: CountStat;
  readonly visitors: CountStat;
  readonly sessions: CountStat;
  readonly bounceRate: RatioStat;
  /** 平均滞在（ms）。 */
  readonly dwellAvg: RatioStat;
  /** 期間の日次。記録の無い日は 0。期間に記録が 1 つも無ければ空配列。 */
  readonly daily: readonly DailyRow[];
  readonly topPages: readonly RankedItem[];
  readonly topReferrers: readonly RankedItem[];
  /** 0 時〜23 時のページビュー。 */
  readonly hours: readonly number[];
  readonly devices: readonly DeviceRow[];
  readonly botPageviews: number;
}

const LINK_STYLE = {
  color: 'var(--tf-color-primary)',
  fontWeight: 600,
  textDecoration: 'none',
} as const;

export function OverviewTab({
  data,
  from,
  to,
  includeBots,
  pagesHref,
  referrersHref,
}: {
  readonly data: OverviewData;
  readonly from: string;
  readonly to: string;
  readonly includeBots: boolean;
  /** 「すべて →」の行き先（ページタブ / 参照元タブ）。 */
  readonly pagesHref: string;
  readonly referrersHref: string;
}) {
  const series: readonly ChartSeries[] = [
    {
      key: 'pageviews',
      label: 'ページビュー',
      tone: 'chart-1',
      points: data.daily.map((row) => ({ label: shortDate(row.date), value: row.pageviews })),
    },
    {
      key: 'visitors',
      label: '訪問者',
      tone: 'chart-2',
      points: data.daily.map((row) => ({ label: shortDate(row.date), value: row.visitors })),
    },
  ];

  const dailyColumns: readonly Column<DailyRow>[] = [
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

  // 集計済みで「人の PV が 0、Bot の PV が 1 以上」の期間（029 設計 §7.1.4）。
  // `?bots=1` のときは合算して見えているので出さない。**件数は集計値から出す。生ログは読まない。**
  const botsOnly =
    !includeBots &&
    botsOnlyInPeriod({ pageviews: data.pageviews.value, botPageviews: data.botPageviews });

  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-6)' }}>
      {botsOnly && (
        // `Alert` の role は tone で決まる（warning は status）。
        // これは「数字が 0 なのは Bot だけだったから」という診断で、気づかせる必要があるので
        // alert として読ませる。**共通部品は変えない**（他の画面の読み上げ方まで変わる）。
        <div role="alert">
          <Alert tone="warning">
            この期間のアクセス {formatCount(data.botPageviews)} 件はすべて Bot
            と判定され、集計に含めていません。「Bot を集計に含める」で件数を見られます。
          </Alert>
        </div>
      )}
      <StatGrid>
        <Tile>
          <Stat
            label="ページビュー"
            value={formatCount(data.pageviews.value)}
            delta={data.pageviews.delta}
          />
        </Tile>
        <Tile>
          <Stat
            label="訪問者"
            value={formatCount(data.visitors.value)}
            delta={data.visitors.delta}
          />
        </Tile>
        <Tile>
          <Stat
            label="セッション"
            value={formatCount(data.sessions.value)}
            delta={data.sessions.delta}
          />
        </Tile>
        <Tile>
          <Stat
            label="直帰率"
            value={formatRate(data.bounceRate.value)}
            delta={data.bounceRate.delta}
          />
        </Tile>
        <Tile>
          <Stat
            label="平均滞在時間"
            value={formatDuration(data.dwellAvg.value)}
            delta={data.dwellAvg.delta}
          />
        </Tile>
      </StatGrid>

      <Card>
        <SectionHeader title="日次の推移" aside={rangeText(from, to)} />
        <Chart
          title="ページビューと訪問者の日次推移"
          series={series}
          height="lg"
          legend
          yAxis
          xTicks
          fallback={
            data.daily.length === 0 ? (
              <EmptyState message="この期間のアクセスの記録はありません。" />
            ) : (
              <details style={{ marginTop: 'var(--tf-space-3)' }}>
                <summary
                  style={{
                    fontSize: 'var(--tf-text-caption)',
                    color: 'var(--tf-color-text-subtle)',
                  }}
                >
                  日ごとの値を表で見る
                </summary>
                <Table columns={dailyColumns} rows={data.daily} rowKey={(row) => row.date} />
              </details>
            )
          }
        />
      </Card>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(18rem, 100%), 1fr))',
          gap: 'var(--tf-space-6)',
          alignItems: 'start',
        }}
      >
        <Card>
          <SectionHeader
            title="上位ページ"
            aside={
              <Link href={pagesHref} style={LINK_STYLE}>
                すべて →
              </Link>
            }
          />
          <RankedList
            items={data.topPages}
            meterLabel="ページビューの割合"
            emptyMessage="この期間のページビューはありません。"
          />
          {includeBots && <Note>{BOTS_EXCLUDED_NOTE}</Note>}
        </Card>

        <Card>
          <SectionHeader
            title="参照元"
            aside={
              <Link href={referrersHref} style={LINK_STYLE}>
                すべて →
              </Link>
            }
          />
          <RankedList
            items={data.topReferrers}
            meterLabel="セッションの割合"
            emptyMessage="この期間のセッションはありません。"
          />
          <Note>
            セッションの最初のページビューの参照元ホスト別のセッション数。
            {includeBots && ` ${BOTS_EXCLUDED_NOTE}`}
          </Note>
        </Card>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(18rem, 100%), 1fr))',
          gap: 'var(--tf-space-6)',
          alignItems: 'start',
        }}
      >
        <HourlyPageviews hours={data.hours} includeBots={includeBots} />
        <DeviceBreakdown
          rows={data.devices}
          botPageviews={data.botPageviews}
          includeBots={includeBots}
        />
      </div>
    </div>
  );
}
