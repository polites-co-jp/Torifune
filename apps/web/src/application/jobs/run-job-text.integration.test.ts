import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runJob } from '@/application/jobs/run-job';
import type { JobDefinition } from '@/application/jobs/scheduler';
import { withConnection } from '@/application/transaction';
import type { Connection } from '@/database/provider';
import type { JobName } from '@/domain/jobs/job';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * ジョブの失敗の文言の NUL・対になっていないサロゲート（L4。046-input-500-nul-and-ranges 設計 §4.1・§9.4、受け入れ条件 #36）。
 *
 * `runJob` の中で `Error('x\u0000')` を投げるジョブは、`job_runs` に `status = 'error'` の行を残し、
 * `error` 列は NUL を含まない（U+FFFD に置き換えて記録する）。いまは記録の失敗になり、失敗の履歴が残らない。
 *
 * `run-job.integration.test.ts` の `jobOf`・`rowsOf` を写した。**ソースに壊れた文字を置かない。**
 */

const REPLACEMENT = String.fromCodePoint(0xfffd);

interface JobRunRow {
  readonly job_name: string;
  readonly status: string;
  readonly error: string | null;
}

let scratch: ScratchDatabase;

function capture(): { records: LogRecord[] } {
  const records: LogRecord[] = [];
  setLogger({
    log(level, message, fields) {
      records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    },
  });
  return { records };
}

/** テスト用のジョブ定義。`run` の中身だけ差し替える。 */
function jobOf(
  name: JobName,
  run: (connection: Connection) => Promise<Readonly<Record<string, unknown>>>,
): JobDefinition<undefined> {
  return { name, intervalMs: 60_000, run };
}

async function rowsOf(name: string): Promise<JobRunRow[]> {
  return withConnection(async (connection) => {
    const result = await sql<JobRunRow>`
      SELECT job_name, status, error FROM job_runs WHERE job_name = ${name} ORDER BY started_at DESC
    `.execute(connection.db);
    return result.rows;
  });
}

async function runFailing(message: string): Promise<void> {
  const job = jobOf('analytics.rollup', async () => {
    throw new Error(message);
  });
  await withConnection((connection) =>
    runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
  );
}

beforeAll(async () => {
  scratch = await useScratchDatabase('runjobtext');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(async () => {
  resetLogger();
  await withConnection((connection) => sql`DELETE FROM job_runs`.execute(connection.db));
});

describe('#36 ジョブの例外の文言に NUL があっても job_runs に記録する', () => {
  it("#36 Error('x\\u0000') を投げるジョブ → status = 'error' の行が 1 つ残る", async () => {
    capture();

    await runFailing('x\u0000');

    const rows = await rowsOf('analytics.rollup');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('error');
  });

  it("#36 Error('x\\u0000') を投げるジョブ → error が NUL を含まず、U+FFFD を含む", async () => {
    capture();

    await runFailing('x\u0000');

    const error = (await rowsOf('analytics.rollup'))[0]?.error ?? null;
    expect(error).not.toBeNull();
    expect(error ?? '').not.toContain('\u0000');
    expect(error).toBe(`x${REPLACEMENT}`);
  });

  it("#36 Error('x\\ud800') を投げるジョブ → error の片割れが U+FFFD になる", async () => {
    capture();

    await runFailing('x\ud800');

    const rows = await rowsOf('analytics.rollup');
    expect(rows[0]?.status).toBe('error');
    expect(rows[0]?.error).toBe(`x${REPLACEMENT}`);
  });

  it('#36 対照：NUL の無い文言はそのまま記録される', async () => {
    capture();

    await runFailing('集計に失敗した');

    expect((await rowsOf('analytics.rollup'))[0]?.error).toBe('集計に失敗した');
  });
});
