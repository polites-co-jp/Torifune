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
 * SNS 配信の API（035-social-publishing 設計 §6.5.9、受け入れ条件 #62、#65）。
 *
 * - `POST /api/v1/social/publish`（`system.manage`）：200 / 401 / 403 / 409 + `Retry-After`
 * - 資格情報が応答本文のどこにも出ない
 *
 * **画面（#73〜#77、#80）は G7（T26）でこのファイルに足す。**
 * それらは `plugins/example-plugin` を有効にして走らせる（実装プラン §8 の 12）ので、
 * `beforeAll` / `afterAll` は `plugin-example.spec.ts` を写す。ここまでの 2 条件は
 * publisher を要らないので、Plugin を入れずに走る（実装プラン §8 の 1）。
 */

const origin = 'http://127.0.0.1:3000';

/** `infrastructure/job-lock.ts` と同じ鍵（029 設計 §6.1.6）。 */
const JOB_LOCK_NAMESPACE = 7_602_931;

function jobLockKey(name: string): number {
  return createHash('sha256').update(name).digest().readInt32BE(0);
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

/** 別の接続で `social.publish` のロックを保持したまま `fn` を実行する。 */
async function whileHoldingLock<T>(fn: () => Promise<T>): Promise<T> {
  return withDatabase(async (client) => {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [JOB_LOCK_NAMESPACE, jobLockKey('social.publish')],
    );
    expect(locked.rows[0]?.locked, '定期実行と重なった。やり直す').toBe(true);
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        JOB_LOCK_NAMESPACE,
        jobLockKey('social.publish'),
      ]);
    }
  });
}

/** 数秒前（サーバーとクライアントの時計のずれを吸収する）。 */
function shortlyBefore(): Date {
  return new Date(Date.now() - 5_000);
}

async function manualRunCount(since: Date): Promise<number> {
  return withDatabase(async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM job_runs
        WHERE job_name = 'social.publish' AND triggered_by = 'manual' AND started_at >= $1`,
      [since],
    );
    return Number(result.rows[0]?.count ?? '0');
  });
}

async function publish(request: APIRequestContext): Promise<APIResponse> {
  const token = await csrf(request);
  return request.post('/api/v1/social/publish', {
    headers: headers(token),
    data: { csrfToken: token },
  });
}

/** `viewer` は `social.read` を持ち `system.manage` を持たない。 */
async function viewerContext(
  request: APIRequestContext,
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<APIRequestContext> {
  const token = await csrf(request);
  const loginId = `e2e_pub_viewer_${Math.random().toString(36).slice(2, 10)}`;
  const password = 'e2e publish viewer correct horse battery staple';
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

const SUMMARY_KEYS = [
  'interrupted',
  'due',
  'skipped',
  'attempted',
  'published',
  'retried',
  'failed',
  'unrecorded',
];

/** #62。`POST /api/v1/social/publish`（`TORIFUNE_SCHEDULER=off` の運用を SNS でも成り立たせる）。 */
test.describe('#62 POST /api/v1/social/publish', () => {
  test('#62 管理者では 200 で { data: <summary> } を返す', async ({ request }) => {
    const response = await publish(request);
    expect(response.status(), await response.text()).toBe(200);

    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(['data']);
    expect(Object.keys(body.data).sort()).toEqual([...SUMMARY_KEYS].sort());
    for (const key of SUMMARY_KEYS) {
      expect(typeof body.data[key], key).toBe('number');
    }
  });

  test("#62 job_runs に triggered_by = 'manual' の行が残る", async ({ request }) => {
    const since = shortlyBefore();

    expect((await publish(request)).status()).toBe(200);

    expect(await manualRunCount(since)).toBeGreaterThanOrEqual(1);
  });

  test('#62 未認証では 401', async ({ request }) => {
    const response = await request.post('/api/v1/social/publish', {
      headers: { Cookie: '', Origin: origin },
      data: {},
    });

    expect(response.status()).toBe(401);
  });

  test('#62 system.manage を持たない viewer では 403', async ({ request, playwright }) => {
    const viewer = await viewerContext(request, playwright);
    try {
      const response = await publish(viewer);

      expect(response.status(), await response.text()).toBe(403);
    } finally {
      await viewer.dispose();
    }
  });

  test('#62 別の接続がロックを保持している間は 409 と Retry-After: 10', async ({ request }) => {
    // 手動（API）は解放を待つ。待っても取れなければ 409（029 設計 §6.3 と同じ形）。
    test.setTimeout(60_000);

    const response = await whileHoldingLock(async () => publish(request));

    expect(response.status(), await response.text()).toBe(409);
    expect(response.headers()['retry-after']).toBe('10');

    const body = (await response.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('CONFLICT');
    expect(Array.isArray(body.error.details?.['job'])).toBe(true);
  });
});

/**
 * #65。**資格情報は応答本文のどこにも出ない**（設計 §6.4 / §6.5.5）。
 *
 * 応答は `credentialConfigured` だけを返す（05 §18）。配信を通した後も変わらない。
 */
test.describe('#65 資格情報が応答本文に出ない', () => {
  const MARKER = 'CRED-MARKER';

  test('#65 配信を実行しても 4 つの応答に資格情報が現れない', async ({ request }) => {
    const token = await csrf(request);
    const createdAccount = await request.post('/api/v1/social/accounts', {
      headers: headers(token),
      data: {
        provider: 'x',
        displayName: 'E2E 配信の資格情報',
        handle: '@e2e_publish',
        credential: MARKER,
        status: 'connected',
        csrfToken: token,
      },
    });
    expect(createdAccount.status(), await createdAccount.text()).toBe(201);
    const accountId = ((await createdAccount.json()) as { data: { id: string } }).data.id;

    const postToken = await csrf(request);
    const createdPost = await request.post('/api/v1/social/posts', {
      headers: headers(postToken),
      data: {
        socialAccountId: accountId,
        body: 'E2E 配信の確認',
        status: 'scheduled',
        // **配信 Plugin が無くても断らない**（要件 §4 裁定 #8）。
        deliveryMode: 'auto',
        scheduledAt: new Date(Date.now() - 60_000).toISOString(),
        csrfToken: postToken,
      },
    });
    expect(createdPost.status(), await createdPost.text()).toBe(201);
    const postId = ((await createdPost.json()) as { data: { id: string } }).data.id;

    try {
      expect((await publish(request)).status()).toBe(200);

      for (const path of [
        '/api/v1/social/posts',
        `/api/v1/social/posts/${postId}`,
        `/api/v1/social/accounts/${accountId}`,
        '/api/v1/jobs',
      ]) {
        const response = await request.get(path);
        expect(response.status(), path).toBe(200);
        expect(await response.text(), path).not.toContain(MARKER);
      }

      // 「設定済み」だけは見せる（何も設定されていないのと区別が付かないと運用できない）。
      const account = (await (
        await request.get(`/api/v1/social/accounts/${accountId}`)
      ).json()) as {
        data: { credentialConfigured: boolean };
      };
      expect(account.data.credentialConfigured).toBe(true);
    } finally {
      // 既存の `social.spec.ts` の前提（#79）を壊さないよう、作ったものは消す。
      const cleanupPost = await csrf(request);
      await request.delete(`/api/v1/social/posts/${postId}`, {
        headers: headers(cleanupPost),
        data: { csrfToken: cleanupPost },
      });
      const cleanupAccount = await csrf(request);
      await request.delete(`/api/v1/social/accounts/${accountId}`, {
        headers: headers(cleanupAccount),
        data: { csrfToken: cleanupAccount },
      });
    }
  });
});
