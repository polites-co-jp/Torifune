import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import { createHash } from 'node:crypto';
import pg from 'pg';

/**
 * 定期実行ジョブの API（029-scheduled-jobs 設計 §6.3 / §6.5、受け入れ条件 #41〜#45）。
 *
 * - `GET /api/v1/jobs`（`system.manage`）：監視用。200 / 401 / 403
 * - `POST /api/v1/analytics/rollup` / `POST /api/v1/webhooks/deliver` は `runJob` 経由になり、
 *   応答の形は変えずに `job_runs` へ `triggered_by = 'manual'` で記録される。
 *   別の接続がロックを保持していれば 10 秒待って 409 `CONFLICT` + `Retry-After: 10`
 *
 * E2E は定期実行が有効（`TORIFUNE_ROLLUP_INTERVAL_MINUTES=1`）な状態で走る。
 * ロックを保持している間に定期側が `skipped` を記録することがあるので、`job_runs` は
 * `triggered_by = 'manual'` と開始時刻で絞って読む。
 */

const origin = 'http://127.0.0.1:3000';

/** `infrastructure/job-lock.ts` と同じ鍵（設計 §6.1.6）。 */
const JOB_LOCK_NAMESPACE = 7_602_931;

function jobLockKey(name: string): number {
  return createHash('sha256').update(name).digest().readInt32BE(0);
}

const SERVER_TIME_ZONE = 'Asia/Tokyo';

function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SERVER_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

function headers(token: string): Record<string, string> {
  return { 'X-CSRF-Token': token, Origin: origin };
}

async function withDatabase<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const connectionString = process.env['DATABASE_URL'];
  expect(connectionString, 'E2E には DATABASE_URL が必要').toBeTruthy();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

interface JobRunRow {
  readonly job_name: string;
  readonly triggered_by: string;
  readonly status: string;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly summary: Record<string, unknown>;
}

/** `since` 以降に始まった手動（API）の記録を新しい順に読む。 */
async function manualRunsSince(jobName: string, since: Date): Promise<JobRunRow[]> {
  return withDatabase(async (client) => {
    const result = await client.query<JobRunRow>(
      `SELECT job_name, triggered_by, status, started_at, finished_at, summary
       FROM job_runs
       WHERE job_name = $1 AND triggered_by = 'manual' AND started_at >= $2
       ORDER BY started_at DESC`,
      [jobName, since],
    );
    return result.rows;
  });
}

/**
 * 別の接続でジョブのロックを保持したまま `fn` を実行する。
 *
 * セッションレベルの advisory lock は接続を閉じれば落ちる。
 */
async function whileHoldingLock<T>(jobName: string, fn: () => Promise<T>): Promise<T> {
  return withDatabase(async (client) => {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [JOB_LOCK_NAMESPACE, jobLockKey(jobName)],
    );
    expect(locked.rows[0]?.locked, '定期実行と重なった。やり直す').toBe(true);
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        JOB_LOCK_NAMESPACE,
        jobLockKey(jobName),
      ]);
    }
  });
}

/** 数秒前（サーバーとクライアントの時計のずれを吸収する）。 */
function shortlyBefore(): Date {
  return new Date(Date.now() - 5_000);
}

/** `since` 以降に始まった手動（API）の記録の件数。 */
async function manualRunCount(jobName: string, since: Date): Promise<number> {
  return (await manualRunsSince(jobName, since)).length;
}

/** `YYYY-MM-DD` を日数ぶんずらす（文字列の日付演算。タイムゾーンに依らない）。 */
function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * `viewer` ロールの利用者でログインした request context。
 *
 * `viewer` は `analytics.read` を持ち `system.manage` を持たない。
 */
async function viewerContext(
  request: APIRequestContext,
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<APIRequestContext> {
  const token = await csrf(request);
  const loginId = `e2e_jobs_viewer_${Math.random().toString(36).slice(2, 10)}`;
  const password = 'e2e jobs viewer correct horse battery staple';
  const created = await request.post('/api/v1/users', {
    headers: headers(token),
    data: {
      loginId,
      displayName: `E2E ${loginId}`,
      email: `${loginId}@example.com`,
      password,
      roles: ['viewer'],
      csrfToken: token,
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  const context = await playwright.request.newContext({ baseURL: origin });
  const loginToken = await csrf(context);
  const login = await context.post('/api/v1/auth/login', {
    headers: headers(loginToken),
    data: { loginId, password, csrfToken: loginToken },
  });
  expect(login.status(), await login.text()).toBe(200);
  return context;
}

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

interface JobRunBody {
  readonly id: string;
  readonly jobName: string;
  readonly triggeredBy: string;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: string | null;
  readonly summary: Record<string, unknown>;
  readonly runner: string | null;
}

interface JobStatusBody {
  readonly name: string;
  readonly scheduled: boolean;
  readonly intervalMinutes: number;
  readonly nextRunAt: string | null;
  readonly running: boolean;
  readonly lastRun: JobRunBody | null;
  readonly lastSuccess: JobRunBody | null;
  readonly recentErrors: JobRunBody[];
}

async function rollup(
  request: APIRequestContext,
  extra: Record<string, unknown> = {},
): Promise<APIResponse> {
  const token = await csrf(request);
  return request.post('/api/v1/analytics/rollup', {
    headers: headers(token),
    data: { from: today(), to: today(), csrfToken: token, ...extra },
  });
}

async function deliver(request: APIRequestContext): Promise<APIResponse> {
  const token = await csrf(request);
  return request.post('/api/v1/webhooks/deliver', {
    headers: headers(token),
    data: { csrfToken: token },
  });
}

/**
 * #41。`GET /api/v1/jobs`。
 */
test.describe('GET /api/v1/jobs', () => {
  test('200 で { data: [{ name, scheduled, intervalMinutes, nextRunAt, running, lastRun, lastSuccess, recentErrors }] } を返す', async ({
    request,
  }) => {
    const response = await request.get('/api/v1/jobs');
    expect(response.status(), await response.text()).toBe(200);

    const body = (await response.json()) as { data: JobStatusBody[] };
    expect(Object.keys(body)).toEqual(['data']);
    expect(body.data.map((job) => job.name)).toEqual(['analytics.rollup', 'webhook.deliver']);
    for (const job of body.data) {
      expect(Object.keys(job).sort()).toEqual(
        [
          'name',
          'scheduled',
          'intervalMinutes',
          'nextRunAt',
          'running',
          'lastRun',
          'lastSuccess',
          'recentErrors',
        ].sort(),
      );
      expect(typeof job.scheduled).toBe('boolean');
      expect(typeof job.intervalMinutes).toBe('number');
      expect(typeof job.running).toBe('boolean');
      expect(Array.isArray(job.recentErrors)).toBe(true);
    }
    // E2E は定期実行が有効（ロールアップ 1 分）。
    const rollupJob = body.data.find((job) => job.name === 'analytics.rollup');
    expect(rollupJob?.scheduled).toBe(true);
    expect(rollupJob?.intervalMinutes).toBe(1);
  });

  test('日時は ISO 8601 の文字列', async ({ request }) => {
    // 手動で 1 回流して lastRun を埋める。
    expect((await rollup(request)).status()).toBe(200);

    const body = (await (await request.get('/api/v1/jobs')).json()) as { data: JobStatusBody[] };
    const rollupJob = body.data.find((job) => job.name === 'analytics.rollup');

    expect(rollupJob?.nextRunAt).toMatch(ISO_8601);
    expect(rollupJob?.lastRun).not.toBeNull();
    expect(rollupJob?.lastRun?.startedAt).toMatch(ISO_8601);
    expect(rollupJob?.lastRun?.finishedAt).toMatch(ISO_8601);
    expect(Object.keys(rollupJob?.lastRun ?? {}).sort()).toEqual(
      [
        'id',
        'jobName',
        'triggeredBy',
        'status',
        'startedAt',
        'finishedAt',
        'error',
        'summary',
        'runner',
      ].sort(),
    );
    expect(rollupJob?.lastSuccess?.status).toBe('ok');
  });

  test('未認証では 401', async ({ request }) => {
    const response = await request.get('/api/v1/jobs', { headers: { Cookie: '' } });
    expect(response.status()).toBe(401);
  });

  test('system.manage を持たない viewer では 403', async ({ request, playwright }) => {
    const viewer = await viewerContext(request, playwright);
    try {
      const response = await viewer.get('/api/v1/jobs');
      expect(response.status()).toBe(403);
    } finally {
      await viewer.dispose();
    }
  });

  test('OpenAPI に応答スキーマが宣言されている', async ({ request }) => {
    const document = (await (await request.get('/api/v1/openapi.json')).json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId: string;
            security?: unknown[];
            responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
          }
        >
      >;
    };

    const operation = document.paths['/jobs']?.['get'];
    expect(operation?.operationId).toBe('listJobStatuses');
    expect(operation?.security).toBeDefined();
    expect(operation?.responses['200']?.content?.['application/json']?.schema).toBeDefined();
  });
});

/**
 * #42〜#44。`POST /api/v1/analytics/rollup` の経路変更。
 */
test.describe('POST /api/v1/analytics/rollup', () => {
  /** #42 */
  test('従来どおり 200 で { from, to, days, points, pruned } を返し、job_runs に manual / ok で記録される', async ({
    request,
  }) => {
    const since = shortlyBefore();

    const response = await rollup(request);
    expect(response.status(), await response.text()).toBe(200);

    const body = (await response.json()) as {
      data: { from: string; to: string; days: number; points: number; pruned: number };
    };
    expect(Object.keys(body.data).sort()).toEqual(['days', 'from', 'points', 'pruned', 'to']);
    expect(body.data.from).toBe(today());
    expect(body.data.to).toBe(today());

    const runs = await manualRunsSince('analytics.rollup', since);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const run = runs[0];
    expect(run?.status).toBe('ok');
    expect(run?.triggered_by).toBe('manual');
    expect(run?.summary['from']).toBe(body.data.from);
    expect(run?.summary['to']).toBe(body.data.to);
  });

  /** #43。10 秒待っても取れなければ 409。 */
  test('別の接続がロックを保持している間は約 10 秒後に 409 CONFLICT と Retry-After: 10 を返し、skipped が記録される', async ({
    request,
  }) => {
    test.setTimeout(20_000);
    const since = shortlyBefore();

    const { response, elapsed } = await whileHoldingLock('analytics.rollup', async () => {
      const started = Date.now();
      const held = await rollup(request);
      return { response: held, elapsed: Date.now() - started };
    });

    expect(response.status(), await response.text()).toBe(409);
    expect(elapsed).toBeGreaterThanOrEqual(9_000);
    expect(response.headers()['retry-after']).toBe('10');
    const body = (await response.json()) as {
      error: { code: string; message: string; details?: Record<string, string[]> };
    };
    expect(body.error.code).toBe('CONFLICT');
    expect(Array.isArray(body.error.details?.['job'])).toBe(true);
    expect(body.error.details?.['job']?.[0]).toContain('実行中');

    const runs = await manualRunsSince('analytics.rollup', since);
    expect(runs.map((run) => run.status)).toContain('skipped');
  });

  /** #44。prune はロックの外で現行どおり。 */
  test('pruneOlderThanDays を付けると pruned が数で返り、応答後にロックは解放されている', async ({
    request,
  }) => {
    const response = await rollup(request, { pruneOlderThanDays: 3650 });
    expect(response.status(), await response.text()).toBe(200);

    const body = (await response.json()) as { data: { pruned: number } };
    expect(typeof body.data.pruned).toBe('number');

    // 集計のロックは応答の時点で解放されている（prune の間も握ったままにしない）。
    const free = await withDatabase(async (client) => {
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS locked',
        [JOB_LOCK_NAMESPACE, jobLockKey('analytics.rollup')],
      );
      if (result.rows[0]?.locked) {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [
          JOB_LOCK_NAMESPACE,
          jobLockKey('analytics.rollup'),
        ]);
      }
      return result.rows[0]?.locked ?? false;
    });
    expect(free).toBe(true);
  });

  /** #44。`pruneOlderThanDays` は `system.manage`（現行どおり）。 */
  test('system.manage を持たない viewer が pruneOlderThanDays を付けると 403', async ({
    request,
    playwright,
  }) => {
    const viewer = await viewerContext(request, playwright);
    try {
      const response = await rollup(viewer, { pruneOlderThanDays: 30 });
      expect(response.status(), await response.text()).toBe(403);
    } finally {
      await viewer.dispose();
    }
  });

  /** #44 の対。`analytics.read` を持つ viewer は prune 無しなら流せる（現行どおり）。 */
  test('viewer でも pruneOlderThanDays 無しなら 200', async ({ request, playwright }) => {
    const viewer = await viewerContext(request, playwright);
    try {
      const response = await rollup(viewer);
      expect(response.status(), await response.text()).toBe(200);
    } finally {
      await viewer.dispose();
    }
  });
});

/**
 * #45。`POST /api/v1/webhooks/deliver` の経路変更。
 */
test.describe('POST /api/v1/webhooks/deliver', () => {
  test('従来どおり { attempted, delivered, failed } を返し、job_runs に manual で記録される', async ({
    request,
  }) => {
    const since = shortlyBefore();

    const response = await deliver(request);
    expect(response.status(), await response.text()).toBe(200);

    const body = (await response.json()) as {
      data: { attempted: number; delivered: number; failed: number };
    };
    expect(Object.keys(body.data).sort()).toEqual(['attempted', 'delivered', 'failed']);

    const runs = await manualRunsSince('webhook.deliver', since);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0]?.status).toBe('ok');
    expect(runs[0]?.summary).toEqual({
      attempted: body.data.attempted,
      delivered: body.data.delivered,
      failed: body.data.failed,
    });
  });

  test('別の接続がロックを保持している間は 409', async ({ request }) => {
    test.setTimeout(20_000);
    const since = shortlyBefore();

    const response = await whileHoldingLock('webhook.deliver', () => deliver(request));

    expect(response.status(), await response.text()).toBe(409);
    expect(response.headers()['retry-after']).toBe('10');
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CONFLICT');

    const runs = await manualRunsSince('webhook.deliver', since);
    expect(runs.map((run) => run.status)).toContain('skipped');
  });

  test('未認証では受け付けない', async ({ request }) => {
    const response = await request.post('/api/v1/webhooks/deliver', {
      headers: { Cookie: '', Origin: origin },
      data: {},
    });

    // Cookie が無ければ CSRF も通らない（API 基盤は CSRF 検証を認証より先に行う）。
    // 029 の経路変更とは関係のない既存の挙動で、`plugin-manager.spec.ts` と同じ書き方にそろえる。
    // どちらで落ちてもジョブが走らなければよい。
    expect([401, 403]).toContain(response.status());
  });

  test('system.manage を持たない viewer では 403', async ({ request, playwright }) => {
    const viewer = await viewerContext(request, playwright);
    try {
      const response = await deliver(viewer);
      expect(response.status(), await response.text()).toBe(403);
    } finally {
      await viewer.dispose();
    }
  });
});

/**
 * 待機枠のゲート（設計 §6.1.6、受け入れ条件 #67。security-reviewer A-1 の重大指摘）。
 *
 * `POST /analytics/rollup` の Permission は `analytics.read` で**閲覧者ロールも持つ**。
 * ゲートが無いと、1 アカウントが並列に叩くだけで待機中の pin が Pool（既定 `max = 10`）を
 * 使い切り、ログイン・画面描画まで止まる。
 *
 * **待てるのはジョブごとに 1 本。** あふれた呼び出しは待たずに 409 で返り、
 * その間もアプリ全体は生きている。
 */
test.describe('ロック待ちで全体が止まらない', () => {
  /** #67 */
  test('ロック保持中に 5 本同時に投げると 1 本だけが待ち、残りは即座に 409 で、その間も他の API が 200 を返す', async ({
    request,
  }) => {
    test.setTimeout(60_000);
    const since = shortlyBefore();
    const token = await csrf(request);

    const { results, meDuringWait } = await whileHoldingLock('analytics.rollup', async () => {
      const started = Date.now();
      const calls = [1, 2, 3, 4, 5].map(async () => {
        const response = await request.post('/api/v1/analytics/rollup', {
          headers: headers(token),
          data: { from: today(), to: today(), csrfToken: token },
        });
        return { status: response.status(), elapsed: Date.now() - started };
      });

      // 待っている最中に、関係のないリクエストが通ること（Pool が待機で埋まっていない）。
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const me = await request.get('/api/v1/auth/me');

      return { results: await Promise.all(calls), meDuringWait: me.status() };
    });

    // Pool が待機で埋まっていれば、これが返ってこない（タイムアウトする）。
    expect(meDuringWait, 'ロック待ちの最中にアプリ全体が止まっている').toBe(200);

    // ロック競合なので全部 409。
    expect(results.map((result) => result.status)).toEqual([409, 409, 409, 409, 409]);

    // 待ったのは 1 本だけ。
    const waited = results.filter((result) => result.elapsed >= 9_000);
    const immediate = results.filter((result) => result.elapsed < 1_000);
    expect(waited, '待った本数が 1 本ではない').toHaveLength(1);
    expect(immediate, '待たずに返った本数が 4 本ではない').toHaveLength(4);

    // 5 本とも記録は残る（`skipped`）。
    const runs = await manualRunsSince('analytics.rollup', since);
    expect(runs.filter((run) => run.status === 'skipped').length).toBeGreaterThanOrEqual(5);
  });
});

/**
 * ロック取得そのものの失敗（設計 §6.3、受け入れ条件 #70。security-reviewer A-3）。
 *
 * 競合（`skipped`）は 409、**ロックのセッション自体の失敗（`failed`）は 500**。
 * DB 停止や Pool 枯渇を「他が実行中」と表示すると、監視できるようにするという 029 の目的が崩れる。
 *
 * ロック待ちのバックエンドを `pg_terminate_backend` で落として再現する。
 */
test.describe('ロック取得の失敗', () => {
  /** advisory lock を待っているバックエンド（この API サーバーのもの）。 */
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

  /** #70 */
  test('ロックのセッションが落ちると 409 ではなく 500 を返し、応答に内部情報が出ない', async ({
    request,
  }) => {
    test.setTimeout(60_000);
    const connectionString = process.env['DATABASE_URL'];
    expect(connectionString, 'E2E には DATABASE_URL が必要').toBeTruthy();

    const holder = new pg.Client({ connectionString });
    const admin = new pg.Client({ connectionString });
    await holder.connect();
    await admin.connect();

    try {
      const locked = await holder.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1, $2) AS locked',
        [JOB_LOCK_NAMESPACE, jobLockKey('analytics.rollup')],
      );
      expect(locked.rows[0]?.locked, '定期実行と重なった。やり直す').toBe(true);

      const token = await csrf(request);
      const pending = request.post('/api/v1/analytics/rollup', {
        headers: headers(token),
        data: { from: today(), to: today(), csrfToken: token },
      });

      // 待ちに入ったバックエンドを落とす（= ロックのセッションが失敗した状況）。
      let pid: number | null = null;
      for (let i = 0; i < 60 && pid === null; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        pid = await waitingBackendPid(admin);
      }
      expect(pid, 'ロック待ちのバックエンドが見つからない').not.toBeNull();
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);

      const response = await pending;
      const text = await response.text();

      expect(response.status(), text).toBe(500);
      expect(response.headers()['retry-after'], '競合として扱っている').toBeUndefined();
      const body = JSON.parse(text) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('INTERNAL_ERROR');

      // 例外の内容・SQL・接続文字列を応答に出さない（07 §37）。
      expect(text).not.toContain('postgresql://');
      expect(text).not.toContain(connectionString);
      expect(text).not.toContain('pg_advisory_lock');
      expect(text).not.toContain('job_runs');
      expect(text).not.toMatch(/at .*\.ts:\d+/);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1, $2)', [
        JOB_LOCK_NAMESPACE,
        jobLockKey('analytics.rollup'),
      ]);
      await holder.end();
      await admin.end();
    }
  });
});

/**
 * 期間の検査（設計 §6.3、受け入れ条件 #76。security-reviewer A-2）。
 *
 * 現行は形式（`YYYY-MM-DD`）しか見ておらず、`{"from":"1000-01-01","to":"9999-12-31"}` で
 * 生ログの全期間を走査でき、029 以降はその間ロックを握って定期集計まで止まる。
 * 画面の期間上限（400 日）に揃える。**422 のときはロックを取らないので `job_runs` が増えない。**
 */
test.describe('rollup の期間の検査', () => {
  /** #76 */
  test('1000-01-01 〜 9999-12-31 は 422 で、job_runs が増えない', async ({ request }) => {
    const since = shortlyBefore();
    const before = await manualRunCount('analytics.rollup', since);

    const response = await rollup(request, { from: '1000-01-01', to: '9999-12-31' });

    expect(response.status(), await response.text()).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(await manualRunCount('analytics.rollup', since)).toBe(before);
  });

  /**
   * #81（security-reviewer M-1）。**実在しない日付でフェイルオープンしない。**
   *
   * `isValidRange` が形式（`^\d{4}-\d{2}-\d{2}$`）しか見ていないと `0000-00-00` /
   * `9999-99-99` が通り、`rangeDays` は `Date.parse` に依るので `NaN` になる。
   * `NaN > MAX_RANGE_DAYS` は `false` なので幅の検査も素通りし、
   * `analytics.read` しか持たない利用者がロックを取って `job_runs` に行を積める。
   */
  test('0000-00-00 〜 9999-99-99 は 422 で、job_runs が増えない', async ({ request }) => {
    const since = shortlyBefore();
    const before = await manualRunCount('analytics.rollup', since);

    const response = await rollup(request, { from: '0000-00-00', to: '9999-99-99' });

    expect(response.status(), await response.text()).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(await manualRunCount('analytics.rollup', since)).toBe(before);
  });

  /** #81。カレンダー上存在しない日（2 月 30 日・平年の 2 月 29 日・13 月）。 */
  for (const [from, to] of [
    ['2026-02-30', '2026-03-01'],
    ['2025-02-01', '2025-02-29'],
    ['2026-13-01', '2026-13-02'],
  ] as const) {
    test(`実在しない日付 ${from} 〜 ${to} は 422 で、job_runs が増えない`, async ({ request }) => {
      const since = shortlyBefore();
      const before = await manualRunCount('analytics.rollup', since);

      const response = await rollup(request, { from, to });

      expect(response.status(), await response.text()).toBe(422);
      expect(await manualRunCount('analytics.rollup', since)).toBe(before);
    });
  }

  /** #76。逆転。 */
  test('from > to は 422 で、job_runs が増えない', async ({ request }) => {
    const since = shortlyBefore();
    const before = await manualRunCount('analytics.rollup', since);

    const response = await rollup(request, { from: today(), to: shiftDate(today(), -1) });

    expect(response.status(), await response.text()).toBe(422);
    expect(await manualRunCount('analytics.rollup', since)).toBe(before);
  });

  /** #76。401 日（`rangeDays` は両端を含む）。 */
  test('401 日は 422 で、job_runs が増えない', async ({ request }) => {
    const since = shortlyBefore();
    const before = await manualRunCount('analytics.rollup', since);

    const response = await rollup(request, { from: shiftDate(today(), -400), to: today() });

    expect(response.status(), await response.text()).toBe(422);
    expect(await manualRunCount('analytics.rollup', since)).toBe(before);
  });

  /** #76。**400 日ちょうどは通す**（画面の上限と同じ）。 */
  test('400 日ちょうどは 200', async ({ request }) => {
    test.setTimeout(60_000);

    const response = await rollup(request, { from: shiftDate(today(), -399), to: today() });

    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as { data: { from: string; to: string } };
    expect(body.data.from).toBe(shiftDate(today(), -399));
    expect(body.data.to).toBe(today());
  });
});
