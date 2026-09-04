'use client';

import { useRouter } from 'next/navigation';
import {
  Alert,
  DateField,
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
  isAnalyticsTab,
  MIDDLE_DOT,
  NO_VALUE,
  PERIOD_LABEL,
  TAB_LABEL,
  rangeText,
} from './labels';
import { NotTracked, type NotTrackedData } from './not-tracked';
import { OverviewTab, type OverviewData } from './overview-tab';
import { PagesTab, type PagesData } from './pages-tab';
import { CAPTION } from './parts';
import { ReferrersTab, type ReferrersData } from './referrers-tab';
import { SettingsTab, type SettingsData } from './settings-tab';
import { VisitorsTab, type VisitorsData } from './visitors-tab';

/**
 * アナリティクス画面の骨格（028-analytics-dashboard-redesign 設計 §7.3.2）。
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
  | { readonly kind: 'not-tracked'; readonly data: NotTrackedData };

export interface AnalyticsViewProps {
  readonly query: AnalyticsQuery;
  readonly sites: readonly SiteOption[];
  /** 前期間（`YYYY-MM-DD`）。 */
  readonly previousFrom: string;
  readonly previousTo: string;
  /** 1 日の境目に使っているタイムゾーン。 */
  readonly timeZone: string;
  /** 最終受信（`YYYY-MM-DD HH:mm`）。無ければ null。 */
  readonly lastSeenAt: string | null;
  /** `custom` の期間が不正で 30 日に戻したとき true。 */
  readonly rangeWarning: boolean;
  /** 設定タブを出せるか（`site.read`）。 */
  readonly canReadSites: boolean;
  readonly tab: TabData;
}

export function AnalyticsView({
  query,
  sites,
  previousFrom,
  previousTo,
  timeZone,
  lastSeenAt,
  rangeWarning,
  canReadSites,
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

  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-6)' }}>
      <div style={{ display: 'grid', gap: 'var(--tf-space-2)' }}>
        <h1 style={{ margin: 0 }}>アナリティクス</h1>
        {/*
          **どの時間帯で 1 日を区切っているかを見せる。** 見えないと、
          「昨日のはずの数字が今日に入っている」ときに確かめようがない。
        */}
        <p
          style={{ margin: 0, color: 'var(--tf-color-text-muted)' }}
          data-analytics-timezone={timeZone}
        >
          前期間（{rangeText(previousFrom, previousTo)}）と比較 {MIDDLE_DOT} 日付の区切りは{' '}
          {timeZone}
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
