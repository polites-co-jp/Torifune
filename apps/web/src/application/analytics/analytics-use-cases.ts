import type { AuthorizationContext } from '@/application/authorization/authorize';
import { defineUseCase } from '@/application/authorization/use-case';
import {
  CORE_SOURCE,
  isReservedSource,
  isValidBreakdownKey,
  isValidMetricName,
  isValidRange,
  isValidSource,
  MAX_RANGE_DAYS,
  rangeDays,
  type AnalyticsPoint,
  type AnalyticsStatus,
  type BreakdownItem,
  type TopPath,
  type TrackedSite,
} from '@/domain/analytics/analytics';
import { NotFoundError, ValidationError } from '@/domain/repository';
import { analyticsRepository } from '@/infrastructure/analytics-repository';

/**
 * アクセス・分析データの参照（05_API設計.md §20、018-analytics）。
 *
 * **画面はここだけを見る。** 生ログを直接集計しない（設計 §4.1）。
 */

/** `metrics` で一度に絞れる指標の数。 */
const MAX_METRICS_FILTER = 20;

/** `keys` で一度に絞れる key の数（画面の 1 ページ分）。 */
const MAX_KEYS_FILTER = 100;

export interface AnalyticsRangeInput {
  readonly siteId: string | null;
  readonly from: string;
  readonly to: string;
  readonly source: string | null;
  /** 指標名で絞る（最大 20 個）。省略は全指標。 */
  readonly metrics?: readonly string[];
  /** key で絞る。`''` を渡すとキー無しの行だけ。省略は全 key。 */
  readonly key?: string;
}

/**
 * 絞り込みを検証して Repository へ渡す形にする。
 *
 * 画面は必ず `key: ''` と `metrics` を渡す（028 設計 §6.1）。
 * 渡さないとパス別の行を全部読むことになる。
 */
function rangeOf(input: AnalyticsRangeInput) {
  assertRange(input.from, input.to);

  if (input.metrics !== undefined) {
    if (input.metrics.length > MAX_METRICS_FILTER) {
      throw new ValidationError(
        'Analytics',
        'metrics',
        `指標は${MAX_METRICS_FILTER}個以内で指定してください。`,
      );
    }
    if (!input.metrics.every(isValidMetricName)) {
      throw new ValidationError('Analytics', 'metrics', '指標名の形式が不正です。');
    }
  }

  return {
    siteId: input.siteId,
    from: input.from,
    to: input.to,
    source: input.source,
    ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
    ...(input.key === undefined ? {} : { key: input.key }),
  };
}

function assertRange(from: string, to: string): void {
  if (!isValidRange(from, to)) {
    throw new ValidationError('Analytics', 'to', '期間を確認してください（開始日以降にする）。');
  }
  if (rangeDays(from, to) > MAX_RANGE_DAYS) {
    // 広すぎる期間で画面と DB を止めない。
    throw new ValidationError(
      'Analytics',
      'from',
      `期間が長すぎます（${MAX_RANGE_DAYS}日以内にしてください）。`,
    );
  }
}

export const listAnalytics = defineUseCase<AnalyticsRangeInput, readonly AnalyticsPoint[]>({
  name: 'analytics.list',
  permission: 'analytics.read',
  handler: async (context, input) =>
    analyticsRepository.listPoints(context.connection, rangeOf(input)),
});

/**
 * ページ指定つきの参照（05_API設計.md §33）。
 *
 * **`{id}` での取得は無い。** analytics は
 * `(site_id, metric_date, source, metric)` の複合キーで保存する集計値の集合であり、
 * 1件を指す id が存在しない。必要な範囲は期間指定・絞り込み・Pagination で取る
 * （仕様書 §20 / `docs/仕様書/改訂履歴.md` 2026-09-01）。
 */
export interface AnalyticsPageInput extends AnalyticsRangeInput {
  readonly page: number;
  readonly perPage: number;
}

/**
 * 一覧の結果。
 *
 * 他の UseCase（`UserWithRolesPage` など）と同じく `{ items, total }` だけを返す。
 * `page` / `perPage` は要求した側が知っているので、返しても増えるだけ。
 */
export interface AnalyticsPage<T> {
  readonly items: readonly T[];
  readonly total: number;
}

function offsetOf(input: { readonly page: number; readonly perPage: number }): number {
  return (input.page - 1) * input.perPage;
}

export const listAnalyticsPage = defineUseCase<AnalyticsPageInput, AnalyticsPage<AnalyticsPoint>>({
  name: 'analytics.listPage',
  permission: 'analytics.read',
  handler: async (context, input) => {
    const range = rangeOf(input);

    // 件数を先に取る。**「そのページの件数」ではなく条件に合う全件数**を返す（§33）。
    const total = await analyticsRepository.countPoints(context.connection, range);
    const items = await analyticsRepository.listPoints(context.connection, {
      ...range,
      limit: input.perPage,
      offset: offsetOf(input),
    });

    return { items, total };
  },
});

/**
 * 内訳（028 設計 §6.2）。
 *
 * 期間内の日ごとの値を key ごとに合算する。パス別・参照元別・時間帯別などは全部これで引く。
 */
export interface BreakdownInput {
  /** null は全サイト合算。 */
  readonly siteId: string | null;
  readonly from: string;
  readonly to: string;
  readonly metric: string;
  /** null は全出所を合算。 */
  readonly source: string | null;
  readonly page: number;
  readonly perPage: number;
  /** 指定した key に限る（最大 100 個）。画面が表の 1 ページ分の別指標を引くためのもの。 */
  readonly keys?: readonly string[];
}

/** 検証して内訳を読む。`listTopPathsPage` と共有する。 */
async function breakdownPage(
  context: AuthorizationContext,
  input: BreakdownInput,
): Promise<AnalyticsPage<BreakdownItem>> {
  assertRange(input.from, input.to);

  if (!isValidMetricName(input.metric)) {
    throw new ValidationError('Analytics', 'metric', '指標名の形式が不正です。');
  }
  if (input.keys !== undefined) {
    if (input.keys.length > MAX_KEYS_FILTER) {
      throw new ValidationError(
        'Analytics',
        'keys',
        `key は${MAX_KEYS_FILTER}個以内で指定してください。`,
      );
    }
    if (!input.keys.every(isValidBreakdownKey)) {
      throw new ValidationError('Analytics', 'keys', '内訳キーの形式が不正です。');
    }
  }

  const filter = {
    siteId: input.siteId,
    from: input.from,
    to: input.to,
    metric: input.metric,
    source: input.source,
    ...(input.keys === undefined ? {} : { keys: input.keys }),
  };

  // 件数は行数ではなく key の種類数（§33 の `meta.total`）。
  const total = await analyticsRepository.countKeys(context.connection, filter);
  const items = await analyticsRepository.sumByKey(context.connection, {
    ...filter,
    limit: input.perPage,
    offset: offsetOf(input),
  });

  return { items, total };
}

export const listAnalyticsBreakdown = defineUseCase<BreakdownInput, AnalyticsPage<BreakdownItem>>({
  name: 'analytics.breakdown',
  permission: 'analytics.read',
  handler: breakdownPage,
});

/**
 * 上位ページ（`GET /analytics?kind=topPaths`）。
 *
 * **互換のために残す**（05_API設計.md §41）。中身は `path_pageviews` の内訳で、
 * 生ログは読まない。集計を流すまで出ない。新しい呼び出しは `listAnalyticsBreakdown` を使う。
 */
export const listTopPathsPage = defineUseCase<AnalyticsPageInput, AnalyticsPage<TopPath>>({
  name: 'analytics.topPathsPage',
  permission: 'analytics.read',
  handler: async (context, input) => {
    const page = await breakdownPage(context, {
      siteId: input.siteId,
      from: input.from,
      to: input.to,
      metric: 'path_pageviews',
      // Plugin が同名の指標を書いても、従来どおり Torifune 自身の集計だけを出す。
      source: CORE_SOURCE,
      page: input.page,
      perPage: input.perPage,
    });

    return {
      items: page.items.map((item) => ({ path: item.key, pageviews: item.value })),
      total: page.total,
    };
  },
});

export interface RecordAnalyticsInput {
  readonly siteId: string;
  readonly metricDate: string;
  readonly source: string;
  readonly metric: string;
  /** 内訳キー（パス・ホストなど）。省略は `''`（キーを持たない指標）。 */
  readonly key?: string;
  readonly value: number;
}

/**
 * 集計値を書き込む。
 *
 * **Plugin が外部サービスから取り込んだ値を入れるための口**（設計 §6）。
 * `core` を名乗らせない。名乗れると、Plugin の値が本体の集計として表示される。
 */
export const recordAnalytics = defineUseCase<RecordAnalyticsInput, void>({
  name: 'analytics.record',
  // 書き込みは参照より重い操作だが、専用の Permission は作らない。
  // 分析データを見られる相手が、外部から取り込んだ値を足せて困る場面が無い。
  permission: 'analytics.read',
  handler: async (context, input) => {
    if (!isValidRange(input.metricDate, input.metricDate)) {
      throw new ValidationError('Analytics', 'metricDate', '日付の形式が不正です。');
    }
    if (!isValidMetricName(input.metric)) {
      throw new ValidationError('Analytics', 'metric', '指標名の形式が不正です。');
    }
    if (!isValidSource(input.source) || isReservedSource(input.source)) {
      throw new ValidationError('Analytics', 'source', 'この出所は指定できません。');
    }
    const key = input.key ?? '';
    if (!isValidBreakdownKey(key)) {
      throw new ValidationError('Analytics', 'key', '内訳キーの形式が不正です。');
    }
    if (!Number.isFinite(input.value) || input.value < 0) {
      throw new ValidationError('Analytics', 'value', '0以上の数値を指定してください。');
    }

    await context.connection.transaction((tx) =>
      analyticsRepository.putPoint(tx, {
        siteId: input.siteId,
        metricDate: input.metricDate,
        source: input.source,
        metric: input.metric,
        key,
        value: Math.floor(input.value),
      }),
    );
  },
});

/**
 * サイトの受信状況（028 設計 §6.4）。
 *
 * 画面の「設定」タブと「未設置」判定が使う。API には出していない。
 */
export const getAnalyticsStatus = defineUseCase<{ readonly siteId: string }, AnalyticsStatus>({
  name: 'analytics.status',
  permission: 'analytics.read',
  handler: async (context, input) => {
    const site = await analyticsRepository.findSiteLastSeen(context.connection, input.siteId);
    if (site === null) {
      throw new NotFoundError('Site', input.siteId);
    }

    const lastRollupAt = await analyticsRepository.findLastRollupAt(
      context.connection,
      input.siteId,
    );

    return {
      siteId: input.siteId,
      analyticsLastSeenAt: site.analyticsLastSeenAt,
      lastRollupAt,
    };
  },
});

/**
 * 計測タグを表示するためのサイト一覧（06_画面設計.md §15）。
 *
 * 公開キーを含むので `site.read` を要求する。
 * 公開キーは計測タグに埋めて配る値で秘密ではないが、
 * どのサイトを持っているかは権限のある人にだけ見せる。
 *
 * 名前順。計測タグを貼ったままの `archived` のサイトも含む（受信状況を見るため）。
 */
export const listTrackedSites = defineUseCase<Record<string, never>, readonly TrackedSite[]>({
  name: 'analytics.trackedSites',
  permission: 'site.read',
  handler: async (context) => analyticsRepository.listTrackedSites(context.connection, 200),
});
