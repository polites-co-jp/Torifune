import type { AnalyticsPurgedEventPayload } from '@torifune/plugin-api';
import { rollupAnalytics } from '@/application/analytics/rollup';
import { emit } from '@/application/events';
import type { JobContext } from '@/application/jobs/scheduler';
import type { Connection } from '@/database/provider';
import { dateInTimeZone, shiftDays, todayInTimeZone } from '@/domain/analytics/day';
import { analyticsRepository } from '@/infrastructure/analytics-repository';
import { log } from '@/infrastructure/logging';

/**
 * 基準タイムゾーンを変えたときの洗い替え（032-timezone-setting 設計 §6.2）。
 *
 * 2 段で行う。
 *
 * 1. 生ログのある期間を、**新しい境目で 30 日ずつ**畳み直す（古い日 → 今日）
 * 2. **すべてのチャンクが終わってから**、その日に生ログが 1 行も無い (サイト, 日) の
 *    集計値を**出所を問わず**消す（裁定 §3.3 ＋ `要件.md` §7-1）
 *
 * **削除は必ず最後。** 先に消すと「消したのにロールアップが終わっていない」という、
 * 取り返しのつかない中断点ができる。ロールアップの途中で落ちても何も失っておらず、
 * 頭からやり直せば同じ結果になる（`replaceCorePoints` は (site, day) ごとの差し替え）。
 *
 * **冪等。** 現在の状態だけから決まるので、何度走らせても同じところへ収束する。
 * 失敗したときの立て直しは人が起こす（自動再試行はしない。`要件.md` §7-2）。
 *
 * **洗い替えでも訪問者数は完全には直らない。** 過去の `visitor_hash` は旧境目で回った
 * ソルトで作られており、ソルトは保存していない（018 §3.2 の裁定）。
 * ページビューは正確に直るが、訪問者数・セッション数・直帰率・滞在は多めに出る。
 * 直すには裁定を覆す必要があるので、直さずに画面で断る（設計 §7.2）。
 */

/**
 * 1 チャンクの日数（設計 §6.2.1）。
 *
 * `aggregateDailyBreakdown` は範囲全体の集計結果を一度にメモリへ返すので、
 * 数年ぶんを 1 回で返させない。1 チャンクが失敗しても、それまでの結果は残る。
 */
export const REBUILD_CHUNK_DAYS = 30;

export interface RebuildInput {
  /** 新しい基準タイムゾーン。**ジョブの中で解決し直さない**（走行中に変わっても揺れない）。 */
  readonly timeZone: string;
  /**
   * 変更前の値。**記録専用**（設計 §6.2.6）。
   *
   * 処理の分岐にも条件にも 1 度も入らない。やり直しでは `timeZone` と同じ値になり、
   * **前後が同じであること自体が「やり直しである」印**になる。
   */
  readonly previousTimeZone: string;
}

/** `from` から 30 日ずつ、`to` を超えない範囲に切る。 */
function chunksOf(from: string, to: string): readonly { from: string; to: string }[] {
  const chunks: { from: string; to: string }[] = [];
  let start = from;

  while (start <= to) {
    const candidate = shiftDays(start, REBUILD_CHUNK_DAYS - 1);
    const end = candidate > to ? to : candidate;
    chunks.push({ from: start, to: end });
    start = shiftDays(end, 1);
  }

  return chunks;
}

/**
 * 洗い替えの本体。戻り値が `job_runs.summary` になる。
 *
 * **古い日から今日へ向かって進む。** 最後のチャンクに今日が入るので、
 * 走行中に届いた分をできるだけ拾える。
 */
export async function rebuildAnalyticsForTimeZone(
  connection: Connection,
  input: RebuildInput,
  job: JobContext,
): Promise<Readonly<Record<string, unknown>>> {
  const { timeZone, previousTimeZone } = input;

  // 生ログが 1 行も無ければ、ロールアップの段を丸ごと飛ばして削除だけを行う。
  const oldest = await analyticsRepository.findOldestAccessAt(connection);
  const from = oldest === null ? null : dateInTimeZone(oldest, timeZone);
  const to = oldest === null ? null : todayInTimeZone(timeZone);

  let days = 0;
  let points = 0;
  let completedThrough: string | null = null;

  const summary = (): Record<string, unknown> => ({
    timeZone,
    previousTimeZone,
    from,
    to,
    completedThrough,
    days,
    points,
    // 削除の前は「まだ実行していない」。0 件と区別できるようにする。
    deletedDays: null,
    deletedCoreRows: null,
    deletedPluginRows: null,
  });

  if (from !== null && to !== null) {
    for (const chunk of chunksOf(from, to)) {
      // **タイムゾーンを引数で渡す。** チャンクごとに解決し直すと、走行中に
      // もう一度変えられた場合にチャンクごとに違う境目で畳んでしまう。
      const result = await rollupAnalytics(connection, chunk, { timeZone });
      days += result.days;
      points += result.points;
      completedThrough = chunk.to;
      await job.report(summary());
    }
  }

  // **ここから先が不可逆。** すべてのチャンクが終わってから 1 回だけ実行する。
  const deleted = await analyticsRepository.deleteStalePoints(connection, timeZone);
  const deletedRows = deleted.coreRows + deleted.pluginRows;

  log.info('analytics timezone rebuild finished', {
    timeZone,
    from,
    to,
    days,
    points,
    deletedDays: deleted.days,
    deletedCoreRows: deleted.coreRows,
    deletedPluginRows: deleted.pluginRows,
  });

  // **削除が成功したあと、1 回だけ知らせる**（設計 §9.3.2）。
  //
  // 文書の改訂は**既に出荷済みの Plugin には届かない。**「◯◯日まで取り込み済み」という
  // 状態を持つ Plugin は、取り込み済みだと信じたまま行が消えた状態になり、二度と再取得しない。
  //
  // * **サイトごとには発火しない。** 遅い Plugin のハンドラがサイト数だけ直列に走る
  //   （`analytics.rolledUp` が「集計が済んだ単位で 1 回だけ」にしているのと同じ立場）
  // * **1 行も消えなければ発火しない。** 起きていないことを知らせない
  // * ハンドラの失敗は `emit` が握る。**洗い替えを Plugin の不具合で落とさない**
  if (deletedRows > 0) {
    const payload: AnalyticsPurgedEventPayload = {
      timeZone,
      rows: deletedRows,
      sites: deleted.sites,
    };
    await emit('analytics.purged', payload);
  }

  return {
    ...summary(),
    deletedDays: deleted.days,
    deletedCoreRows: deleted.coreRows,
    deletedPluginRows: deleted.pluginRows,
  };
}
