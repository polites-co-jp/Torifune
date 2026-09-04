import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { defineRoute } from './route';

/**
 * 想定外の例外をログへ載せるときの秘匿（029-scheduled-jobs 検証の反映。
 * 受け入れ条件 #83。security-reviewer M-2）。
 *
 * `run-job.ts` は `redactSecrets` → `truncateError` を通して `job_runs.error` に書くが、
 * `app/api/v1/analytics/rollup/route.ts` などが**投げ直した生の例外**は
 * `api/route.ts` の catch-all（`log.error('unhandled error in route', { reason })`）に届き、
 * **無加工でログに出る**。`logging.ts` の `maskSecrets` はキー名で落とす仕組みなので、
 * `reason` の中身（自由文）には効かない。
 *
 * DB に伏せて書いた値が、同じ例外からログへ素通りするのでは秘匿になっていない。
 *
 * **catch-all そのものを見る。** 検証用のルートを 1 つ定義して、
 * 接続文字列を含む例外を投げさせる（どの UseCase から来た例外でも同じ経路を通る）。
 * `buildAuthorizationContext` が接続を要るので結合テストにする。
 */

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

function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') throw new Error('DATABASE_URL が要る');
  return url;
}

/** `postgresql://user:password@host` の password 部分。 */
function passwordOf(url: string): string {
  return /\/\/[^:/@\s]+:([^@\s]+)@/.exec(url)?.[1] ?? '';
}

/**
 * 例外を投げるだけのルート。
 *
 * 認証・CSRF を通さずに catch-all まで届かせたいので、GET・`permission: null`。
 * OpenAPI には載せない（`documented: false`）。
 */
function throwingRoute(error: unknown) {
  return defineRoute({
    operationId: `testThrow${Math.random().toString(36).slice(2, 8)}`,
    method: 'GET',
    path: '/__test/throwing',
    summary: '検証用。必ず失敗する',
    permission: null,
    reason: '検証用のルート。認可の判断をしない',
    documented: false,
    rateLimit: 'none',
    handler: () => {
      throw error;
    },
  });
}

async function call(handler: ReturnType<typeof throwingRoute>): Promise<Response> {
  return handler(new Request('http://127.0.0.1:3000/api/v1/__test/throwing'));
}

beforeAll(async () => {
  scratch = await useScratchDatabase('routeredact');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(() => {
  resetLogger();
});

describe('catch-all のログ', () => {
  /** #83 */
  it('接続文字列を含む例外でも、reason に接続文字列が出ない', async () => {
    const { records } = capture();
    const url = databaseUrl();
    const handler = throwingRoute(new Error(`connect ECONNREFUSED ${url}`));

    const response = await call(handler);

    expect(response.status).toBe(500);
    const logged = records.find((record) => record.message === 'unhandled error in route');
    expect(logged, 'catch-all のログが出ていない').toBeDefined();
    expect(logged?.level).toBe('error');
    const reason = String(logged?.fields?.['reason'] ?? '');
    expect(reason).not.toContain(url);
    expect(reason).toContain('***');
  });

  /** #83。`scheme://user:password@host` の形なら DATABASE_URL 以外でも伏せる。 */
  it('別の接続文字列を含む例外でも、credential が出ない', async () => {
    const { records } = capture();
    const handler = throwingRoute(
      new Error('provider failed: postgresql://appuser:sup3rs3cret@db.internal:5432/torifune'),
    );

    await call(handler);

    const reason = String(
      records.find((record) => record.message === 'unhandled error in route')?.fields?.['reason'] ??
        '',
    );
    expect(reason).not.toContain('sup3rs3cret');
    expect(reason).toContain('***');
  });

  /** #83。password 部分が単独で出ても伏せる。 */
  it('接続文字列の password 部分が単独で出ても、reason に出ない', async () => {
    const { records } = capture();
    const password = passwordOf(databaseUrl());
    expect(password.length, 'DATABASE_URL に password が無い').toBeGreaterThan(0);
    const handler = throwingRoute(new Error(`password authentication failed: ${password}`));

    await call(handler);

    const reason = String(
      records.find((record) => record.message === 'unhandled error in route')?.fields?.['reason'] ??
        '',
    );
    expect(reason).not.toContain(password);
  });

  /** #83。Error でない値を投げられても落ちない。 */
  it('Error でない値を投げても catch-all が動き、接続文字列は出ない', async () => {
    const { records } = capture();
    const url = databaseUrl();
    const handler = throwingRoute(`failed with ${url}`);

    const response = await call(handler);

    expect(response.status).toBe(500);
    const reason = String(
      records.find((record) => record.message === 'unhandled error in route')?.fields?.['reason'] ??
        '',
    );
    expect(reason).not.toContain(url);
  });

  /** #83 の対。伏せるのは接続情報だけで、原因の手がかりは残す。 */
  it('接続情報を含まない例外のメッセージはそのまま出る', async () => {
    const { records } = capture();
    const handler = throwingRoute(new Error('集計に失敗した'));

    await call(handler);

    const reason = String(
      records.find((record) => record.message === 'unhandled error in route')?.fields?.['reason'] ??
        '',
    );
    expect(reason).toBe('集計に失敗した');
  });

  /** #83。応答本文には従来どおり何も出さない（05_API設計.md §11）。 */
  it('応答本文に例外の内容が出ない', async () => {
    capture();
    const url = databaseUrl();
    const handler = throwingRoute(new Error(`connect ECONNREFUSED ${url}`));

    const text = await (await call(handler)).text();

    expect(text).not.toContain(url);
    expect(text).not.toContain('ECONNREFUSED');
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });
});
