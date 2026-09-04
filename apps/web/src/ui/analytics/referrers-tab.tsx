'use client';

import { Card, EmptyState, Meter, Pagination, Table, type Column } from '@/ui/components';
import { formatCount, formatRate } from './labels';
import { BOTS_EXCLUDED_NOTE, MONO, Note, SectionHeader } from './parts';

/**
 * 参照元タブ（028-analytics-dashboard-redesign 設計 §7.3.6）。
 *
 * セッション順の表。参照元はセッションの最初のページビューの `referrer_host`。
 * 無ければ `(direct)`。Bot は含めない（スイッチに関係なく）。
 */

export interface ReferrerRow {
  readonly host: string;
  readonly sessions: number;
  readonly visitors: number;
  /** `referrer_bounces / referrer`。分母 0 は null。 */
  readonly bounceRate: number | null;
  /** `referrer / sessions`（Bot 抜きの sessions）。分母 0 は null。 */
  readonly share: number | null;
}

export interface ReferrersData {
  readonly rows: readonly ReferrerRow[];
  /** 参照元の種類数（全ページ分）。 */
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
}

export function ReferrersTab({
  data,
  includeBots,
  onPageChange,
}: {
  readonly data: ReferrersData;
  readonly includeBots: boolean;
  readonly onPageChange: (page: number) => void;
}) {
  const columns: readonly Column<ReferrerRow>[] = [
    {
      key: 'host',
      header: '参照元',
      render: (row) => <span style={{ overflowWrap: 'anywhere' }}>{row.host}</span>,
    },
    {
      key: 'sessions',
      header: 'セッション',
      align: 'right',
      width: '7rem',
      render: (row) => formatCount(row.sessions),
    },
    {
      key: 'visitors',
      header: '訪問者',
      align: 'right',
      width: '6rem',
      render: (row) => formatCount(row.visitors),
    },
    {
      key: 'bounceRate',
      header: '直帰率',
      align: 'right',
      width: '6rem',
      render: (row) => formatRate(row.bounceRate),
    },
    {
      key: 'share',
      header: '割合',
      width: '12rem',
      render: (row) => (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: 'var(--tf-space-3)',
            alignItems: 'center',
          }}
        >
          <Meter value={row.share ?? 0} max={1} label={`${row.host} の割合`} />
          <span style={{ ...MONO, fontSize: 'var(--tf-text-caption)', fontWeight: 500 }}>
            {formatRate(row.share)}
          </span>
        </div>
      ),
    },
  ];

  return (
    <Card>
      <SectionHeader title="参照元" aside="セッションの最初のページビューの参照元ホスト" />
      {data.rows.length === 0 ? (
        <EmptyState message="この期間のセッションはありません。" />
      ) : (
        <>
          <Table columns={columns} rows={data.rows} rowKey={(row) => row.host} />
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
        参照元はホスト名だけを保存しています。ページの経路までは記録しません。
        {includeBots && ` ${BOTS_EXCLUDED_NOTE}`}
      </Note>
    </Card>
  );
}
