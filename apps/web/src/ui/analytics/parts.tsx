'use client';

import type { CSSProperties, ReactNode } from 'react';
import type { DeviceRow } from '@/domain/analytics/summary';
import { BarChart, Card, EmptyState, Meter, Table, type Column } from '@/ui/components';
import { DEVICE_LABEL, MIDDLE_DOT, formatCount, formatRate } from './labels';

/**
 * アナリティクス画面のタブが共有する小さな部品（028-analytics-dashboard-redesign 設計 §7.3.6）。
 *
 * 時間帯別とデバイスは概要タブと訪問者タブの両方に出る。片方ずつ書くと、
 * 注記の文言や強調のしかたが二つに分かれる。
 */

export const CAPTION: CSSProperties = {
  fontSize: 'var(--tf-text-caption)',
  color: 'var(--tf-color-text-subtle)',
};

export const MONO: CSSProperties = {
  fontFamily: 'var(--tf-font-mono)',
  fontVariantNumeric: 'tabular-nums',
};

/** KPI タイルを横に並べる枠。狭い画面では折り返す。 */
export function StatGrid({ children }: { readonly children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(10rem, 100%), 1fr))',
        gap: 'var(--tf-space-4)',
      }}
    >
      {children}
    </div>
  );
}

/** KPI タイル 1 枚の枠。中身は `Stat`。 */
export function Tile({ children }: { readonly children: ReactNode }) {
  return (
    <div
      style={{
        minWidth: 0,
        border: '1px solid var(--tf-color-border)',
        borderRadius: 'var(--tf-radius-2xl)',
        padding: 'var(--tf-space-6)',
      }}
    >
      {children}
    </div>
  );
}

/** カードの見出し行。右に補足や導線を置く。 */
export function SectionHeader({
  title,
  aside,
}: {
  readonly title: string;
  readonly aside?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 'var(--tf-space-4)',
        flexWrap: 'wrap',
        marginBottom: 'var(--tf-space-5)',
      }}
    >
      <h2 style={{ fontSize: 'var(--tf-text-h2)', fontWeight: 600, margin: 0 }}>{title}</h2>
      {aside !== undefined && <div style={CAPTION}>{aside}</div>}
    </div>
  );
}

/** 注記。カードの末尾に置く。 */
export function Note({ children }: { readonly children: ReactNode }) {
  return <p style={{ ...CAPTION, margin: 'var(--tf-space-4) 0 0', lineHeight: 1.5 }}>{children}</p>;
}

export interface RankedItem {
  readonly key: string;
  readonly value: number;
}

/**
 * 上位ページ・参照元の一覧。名前と横棒と値を 1 行に並べる。
 *
 * 横棒は先頭（最大）を満たした長さにする。全体に対する割合ではないので、
 * 5 件しか出さない概要でも棒の差が読める。
 */
export function RankedList({
  items,
  meterLabel,
  emptyMessage,
}: {
  readonly items: readonly RankedItem[];
  /** 何の割合かを読み上げへ伝える。項目名が続く。 */
  readonly meterLabel: string;
  readonly emptyMessage: string;
}) {
  if (items.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }
  const max = Math.max(...items.map((item) => item.value));

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map((item) => (
        <li
          key={item.key}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: 'var(--tf-space-4)',
            alignItems: 'center',
            padding: 'var(--tf-space-3) 0',
            borderBottom: '1px solid var(--tf-color-border-weak)',
          }}
        >
          <div style={{ display: 'grid', gap: 'var(--tf-space-2)', minWidth: 0 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.key}
            </span>
            <Meter value={item.value} max={max} label={`${meterLabel} ${item.key}`} />
          </div>
          <span style={{ ...MONO, fontWeight: 500 }}>{formatCount(item.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * デバイス別（設計 §7.3.4）。
 *
 * 3 行は常に出し、「Bot を含める」なら Bot 行が足される（行の中身は Domain が決める）。
 * 注記で「Bot と判定したアクセス n 件」をどう扱っているかを示す。
 */
export function DeviceBreakdown({
  rows,
  botPageviews,
  includeBots,
}: {
  readonly rows: readonly DeviceRow[];
  readonly botPageviews: number;
  readonly includeBots: boolean;
}) {
  const max = Math.max(0, ...rows.map((row) => row.value));

  return (
    <Card>
      <SectionHeader title="デバイス" />
      <div style={{ display: 'grid', gap: 'var(--tf-space-4)' }}>
        {rows.map((row) => (
          <div key={row.key} style={{ display: 'grid', gap: 'var(--tf-space-2)' }}>
            <div
              style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--tf-space-4)' }}
            >
              <span>{DEVICE_LABEL[row.key]}</span>
              <span style={{ ...MONO, fontWeight: 500 }}>
                {formatRate(row.share)}
                <span style={{ color: 'var(--tf-color-text-subtle)' }}>
                  {` ${MIDDLE_DOT} ${formatCount(row.value)}`}
                </span>
              </span>
            </div>
            <Meter value={row.value} max={max} label={`${DEVICE_LABEL[row.key]}の割合`} />
          </div>
        ))}
      </div>
      <Note>
        Bot と判定したアクセス {formatCount(botPageviews)} 件
        {includeBots ? 'を集計に含めています。' : 'は集計に含めていません。'}
      </Note>
    </Card>
  );
}

interface HourRow {
  readonly hour: number;
  readonly pageviews: number;
}

/** 24 本のうち、横軸に出す時刻。等間隔に 4 つ。 */
const HOUR_AXIS_LABELS = ['0時', '6時', '12時', '18時'];

/**
 * 時間帯別のページビュー（設計 §7.3.6）。Bot は含めない（スイッチに関係なく）。
 *
 * `hours` は 0 時〜23 時の 24 個。
 */
export function HourlyPageviews({
  hours,
  includeBots,
}: {
  readonly hours: readonly number[];
  /** スイッチがオンのときだけ「Bot は含めていません」を添える（設計 §7.3.4）。 */
  readonly includeBots: boolean;
}) {
  const rows: readonly HourRow[] = hours.map((pageviews, hour) => ({ hour, pageviews }));
  const max = Math.max(0, ...hours);
  // 同数なら早い時間帯。`indexOf` は最初に見つかったものを返す。
  const peak = max === 0 ? null : hours.indexOf(max);

  const columns: readonly Column<HourRow>[] = [
    { key: 'hour', header: '時間帯', render: (row) => `${row.hour}時台` },
    {
      key: 'pageviews',
      header: 'ページビュー',
      align: 'right',
      render: (row) => formatCount(row.pageviews),
    },
  ];

  return (
    <Card>
      <SectionHeader title="時間帯別のページビュー" />
      <BarChart
        title="時間帯別のページビュー"
        bars={rows.map((row) => ({ label: `${row.hour}時台`, value: row.pageviews }))}
        highlightMax
        axisLabels={HOUR_AXIS_LABELS}
        fallback={
          max === 0 ? (
            <EmptyState message="この期間のページビューはありません。" />
          ) : (
            <details style={{ marginTop: 'var(--tf-space-3)' }}>
              <summary style={CAPTION}>時間帯ごとの値を表で見る</summary>
              <Table columns={columns} rows={rows} rowKey={(row) => String(row.hour)} />
            </details>
          )
        }
      />
      {(peak !== null || includeBots) && (
        <Note>
          {peak !== null && `最も多い時間帯は ${peak} 時台。`}
          {includeBots && ` ${BOTS_EXCLUDED_NOTE}`}
        </Note>
      )}
    </Card>
  );
}

/** Bot を含めない区画に、スイッチがオンのとき添える注記（設計 §7.3.4）。 */
export const BOTS_EXCLUDED_NOTE = 'Bot は含めていません。';
