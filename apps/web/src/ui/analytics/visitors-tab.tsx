'use client';

import type { DeviceRow } from '@/domain/analytics/summary';
import { Card, Stat, type StatDelta } from '@/ui/components';
import { NO_VALUE, formatAverage, formatCount, formatRate } from './labels';
import type { CountStat, RatioStat } from './overview-tab';
import { DeviceBreakdown, HourlyPageviews, Note, SectionHeader, StatGrid, Tile } from './parts';

/**
 * 訪問者タブ（028-analytics-dashboard-redesign 設計 §7.3.6）。
 *
 * KPI 4 つ、デバイス、時間帯別、「Bot のアクセス」。
 * 「Bot のアクセス」だけは**「Bot を集計に含める」スイッチに左右されない**（§7.3.4）。
 */

export interface BotAccess {
  readonly botPageviews: number;
  readonly humanPageviews: number;
  /** `bot_pageviews / (pageviews + bot_pageviews)`。分母 0 は null。 */
  readonly share: number | null;
  /** 日次 `bot_pageviews` が最大の日（`YYYY-MM-DD`）。Bot が無ければ null。 */
  readonly peakDay: string | null;
}

export interface VisitorsData {
  readonly visitors: CountStat;
  readonly sessions: CountStat;
  /** 訪問者あたりページビュー。 */
  readonly perVisitor: RatioStat;
  /** 1 日あたり訪問者。 */
  readonly perDay: { readonly value: number; readonly delta: StatDelta };
  /** 0 時〜23 時のページビュー。 */
  readonly hours: readonly number[];
  readonly devices: readonly DeviceRow[];
  readonly bot: BotAccess;
}

const BOT_ACCESS_NOTE =
  'User-Agent から Bot と判定したアクセスの内訳です。この欄の数値は「Bot を集計に含める」スイッチに左右されません。急にアクセスが増えたときは、ここで Bot かどうかを確かめられます。';

export function VisitorsTab({
  data,
  includeBots,
}: {
  readonly data: VisitorsData;
  readonly includeBots: boolean;
}) {
  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-6)' }}>
      <StatGrid>
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
            label="訪問者あたりページビュー"
            value={data.perVisitor.value === null ? NO_VALUE : data.perVisitor.value.toFixed(2)}
            delta={data.perVisitor.delta}
          />
        </Tile>
        <Tile>
          <Stat
            label="1日あたり訪問者"
            value={formatAverage(data.perDay.value)}
            delta={data.perDay.delta}
          />
        </Tile>
      </StatGrid>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(18rem, 100%), 1fr))',
          gap: 'var(--tf-space-6)',
          alignItems: 'start',
        }}
      >
        <DeviceBreakdown
          rows={data.devices}
          botPageviews={data.bot.botPageviews}
          includeBots={includeBots}
        />
        <HourlyPageviews hours={data.hours} includeBots={includeBots} />
      </div>

      <Card>
        <SectionHeader
          title="Bot のアクセス"
          aside={
            includeBots
              ? '現在、他の指標にも Bot を含めています'
              : '現在、他の指標から Bot を除いています'
          }
        />
        <StatGrid>
          <Stat label="Bot のページビュー" value={formatCount(data.bot.botPageviews)} />
          <Stat label="人のページビュー" value={formatCount(data.bot.humanPageviews)} />
          <Stat label="Bot の割合（人 + Bot に対して）" value={formatRate(data.bot.share)} />
          <Stat label="Bot が最も多かった日" value={data.bot.peakDay ?? NO_VALUE} />
        </StatGrid>
        <Note>{BOT_ACCESS_NOTE}</Note>
      </Card>
    </div>
  );
}
