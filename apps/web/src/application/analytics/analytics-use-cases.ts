import { defineUseCase } from '@/application/authorization/use-case';
import {
  isReservedSource,
  isValidMetricName,
  isValidRange,
  isValidSource,
  MAX_RANGE_DAYS,
  rangeDays,
  type AnalyticsPoint,
} from '@/domain/analytics/analytics';
import { ValidationError } from '@/domain/repository';
import { analyticsRepository, type TopPath } from '@/infrastructure/analytics-repository';

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
