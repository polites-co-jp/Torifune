import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { originFromHeaders } from '@/api/absolute-url';
import {
  getAnalyticsStatus,
  listAnalytics,
  listAnalyticsBreakdown,
  listTrackedSites,
  type AnalyticsPage,
} from '@/application/analytics/analytics-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { analyticsTimeZone } from '@/application/analytics/timezone';
import {
  isValidRange,
  KEYLESS_CORE_METRICS,
  MAX_RANGE_DAYS,
  rangeDays,
  type AnalyticsPoint,
  type BreakdownItem,
  type TrackedSite,
} from '@/domain/analytics/analytics';
import {
  formatDateTimeInTimeZone,
  isPeriodPreset,
  presetRange,
  previousRange,
  shiftDays,
  todayInTimeZone,
} from '@/domain/analytics/day';
import {
  botShare,
  delta,
  deltaPt,
  deviceRows,
  summarize,
  summarizeDaily,
  type Summary,
} from '@/domain/analytics/summary';
import { NotFoundError } from '@/domain/repository';
import type { AnalyticsQuery } from '@/ui/analytics/analytics-query';
import { AnalyticsView, type SiteOption, type TabData } from '@/ui/analytics/analytics-view';
import { isAnalyticsTab, type AnalyticsPeriod, type AnalyticsTab } from '@/ui/analytics/labels';
import type { OverviewData } from '@/ui/analytics/overview-tab';
import type { PagesData } from '@/ui/analytics/pages-tab';
import type { ReferrersData } from '@/ui/analytics/referrers-tab';
import type { VisitorsData } from '@/ui/analytics/visitors-tab';
import { Button, EmptyState } from '@/ui/components';
import { AppShell } from '@/ui/layout/app-shell';
import { requirePageSession } from '@/ui/server/page-session';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/** ページ / 参照元タブの 1 ページの行数（設計 §7.3.1）。 */
const TABLE_PER_PAGE = 50;

/** 概要の上位ページ・参照元の件数。 */
const TOP_LIMIT = 5;

/** 期間の既定。`period` が無い・読めないときに使う。 */
const DEFAULT_PERIOD = '30d';

function asString(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseTab(value: string | null): AnalyticsTab {
  return value !== null && isAnalyticsTab(value) ? value : 'overview';
}

/** 1 以上の整数。それ以外は 1。 */
function parsePage(value: string | null): number {
  const page = value === null ? Number.NaN : Number(value);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

/**
 * 暦として実在する `YYYY-MM-DD` か。
 *
 * `isValidRange` は形式しか見ないので、`2026-02-30` のような日付はここで落とす
 * （日付を動かして戻したとき同じ文字列にならない）。
 */
function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && shiftDays(value, 0) === value;
}

interface ResolvedPeriod {
  readonly period: AnalyticsPeriod;
  readonly from: string;
  readonly to: string;
  /** `custom` の期間が不正で既定に戻したとき true。 */
  readonly warning: boolean;
}

/**
 * URL の `period` / `from` / `to` から期間を決める（設計 §7.3.1）。
 *
 * `custom` の不正（読めない・逆転・400 日超）は**画面を落とさず**警告を出して既定へ戻す。
 * API と違って 422 にしない。共有された URL を開いた人が何も見られないのは困る。
 */
function resolvePeriod(
  params: Record<string, string | string[] | undefined>,
  today: string,
): ResolvedPeriod {
  const periodParam = asString(params['period']);
  const from = asString(params['from']);
  const to = asString(params['to']);

  const period: AnalyticsPeriod =
    periodParam === null
      ? from !== null || to !== null
        ? 'custom'
        : DEFAULT_PERIOD
      : periodParam === 'custom'
        ? 'custom'
        : isPeriodPreset(periodParam)
          ? periodParam
          : DEFAULT_PERIOD;

  if (period !== 'custom') {
    return { period, ...presetRange(period, today), warning: false };
  }

  if (
    from !== null &&
    to !== null &&
    isCalendarDate(from) &&
    isCalendarDate(to) &&
    isValidRange(from, to) &&
    rangeDays(from, to) <= MAX_RANGE_DAYS
  ) {
    return { period: 'custom', from, to, warning: false };
  }

  return { period: DEFAULT_PERIOD, ...presetRange(DEFAULT_PERIOD, today), warning: true };
}

/** `from` 〜 `to` の日付列（両端を含む）。 */
function datesBetween(from: string, to: string): readonly string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = shiftDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

/** 内訳の 1 ページ（key → value）。 */
async function breakdown(
  context: AuthorizationContext,
  input: {
    readonly siteId: string;
    readonly from: string;
    readonly to: string;
    readonly metric: string;
    readonly page?: number;
    readonly perPage: number;
    readonly keys?: readonly string[];
  },
): Promise<AnalyticsPage<BreakdownItem>> {
  // 出所は全部（`source: null`）。Plugin が取り込んだ値も表示に入る（設計 §7.3.3）。
  return listAnalyticsBreakdown(context, {
    siteId: input.siteId,
    from: input.from,
    to: input.to,
    metric: input.metric,
    source: null,
    page: input.page ?? 1,
    perPage: input.perPage,
    ...(input.keys === undefined ? {} : { keys: input.keys }),
  });
}

/** 表の 1 ページ分の key に限って、付随する指標を引く。key が無ければ引かない。 */
async function valuesByKey(
  context: AuthorizationContext,
  range: { readonly siteId: string; readonly from: string; readonly to: string },
  metric: string,
  keys: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (keys.length === 0) {
    return new Map();
  }
  const page = await breakdown(context, { ...range, metric, perPage: keys.length, keys });
  return new Map(page.items.map((item) => [item.key, item.value]));
}

/** 時間帯別（`'00'`〜`'23'`）を 24 個の配列に写す。無い時間帯は 0。 */
function hoursOf(items: readonly BreakdownItem[]): readonly number[] {
  const hours = new Array<number>(24).fill(0);
  for (const item of items) {
    const hour = Number(item.key);
    if (Number.isInteger(hour) && hour >= 0 && hour < 24) {
      hours[hour] = (hours[hour] ?? 0) + item.value;
    }
  }
  return hours;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** 平均滞在の前期間比。標本が無い側は 0 として扱う（前期 0 なら `—`）。 */
function deltaOfAverage(current: number | null, previous: number | null) {
  return delta(current ?? 0, previous ?? 0);
}

/**
 * アナリティクス画面（06_画面設計.md §15、028-analytics-dashboard-redesign 設計 §7.3）。
 *
 * **読み取りは Server Component から UseCase を直接呼ぶ**（決定事項 D-06）。
 * 認可は UseCase 側で行われる。ここでの Permission の参照は表示制御にすぎない。
 *
 * 状態はすべて URL パラメータ（§7.3.1）。表示するタブのデータだけを取る（§7.3.3）。
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { context, displayName, permissions } = await requirePageSession();

  if (!permissions.has('analytics.read')) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  const canReadSites = permissions.has('site.read');

  // 計測タグ（公開キー）と選択肢の名前は `site.read` が要る。無ければ ID だけで出す（§7.3.2）。
  const trackedSites: readonly TrackedSite[] = canReadSites
    ? await listTrackedSites(context, {})
    : [];
  const siteId = asString(params['siteId']) ?? trackedSites[0]?.id ?? null;

  if (siteId === null) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <h1 style={{ marginTop: 0 }}>アナリティクス</h1>
        {canReadSites ? (
          <EmptyState
            message="Webサイトを登録すると、ここに計測が出ます。"
            action={
              <Link href="/sites/new">
                <Button variant="primary">Webサイトを登録</Button>
              </Link>
            }
          />
        ) : (
          <EmptyState message="サイトを指定してください。" />
        )}
      </AppShell>
    );
  }

  // **集計と同じ境目で「今日」を決める。** サーバーのローカル日付で作ると、
  // 集計が畳んだ日と食い違って常に 0 件になる期間ができる。
  const timeZone = analyticsTimeZone();
  const today = todayInTimeZone(timeZone);
  const resolved = resolvePeriod(params, today);
  const previous = previousRange(resolved.from, resolved.to);
  const includeBots = asString(params['bots']) === '1';

  const query: AnalyticsQuery = {
    siteId,
    tab: parseTab(asString(params['tab'])),
    period: resolved.period,
    from: resolved.from,
    to: resolved.to,
    includeBots,
    page: parsePage(asString(params['page'])),
  };
  // 設定タブは公開キーが要るので、サイト一覧から引けなければ出さない。URL で指されても概要にする。
  const trackedSite = trackedSites.find((candidate) => candidate.id === siteId);
  const tab: AnalyticsTab =
    query.tab === 'settings' && trackedSite === undefined ? 'overview' : query.tab;

  // 受信状況。無い ID（UUID でない値も）は 404。
  const status = await getAnalyticsStatus(context, { siteId }).catch((error: unknown) => {
    if (error instanceof NotFoundError) {
      notFound();
    }
    throw error;
  });

  const range = { siteId, from: resolved.from, to: resolved.to };
  const keyless = (from: string, to: string): Promise<readonly AnalyticsPoint[]> =>
    listAnalytics(context, {
      siteId,
      from,
      to,
      source: null,
      metrics: [...KEYLESS_CORE_METRICS],
      key: '',
    });

  // 当期は「未設置」判定に使うので、どのタブでも読む。前期は前期間比を出すタブだけ。
  const currentPoints = await keyless(resolved.from, resolved.to);
  const untracked = status.analyticsLastSeenAt === null && currentPoints.length === 0;

  const summaryOptions = { includeBots } as const;
  const current = summarize(currentPoints, summaryOptions);
  const days = rangeDays(resolved.from, resolved.to);

  const tabData = await (async (): Promise<TabData> => {
    if (untracked && tab !== 'settings') {
      return { kind: 'not-tracked' };
    }

    switch (tab) {
      case 'overview': {
        const [previousPoints, hours, devices, topPages, topReferrers] = await Promise.all([
          keyless(previous.from, previous.to),
          breakdown(context, { ...range, metric: 'pageviews_hour', perPage: 24 }),
          breakdown(context, { ...range, metric: 'pageviews_device', perPage: 10 }),
          breakdown(context, { ...range, metric: 'path_pageviews', perPage: TOP_LIMIT }),
          breakdown(context, { ...range, metric: 'referrer', perPage: TOP_LIMIT }),
        ]);
        const prev = summarize(previousPoints, summaryOptions);
        const dailyByDate = new Map(
          summarizeDaily(currentPoints, summaryOptions).map((day) => [day.date, day]),
        );
        const botPageviews = botShare(currentPoints).botPageviews;

        const data: OverviewData = {
          pageviews: { value: current.pageviews, delta: delta(current.pageviews, prev.pageviews) },
          visitors: { value: current.visitors, delta: delta(current.visitors, prev.visitors) },
          sessions: { value: current.sessions, delta: delta(current.sessions, prev.sessions) },
          bounceRate: {
            value: current.bounceRate,
            // 直帰率だけ「下がると良い」（設計 §7.3.5）。
            delta: deltaPt(current.bounceRate, prev.bounceRate, true),
          },
          dwellAvg: {
            value: current.dwellAvg,
            delta: deltaOfAverage(current.dwellAvg, prev.dwellAvg),
          },
          // 記録の無い日は 0 で埋める。記録が 1 つも無ければ空にして空状態を出す。
          daily:
            currentPoints.length === 0
              ? []
              : datesBetween(resolved.from, resolved.to).map((date) => ({
                  date,
                  pageviews: dailyByDate.get(date)?.pageviews ?? 0,
                  visitors: dailyByDate.get(date)?.visitors ?? 0,
                })),
          topPages: topPages.items,
          topReferrers: topReferrers.items,
          hours: hoursOf(hours.items),
          devices: deviceRows(devices.items, { ...summaryOptions, botPageviews }),
          botPageviews,
        };
        return { kind: 'overview', data };
      }

      case 'pages': {
        const page = await breakdown(context, {
          ...range,
          metric: 'path_pageviews',
          page: query.page,
          perPage: TABLE_PER_PAGE,
        });
        const keys = page.items.map((item) => item.key);
        const [visitors, landing, bounces, dwellMs, dwellSamples] = await Promise.all([
          valuesByKey(context, range, 'path_visitors', keys),
          valuesByKey(context, range, 'landing', keys),
          valuesByKey(context, range, 'path_bounces', keys),
          valuesByKey(context, range, 'path_dwell_ms', keys),
          valuesByKey(context, range, 'path_dwell_samples', keys),
        ]);

        const data: PagesData = {
          rows: page.items.map((item) => ({
            path: item.key,
            pageviews: item.value,
            visitors: visitors.get(item.key) ?? 0,
            landing: landing.get(item.key) ?? 0,
            bounceRate: ratio(bounces.get(item.key) ?? 0, landing.get(item.key) ?? 0),
            dwellAvg: ratio(dwellMs.get(item.key) ?? 0, dwellSamples.get(item.key) ?? 0),
          })),
          total: page.total,
          page: query.page,
          perPage: TABLE_PER_PAGE,
        };
        return { kind: 'pages', data };
      }

      case 'referrers': {
        const page = await breakdown(context, {
          ...range,
          metric: 'referrer',
          page: query.page,
          perPage: TABLE_PER_PAGE,
        });
        const keys = page.items.map((item) => item.key);
        const [visitors, bounces] = await Promise.all([
          valuesByKey(context, range, 'referrer_visitors', keys),
          valuesByKey(context, range, 'referrer_bounces', keys),
        ]);
        // 割合の分母は Bot 抜きのセッション（設計 §7.3.6）。
        const sessions = summarize(currentPoints, { includeBots: false }).sessions;

        const data: ReferrersData = {
          rows: page.items.map((item) => ({
            host: item.key,
            sessions: item.value,
            visitors: visitors.get(item.key) ?? 0,
            bounceRate: ratio(bounces.get(item.key) ?? 0, item.value),
            share: ratio(item.value, sessions),
          })),
          total: page.total,
          page: query.page,
          perPage: TABLE_PER_PAGE,
        };
        return { kind: 'referrers', data };
      }

      case 'visitors': {
        const [previousPoints, hours, devices] = await Promise.all([
          keyless(previous.from, previous.to),
          breakdown(context, { ...range, metric: 'pageviews_hour', perPage: 24 }),
          breakdown(context, { ...range, metric: 'pageviews_device', perPage: 10 }),
        ]);
        const prev: Summary = summarize(previousPoints, summaryOptions);
        const previousDays = rangeDays(previous.from, previous.to);
        const bot = botShare(currentPoints);

        const data: VisitorsData = {
          visitors: { value: current.visitors, delta: delta(current.visitors, prev.visitors) },
          sessions: { value: current.sessions, delta: delta(current.sessions, prev.sessions) },
          perVisitor: {
            value: current.perVisitor,
            delta: deltaOfAverage(current.perVisitor, prev.perVisitor),
          },
          perDay: {
            value: current.visitors / days,
            delta: delta(current.visitors / days, prev.visitors / previousDays),
          },
          hours: hoursOf(hours.items),
          devices: deviceRows(devices.items, { ...summaryOptions, botPageviews: bot.botPageviews }),
          bot,
        };
        return { kind: 'visitors', data };
      }

      case 'settings': {
        if (trackedSite === undefined) {
          // `tab` の決め方で除いている。型を閉じるためだけの分岐。
          notFound();
        }
        // **計測タグの src は絶対 URL で出す。** 相対パスのまま貼られると、
        // 貼った先のサーバーの `/t.js` を探しに行って計測が届かない。
        const scriptOrigin = originFromHeaders(await headers());
        return {
          kind: 'settings',
          data: {
            siteId,
            publicKey: trackedSite.publicKey,
            scriptOrigin,
            canRegenerate: permissions.has('site.write'),
            lastSeenAt:
              status.analyticsLastSeenAt === null
                ? null
                : formatDateTimeInTimeZone(status.analyticsLastSeenAt, timeZone),
            lastRollupAt:
              status.lastRollupAt === null
                ? null
                : formatDateTimeInTimeZone(status.lastRollupAt, timeZone),
            timeZone,
          },
        };
      }
    }
  })();

  const sites: readonly SiteOption[] = trackedSites.map((site) => ({
    id: site.id,
    name: site.name,
    url: site.url,
    tracked: site.analyticsLastSeenAt !== null,
  }));

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <AnalyticsView
        query={{ ...query, tab }}
        sites={sites}
        previousFrom={previous.from}
        previousTo={previous.to}
        timeZone={timeZone}
        lastSeenAt={
          status.analyticsLastSeenAt === null
            ? null
            : formatDateTimeInTimeZone(status.analyticsLastSeenAt, timeZone)
        }
        rangeWarning={resolved.warning}
        canReadSites={canReadSites}
        tab={tabData}
      />
    </AppShell>
  );
}
