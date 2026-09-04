import { sql } from 'kysely';
import type { Connection } from '../database/provider';
import type { JobName, JobRun, JobRunStatus, JobTrigger } from '../domain/jobs/job';

/**
 * 定期実行ジョブの実行記録（029-scheduled-jobs 設計 §5.2 / §6.5）。
 *
 * SQL はここに置く（02_データベース設計.md §7）。Application 層は `connection.db` に触れない。
 *
 * **ジョブごとに最新 `keep` 件だけ残す**（`trimHistory`）。監視・診断のための小さな表であり、
 * 履歴の長期保管はしない。読み取りはすべて `job_runs_job_started_idx (job_name, started_at DESC)` で引く。
 */

/** `job_runs` の 1 行。 */
interface JobRunRow {
  readonly id: string;
  readonly job_name: string;
  readonly triggered_by: string;
  readonly status: string;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly error: string | null;
  readonly summary: Record<string, unknown>;
  readonly runner: string | null;
}

/**
 * 行 → `JobRun`。
 *
 * `job_name` / `triggered_by` / `status` は CHECK 制約と自分の書き込みで値が決まっているので、
 * `listTrackedSites` の `status as SiteStatus` と同じく型を宛てる。
 */
function toJobRun(row: JobRunRow): JobRun {
  return {
    id: row.id,
    jobName: row.job_name as JobName,
    triggeredBy: row.triggered_by as JobTrigger,
    status: row.status as JobRunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    summary: row.summary,
    runner: row.runner,
  };
}

/** 「ジョブ × 新しい順」の先頭 1 件。 */
async function latest(
  connection: Connection,
  name: JobName,
  onlySucceeded: boolean,
): Promise<JobRun | null> {
  let query = connection.db
    .selectFrom('job_runs')
    .selectAll()
    .where('job_name', '=', name)
    .orderBy('started_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1);

  if (onlySucceeded) {
    query = query.where('status', '=', 'ok');
  }

  const row = await query.executeTakeFirst();
  return row === undefined ? null : toJobRun(row);
}

export interface NewJobRun {
  readonly id: string;
  readonly jobName: JobName;
  readonly triggeredBy: JobTrigger;
  readonly runner: string;
}

export const jobRunRepository = {
  /** 実行を開始した記録。`started_at` は DB の時計（`now()`）。 */
  async insertRunning(connection: Connection, input: NewJobRun): Promise<JobRun> {
    const row = await connection.db
      .insertInto('job_runs')
      .values({
        id: input.id,
        job_name: input.jobName,
        triggered_by: input.triggeredBy,
        status: 'running',
        error: null,
        runner: input.runner,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toJobRun(row);
  },

  /**
   * ロックが取れずに走らせなかった記録（設計 §5.2）。
   *
   * 複数プロセス構成で「排他が効いている」ことを DB から確かめられる。
   * `finished_at = started_at` にするので、時刻は 1 つの値から両方へ入れる。
   */
  async insertSkipped(connection: Connection, input: NewJobRun & { at: Date }): Promise<JobRun> {
    const row = await connection.db
      .insertInto('job_runs')
      .values({
        id: input.id,
        job_name: input.jobName,
        triggered_by: input.triggeredBy,
        status: 'skipped',
        started_at: input.at,
        finished_at: input.at,
        error: null,
        runner: input.runner,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toJobRun(row);
  },

  /**
   * 走らせる前に失敗した記録（設計 §6.1.5 手順 1）。
   *
   * ロックのセッション自体が失敗したとき（Pool 枯渇・DB 停止・権限エラー）に 1 行だけ入れる。
   * **競合（`skipped`）と区別する。** 丸めると DB 停止が「他が実行中」として残る。
   */
  async insertError(
    connection: Connection,
    input: NewJobRun & { at: Date; error: string },
  ): Promise<JobRun> {
    const row = await connection.db
      .insertInto('job_runs')
      .values({
        id: input.id,
        job_name: input.jobName,
        triggered_by: input.triggeredBy,
        status: 'error',
        started_at: input.at,
        finished_at: input.at,
        error: input.error,
        runner: input.runner,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toJobRun(row);
  },

  /**
   * 成功で閉じる。
   *
   * **`finished_at` は DB の時計で入れる。** アプリ側の `new Date()` を使うと、
   * 時計がずれている構成で `finished_at >= started_at` の CHECK に当たる。
   */
  async finishOk(
    connection: Connection,
    id: string,
    summary: Readonly<Record<string, unknown>>,
  ): Promise<JobRun | null> {
    const row = await connection.db
      .updateTable('job_runs')
      .set({
        status: 'ok',
        finished_at: sql<Date>`now()`,
        summary: JSON.stringify(summary),
        error: null,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? null : toJobRun(row);
  },

  /** 失敗で閉じる。`message` は呼ぶ側が上限まで切っておく（`truncateError`）。 */
  async finishError(connection: Connection, id: string, message: string): Promise<JobRun | null> {
    const row = await connection.db
      .updateTable('job_runs')
      .set({ status: 'error', finished_at: sql<Date>`now()`, error: message })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? null : toJobRun(row);
  },

  /** 直近の実行（`skipped` も含む）。 */
  async findLatest(connection: Connection, name: JobName): Promise<JobRun | null> {
    return latest(connection, name, false);
  },

  /** 直近の成功。「最後にいつ集計できたか」はこれで答える。 */
  async findLatestSucceeded(connection: Connection, name: JobName): Promise<JobRun | null> {
    return latest(connection, name, true);
  },

  /** 直近のエラー（新しい順）。 */
  async listRecentErrors(
    connection: Connection,
    name: JobName,
    limit: number,
  ): Promise<readonly JobRun[]> {
    const rows = await connection.db
      .selectFrom('job_runs')
      .selectAll()
      .where('job_name', '=', name)
      .where('status', '=', 'error')
      .orderBy('started_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();

    return rows.map(toJobRun);
  },

  /**
   * そのジョブの記録を最新 `keep` 件に切り詰める（設計 §5.2）。
   *
   * 表が小さいので索引 1 本で足りる。**他のジョブの行には触れない。**
   */
  async trimHistory(connection: Connection, name: JobName, keep: number): Promise<void> {
    await connection.db
      .deleteFrom('job_runs')
      .where('job_name', '=', name)
      .where('id', 'not in', (eb) =>
        eb
          .selectFrom('job_runs')
          .select('id')
          .where('job_name', '=', name)
          .orderBy('started_at', 'desc')
          .orderBy('id', 'desc')
          .limit(keep),
      )
      .execute();
  },
};
