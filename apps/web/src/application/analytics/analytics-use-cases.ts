import { defineUseCase } from '@/application/authorization/use-case';
import {
  isReservedSource,
  isValidMetricName,
  isValidRange,
  isValidSource,
  MAX_RANGE_DAYS,
  rangeDays,
  type AnalyticsPoint,
  type TopPath,
  type TrackedSite,
} from '@/domain/analytics/analytics';
import { ValidationError } from '@/domain/repository';
import { analyticsRepository } from '@/infrastructure/analytics-repository';
import { analyticsTimeZone } from './timezone';

/**
 * アクセス・分析データの参照（05_API設計.md §20、018-analytics）。
 *
 * **画面はここだけを見る。** 生ログを直接集計しない（設計 §4.1）。
 */

export interface AnalyticsRangeInput {
  readonly siteId: string | null;
  readonly from: string;
  readonly to: string;
  readonly source: string | null;
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
  handler: async (context, input) => {
    assertRange(input.from, input.to);

    return analyticsRepository.listPoints(context.connection, {
      siteId: input.siteId,
      from: input.from,
      to: input.to,
      source: input.source,
    });
  },
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

function offsetOf(input: AnalyticsPageInput): number {
  return (input.page - 1) * input.perPage;
}

export const listAnalyticsPage = defineUseCase<AnalyticsPageInput, AnalyticsPage<AnalyticsPoint>>({
  name: 'analytics.listPage',
  permission: 'analytics.read',
  handler: async (context, input) => {
    assertRange(input.from, input.to);

    const range = {
      siteId: input.siteId,
      from: input.from,
      to: input.to,
      source: input.source,
    };

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

export const listTopPathsPage = defineUseCase<AnalyticsPageInput, AnalyticsPage<TopPath>>({
  name: 'analytics.topPathsPage',
  permission: 'analytics.read',
  handler: async (context, input) => {
    assertRange(input.from, input.to);

    const range = {
      siteId: input.siteId,
      from: input.from,
      to: input.to,
      timeZone: analyticsTimeZone(),
    };

    const total = await analyticsRepository.countTopPaths(context.connection, range);
    const items = await analyticsRepository.topPaths(context.connection, {
      ...range,
      limit: input.perPage,
      offset: offsetOf(input),
    });

    return { items, total };
  },
});

export const listTopPaths = defineUseCase<
  AnalyticsRangeInput & { readonly limit: number },
  readonly TopPath[]
>({
  name: 'analytics.topPaths',
  permission: 'analytics.read',
  handler: async (context, input) => {
    assertRange(input.from, input.to);

    return analyticsRepository.topPaths(context.connection, {
      siteId: input.siteId,
      from: input.from,
      to: input.to,
      timeZone: analyticsTimeZone(),
      limit: Math.min(Math.max(1, input.limit), 100),
    });
  },
});

export interface RecordAnalyticsInput {
  readonly siteId: string;
  readonly metricDate: string;
  readonly source: string;
  readonly metric: string;
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
    if (!Number.isFinite(input.value) || input.value < 0) {
      throw new ValidationError('Analytics', 'value', '0以上の数値を指定してください。');
    }

    await context.connection.transaction((tx) =>
      analyticsRepository.putPoint(tx, {
        siteId: input.siteId,
        metricDate: input.metricDate,
        source: input.source,
        metric: input.metric,
        value: Math.floor(input.value),
      }),
    );
  },
});

/**
 * 計測タグを表示するためのサイト一覧（06_画面設計.md §15）。
 *
 * 公開キーを含むので `site.read` を要求する。
 * 公開キーは計測タグに埋めて配る値で秘密ではないが、
 * どのサイトを持っているかは権限のある人にだけ見せる。
 */
export const listTrackedSites = defineUseCase<Record<string, never>, readonly TrackedSite[]>({
  name: 'analytics.trackedSites',
  permission: 'site.read',
  handler: async (context) => analyticsRepository.listTrackedSites(context.connection, 200),
});
