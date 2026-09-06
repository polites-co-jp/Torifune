import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import pg from 'pg';

/**
 * 基準タイムゾーンの設定と洗い替え（032-timezone-setting 設計 §6.5 / §7、受け入れ条件
 * #63〜#71、#81〜#84、#95、#98、#106、#107、#110、#122、#142〜#144）。
 *
 * **このファイルは 1 つに閉じる。** `apps/web/e2e/` の全ファイルが
 * `GET /api/v1/auth/csrf` の Rate Limit（300 回 / 60 秒、`operationId:IP`）を共有しており、
 * 余裕が少ない（実装プラン §7 #2）。
 *
 * * 追加の csrf は **8 回以内**（実際は 6 回：管理者 1・viewer 2・未認証 1・画面 2）
 * * サイトは 1 つだけ作る
 * * Plugin の集計値と `job_runs` の行は `withDatabase` で直接入れる（csrf 0 回）
 * * #81〜#84 と #98 は**同じ 1 本の流れ**にまとめる（往復を増やさない）
 *
 * **CSRF トークンは、それを使うコンテキストから取る。**
 * `GET /api/v1/auth/csrf` は**呼ぶたびに新しいトークンを生成して Cookie に置く**ので、
 * 別のコンテキストで取ったトークンは Cookie と一致せず 403 `CSRF_FAILED` になる。
 * ここでは予算のためにトークンを 1 度しか取らないので、
 * **その 1 つのコンテキスト（`adminRequest`）を通しで使う**。
 * テストごとの `request` フィクスチャは別の Cookie を持つため、更新系では使わない。
 *
 * **ファイル名の位置に意味がある。** 画面から保存すると `system_settings` の値が
 * 環境変数より優先されるため、同じ実行の後続ファイルに効き続ける。
 * 辞書順で `analytics` / `jobs` / `responsive` / `settings-tabs` より**後**に置き、
 * `test.afterAll` で必ず `Asia/Tokyo` へ戻す（実装プラン §7 #3）。
 */

const origin = 'http://127.0.0.1:3000';

/** `playwright.config.ts` が渡している値。テストの前後でここへ戻す。 */
const DEFAULT_TIME_ZONE = 'Asia/Tokyo';

/** 画面から選び直す先。`Asia/Tokyo` と日付がずれる西側の地域にする。 */
const TARGET_TIME_ZONE = 'America/Los_Angeles';

/** `infrastructure/job-lock.ts` と同じ鍵（029 設計 §6.1.6）。 */
const JOB_LOCK_NAMESPACE = 7_602_931;

function jobLockKey(name: string): number {
  return createHash('sha256').update(name).digest().readInt32BE(0);
}

function headers(token: string): Record<string, string> {
  return { 'X-CSRF-Token': token, Origin: origin };
}

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
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
  readonly status: string;
  readonly summary: Record<string, unknown>;
  readonly started_at: Date;
}

async function rebuildRuns(): Promise<JobRunRow[]> {
  return withDatabase(async (client) => {
    const result = await client.query<JobRunRow>(
      `SELECT job_name, status, summary, started_at FROM job_runs
       WHERE job_name = 'analytics.timezoneRebuild'
       ORDER BY started_at DESC`,
    );
    return result.rows;
  });
}

/** そのサイトの集計値の行数（出所で絞れる）。 */
async function analyticsCountForSite(siteId: string, source?: string): Promise<number> {
  return withDatabase(async (client) => {
    const result =
      source === undefined
        ? await client.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM analytics WHERE site_id = $1',
            [siteId],
          )
        : await client.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM analytics WHERE site_id = $1 AND source = $2',
            [siteId, source],
          );
    return Number(result.rows[0]?.count ?? '0');
  });
}

async function analyticsCount(source?: string): Promise<number> {
  return withDatabase(async (client) => {
    const result =
      source === undefined
        ? await client.query<{ count: string }>('SELECT count(*)::text AS count FROM analytics')
        : await client.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM analytics WHERE source = $1',
            [source],
          );
    return Number(result.rows[0]?.count ?? '0');
  });
}

/** 別の接続でジョブのロックを保持したまま `fn` を実行する（`jobs.spec.ts` の先例）。 */
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

interface Preview {
  readonly timeZone: string;
  readonly currentTimeZone: string;
  readonly currentSource: string;
  readonly unchanged: boolean;
  readonly rebuildFrom: string | null;
  readonly rebuildTo: string | null;
  readonly rebuildDays: number;
  readonly lostDays: number;
  readonly lostCoreRows: number;
  readonly lostPluginRows: number;
  readonly lostSources: string[];
  readonly lostSites: number;
  readonly lostFrom: string | null;
  readonly lostTo: string | null;
}

interface JobStatusBody {
  readonly name: string;
  readonly intervalMinutes: number | null;
}

/**
 * 管理者の API コンテキスト。**このファイルの API 呼び出しはすべてここから行う。**
 *
 * `adminToken` はこのコンテキストの Cookie と対になっているので、
 * 別のコンテキスト（テストごとの `request` フィクスチャ）から使うと 403 になる。
 */
let adminRequest: APIRequestContext;
/** 管理者の CSRF トークン。**1 度だけ取って使い回す**（Rate Limit の予算）。 */
let adminToken: string;
/** 計測タグを持つサイト。**1 つだけ作る。** */
let siteId: string;
/**
 * **計測タグを一度も貼っていない**サイト（§5.4.1、受け入れ条件 #122）。
 *
 * Plugin が外部サービスの数値を取り込むためだけに作られたサイトを模す。
 * `access_logs` が 0 行なので、洗い替えの削除の対象にならない。
 * **管理者のトークンを使い回すので csrf は増えない。**
 */
let untrackedSiteId: string;
/** `system.manage` を持たない利用者（#68 の 403 と #83 で使い回す）。 */
let viewerRequest: APIRequestContext;
let viewerToken: string;
let viewerBrowserContext: Awaited<ReturnType<Browser['newContext']>>;

/** 生ログの無い日に Plugin が入れた集計値（#98 で消える）。 */
const PLUGIN_SOURCE = 'e2e-plugin';
const PLUGIN_METRIC_DATE = '2024-05-01';

test.beforeAll(async ({ playwright, browser }) => {
  // **`dispose()` しない。** トークンと Cookie の対を保ったまま、afterAll まで使い続ける。
  adminRequest = await playwright.request.newContext({
    baseURL: origin,
    storageState: 'e2e/.auth/admin.json',
  });
  adminToken = await csrf(adminRequest);

  const created = await adminRequest.post('/api/v1/sites', {
    headers: headers(adminToken),
    data: {
      name: `E2E timezone ${Math.random().toString(36).slice(2, 8)}`,
      url: 'https://timezone.example.com',
      description: '',
      status: 'active',
      csrfToken: adminToken,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  siteId = ((await created.json()) as { data: { id: string } }).data.id;

  // #122。計測タグを貼らないサイト（同じトークンを使うので csrf は増えない）。
  const untracked = await adminRequest.post('/api/v1/sites', {
    headers: headers(adminToken),
    data: {
      name: `E2E timezone untracked ${Math.random().toString(36).slice(2, 8)}`,
      url: 'https://untracked.example.com',
      description: '',
      status: 'active',
      csrfToken: adminToken,
    },
  });
  expect(untracked.status(), await untracked.text()).toBe(201);
  untrackedSiteId = ((await untracked.json()) as { data: { id: string } }).data.id;

  // `system.manage` を持たない利用者を 1 人だけ作る（管理者のトークンを使い回す）。
  const loginId = `e2e_tz_viewer_${Math.random().toString(36).slice(2, 10)}`;
  const password = 'e2e timezone viewer correct horse battery staple';
  const user = await adminRequest.post('/api/v1/users', {
    headers: headers(adminToken),
    data: {
      loginId,
      displayName: `E2E ${loginId}`,
      email: `${loginId}@example.com`,
      password,
      roles: ['viewer'],
      csrfToken: adminToken,
    },
  });
  expect(user.status(), await user.text()).toBe(201);

  viewerBrowserContext = await browser.newContext({ baseURL: origin });
  viewerRequest = viewerBrowserContext.request;
  const loginToken = await csrf(viewerRequest);
  const login = await viewerRequest.post('/api/v1/auth/login', {
    headers: headers(loginToken),
    data: { loginId, password, csrfToken: loginToken },
  });
  expect(login.status(), await login.text()).toBe(200);
  // ログインでセッションが変わるので、更新系のために取り直す。
  viewerToken = await csrf(viewerRequest);
});

/**
 * **必ず `Asia/Tokyo` へ戻す。**
 *
 * 画面設定は環境変数より優先されるため、残すと同じ実行の後続ファイルに効き続ける。
 */
test.afterAll(async () => {
  const restored = await adminRequest.put('/api/v1/settings/timezone', {
    headers: headers(adminToken),
    data: { timeZone: DEFAULT_TIME_ZONE, csrfToken: adminToken },
  });
  // 戻せていなければ後続の spec が別の境目で動く。黙って通さない。
  expect(restored.status(), await restored.text()).toBe(200);

  await viewerBrowserContext.close();
  await adminRequest.dispose();
});

test.describe('API', () => {
  /** #63 / #95 */
  test('GET /api/v1/settings/timezone が 200 でプレビューを返し、消える行を出所ごとに分ける', async () => {
    const response = await adminRequest.get(
      `/api/v1/settings/timezone?timeZone=${encodeURIComponent(TARGET_TIME_ZONE)}`,
    );
    expect(response.status(), await response.text()).toBe(200);

    const body = (await response.json()) as { data: Preview };
    expect(Object.keys(body)).toEqual(['data']);
    expect(body.data.timeZone).toBe(TARGET_TIME_ZONE);
    expect(typeof body.data.currentTimeZone).toBe('string');
    expect(['database', 'environment', 'default']).toContain(body.data.currentSource);
    expect(body.data.unchanged).toBe(false);

    // #95。合計だけでは Plugin の値も消えることが読み取れない。
    for (const key of ['lostDays', 'lostCoreRows', 'lostPluginRows', 'lostSites'] as const) {
      expect(typeof body.data[key], key).toBe('number');
    }
    expect(Array.isArray(body.data.lostSources)).toBe(true);
  });

  /** #63。**何も変えない。** */
  test('プレビューは設定も集計値も変えない', async () => {
    const before = await analyticsCount();
    const stored = await withDatabase(async (client) =>
      client.query("SELECT value FROM system_settings WHERE key = 'analytics.time_zone'"),
    );

    const response = await adminRequest.get('/api/v1/settings/timezone?timeZone=Europe/Berlin');
    expect(response.status()).toBe(200);

    expect(await analyticsCount()).toBe(before);
    const after = await withDatabase(async (client) =>
      client.query("SELECT value FROM system_settings WHERE key = 'analytics.time_zone'"),
    );
    expect(after.rows).toEqual(stored.rows);
  });

  /** #64。「不正だから UTC で数えました」という応答を返さない。 */
  test('timeZone が不正なら 422', async () => {
    const response = await adminRequest.get('/api/v1/settings/timezone?timeZone=Foo%2FBar');

    expect(response.status(), await response.text()).toBe(422);
  });

  /** #64。オフセット表記も拒否する（一覧に無い）。 */
  test('オフセット表記の timeZone も 422', async () => {
    const response = await adminRequest.get('/api/v1/settings/timezone?timeZone=%2B09%3A00');

    expect(response.status(), await response.text()).toBe(422);
  });

  /** #65 */
  test('timeZone が無ければ 422', async () => {
    const response = await adminRequest.get('/api/v1/settings/timezone');

    expect(response.status(), await response.text()).toBe(422);
  });

  /** #66。**ジョブの完了を待たない。** */
  test('PUT /api/v1/settings/timezone が 200 を返し、洗い替えの完了を待たない', async () => {
    const startedAt = Date.now();
    const response = await adminRequest.put('/api/v1/settings/timezone', {
      headers: headers(adminToken),
      data: { timeZone: 'Europe/Berlin', csrfToken: adminToken },
    });
    const elapsed = Date.now() - startedAt;

    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as {
      data: { timeZone: string; previousTimeZone: string; rebuildStarted: boolean };
    };
    expect(body.data.timeZone).toBe('Europe/Berlin');
    expect(body.data.rebuildStarted).toBe(true);
    // 洗い替えを待っていたら、この時間では返らない。
    expect(elapsed).toBeLessThan(5_000);

    // 記録は非同期に増える。
    await expect
      .poll(async () => (await rebuildRuns()).length, { timeout: 20_000 })
      .toBeGreaterThan(0);
  });

  /** #67 / #106。**やり直しは `system_settings` を書き換えない。** */
  test('POST /api/v1/analytics/timezone-rebuild が 200 を返し、system_settings を書き換えない', async () => {
    const before = await withDatabase(async (client) =>
      client.query<{ value: string; updated_at: Date }>(
        "SELECT value::text AS value, updated_at FROM system_settings WHERE key = 'analytics.time_zone'",
      ),
    );

    const response = await adminRequest.post('/api/v1/analytics/timezone-rebuild', {
      headers: headers(adminToken),
      data: { csrfToken: adminToken },
    });

    expect(response.status(), await response.text()).toBe(200);
    expect((await response.json()) as unknown).toEqual({ data: { started: true } });

    const after = await withDatabase(async (client) =>
      client.query<{ value: string; updated_at: Date }>(
        "SELECT value::text AS value, updated_at FROM system_settings WHERE key = 'analytics.time_zone'",
      ),
    );
    expect(after.rows).toEqual(before.rows);
  });

  /**
   * #107。走行中に押されても壊れない（設計 §7.3.2）。
   *
   * 029 の排他がそのまま効き、`skipped` が 1 行記録されて何も起きない。
   * **これは雑音ではなく答えである**（「押したが、他が動いていたので何もしなかった」）。
   */
  test('洗い替えの実行中に叩くと skipped が 1 行増え、analytics の行が変わらない', async () => {
    // **直前のテストが起こした洗い替えが終わるのを待つ。**
    //
    // #67 / #106 の `POST /analytics/timezone-rebuild` は本当にジョブを起こすので、
    // その洗い替えが `analytics.rollup` の鍵を握っている間はここで鍵を取れない。
    // 待つのは `job_runs` を読むだけで、**csrf も API 呼び出しも増やさない**。
    // 上限つき。超えたら「鍵が空かない」として明示的に落とす（無限には待たない）。
    await expect
      .poll(async () => (await rebuildRuns()).filter((run) => run.status === 'running').length, {
        message: '直前の洗い替えが終わらない（analytics.rollup の鍵が空かない）',
        timeout: 30_000,
        intervals: [200],
      })
      .toBe(0);

    // **数えるのは待ったあと。** 待っている間に洗い替えが `analytics` を書き換えうる。
    const before = (await rebuildRuns()).length;
    const rowsBefore = await analyticsCount();

    await whileHoldingLock('analytics.rollup', async () => {
      const response = await adminRequest.post('/api/v1/analytics/timezone-rebuild', {
        headers: headers(adminToken),
        data: { csrfToken: adminToken },
      });
      expect(response.status(), await response.text()).toBe(200);

      await expect
        .poll(async () => (await rebuildRuns()).filter((run) => run.status === 'skipped').length, {
          timeout: 30_000,
        })
        .toBeGreaterThanOrEqual(1);
    });

    const runs = await rebuildRuns();
    expect(runs.length).toBe(before + 1);
    expect(runs[0]?.status).toBe('skipped');
    expect(await analyticsCount()).toBe(rowsBefore);
  });

  /**
   * #68。未認証は 401。
   *
   * **`newContext()` だけでは未認証にならない。** `playwright.config.ts` の
   * `use.storageState`（`e2e/.auth/admin.json`）を引き継ぐため、管理者のまま 200 が返る。
   * **空の `storageState` を明示して**セッションを持たないコンテキストを作る。
   *
   * API 基盤は CSRF を認証より先に検証するので、Cookie を落としただけでは
   * 403 `CSRF_FAILED` になって 401 を確かめられない。
   * このコンテキスト自身で CSRF を取り、**CSRF は通したうえでセッションが無い**状態にする。
   */
  test('未認証では 3 つのエンドポイントすべてが 401', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext({
      baseURL: origin,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const token = await csrf(anonymous);

      const preview = await anonymous.get('/api/v1/settings/timezone?timeZone=Asia/Tokyo');
      expect(preview.status(), await preview.text()).toBe(401);

      const update = await anonymous.put('/api/v1/settings/timezone', {
        headers: headers(token),
        data: { timeZone: 'Asia/Tokyo', csrfToken: token },
      });
      expect(update.status(), await update.text()).toBe(401);

      const rebuild = await anonymous.post('/api/v1/analytics/timezone-rebuild', {
        headers: headers(token),
        data: { csrfToken: token },
      });
      expect(rebuild.status(), await rebuild.text()).toBe(401);
    } finally {
      await anonymous.dispose();
    }
  });

  /**
   * #68。`system.manage` を持たなければ 403。
   *
   * **消える件数すら数えられない。** プレビューは変更の前段であり、変更と同じ水準に置く。
   */
  test('system.manage を持たない利用者は 3 つとも 403', async () => {
    const preview = await viewerRequest.get('/api/v1/settings/timezone?timeZone=Asia/Tokyo');
    expect(preview.status(), await preview.text()).toBe(403);

    const update = await viewerRequest.put('/api/v1/settings/timezone', {
      headers: headers(viewerToken),
      data: { timeZone: 'Asia/Tokyo', csrfToken: viewerToken },
    });
    expect(update.status(), await update.text()).toBe(403);

    const rebuild = await viewerRequest.post('/api/v1/analytics/timezone-rebuild', {
      headers: headers(viewerToken),
      data: { csrfToken: viewerToken },
    });
    expect(rebuild.status(), await rebuild.text()).toBe(403);
  });

  /** #70。周期を持たないジョブは `intervalMinutes` が `null`。 */
  test('GET /api/v1/jobs が 3 件を返し、洗い替えの intervalMinutes は null', async () => {
    const response = await adminRequest.get('/api/v1/jobs');
    expect(response.status(), await response.text()).toBe(200);

    const body = (await response.json()) as { data: JobStatusBody[] };
    expect(body.data.map((job) => job.name)).toEqual([
      'analytics.rollup',
      'webhook.deliver',
      'analytics.timezoneRebuild',
    ]);
    const rebuild = body.data.find((job) => job.name === 'analytics.timezoneRebuild');
    expect(rebuild?.intervalMinutes).toBeNull();
  });

  /**
   * #142〜#144。`GET /api/v1/settings` から `analyticsTimeZone` を落とす（設計 §6.5.1）。
   *
   * この口は `permission: null` で **Cookie 無しでも叩ける**。
   * `SystemSettings` に基準タイムゾーンを足したことで、
   * **インスタンスの運用地域が未認証の 1 リクエストで分かる**ようになっていた。
   *
   * 読む必要のある利用者は `/api/v1/settings/timezone`（`system.manage`）から読める。
   */
  test('GET /api/v1/settings は analyticsTimeZone を返さず、既存の 2 項目は変わらない', async () => {
    const response = await adminRequest.get('/api/v1/settings');
    expect(response.status(), await response.text()).toBe(200);

    const body = (await response.json()) as { data: Record<string, unknown> };

    // #142
    expect(Object.keys(body.data)).not.toContain('analyticsTimeZone');
    expect(await response.text()).not.toContain('analyticsTimeZone');
    // #144。既存の 2 項目は従来どおり。
    expect(Object.keys(body.data).sort()).toEqual(['rememberMeEnabled', 'serviceName']);
    expect(typeof body.data['serviceName']).toBe('string');
    expect(typeof body.data['rememberMeEnabled']).toBe('boolean');
  });

  /** #143。未認証でも漏れない（`Cookie: ''` は `jobs.spec.ts` の先例）。 */
  test('未認証で GET /api/v1/settings を叩いても analyticsTimeZone が漏れない', async () => {
    const response = await adminRequest.get('/api/v1/settings', { headers: { Cookie: '' } });

    // この口は認証を要求しない（032 が持ち込んだ性質ではない。未決 #15）。
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('analyticsTimeZone');
    // 地域名そのものが載っていないこと（キー名を変えて載せても落ちるように）。
    expect(text).not.toContain('Asia/Tokyo');
    expect(text).not.toContain('America/Los_Angeles');
  });

  /** #69。既存の `PUT /api/v1/settings` の body / 応答は変わっていない。 */
  test('PUT /api/v1/settings（既存）の body と応答が変わっていない', async () => {
    const response = await adminRequest.put('/api/v1/settings', {
      headers: headers(adminToken),
      data: { serviceName: 'とりふね', rememberMeEnabled: true, csrfToken: adminToken },
    });

    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(['data']);
    expect(body.data['serviceName']).toBe('とりふね');
    expect(body.data['rememberMeEnabled']).toBe(true);
  });
});

test.describe('画面', () => {
  /** 「基準タイムゾーン」の区画の選択欄（設定 → 一般で唯一の `<select>`）。 */
  function timeZoneSelect(page: Page) {
    return page.getByRole('combobox');
  }

  /**
   * #81〜#84 ＋ #98。**1 本にまとめる**（往復を増やさない。実装プラン §7 #2）。
   *
   * 生ログの無い日に Plugin が入れた集計値を先に置き、
   * 確認ダイアログにその行数が出ること・確定後に消えていることまでを 1 つの流れで見る。
   */
  test('選んで確認して保存すると、Toast が出て現在値・定期実行の行・日付の区切りが変わり、Plugin の集計値が消える', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // #98 の下ごしらえ。生ログの無い日なので、洗い替えで消える。
    //
    // **このサイトを「計測しているサイト」にしておく**（§5.4.1）。
    // 生ログが 1 行も無いサイトは削除の対象外になったので、1 行も無いままだと
    // #98 が「消えない」で通ってしまい、検査の意味が失われる。
    await withDatabase(async (client) => {
      await client.query(
        `INSERT INTO access_logs (id, site_id, occurred_at, path, referrer_host, visitor_hash, device)
         VALUES (gen_random_uuid(), $1, now(), '/', NULL, 'e2e-timezone-visitor', 'desktop')`,
        [siteId],
      );
      await client.query(
        `INSERT INTO analytics (site_id, metric_date, source, metric, key, value)
         VALUES ($1, $2, $3, 'pageviews', '', 123)
         ON CONFLICT (site_id, metric_date, source, metric, key) DO UPDATE SET value = 123`,
        [siteId, PLUGIN_METRIC_DATE, PLUGIN_SOURCE],
      );
      // #122。**計測タグを貼っていない**サイトの集計値。生ログが 1 行も無いので消えない。
      await client.query(
        `INSERT INTO analytics (site_id, metric_date, source, metric, key, value)
         VALUES ($1, $2, $3, 'pageviews', '', 456)
         ON CONFLICT (site_id, metric_date, source, metric, key) DO UPDATE SET value = 456`,
        [untrackedSiteId, PLUGIN_METRIC_DATE, PLUGIN_SOURCE],
      );
    });
    expect(await analyticsCountForSite(siteId, PLUGIN_SOURCE)).toBeGreaterThan(0);
    expect(await analyticsCountForSite(untrackedSiteId, PLUGIN_SOURCE)).toBeGreaterThan(0);

    await page.goto('/settings?tab=general');
    await expect(page.getByRole('heading', { name: '基準タイムゾーン' })).toBeVisible();

    await timeZoneSelect(page).selectOption(TARGET_TIME_ZONE);
    await page.getByRole('button', { name: '変更する' }).click();

    // #74 / #96 の画面側：確認ダイアログに消える件数と Plugin の行が出る。
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(TARGET_TIME_ZONE);
    await expect(dialog).toContainText('Plugin');
    await expect(dialog).toContainText(PLUGIN_SOURCE);
    await expect(dialog).toContainText('訪問者数');

    await dialog.getByRole('button', { name: '変更する' }).click();

    // #81。Toast が出て、現在値が新しい値になる。
    await expect(page.getByRole('status')).toBeVisible();
    await expect
      .poll(
        async () => {
          await page.goto('/settings?tab=general');
          return page.getByText(TARGET_TIME_ZONE, { exact: false }).count();
        },
        { timeout: 30_000, intervals: [2_000] },
      )
      .toBeGreaterThan(0);
    await expect(page.getByText('データベース', { exact: false })).toBeVisible();

    // #82。「定期実行」に洗い替えの行が現れる。
    await expect(page.getByRole('row', { name: /タイムゾーン変更の洗い替え/ })).toBeVisible();

    // #98。洗い替えが終わると、**計測しているサイト**の生ログの無い日の Plugin の行は消えている。
    await expect
      .poll(async () => analyticsCountForSite(siteId, PLUGIN_SOURCE), {
        timeout: 60_000,
        intervals: [2_000],
      })
      .toBe(0);

    // #122。**計測タグを一度も貼っていないサイトの集計値は残る**（§5.4.1）。
    expect(await analyticsCountForSite(untrackedSiteId, PLUGIN_SOURCE)).toBeGreaterThan(0);

    // #84。アナリティクス → 設定タブの「日付の区切り」が新しい値になっている。
    await page.goto(`/analytics?siteId=${siteId}&tab=settings`);
    await expect(
      page.getByText(`日付の区切りは ${TARGET_TIME_ZONE}`, { exact: false }),
    ).toBeVisible();
  });

  /** #83。表示制御であって認可ではない（認可は UseCase 側で見る。#68）。 */
  test('system.manage を持たない利用者には選択欄が disabled で表示される', async () => {
    const page = await viewerBrowserContext.newPage();
    try {
      await page.goto('/settings?tab=general');

      await expect(page.getByRole('heading', { name: '基準タイムゾーン' })).toBeVisible();
      await expect(timeZoneSelect(page)).toBeDisabled();
      await expect(page.getByRole('button', { name: '変更する' })).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

  /**
   * #110。失敗した洗い替えのやり直し（`要件.md` §7-2）。
   *
   * **自動再試行はしない。** 立て直しは人が押す。
   *
   * **ファイル内の実行順に依存させない。** 「前回の実行」は
   * *そのとき効いている*基準タイムゾーンで整形されるので、先行する画面テストが
   * 保存を済ませたかどうかで日付が 1 日ずれる（`2020-01-02T03:04:05Z` は
   * `Asia/Tokyo` では 01-02、`America/Los_Angeles` では 01-01）。
   * IANA のオフセットは ±14 時間に収まるため、**どの地域でも `2020-01-0` で始まる**。
   * 日付そのものではなく、この接頭辞が消えることで「更新された」を見る。
   */
  test('error の行の「洗い替えをやり直す」を押すと「前回の実行」が更新される', async ({ page }) => {
    test.setTimeout(90_000);

    const staleStartedAt = '2020-01-02T03:04:05Z';
    /** どの基準タイムゾーンで整形されても一致する接頭辞。 */
    const STALE_PREFIX = '2020-01-0';
    await withDatabase(async (client) => {
      await client.query("DELETE FROM job_runs WHERE job_name = 'analytics.timezoneRebuild'");
      await client.query(
        `INSERT INTO job_runs (id, job_name, triggered_by, status, started_at, finished_at, error, summary, runner)
         VALUES (gen_random_uuid(), 'analytics.timezoneRebuild', 'manual', 'error', $1::timestamptz, $1::timestamptz,
                 '洗い替えが失敗した', '{}'::jsonb, 'e2e:0')`,
        [staleStartedAt],
      );
    });

    await page.goto('/settings?tab=general');
    const row = page.getByRole('row', { name: /タイムゾーン変更の洗い替え/ });
    await expect(row).toBeVisible();
    // 直近の実行が error であること（再実行ボタンが出る条件。設計 §7.3.1）。
    await expect(row.locator('[data-job-status="error"]')).toHaveCount(1);
    await expect(row).toContainText(STALE_PREFIX);

    await page.getByRole('button', { name: '洗い替えをやり直す' }).click();

    // **押した直後はページ自身が遷移している。**
    // 再実行ハンドラは POST が成功すると `window.location.reload()` を呼ぶ（設計どおり）。
    // そこへこちらの `page.goto` が重なると、先に始まっていたほうが中断されて
    // `net::ERR_ABORTED` になる。**中断は「まだ更新されていない」として扱い、次の間隔で撃ち直す。**
    //
    // 握りつぶしても判定は甘くならない。中断のたびに返すのは「古い」ことを表す番兵
    // （`STALE_PREFIX`）で、これは `.not.toContain(STALE_PREFIX)` を決して満たさない。
    // ずっと中断され続ければ 60 秒で打ち切られ、明示的に失敗する。
    await expect
      .poll(
        async () => {
          try {
            await page.goto('/settings?tab=general');
            return (await row.textContent()) ?? '';
          } catch {
            // 遷移が中断された（あるいは読み取り中に遷移が起きた）。まだ古いものとして再試行させる。
            return STALE_PREFIX;
          }
        },
        {
          message: '「前回の実行」が更新されない（洗い替えのやり直しが反映されていない）',
          timeout: 60_000,
          intervals: [3_000],
        },
      )
      .not.toContain(STALE_PREFIX);
  });
});
