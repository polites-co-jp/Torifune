import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Connection } from '../database/provider';
import type { Schema } from '../database/schema';
import type { JobName } from '../domain/jobs/job';
import { log } from './logging';
import { processState } from './process-state';
import { redactSecrets } from './secret-text';

/**
 * ジョブの排他（029-scheduled-jobs 設計 §6.1.6）。
 *
 * **セッションレベルの advisory lock を、Pool から 1 本だけ確保した専用の接続で取る。**
 * トランザクションレベル（`pg_advisory_xact_lock`）にしないのは、ロールアップが
 * (site, day) ごとにトランザクションを張り、Webhook 配信が HTTP を待つため。
 * 1 つの長いトランザクションで包みたくない。
 *
 * ジョブ本体には**別の（通常の）接続**を渡す。ロックの接続はロックのためだけに使う。
 *
 * ## Database Provider への要求：セッション親和性
 *
 * この排他は **`connection.db.connection()` が 1 つの物理セッションに親和すること**を前提にしている。
 * 標準の PostgreSQL Provider（`database/postgres-provider.ts`）はこれを満たす。
 *
 * **Database Provider を差し替える Plugin は、セッション親和性を保つこと**（設計 §9）。
 * 1 つの `connection()` スコープ内のクエリを要求ごとに別の接続へ振り分ける実装（プロキシ・プール分散）だと、
 * `pg_try_advisory_lock` を取ったセッションと `pg_advisory_unlock` を呼ぶセッションが別になり、
 * **排他が例外も警告も出さずに効かなくなる。**
 * `DatabaseProvider` の型でこれを強制するのは Provider 契約そのものの変更なので、029 では行わない（設計 §11 #11）。
 */

/**
 * 鍵の名前空間（固定）。
 *
 * マイグレーションのロック（`packages/cli/src/migrate/lock.ts`）は 1 引数の 64bit 形なので、
 * 2 引数形のこちらとは鍵空間が別になり衝突しない。
 */
export const JOB_LOCK_NAMESPACE = 7_602_931;

/**
 * ジョブ名から鍵（符号付き 32bit 整数）を作る。
 *
 * `sha256(name)` の先頭 4 バイト。プロセスをまたいで同じ値になる。
 * テストと E2E が同じ鍵を計算するので export する。
 */
export function jobLockKey(name: string): number {
  return createHash('sha256').update(name).digest().readInt32BE(0);
}

export interface JobLockHandle {
  /**
   * ロックを解放し、専用接続を Pool へ返す。2 回目以降は何もしない。
   *
   * **通常は投げない**（解放クエリの失敗は握って `log.warn` を出す）。
   * ロックのセッション本体が既に失敗していた場合だけ投げうるので、
   * 呼ぶ側が `try/catch` で包む（設計 §6.1.5 手順 5）。
   */
  release(): Promise<void>;
}

/**
 * ロック取得の結果。**競合と失敗を必ず分ける**（設計 §6.1.6）。
 *
 * 「取れなかった」に丸めると、DB 停止や Pool 枯渇が「他が実行中」（`skipped` / 409）として
 * 記録され、監視できるようにするという 029 の目的が崩れる。
 */
export type LockOutcome =
  | { readonly ok: true; readonly lock: JobLockHandle }
  /** 他が保持している、または**このプロセスの待機枠が埋まっている**。接続は pin していない。 */
  | { readonly ok: false; readonly reason: 'busy' }
  /** ロックのセッション自体が失敗した（Pool 枯渇・DB 停止・権限エラーなど）。競合ではない。 */
  | { readonly ok: false; readonly reason: 'failed'; readonly error: unknown };

/**
 * ロック待ちに入っているジョブ（プロセスに 1 つ）。
 *
 * `pg_advisory_lock` の待ちは専用接続を pin したままブロックする。
 * `POST /api/v1/analytics/rollup` の Permission は `analytics.read` で**閲覧者ロールも持つ**ため、
 * 1 アカウントが並列に叩くだけで待機中の pin が積み上がり、Pool（既定 `max = 10`）を使い切って
 * ログイン・画面描画まで止められる。
 *
 * **ジョブごとに「ロック待ちに入れるのは 1 本まで」**（設計 §6.1.6、ユーザー裁定）。
 * あふれた呼び出しは接続を取らずに即座に `busy` を返す。
 *
 * 置き場を Infrastructure にしたのは、守っている資源が「DB 接続 Pool の pin」であり、
 * 待てる本数がロックの取得契約そのものだから。Application 層は「待つか待たないか」だけを決める。
 */
function waitingJobs(): Set<JobName> {
  return processState('jobs.lock-waiting', () => new Set<JobName>());
}

/** テスト用。待機枠を空に戻す。 */
export function resetJobLockWaitingForTests(): void {
  waitingJobs().clear();
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** ロック待ちの打ち切り（`lock_timeout`）。**競合であって失敗ではない。** */
const LOCK_NOT_AVAILABLE = '55P03';

function reasonOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** 待たずに取る。取れなければ false。 */
async function tryAcquire(pinned: Kysely<Schema>, key: number): Promise<boolean> {
  const result = await sql<{
    locked: boolean;
  }>`SELECT pg_try_advisory_lock(${JOB_LOCK_NAMESPACE}, ${key}) AS locked`.execute(pinned);
  return result.rows[0]?.locked ?? false;
}

/**
 * 最大 `waitMs` だけ待って取る。取れなければ（`lock_timeout`）false。
 *
 * `lock_timeout` で待ちを打ち切る。`SET LOCAL` 相当（`set_config(..., true)`）にしてあるので、
 * コミット／ロールバックで戻り、Pool へ返す接続を汚さない。
 * セッションレベルの advisory lock はコミット後も保持される。
 *
 * **`COMMIT` も同じ `try` の中に入れる**（設計 §6.1.6）。`COMMIT` が失敗すると、
 * ロックを取得済みのまま接続が Pool へ戻り、そのジョブが誰にも取れなくなる。
 * 失敗したら `pg_advisory_unlock` を試してから投げ直す（呼ぶ側が `failed` に写す）。
 */
async function acquireWithWait(
  pinned: Kysely<Schema>,
  key: number,
  waitMs: number,
): Promise<boolean> {
  try {
    await sql`BEGIN`.execute(pinned);
    await sql`SELECT set_config('lock_timeout', ${`${waitMs}ms`}, true)`.execute(pinned);
    await sql`SELECT pg_advisory_lock(${JOB_LOCK_NAMESPACE}, ${key})`.execute(pinned);
    await sql`COMMIT`.execute(pinned);
  } catch (error) {
    // **ROLLBACK を忘れると、接続が aborted のまま Pool へ戻る。**
    await sql`ROLLBACK`.execute(pinned).catch(() => undefined);

    if (codeOf(error) === LOCK_NOT_AVAILABLE) {
      return false;
    }

    // `COMMIT` の失敗なら取得済みかもしれない。握ったまま接続を返さない。
    await sql`SELECT pg_advisory_unlock(${JOB_LOCK_NAMESPACE}, ${key})`
      .execute(pinned)
      .catch(() => undefined);
    throw error;
  }
  return true;
}

/**
 * 専用接続を 1 本 pin して鍵を取る。
 *
 * `execute` のコールバックは `release()` まで終わらせない（終えると接続が Pool へ戻る）。
 */
async function acquireSession(
  connection: Connection,
  name: JobName,
  waitMs: number,
): Promise<LockOutcome> {
  const key = jobLockKey(name);
  const acquired = deferred<LockOutcome>();
  const released = deferred<void>();
  const session: { promise: Promise<unknown> } = { promise: Promise.resolve() };
  let settled = false;

  const settle = (outcome: LockOutcome): void => {
    if (!settled) {
      settled = true;
      acquired.resolve(outcome);
    }
  };

  session.promise = connection.db.connection().execute(async (pinned) => {
    const locked =
      waitMs > 0 ? await acquireWithWait(pinned, key, waitMs) : await tryAcquire(pinned, key);

    if (!locked) {
      settle({ ok: false, reason: 'busy' });
      return;
    }

    let done = false;
    settle({
      ok: true,
      lock: {
        async release(): Promise<void> {
          if (!done) {
            done = true;
            released.resolve();
          }
          // 解放が終わって接続が Pool へ戻るまで待つ。
          // セッション本体が既に失敗していれば、ここで投げる（呼ぶ側が握る）。
          await session.promise;
        },
      },
    });

    await released.promise;

    // 解放クエリの失敗は握る（接続を閉じればロックは落ちる）。ただし黙らない。
    try {
      await sql`SELECT pg_advisory_unlock(${JOB_LOCK_NAMESPACE}, ${key})`.execute(pinned);
    } catch (error) {
      log.warn('job lock could not be released', { job: name, reason: reasonOf(error) });
    }
  });

  session.promise.catch((error: unknown) => {
    // **競合ではなく失敗**（設計 §6.1.6）。呼ぶ側が `job_runs` に `error` として残す。
    settle({ ok: false, reason: 'failed', error });
    // 取得後に落ちた場合、`release()` を待ち続けさせない。
    released.resolve();
  });

  return acquired.promise;
}

export const jobLock = {
  /**
   * ジョブのロックを取る。
   *
   * `waitMs > 0` なら最大その時間だけ待つ（手動 API）。定期実行は待たずにスキップする
   * （次の周期にまた来る。待つと周期がずれていく）。
   *
   * **待つ呼び出しはジョブごとに 1 本まで。** あふれた分は接続を取らずに `busy` を返す。
   */
  async acquire(
    connection: Connection,
    name: JobName,
    options: { readonly waitMs: number },
  ): Promise<LockOutcome> {
    if (options.waitMs <= 0) {
      // 待たないので pin は往復 1 回ぶん。ゲートを通さない。
      return acquireSession(connection, name, 0);
    }

    const waiting = waitingJobs();
    if (waiting.has(name)) {
      log.debug('job lock wait slot is taken', { job: name });
      return { ok: false, reason: 'busy' };
    }

    waiting.add(name);
    try {
      return await acquireSession(connection, name, options.waitMs);
    } finally {
      waiting.delete(name);
    }
  },
};
