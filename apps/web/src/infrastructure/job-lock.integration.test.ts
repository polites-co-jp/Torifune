import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withConnection } from '@/application/transaction';
import type { JobName } from '@/domain/jobs/job';
import {
  JOB_LOCK_NAMESPACE,
  jobLock,
  jobLockKey,
  resetJobLockWaitingForTests,
  type JobLockHandle,
  type LockOutcome,
} from '@/infrastructure/job-lock';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * ジョブの排他（029-scheduled-jobs 設計 §6.1.6、受け入れ条件 #12〜#16、#66、#73）。
 *
 * セッションレベルの advisory lock を、Pool から 1 本だけ確保した専用の接続で取る。
 * 「別の保持者」は同じ DB へ別に張った `pg.Client` で、`pg_try_advisory_lock(NS, key)` を直接叩く。
 * 鍵は 2 引数形 `(JOB_LOCK_NAMESPACE, jobLockKey(name))`。
 *
 * `acquire` は `LockOutcome` を返し、**競合（`busy`）とセッションの失敗（`failed`）を分ける**（A-3）。
 * `waitMs > 0` の待機はジョブごとにプロセス内で 1 本までに絞る（待機枠のゲート。A-1）。
 */

let scratch: ScratchDatabase;
/** テスト中に開いた別保持者。後始末で必ず閉じる（閉じればロックは落ちる）。 */
const outsiders: pg.Client[] = [];
/** テスト中に取ったハンドル。後始末で解放する。 */
const handles: JobLockHandle[] = [];

async function outsider(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();
  outsiders.push(client);
  return client;
}

async function tryLockFrom(client: pg.Client, name: string): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1, $2) AS locked',
    [JOB_LOCK_NAMESPACE, jobLockKey(name)],
  );
  return result.rows[0]?.locked ?? false;
}

async function unlockFrom(client: pg.Client, name: string): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1, $2)', [JOB_LOCK_NAMESPACE, jobLockKey(name)]);
}

async function acquire(name: JobName, waitMs = 0): Promise<LockOutcome> {
  const outcome = await withConnection((connection) =>
    jobLock.acquire(connection, name, { waitMs }),
  );
  if (outcome.ok) handles.push(outcome.lock);
  return outcome;
}

/** 取れたハンドル（取れていなければテストを落とす）。 */
function lockOf(outcome: LockOutcome): JobLockHandle {
  if (!outcome.ok) throw new Error(`ロックが取れなかった: ${outcome.reason}`);
  return outcome.lock;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** この使い捨て DB へ張られている接続の本数（自分の問い合わせ用の接続を含む）。 */
async function backendCount(client: pg.Client): Promise<number> {
  const result = await client.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = current_database()',
  );
  return Number(result.rows[0]?.count ?? '0');
}

beforeAll(async () => {
  scratch = await useScratchDatabase('joblock');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    try {
      await handle.release();
    } catch {
      // 後始末なので、解放できなくても次のテストへ進む（接続が閉じればロックは落ちる）。
    }
  }
  for (const client of outsiders.splice(0)) {
    await client.end();
  }
  // 待機枠のゲート（`processState('jobs.lock-waiting', …)`）を空に戻す。
  resetJobLockWaitingForTests();
});

describe('鍵', () => {
  it('名前空間は 7602931 で、鍵はジョブ名ごとに違う符号付き 32bit 整数', () => {
    expect(JOB_LOCK_NAMESPACE).toBe(7_602_931);

    const rollup = jobLockKey('analytics.rollup');
    const webhook = jobLockKey('webhook.deliver');
    expect(Number.isInteger(rollup)).toBe(true);
    expect(rollup).toBeGreaterThanOrEqual(-(2 ** 31));
    expect(rollup).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(rollup).not.toBe(webhook);
    // 決定的（プロセスをまたいで同じ鍵になる）。
    expect(jobLockKey('analytics.rollup')).toBe(rollup);
  });
});

describe('取得と解放', () => {
  /** #12 */
  it('取得中は別の接続から取れず、release() 後は取れる', async () => {
    const outcome = await acquire('analytics.rollup');
    expect(outcome.ok).toBe(true);

    const other = await outsider();
    expect(await tryLockFrom(other, 'analytics.rollup')).toBe(false);

    await lockOf(outcome).release();
    expect(await tryLockFrom(other, 'analytics.rollup')).toBe(true);
    await unlockFrom(other, 'analytics.rollup');
  });

  /** #13 */
  it('別の保持者がいる間は null を返す', async () => {
    const other = await outsider();
    expect(await tryLockFrom(other, 'analytics.rollup')).toBe(true);

    const outcome = await acquire('analytics.rollup');

    // 競合であって失敗ではない（A-3）。
    expect(outcome).toEqual({ ok: false, reason: 'busy' });
  });

  /** #13。ジョブ名が違えば別の鍵。 */
  it('別の保持者が analytics.rollup を持っていても webhook.deliver は取れる', async () => {
    const other = await outsider();
    expect(await tryLockFrom(other, 'analytics.rollup')).toBe(true);

    const outcome = await acquire('webhook.deliver');

    expect(outcome.ok).toBe(true);
  });

  /** #16 */
  it('release() を 2 回呼んでも例外にならない', async () => {
    const outcome = await acquire('analytics.rollup');
    expect(outcome.ok).toBe(true);
    const lock = lockOf(outcome);

    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });
});

describe('待つ取得（waitMs > 0）', () => {
  /** #14。保持側が 500ms 後に解放すれば取れる。 */
  it('waitMs: 2000 のとき、保持側が 500ms 後に解放すれば取得できる', async () => {
    const other = await outsider();
    expect(await tryLockFrom(other, 'analytics.rollup')).toBe(true);
    const releaseLater = sleep(500).then(() => unlockFrom(other, 'analytics.rollup'));

    const started = Date.now();
    const outcome = await acquire('analytics.rollup', 2000);
    await releaseLater;

    expect(outcome.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  /** #14。解放しなければ約 2 秒後に null（3 秒以内）。 */
  it('waitMs: 2000 のとき、保持側が解放しなければ約 2 秒後に null を返す', async () => {
    const other = await outsider();
    expect(await tryLockFrom(other, 'analytics.rollup')).toBe(true);

    const started = Date.now();
    const outcome = await acquire('analytics.rollup', 2000);
    const elapsed = Date.now() - started;

    // `lock_timeout`（55P03）は競合。失敗にしない（A-3）。
    expect(outcome).toEqual({ ok: false, reason: 'busy' });
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThanOrEqual(3000);
  });

  /** #14。`SET LOCAL lock_timeout` はコミット／ロールバックで戻り、Pool の接続を汚さない。 */
  it('打ち切った後も、Pool から取った接続の lock_timeout は既定値のまま', async () => {
    const other = await outsider();
    expect(await tryLockFrom(other, 'analytics.rollup')).toBe(true);
    expect((await acquire('analytics.rollup', 1000)).ok).toBe(false);
    await unlockFrom(other, 'analytics.rollup');
    // 取れた場合の経路（BEGIN → SET LOCAL → 取得 → COMMIT）でも残らない。
    const outcome = await acquire('analytics.rollup', 1000);
    expect(outcome.ok).toBe(true);
    await lockOf(outcome).release();

    // Pool（上限 4）の接続を同時に 4 本使って、どれにも残っていないことを見る。
    const values = await Promise.all(
      [1, 2, 3, 4].map(() =>
        withConnection(async (connection) => {
          const result = await sql<{ lock_timeout: string }>`SHOW lock_timeout`.execute(
            connection.db,
          );
          return result.rows[0]?.lock_timeout;
        }),
      ),
    );

    expect(values).toEqual(['0', '0', '0', '0']);
  });
});

/**
 * 待機枠のゲート（設計 §6.1.6、受け入れ条件 #66。security-reviewer A-1）。
 *
 * `pg_advisory_lock` の待ちは専用接続を pin したままブロックする。`POST /analytics/rollup` は
 * `analytics.read`（閲覧者ロールも持つ）なので、1 アカウントが並列に叩くだけで待機中の pin が積み上がり、
 * Pool を使い切ってログイン・画面描画まで止められる。
 *
 * **ジョブごとに「ロック待ちに入れるのは 1 本まで」**（ユーザー裁定）。
 * あふれた呼び出しは接続を取らずに即座に `busy` を返す。
 */
describe('待機枠のゲート', () => {
  /** #66 */
  it('待っているものがある間、2 本目の acquire は 100ms 以内に busy を返す', async () => {
    const other = await outsider();
    expect(await tryLockFrom(other, 'analytics.rollup')).toBe(true);

    // 1 本目は待ちに入る（5 秒）。
    const first = acquire('analytics.rollup', 5000);
    await sleep(300);

    const started = Date.now();
    const second = await acquire('analytics.rollup', 5000);
    const elapsed = Date.now() - started;

    expect(second).toEqual({ ok: false, reason: 'busy' });
    expect(elapsed, '2 本目が待ちに入ってしまっている').toBeLessThan(100);
    // 1 本目はまだ待っている（2 本目が先に返った）。
    expect((await first).ok).toBe(false);
  }, 20_000);

  /** #66。弾かれた呼び出しは接続を pin しない。 */
  it('2 本目が返っても、この DB への接続数は 1 本目の待機中と変わらない', async () => {
    const observer = await outsider();
    const other = await outsider();
    expect(await tryLockFrom(other, 'analytics.rollup')).toBe(true);

    const first = acquire('analytics.rollup', 5000);
    await sleep(500);
    const during = await backendCount(observer);

    await acquire('analytics.rollup', 5000);
    await acquire('analytics.rollup', 5000);
    const after = await backendCount(observer);

    // 待機で pin されるのはジョブごとに 1 本。弾かれた 2 本は接続を取らない。
    expect(after).toBe(during);
    await first;
  }, 20_000);

  /** #66。枠はジョブごと。別のジョブは待てる。 */
  it('別のジョブ名なら同時に待てる', async () => {
    const other = await outsider();
    expect(await tryLockFrom(other, 'analytics.rollup')).toBe(true);
    expect(await tryLockFrom(other, 'webhook.deliver')).toBe(true);

    const first = acquire('analytics.rollup', 2000);
    await sleep(300);

    const started = Date.now();
    const second = await acquire('webhook.deliver', 2000);
    const elapsed = Date.now() - started;

    // 別の鍵なので待ちに入る（即座に弾かれない）。
    expect(second).toEqual({ ok: false, reason: 'busy' });
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    await first;
  }, 20_000);

  /** #66。枠は待ちが終われば戻る。 */
  it('1 本目が busy で抜けた後は、次の acquire がまた待機に入れる', async () => {
    const other = await outsider();
    expect(await tryLockFrom(other, 'analytics.rollup')).toBe(true);

    expect((await acquire('analytics.rollup', 1000)).ok).toBe(false);

    const started = Date.now();
    const next = await acquire('analytics.rollup', 1000);
    const elapsed = Date.now() - started;

    expect(next).toEqual({ ok: false, reason: 'busy' });
    // 枠が空いているので、即座に弾かれず待ちに入る。
    expect(elapsed, '枠が返っていない（即座に弾かれた）').toBeGreaterThanOrEqual(500);
  }, 20_000);

  /** #66 / #68 の前提。`waitMs === 0` はゲートを通らない。 */
  it('waitMs: 0 は待機中でも即座に busy を返す（ゲートを通らない）', async () => {
    const other = await outsider();
    expect(await tryLockFrom(other, 'analytics.rollup')).toBe(true);

    const first = acquire('analytics.rollup', 3000);
    await sleep(300);

    const started = Date.now();
    const outcomes = await Promise.all([
      acquire('analytics.rollup', 0),
      acquire('analytics.rollup', 0),
      acquire('analytics.rollup', 0),
    ]);
    const elapsed = Date.now() - started;

    expect(outcomes).toEqual([
      { ok: false, reason: 'busy' },
      { ok: false, reason: 'busy' },
      { ok: false, reason: 'busy' },
    ]);
    expect(elapsed).toBeLessThan(1000);
    await first;
  }, 20_000);
});

/**
 * セッションの失敗（設計 §6.1.6、受け入れ条件 #73。security-reviewer A-5）。
 *
 * `waitMs > 0` の取得はトランザクションの中で `pg_advisory_lock` を待つ。
 * その最中にセッションが落ちると（`COMMIT` の失敗もこれに当たる）、
 * **ロックを握ったまま接続が Pool へ戻ってはならない。**
 *
 * 待機中のバックエンドを `pg_terminate_backend` で落として再現する
 * （`COMMIT` だけを失敗させる注入は実装へ手を入れずに作れないため、
 * 「セッションが失敗したときに鍵が残らない」という同じ不変条件で見る）。
 */
describe('セッションの失敗', () => {
  /** 待機中（advisory lock を待っている）のバックエンドの pid。 */
  async function waitingBackendPid(client: pg.Client): Promise<number | null> {
    const result = await client.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND state = 'active'
         AND query ILIKE '%pg_advisory_lock%'
       LIMIT 1`,
    );
    return result.rows[0]?.pid ?? null;
  }

  /** #73 */
  it('待機中にセッションが落ちると failed を返し、ロックを握ったまま接続を返さない', async () => {
    const admin = await outsider();
    const holder = await outsider();
    expect(await tryLockFrom(holder, 'webhook.deliver')).toBe(true);

    const pending = acquire('webhook.deliver', 8000);

    // 待機中のバックエンドを見つけて落とす。
    let pid: number | null = null;
    for (let i = 0; i < 40 && pid === null; i += 1) {
      await sleep(100);
      pid = await waitingBackendPid(admin);
    }
    expect(pid, '待機中のバックエンドが見つからない').not.toBeNull();
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);

    const outcome = await pending;

    // 競合ではなく失敗（A-3）。
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('failed');
    }

    // 保持者が解放すれば、別の接続がその鍵を取れる（誰も握ったままになっていない）。
    await unlockFrom(holder, 'webhook.deliver');
    const another = await outsider();
    expect(await tryLockFrom(another, 'webhook.deliver')).toBe(true);
    await unlockFrom(another, 'webhook.deliver');
  }, 30_000);

  /** #73。失敗した後も待機枠が返り、次の取得ができる。 */
  it('失敗した後も Pool と待機枠が使える', async () => {
    const outcome = await acquire('analytics.rollup', 1000);
    expect(outcome.ok).toBe(true);
    await lockOf(outcome).release();

    const one = await withConnection(async (connection) => {
      const result = await sql<{ one: number }>`SELECT 1 AS one`.execute(connection.db);
      return result.rows[0]?.one;
    });
    expect(one).toBe(1);
  }, 20_000);
});

describe('接続の使い方', () => {
  /** #15。専用接続は解放後に Pool へ戻る。 */
  it('acquire → release を Pool 上限（4）より多い 20 回繰り返しても接続が枯渇しない', async () => {
    for (let i = 0; i < 20; i += 1) {
      const outcome = await withConnection((connection) =>
        jobLock.acquire(connection, 'analytics.rollup', { waitMs: 0 }),
      );
      expect(outcome.ok, `${i + 1} 回目`).toBe(true);
      if (outcome.ok) await outcome.lock.release();
    }

    // 枯渇していれば、ここで待ち続ける。
    const ok = await withConnection(async (connection) => {
      const result = await sql<{ one: number }>`SELECT 1 AS one`.execute(connection.db);
      return result.rows[0]?.one;
    });
    expect(ok).toBe(1);
  }, 15_000);

  /** #15。ロック保持中に通常の接続で SQL が実行できる（専用接続と通常接続が別）。 */
  it('ロック保持中に通常の接続で SELECT 1 が実行できる', async () => {
    const outcome = await acquire('analytics.rollup');
    expect(outcome.ok).toBe(true);

    const one = await withConnection(async (connection) => {
      const result = await sql<{ one: number }>`SELECT 1 AS one`.execute(connection.db);
      return result.rows[0]?.one;
    });

    expect(one).toBe(1);
    // 保持中であることを別の保持者から確かめる（解放されてしまっていない）。
    const other = await outsider();
    expect(await tryLockFrom(other, 'analytics.rollup')).toBe(false);
  });
});
