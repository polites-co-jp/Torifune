import { shiftDays } from '../analytics/day';

/**
 * 定期実行ジョブの型と純関数（029-scheduled-jobs 設計 §5.3）。
 *
 * **ここは DB 製品・タイマー・環境変数を知らない。**
 * 環境変数の「文字列をどう読むか」だけを純関数として持ち、
 * 実際に `process.env` を読むのは `application/jobs/config.ts`。
 */

/** Core が回すジョブ。**Plugin からのジョブ登録は無い**（設計 §9 / §11）。 */
export const JOB_NAMES = [
  'analytics.rollup',
  'webhook.deliver',
  // 032-timezone-setting：基準タイムゾーンを変えたときの洗い替え。
  // **周期を持たない**（`bootScheduler` に載せない。要求されたときだけ走る）。
  // **末尾に足す。** この順がそのまま設定画面「定期実行」の行順になる。
  'analytics.timezoneRebuild',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}

/** 実行のきっかけ。`scheduled` は本体の定期実行、`manual` は API から。 */
export type JobTrigger = 'scheduled' | 'manual';

/** `running` → `ok` / `error`。ロックが取れなければ `skipped`。 */
export type JobRunStatus = 'running' | 'ok' | 'error' | 'skipped';

/** 1 回の実行の記録（`job_runs` の 1 行）。 */
export interface JobRun {
  readonly id: string;
  readonly jobName: JobName;
  readonly triggeredBy: JobTrigger;
  readonly status: JobRunStatus;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  /** 例外のメッセージだけ。スタックトレース・SQL・接続情報を入れない。 */
  readonly error: string | null;
  readonly summary: Readonly<Record<string, unknown>>;
  /** 実行したプロセス（`hostname:pid`）。 */
  readonly runner: string | null;
}

/**
 * ジョブごとに残す実行記録の数（設計 §5.2）。
 *
 * 「最新 1 行を upsert」にしない。直近が失敗したときに
 * 「最後にいつ成功したか」が消えてしまう。
 */
export const JOB_RUN_RETENTION = 50;

/** `job_runs.error` の上限（マイグレーション 021 の CHECK と同じ）。 */
export const JOB_ERROR_MAX_LENGTH = 2000;

/** 定期実行の間隔として受け付ける範囲（分）。 */
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 1440;

/**
 * `TORIFUNE_SCHEDULER` の解釈。
 *
 * 未設定・空は既定（有効）。`on` / `off` は大文字小文字を問わない。
 * **不正なら `null`。** 呼ぶ側が既定へ落として警告する（黙って落ちない）。
 */
export function parseSchedulerSwitch(raw: string | undefined): boolean | null {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'on') {
    return true;
  }
  if (value === 'off') {
    return false;
  }
  return null;
}

/**
 * `TORIFUNE_*_INTERVAL_MINUTES` の解釈。1〜1440 の整数だけを受け付ける。
 *
 * **未設定と不正を区別しない**（どちらも `null`）。区別が要るのは警告を出すかどうかだけで、
 * それは呼ぶ側（`application/jobs/config.ts`）が生の値を見て決める。
 * `NaN` は返さない（呼ぶ側の比較が静かに壊れる）。
 */
export function parseIntervalMinutes(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (value === undefined || value === '' || !/^\d+$/.test(value)) {
    return null;
  }
  const minutes = Number(value);
  if (minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
    return null;
  }
  return minutes;
}

/**
 * 記録するエラーメッセージを上限まで切る（設計 §5.3.1）。
 *
 * **コードポイント単位で切る。** `slice(0, 2000)` は UTF-16 コードユニット単位なので、
 * 絵文字や一部の漢字（サロゲートペア）の途中で切れると孤立サロゲートが残り、
 * 画面と JSON で文字が壊れる。PostgreSQL の `char_length`（文字単位）で見る
 * `job_runs_error_length`（2000）の制約とも食い違う。
 *
 * 切断位置がペアの途中になるときは 1 つ手前で止まる（半分だけ残さない）。
 */
export function truncateError(message: string): string {
  const characters = [...message];
  return characters.length <= JOB_ERROR_MAX_LENGTH
    ? message
    : characters.slice(0, JOB_ERROR_MAX_LENGTH).join('');
}

/** 定期ロールアップがさかのぼる最大日数（裁定 #5）。 */
export const ROLLUP_MAX_LOOKBACK_DAYS = 7;

/**
 * 定期ロールアップの `from`（設計 §6.2、裁定 #5）。
 *
 * 最後に成功した実行の開始日から流し直す（境界日は開始時刻までの生ログしか
 * 含んでいないため、その日ごと差し替える。冪等なので二重にならない）。
 * ただし `today − 7` 日より前にはしない。成功の記録が無ければ昨日から。
 *
 * 日付は `YYYY-MM-DD` なので、文字列比較で大小が判定できる。
 */
export function scheduledRollupFrom(input: {
  readonly lastSucceededStartedAt: string | null;
  readonly today: string;
}): string {
  const candidate = input.lastSucceededStartedAt ?? shiftDays(input.today, -1);
  const floor = shiftDays(input.today, -ROLLUP_MAX_LOOKBACK_DAYS);
  return candidate < floor ? floor : candidate;
}

/**
 * ジョブが実行中で受け付けられない（設計 §6.3、裁定 #6）。
 *
 * API が 409 `CONFLICT` に写す。**`ConflictError` は継承しない。**
 * 「すでに使用されています。」という既定の文言では運用者に理由が伝わらないので、
 * `api/route.ts` で別の分岐にして説明を添える。
 */
export class JobBusyError extends Error {
  constructor(readonly jobName: JobName) {
    super(`ジョブが実行中: ${jobName}`);
    this.name = 'JobBusyError';
  }
}
