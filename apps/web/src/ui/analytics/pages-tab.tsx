'use client';

import { Card, EmptyState, Pagination, Table, type Column } from '@/ui/components';
import { MIDDLE_DOT, formatCount, formatDuration, formatRate } from './labels';
import { BOTS_EXCLUDED_NOTE, Note, SectionHeader } from './parts';

/**
 * ページタブ（028-analytics-dashboard-redesign 設計 §7.3.6）。
 *
 * ページビュー順の表。50 件ごとに送る。Bot は含めない（スイッチに関係なく）。
 */

export interface PageRow {
  readonly path: string;
  readonly pageviews: number;
  readonly visitors: number;
  readonly landing: number;
  /** `path_bounces / landing`。分母 0 は null。 */
  readonly bounceRate: number | null;
  /** `path_dwell_ms / path_dwell_samples`（ms）。分母 0 は null。 */
  readonly dwellAvg: number | null;
}

export interface PagesData {
  readonly rows: readonly PageRow[];
  /** ページの種類数（全ページ分）。 */
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
}

export function PagesTab({
  data,
  includeBots,
  onPageChange,
}: {
  readonly data: PagesData;
  readonly includeBots: boolean;
  readonly onPageChange: (page: number) => void;
}) {
  const columns: readonly Column<PageRow>[] = [
    {
      key: 'path',
      header: 'ページ',
      render: (row) => <span style={{ overflowWrap: 'anywhere' }}>{row.path}</span>,
    },
    {
      key: 'pageviews',
      header: 'ページビュー',
      align: 'right',
      width: '7rem',
      render: (row) => formatCount(row.pageviews),
    },
    {
      key: 'visitors',
      header: '訪問者',
      align: 'right',
      width: '6rem',
      render: (row) => formatCount(row.visitors),
    },
    {
      key: 'landing',
      header: 'ランディング',
      align: 'right',
      width: '7rem',
      render: (row) => formatCount(row.landing),
    },
    {
      key: 'bounceRate',
      header: '直帰率',
      align: 'right',
      width: '6rem',
      render: (row) => formatRate(row.bounceRate),
    },
    {
      key: 'dwellAvg',
      header: '平均滞在',
      align: 'right',
      width: '6rem',
      render: (row) => formatDuration(row.dwellAvg),
    },
  ];

  return (
    <Card>
      <SectionHeader
        title="ページ"
        aside={`${formatCount(data.total)} ページ ${MIDDLE_DOT} ページビュー順`}
      />
      {data.rows.length === 0 ? (
        <EmptyState message="この期間のページビューはありません。" />
      ) : (
        <>
          <Table columns={columns} rows={data.rows} rowKey={(row) => row.path} />
          {data.total > data.perPage && (
            <Pagination
              page={data.page}
              perPage={data.perPage}
              total={data.total}
              onChange={onPageChange}
            />
          )}
        </>
      )}
      <Note>
        平均滞在は、同じ訪問者の連続したページビューの間隔から求めています。セッション最後のページは測れないため、実際より短めに出ます。
        {includeBots && ` ${BOTS_EXCLUDED_NOTE}`}
      </Note>
    </Card>
  );
}
