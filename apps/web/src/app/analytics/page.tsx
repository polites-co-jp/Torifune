import {
  getAnalyticsStatus,
  getTodayAnalytics,
  listAnalytics,
  listAnalyticsBreakdown,
  listTrackedSites,
  type AnalyticsPage,
  type TodayAnalytics,
} from '@/application/analytics/analytics-use-cases';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { originFromHeaders } from '@/api/absolute-url';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { analyticsTimeZone } from '@/application/analytics/timezone';
import {
  isValidBreakdownKey,
  KEYLESS_CORE_METRICS,
  rangeDays,
  type AnalyticsPoint,
  type BreakdownItem,
  type TrackedSite,
} from '@/domain/analytics/analytics';
import {
  dateInTimeZone,
  formatDateTimeInTimeZone,
  previousRange,
  shiftDays,
  todayInTimeZone,
  type DateRange,
} from '@/domain/analytics/day';
import {
  botShare,
  breakdownFromPoints,
  delta,
  deltaPt,
  deviceRows,
  summarize,
  summarizeDaily,
  type Summary,
} from '@/domain/analytics/summary';
import { diagnoseReception } from '@/domain/analytics/reception';
import { NotFoundError } from '@/domain/repository';
import {
  analyticsHref,
  pageSlice,
  resolvePeriod,
  shouldShowStaleRangeNotice,
  type AnalyticsQuery,
} from '@/ui/analytics/analytics-query';
import {
  AnalyticsView,
  type SiteOption,
  type StaleRangeData,
  type TabData,
  type TodayBannerData,
} from '@/ui/analytics/analytics-view';
import {
  isAnalyticsTab,
  pendingText,
  TODAY_BOUNCE_RATE_NOTE,
  TODAY_DWELL_AVG_NOTE,
  TODAY_PERIOD,
  type AnalyticsTab,
} from '@/ui/analytics/labels';
import type { NotTrackedState } from '@/ui/analytics/not-tracked';
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

/**
 * 内訳の行から、key として妥当でないもの（制御文字を含む等）を落とす（設計 §5.3.6 (c)）。
 *
 * 受け口とロールアップで止めているが、`analytics` に直接入った key への防御。
 * 残すと `keys` に渡したときに `ValidationError` になり画面ごと落ちる。
 */
function validItems(items: readonly BreakdownItem[]): readonly BreakdownItem[] {
  return items.filter((item) => isValidBreakdownKey(item.key));
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
 * アナリティクス画面（06_画面設計.md §15、028-analytics-dashboard-redesign 設計 §7.3、
 * 030-analytics-today 設計 §7）。
 *
 * **読み取りは Server Component から UseCase を直接呼ぶ**（決定事項 D-06）。
 * 認可は UseCase 側で行われる。ここでの Permission の参照は表示制御にすぎない。
 *
 * 状態はすべて URL パラメータ（§7.3.1）。表示するタブのデータだけを取る（§7.3.3）。
 *
 * 期間は 3 通りに分かれる。
 *
 * | 期間 | データ源 |
 * | --- | --- |
 * | 「当日」（`period=today`） | **生ログをその場で集計**（`getTodayAnalytics`）。`analytics` は読まない（§13-3） |
 * | 確定期間（プリセット / `custom`） | 集計値（`analytics`）。末尾は昨日 |
 * | 確定値のある期間が無い（今月 1 日の `month`） | **集計を一切行わず**空状態（§7.2） |
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
  const yesterday = shiftDays(today, -1);
  const resolved = resolvePeriod(params, today);
  const isToday = resolved.period === TODAY_PERIOD;
  // `null` は「確定値のある期間が無い」（今月 1 日の `month` だけ。§7.2）。
  const emptyPeriod = resolved.range === null;
  // 日付欄と内部の計算のための代替。**空期間では 1 度も問い合わせに使わない。**
  const period: DateRange = resolved.range ?? { from: today, to: today };
  // 当日は前期間比を出さない（§13-1）。空期間は比べる先が無い。
  const previous = isToday || emptyPeriod ? null : previousRange(period.from, period.to);
  const includeBots = asString(params['bots']) === '1';

  const query: AnalyticsQuery = {
    siteId,
    tab: parseTab(asString(params['tab'])),
    period: resolved.period,
    from: period.from,
    to: period.to,
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

  const range = { siteId, from: period.from, to: period.to };
  const keyless = (from: string, to: string): Promise<readonly AnalyticsPoint[]> =>
    listAnalytics(context, {
      siteId,
      from,
      to,
      source: null,
      metrics: [...KEYLESS_CORE_METRICS],
      key: '',
    });

  // **当日は 1 画面につき 1 回だけ集計する。** 4 タブが要る指標はすべてこの結果に含まれる（§11.3）。
  const todayAnalytics: TodayAnalytics | null = isToday
    ? await getTodayAnalytics(context, { siteId })
    : null;

  // 当期は受信状況の判定に使うので、どのタブでも読む。前期は前期間比を出すタブだけ。
  // 当日は `analytics` を読まず、生ログから作った点をそのまま当期として扱う（§13-3）。
  const currentPoints: readonly AnalyticsPoint[] = emptyPeriod
    ? []
    : (todayAnalytics?.points ?? (await keyless(period.from, period.to)));

  // 受信状況の 4 状態（029 設計 §5.5）。判定は Domain の純関数が持つ。
  // **判定規則は変えていない。** 変えたのは入力 1 つの意味（`to >= 昨日`。030 §9.1）。
  const state = diagnoseReception({
    lastReceivedAt: status.lastReceivedAt,
    pending: status.pending,
    hasPointsInPeriod: currentPoints.length > 0,
    periodMayLackRollup: isToday ? true : period.to >= yesterday,
  });
  // `receiving` 以外は、タブの中身の代わりに導線を出す。
  // **当日で導線を出すのは `not-received` のときだけ**（§7.6）。
  // 「当日」は未集計の値を見るための期間なので、「集計待ち」を理由に中身を隠すのは矛盾する。
  const notTrackedState: NotTrackedState | null = isToday
    ? state === 'not-received'
      ? 'not-received'
      : null
    : state === 'receiving'
      ? null
      : state;

  /** 日時を運用タイムゾーンの `YYYY-MM-DD HH:mm` にする。 */
  const at = (instant: Date | null): string | null =>
    instant === null ? null : formatDateTimeInTimeZone(instant, timeZone);
  const pending = pendingText(status.pending);

  // 最終受信が今日か（§7.5 / §7.5.1）。**追加の問い合わせは要らない。**
  const receivedToday =
    status.lastReceivedAt !== null && dateInTimeZone(status.lastReceivedAt, timeZone) === today;
  const todayHref = analyticsHref({ ...query, period: TODAY_PERIOD, page: 1 });

  const summaryOptions = { includeBots } as const;
  const current = summarize(currentPoints, summaryOptions);
  const days = rangeDays(period.from, period.to);

  /**
   * 内訳の 1 ページ。
   *
   * 当日は `listAnalyticsBreakdown` を呼ばず、**同じ点から組んでメモリ上で切る**（§11.3 / §13-3）。
   * 並び順は `breakdownFromPoints` が Repository の `sumByKey` と揃えてある。
   */
  const breakdownOf = async (
    metric: string,
    options: { readonly page?: number; readonly perPage: number },
  ): Promise<AnalyticsPage<BreakdownItem>> => {
    if (todayAnalytics !== null) {
      // 切り出しは純関数が持つ（設計 §12.3）。ここに算術を直書きしない。
      return pageSlice(
        breakdownFromPoints(todayAnalytics.points, metric),
        options.page ?? 1,
        options.perPage,
      );
    }
    return breakdown(context, { ...range, metric, ...options });
  };

  /** 表の 1 ページ分の key に限った付随指標。当日は同じ点から引く。 */
  const valuesByKeyOf = async (
    metric: string,
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, number>> => {
    if (todayAnalytics !== null) {
      const wanted = new Set(keys);
      return new Map(
        breakdownFromPoints(todayAnalytics.points, metric)
          .filter((item) => wanted.has(item.key))
          .map((item) => [item.key, item.value]),
      );
    }
    return valuesByKey(context, range, metric, keys);
  };

  const tabData = await (async (): Promise<TabData> => {
    if (emptyPeriod) {
      // **集計を一切行わない。** 前月へ倒さず、今日 1 日にも丸めない（§7.2）。
      return { kind: 'empty-period' };
    }

    if (notTrackedState !== null && tab !== 'settings') {
      return {
        kind: 'not-tracked',
        data: {
          state: notTrackedState,
          lastReceivedAt: at(status.lastReceivedAt),
          pendingText: pending,
          scheduled: status.rollup.scheduled,
          intervalMinutes: status.rollup.intervalMinutes,
          nextRunAt: at(status.rollup.nextRunAt),
          receivedToday,
          todayHref: isToday ? null : todayHref,
        },
      };
    }

    switch (tab) {
      case 'overview': {
        const [previousPoints, hours, devices, topPages, topReferrers] = await Promise.all([
          previous === null ? Promise.resolve([]) : keyless(previous.from, previous.to),
          breakdownOf('pageviews_hour', { perPage: 24 }),
          breakdownOf('pageviews_device', { perPage: 10 }),
          breakdownOf('path_pageviews', { perPage: TOP_LIMIT }),
          breakdownOf('referrer', { perPage: TOP_LIMIT }),
        ]);
        const prev = previous === null ? null : summarize(previousPoints, summaryOptions);
        const dailyByDate = new Map(
          summarizeDaily(currentPoints, summaryOptions).map((day) => [day.date, day]),
        );
        const botPageviews = botShare(currentPoints).botPageviews;

        const data: OverviewData = {
          pageviews: {
            value: current.pageviews,
            delta: prev === null ? undefined : delta(current.pageviews, prev.pageviews),
          },
          visitors: {
            value: current.visitors,
            delta: prev === null ? undefined : delta(current.visitors, prev.visitors),
          },
          sessions: {
            value: current.sessions,
            delta: prev === null ? undefined : delta(current.sessions, prev.sessions),
          },
          bounceRate: {
            value: current.bounceRate,
            // 直帰率だけ「下がると良い」（設計 §7.3.5）。
            delta: prev === null ? undefined : deltaPt(current.bounceRate, prev.bounceRate, true),
          },
          dwellAvg: {
            value: current.dwellAvg,
            delta: prev === null ? undefined : deltaOfAverage(current.dwellAvg, prev.dwellAvg),
          },
          // 当日は 1 日しかないので折れ線に意味が無い。カードごと出さない（§7.3）。
          // 確定期間では、記録の無い日は 0 で埋める。記録が 1 つも無ければ空にして空状態を出す。
          daily: isToday
            ? null
            : currentPoints.length === 0
              ? []
              : datesBetween(period.from, period.to).map((date) => ({
                  date,
                  pageviews: dailyByDate.get(date)?.pageviews ?? 0,
                  visitors: dailyByDate.get(date)?.visitors ?? 0,
                })),
          topPages: validItems(topPages.items),
          topReferrers: validItems(topReferrers.items),
          hours: hoursOf(hours.items),
          devices: deviceRows(devices.items, { ...summaryOptions, botPageviews }),
          botPageviews,
          // 補正も除外もしない代わりに、偏りを注記で担保する（§13-2）。
          bounceRateNote: isToday ? TODAY_BOUNCE_RATE_NOTE : undefined,
          dwellAvgNote: isToday ? TODAY_DWELL_AVG_NOTE : undefined,
        };
        return { kind: 'overview', data };
      }

      case 'pages': {
        const page = await breakdownOf('path_pageviews', {
          page: query.page,
          perPage: TABLE_PER_PAGE,
        });
        const items = validItems(page.items);
        const keys = items.map((item) => item.key);
        const [visitors, landing, bounces, dwellMs, dwellSamples] = await Promise.all([
          valuesByKeyOf('path_visitors', keys),
          valuesByKeyOf('landing', keys),
          valuesByKeyOf('path_bounces', keys),
          valuesByKeyOf('path_dwell_ms', keys),
          valuesByKeyOf('path_dwell_samples', keys),
        ]);

        const data: PagesData = {
          rows: items.map((item) => ({
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
        const page = await breakdownOf('referrer', {
          page: query.page,
          perPage: TABLE_PER_PAGE,
        });
        const items = validItems(page.items);
        const keys = items.map((item) => item.key);
        const [visitors, bounces] = await Promise.all([
          valuesByKeyOf('referrer_visitors', keys),
          valuesByKeyOf('referrer_bounces', keys),
        ]);
        // 割合の分母は Bot 抜きのセッション（設計 §7.3.6）。
        const sessions = summarize(currentPoints, { includeBots: false }).sessions;

        const data: ReferrersData = {
          rows: items.map((item) => ({
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
          previous === null ? Promise.resolve([]) : keyless(previous.from, previous.to),
          breakdownOf('pageviews_hour', { perPage: 24 }),
          breakdownOf('pageviews_device', { perPage: 10 }),
        ]);
        const prev: Summary | null =
          previous === null ? null : summarize(previousPoints, summaryOptions);
        const previousDays = previous === null ? 1 : rangeDays(previous.from, previous.to);
        const bot = botShare(currentPoints);

        const data: VisitorsData = {
          visitors: {
            value: current.visitors,
            delta: prev === null ? undefined : delta(current.visitors, prev.visitors),
          },
          sessions: {
            value: current.sessions,
            delta: prev === null ? undefined : delta(current.sessions, prev.sessions),
          },
          perVisitor: {
            value: current.perVisitor,
            delta: prev === null ? undefined : deltaOfAverage(current.perVisitor, prev.perVisitor),
          },
          // 当日は 1 日しかないので「訪問者」と同じ数になる。同じ数を 2 枚並べない（§7.3）。
          perDay:
            isToday || prev === null
              ? isToday
                ? null
                : { value: current.visitors / days }
              : {
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
            // **生ログの最終受信を出す。** 集計を待たずに「届いたか」が分かる。
            lastSeenAt: at(status.lastReceivedAt),
            lastRollupAt: at(status.lastRollupAt),
            timeZone,
            state,
            pendingText: pending,
            lastSucceededAt: at(status.rollup.lastSucceededAt),
            lastRunStatus: status.rollup.lastRun?.status ?? null,
            scheduled: status.rollup.scheduled,
            intervalMinutes: status.rollup.intervalMinutes,
            nextRunAt: at(status.rollup.nextRunAt),
          },
        };
      }
    }
  })();

  // 当日は前期間比の代わりに前日の確定値を並記する（§13-1）。
  // **当日で `analytics` を読むのはここだけ**（昨日 1 日・`key = ''` で 1 回）。
  const previousDay = summarize(
    todayAnalytics === null ? [] : await keyless(yesterday, yesterday),
    summaryOptions,
  );

  const todayBanner: TodayBannerData | null =
    todayAnalytics === null
      ? null
      : {
          generatedAt: formatDateTimeInTimeZone(todayAnalytics.generatedAt, timeZone),
          intervalMinutes: status.rollup.intervalMinutes,
          previousDay: {
            date: yesterday,
            pageviews: previousDay.pageviews,
            visitors: previousDay.visitors,
          },
          noAccessYet: todayAnalytics.points.length === 0,
          lastReceivedAt: at(status.lastReceivedAt),
          unavailable: todayAnalytics.unavailable,
        };

  // §7.5.1。**6 条件はすべて述語が持つ**（`hasConfirmedRange` も含む）。
  // ここで分岐を足すと、条件が画面と述語に分かれて取り違えに気づけなくなる。
  // 判定は純関数に閉じているので、問い合わせも増えない。
  const staleRange: StaleRangeData | null = shouldShowStaleRangeNotice({
    period: resolved.period,
    notTracked: notTrackedState,
    currentPointCount: currentPoints.length,
    receivedToday,
    tab,
    hasConfirmedRange: !emptyPeriod,
  })
    ? { from: period.from, to: period.to, todayHref }
    : null;

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
        previousFrom={previous?.from ?? null}
        previousTo={previous?.to ?? null}
        timeZone={timeZone}
        lastSeenAt={at(status.lastReceivedAt)}
        lastRollupAt={at(status.lastRollupAt)}
        rangeIncludesToday={!emptyPeriod && period.to >= today}
        rangeWarning={resolved.warning}
        canReadSites={canReadSites}
        today={todayBanner}
        staleRange={staleRange}
        tab={tabData}
      />
    </AppShell>
  );
}
