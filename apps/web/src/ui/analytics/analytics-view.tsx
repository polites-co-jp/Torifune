'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  DateField,
  EmptyState,
  SegmentedControl,
  Select,
  Switch,
  Tabs,
  type TabItem,
} from '@/ui/components';
import { analyticsHref, type AnalyticsQuery } from './analytics-query';
import {
  ANALYTICS_PERIODS,
  ANALYTICS_TABS,
  EMPTY_PERIOD_TEXT,
  isAnalyticsTab,
  NO_VALUE,
  PERIOD_LABEL,
  TAB_LABEL,
  TODAY_CORE_ONLY_NOTE,
  TODAY_PERIOD,
  TODAY_PROVISIONAL_TEXT,
  TODAY_UNAVAILABLE_TEXT,
  VIEW_TODAY_LABEL,
  analyticsHeaderText,
  customIncludesTodayText,
  noAccessTodayText,
  previousDayTotalsText,
  staleRangeNoticeText,
  todayRollupIntervalText,
} from './labels';
import { NotTracked, type NotTrackedData } from './not-tracked';
import { OverviewTab, type OverviewData } from './overview-tab';
import { PagesTab, type PagesData } from './pages-tab';
import { CAPTION } from './parts';
import { ReferrersTab, type ReferrersData } from './referrers-tab';
import { SettingsTab, type SettingsData } from './settings-tab';
import { VisitorsTab, type VisitorsData } from './visitors-tab';

/**
 * アナリティクス画面の骨格（028-analytics-dashboard-redesign 設計 §7.3.2、
 * 030-analytics-today 設計 §7）。
 *
 * 1 サイトずつ・期間プリセットと前期間比較つき・5 タブ。
 * **状態はすべて URL パラメータで持つ。** 期間・サイト・Bot・タブの変更は
 * `router.push` で URL を書き換えるだけで、ここでは何も覚えない。
 *
 * **Client Component にしている。** 共通の Table が Client Component であり、
 * 列定義の `render` は関数なので、Server Component から渡せない。
 * 数の計算は `app/analytics/page.tsx` と Domain の純関数が済ませ、ここでは並べるだけ。
 */

export interface SiteOption {
  readonly id: string;
  readonly name: string;
  readonly url: string | null;
  /** 最終受信があるか。無ければ選択肢に「（未設置）」を添える。 */
  readonly tracked: boolean;
}

/** 表示するタブの中身。表示しないタブのデータは取らない（設計 §7.3.3）。 */
export type TabData =
  | { readonly kind: 'overview'; readonly data: OverviewData }
  | { readonly kind: 'pages'; readonly data: PagesData }
  | { readonly kind: 'referrers'; readonly data: ReferrersData }
  | { readonly kind: 'visitors'; readonly data: VisitorsData }
  | { readonly kind: 'settings'; readonly data: SettingsData }
  /**
   * 数字が出ない状態（028 §7.3.7、029 §7.1.3）。タブの中身の代わりに導線を出す。
   *
   * 「未受信」だけでなく「集計待ち」「Bot のみ受信」も含む。
   */
  | { readonly kind: 'not-tracked'; readonly data: NotTrackedData }
  /**
   * 確定値のある期間が存在しない（030 §7.2）。
   *
   * 今日が月の 1 日の `month` だけ。**集計を一切行わない**ので、タブの中身が無い。
   */
  | { readonly kind: 'empty-period' };

/** 当日のバナー（030 §7.4.2）。`period === 'today'` のときだけ渡す。 */
export interface TodayBannerData {
  /** 集計した瞬間（`YYYY-MM-DD HH:mm`）。**サーバーの時計**であってブラウザの時計ではない。 */
  readonly generatedAt: string;
  /** ロールアップの間隔（分）。 */
  readonly intervalMinutes: number;
  /** 前日の確定値（前期間比の代わりに並記する。§13-1）。 */
  readonly previousDay: {
    readonly date: string;
    readonly pageviews: number;
    readonly visitors: number;
  };
  /** 今日の生ログが 1 件も無い。 */
  readonly noAccessYet: boolean;
  /** 最終受信（`YYYY-MM-DD HH:mm`）。 */
  readonly lastReceivedAt: string | null;
  /** 当日の集計を時間内に終えられなかった（§11.2）。 */
  readonly unavailable: boolean;
}

/** §7.5.1 の案内に要る値。 */
export interface StaleRangeData {
  /** 当期（`YYYY-MM-DD`）。 */
  readonly from: string;
  readonly to: string;
  /** 「当日」（`?period=today`）への導線。 */
  readonly todayHref: string;
}

export interface AnalyticsViewProps {
  readonly query: AnalyticsQuery;
  readonly sites: readonly SiteOption[];
  /** 前期間（`YYYY-MM-DD`）。当日と、確定値のある期間が無いときは null。 */
  readonly previousFrom: string | null;
  readonly previousTo: string | null;
  /** 1 日の境目に使っているタイムゾーン。 */
  readonly timeZone: string;
  /** 最終受信（`YYYY-MM-DD HH:mm`）。無ければ null。 */
  readonly lastSeenAt: string | null;
  /** 最終集計（`YYYY-MM-DD HH:mm`）。今日を含むカスタム期間の注記に出す。 */
  readonly lastRollupAt: string | null;
  /** 当期が今日を含むか。今日を含む `custom` では「集計は前日まで」を出さない（§7.4.1）。 */
  readonly rangeIncludesToday: boolean;
  /** `custom` の期間が不正で 30 日に戻したとき true。 */
  readonly rangeWarning: boolean;
  /** 設定タブを出せるか（`site.read`）。 */
  readonly canReadSites: boolean;
  /** 当日のバナー。`period !== 'today'` なら null。 */
  readonly today: TodayBannerData | null;
  /** §7.5.1 の案内。出さないなら null。 */
  readonly staleRange: StaleRangeData | null;
  readonly tab: TabData;
}

const LINK_STYLE = {
  color: 'var(--tf-color-primary)',
  fontWeight: 600,
} as const;

/**
 * 確定期間が空で、本日に受信がある状態の案内（030-analytics-today 設計 §7.5.1）。
 *
 * 定期ロールアップが走った直後は未集計が 0 件になり `diagnoseReception` は `receiving` を返す。
 * 導線（`not-tracked.tsx`）は出ず、当期（末尾が昨日）には 1 行も無いので
 * **0 が並ぶだけの概要タブ**が出る。計測タグを貼った初日の利用者はちょうどここを踏む。
 *
 * **「集計待ち」と誤って説明しない。** 次の集計が走っても、今日の分は
 * 末尾が昨日の期間には入らない。
 *
 * 出す条件は `shouldShowStaleRangeNotice`（`analytics-query.ts` の純関数）が持つ。
 * ここは描くだけ。**`AnalyticsView` に 1 つだけ置く**（タブごとに書かない）。
 */
export function StaleRangeNotice({
  from,
  to,
  todayHref,
}: {
  readonly from: string;
  readonly to: string;
  readonly todayHref: string;
}) {
  return (
    <Alert tone="info">
      <div style={{ display: 'grid', gap: 'var(--tf-space-3)', justifyItems: 'start' }}>
        <span>{staleRangeNoticeText(from, to)}</span>
        <Link href={todayHref}>
          <Button variant="primary">{VIEW_TODAY_LABEL}</Button>
        </Link>
      </div>
    </Alert>
  );
}

/**
 * 確定値のある期間が存在しないときの空状態（030-analytics-today 設計 §7.2）。
 *
 * `to` を昨日にすると、今日が月の 1 日のとき `month` は `from > to` になる。
 * `presetRange` はそこで `null` を返し、画面は**集計を一切行わず**この空状態を出す。
 *
 * * **前月へ倒さない。**「今月」というラベルで前月を見せるのは嘘になる（導線だけを置く）
 * * **`to = from`（今日 1 日）に丸めない。** その日は未確定で、確定値の期間としては空
 *
 * `StaleRangeNotice` と同じく named export する。空状態が出るのは月の 1 日だけで、
 * 画面全体を組み上げるテストでは実行日が 1 日のときしか通らない。
 * 部品として単独で描画できれば、実行日に依らず決定的に確かめられる。
 */
export function EmptyPeriodNotice({
  todayHref,
  previousMonthHref,
}: {
  /** `?period=today`。 */
  readonly todayHref: string;
  /** `?period=prev-month`。 */
  readonly previousMonthHref: string;
}) {
  return (
    <EmptyState
      message={EMPTY_PERIOD_TEXT}
      action={
        <div
          style={{
            display: 'flex',
            gap: 'var(--tf-space-4)',
            alignItems: 'center',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Link href={todayHref}>
            <Button variant="primary">{VIEW_TODAY_LABEL}</Button>
          </Link>
          <Link href={previousMonthHref} style={LINK_STYLE}>
            前月を見る
          </Link>
        </div>
      }
    />
  );
}

export function AnalyticsView({
  query,
  sites,
  previousFrom,
  previousTo,
  timeZone,
  lastSeenAt,
  lastRollupAt,
  rangeIncludesToday,
  rangeWarning,
  canReadSites,
  today,
  staleRange,
  tab,
}: AnalyticsViewProps) {
  const router = useRouter();
  const go = (next: Partial<AnalyticsQuery>): void => {
    router.push(analyticsHref({ ...query, ...next }));
  };

  const selected = sites.find((site) => site.id === query.siteId) ?? null;
  // 一覧に無い ID（`site.read` が無い、または一覧に載らない）は ID だけの選択肢にする。
  const options: readonly SiteOption[] =
    selected === null
      ? [{ id: query.siteId, name: query.siteId, url: null, tracked: true }, ...sites]
      : sites;

  const todayHref = analyticsHref({ ...query, period: TODAY_PERIOD, page: 1 });

  const presetItems = ANALYTICS_PERIODS.map((period) => ({
    key: period,
    label: PERIOD_LABEL[period],
    // カスタムは今の期間を引き継ぐ。押した瞬間に期間が変わらないように。
    href: analyticsHref({ ...query, period, page: 1 }),
  }));

  const tabItems: readonly TabItem[] = ANALYTICS_TABS.map((key) => ({
    key,
    label: TAB_LABEL[key],
    visible: key !== 'settings' || canReadSites,
  }));

  // 今日を含むカスタム期間は集計値（最大 15 分遅れ）。当日（生ログ）とは値が違いうる（§7.4.3）。
  const showCustomIncludesToday = query.period === 'custom' && rangeIncludesToday;

  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-6)' }}>
      <div style={{ display: 'grid', gap: 'var(--tf-space-2)' }}>
        <h1 style={{ margin: 0 }}>アナリティクス</h1>
        {/*
          **どの時間帯で 1 日を区切っているかを見せる。** 見えないと、
          「昨日のはずの数字が今日に入っている」ときに確かめようがない。
          期間ごとに出し分ける（030 §7.4.1）。
        */}
        <p
          style={{ margin: 0, color: 'var(--tf-color-text-muted)' }}
          data-analytics-timezone={timeZone}
        >
          {analyticsHeaderText({
            period: query.period,
            previousFrom,
            previousTo,
            generatedAt: today?.generatedAt ?? null,
            rangeIncludesToday,
            timeZone,
          })}
        </p>
      </div>

      {rangeWarning && (
        <Alert tone="danger">
          期間を確認してください。日付の形式が不正か、終了日が開始日より前か、400
          日を超えています。直近 30 日で表示しています。
        </Alert>
      )}

      <div
        style={{
          display: 'flex',
          gap: 'var(--tf-space-4)',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        {/*
          「当日」は**期間セグメントとは別のグループ**（裁定 3.2）。
          項目 1 つの `SegmentedControl` をもう 1 つ置くだけで、共通部品は変えない（§7.1.3）。
          `period === 'today'` のとき、右の 6 項目はどれも選択状態にならない。
        */}
        <SegmentedControl
          items={[{ key: TODAY_PERIOD, label: PERIOD_LABEL[TODAY_PERIOD], href: todayHref }]}
          current={query.period}
          label="当日"
        />
        <SegmentedControl items={presetItems} current={query.period} label="期間" />
        <div
          style={{
            display: 'flex',
            gap: 'var(--tf-space-2)',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          {/*
            非制御にして、URL が変わったら `key` で作り直す。制御にすると、
            日付を途中まで打った時点で React が元の値へ戻してしまう。
            **当日でも無効化しない**（§7.1.4）。触ったら現行どおり `period=custom` へ抜ける。
          */}
          <DateField
            key={`from-${query.from}`}
            aria-label="開始日"
            defaultValue={query.from}
            style={{ width: 'auto' }}
            onChange={(event) => {
              // 触ったら custom。もう片方は今の値を引き継ぐ。
              if (event.currentTarget.value !== '') {
                go({ period: 'custom', from: event.currentTarget.value, page: 1 });
              }
            }}
          />
          <span style={{ color: 'var(--tf-color-text-subtle)' }}>–</span>
          <DateField
            key={`to-${query.to}`}
            aria-label="終了日"
            defaultValue={query.to}
            style={{ width: 'auto' }}
            onChange={(event) => {
              if (event.currentTarget.value !== '') {
                go({ period: 'custom', to: event.currentTarget.value, page: 1 });
              }
            }}
          />
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 'var(--tf-space-4)',
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--tf-space-4)',
            flexWrap: 'wrap',
            minWidth: 0,
          }}
        >
          <label
            htmlFor="analytics-site"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--tf-space-3)',
              maxWidth: '100%',
              color: 'var(--tf-color-text-muted)',
            }}
          >
            サイト
            <Select
              id="analytics-site"
              aria-label="サイト"
              value={query.siteId}
              onChange={(event) => go({ siteId: event.currentTarget.value, page: 1 })}
              style={{ width: 'auto', maxWidth: '100%', fontWeight: 600 }}
            >
              {options.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.tracked ? site.name : `${site.name}（未設置）`}
                </option>
              ))}
            </Select>
          </label>
          {selected?.url !== null && selected?.url !== undefined && (
            <a
              href={selected.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--tf-color-text-muted)', overflowWrap: 'anywhere' }}
            >
              {selected.url}
            </a>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--tf-space-5)',
            flexWrap: 'wrap',
          }}
        >
          <Switch
            checked={query.includeBots}
            onChange={(checked) => go({ includeBots: checked })}
            label="Bot を集計に含める"
          />
          <span style={CAPTION}>最終受信 {lastSeenAt ?? NO_VALUE}</span>
        </div>
      </div>

      <Tabs
        items={tabItems}
        current={query.tab}
        hrefFor={(key) =>
          analyticsHref({ ...query, tab: isAnalyticsTab(key) ? key : 'overview', page: 1 })
        }
        label="アナリティクスのタブ"
      />

      {/* 当日のバナー（§7.4.2）。**タブごとに書かない。** ここに 1 つだけ置く。 */}
      {today !== null && (
        <Alert tone={today.unavailable ? 'warning' : 'info'}>
          <div style={{ display: 'grid', gap: 'var(--tf-space-2)' }}>
            {today.unavailable ? (
              <span>{TODAY_UNAVAILABLE_TEXT}</span>
            ) : (
              <span>
                {TODAY_PROVISIONAL_TEXT}
                {todayRollupIntervalText(today.intervalMinutes)}
              </span>
            )}
            <span>
              {previousDayTotalsText(
                today.previousDay.date,
                today.previousDay.pageviews,
                today.previousDay.visitors,
              )}
            </span>
            {today.noAccessYet && <span>{noAccessTodayText(today.lastReceivedAt)}</span>}
            <span>{TODAY_CORE_ONLY_NOTE}</span>
          </div>
        </Alert>
      )}

      {showCustomIncludesToday && (
        <Alert tone="info">
          <div style={{ display: 'grid', gap: 'var(--tf-space-3)', justifyItems: 'start' }}>
            <span>{customIncludesTodayText(lastRollupAt)}</span>
            <Link href={todayHref} style={LINK_STYLE}>
              {VIEW_TODAY_LABEL}
            </Link>
          </div>
        </Alert>
      )}

      {staleRange !== null && (
        <StaleRangeNotice
          from={staleRange.from}
          to={staleRange.to}
          todayHref={staleRange.todayHref}
        />
      )}

      {tab.kind === 'empty-period' && (
        <EmptyPeriodNotice
          todayHref={todayHref}
          previousMonthHref={analyticsHref({ ...query, period: 'prev-month', page: 1 })}
        />
      )}
      {tab.kind === 'not-tracked' && (
        <NotTracked
          settingsHref={analyticsHref({ ...query, tab: 'settings', page: 1 })}
          canOpenSettings={canReadSites}
          data={tab.data}
        />
      )}
      {tab.kind === 'overview' && (
        <OverviewTab
          data={tab.data}
          from={query.from}
          to={query.to}
          includeBots={query.includeBots}
          pagesHref={analyticsHref({ ...query, tab: 'pages', page: 1 })}
          referrersHref={analyticsHref({ ...query, tab: 'referrers', page: 1 })}
        />
      )}
      {tab.kind === 'pages' && (
        <PagesTab
          data={tab.data}
          includeBots={query.includeBots}
          onPageChange={(page) => go({ page })}
        />
      )}
      {tab.kind === 'referrers' && (
        <ReferrersTab
          data={tab.data}
          includeBots={query.includeBots}
          onPageChange={(page) => go({ page })}
        />
      )}
      {tab.kind === 'visitors' && <VisitorsTab data={tab.data} includeBots={query.includeBots} />}
      {tab.kind === 'settings' && <SettingsTab data={tab.data} />}
    </div>
  );
}
