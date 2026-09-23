import type { Plugin, PluginManifest, PublisherRegistration } from '@torifune/plugin-api';
import {
  PluginExtensionNotDeclaredError,
  PluginPublisherConflictError,
} from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as createSocialPostRoute } from '@/app/api/v1/social/posts/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { resetEventHandlers } from '@/application/events';
import { publishDuePosts } from '@/application/social/publish';
import {
  findPublisher,
  publisherLabels,
  resetPublisherRegistry,
} from '@/application/social/publisher-registry';
import {
  createSocialAccount,
  createSocialPost,
  resolveManualHandoff,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { providerLabel } from '@/domain/social/social';
import { resetLogger } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import type { DependencyCandidate } from './dependencies';
import { disablePlugin, enablePlugin, findPluginRecord, installPlugin } from './lifecycle';
import { discoverPlugins } from './loader';
import { resetPluginRuntime } from './runtime';

/**
 * Bluesky 配信 Plugin を **Core のジョブを通して**動かす（036-sns-bluesky 設計 §10「B」）。
 *
 * 受け入れ条件 #13〜#15（導入・有効化・登録簿）と #63〜#70（配信・登録時の検査）。
 *
 * **実装は増えない。** G1・G2 で作ったものが、Core の `publishDuePosts` から
 * 実際に呼ばれて動くことを見る。
 *
 * **偽の PDS を挿す口は `globalThis.fetch` だけ**である（実装プラン §8 の 8）。
 * `plugins/sns-bluesky/index.ts` は `fetch` を注入せず既定を使うので、
 * ここを差し替えないと本物の Bluesky を叩くことになる。`afterEach` で必ず戻す。
 */

const PLUGIN_ID = 'sns-bluesky';
const PROVIDER = 'bluesky';

const SESSION_NSID = 'com.atproto.server.createSession';
const RECORD_NSID = 'com.atproto.repo.createRecord';

const SESSION_DID = 'did:plc:torifuneintegration01';
const SESSION_HANDLE = 'real-handle.bsky.example';
const RKEY = '3kintegrationrkey1';

const IDENTIFIER = 'torifune-b.bsky.example';
/** **この値が `failure_reason` にもログにも出てはならない**（#66）。 */
const APP_PASSWORD = 'qqqq-rrrr-ssss-tttt';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let realFetch: typeof globalThis.fetch;

/* -------------------------------------------------------------------------- */
/* 偽の PDS                                                                    */
/* -------------------------------------------------------------------------- */

type Route = (url: string, init: RequestInit) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sessionOk(): Response {
  return json({
    did: SESSION_DID,
    handle: SESSION_HANDLE,
    accessJwt: 'access-jwt-integration',
    refreshJwt: 'refresh-jwt-integration',
  });
}

/** `globalThis.fetch` を偽の PDS に差し替える。要求した URL の列を返す。 */
function useFakePds(options: { readonly session?: Route; readonly record?: Route } = {}): string[] {
  const urls: string[] = [];

  globalThis.fetch = (async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    urls.push(url);

    if (url.includes(SESSION_NSID)) {
      return (options.session ?? sessionOk)(url, init);
    }
    if (url.includes(RECORD_NSID)) {
      return (
        options.record ??
        (() => json({ uri: `at://${SESSION_DID}/app.bsky.feed.post/${RKEY}`, cid: 'bafyb01' }))
      )(url, init);
    }
    throw new Error(`偽の PDS が知らない宛先: ${url}`);
  }) as typeof globalThis.fetch;

  return urls;
}

/* -------------------------------------------------------------------------- */
/* Plugin の導入と有効化（`example-plugin.integration.test.ts` の流儀）           */
/* -------------------------------------------------------------------------- */

function entry(): { readonly manifest: PluginManifest; readonly plugin: Plugin } {
  const found = discoverPlugins().plugins.find((p) => p.manifest.id === PLUGIN_ID);
  if (found === undefined) throw new Error('Bluesky 配信 Plugin が読み込めていない');
  return found;
}

function candidatesOf(
  manifest: PluginManifest,
  enabled: boolean,
): Map<string, DependencyCandidate> {
  return new Map([[manifest.id, { manifest, enabled }]]);
}

async function activate(): Promise<{ ok: boolean; reason?: string }> {
  const { manifest, plugin } = entry();
  return withConnection(async (connection) => {
    await installPlugin(connection, manifest);
    return enablePlugin({
      connection,
      manifest,
      plugin,
      authorization: admin,
      candidates: candidatesOf(manifest, false),
    });
  });
}

async function deactivate(): Promise<void> {
  const { manifest, plugin } = entry();
  await withConnection((connection) =>
    disablePlugin({
      connection,
      manifest,
      plugin,
      authorization: admin,
      candidates: candidatesOf(manifest, true),
    }),
  );
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `b${suffix}`,
        email: `b${suffix}@example.com`,
        display_name: 'sns bluesky test',
      })
      .execute();

    for (const roleName of roleNames) {
      const role = await roleRepository.findByName(connection, roleName);
      if (role === null) throw new Error(`ロールが無い: ${roleName}`);
      await connection.db
        .insertInto('user_roles')
        .values({ user_id: id, role_id: role.id })
        .execute();
    }
  });

  const identity: UserIdentity = {
    userId: id,
    loginId: `b${suffix}`,
    displayName: 'sns bluesky test',
    email: `b${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

/* -------------------------------------------------------------------------- */
/* 投稿とアカウント                                                             */
/* -------------------------------------------------------------------------- */

async function accountFor(withCredentials = true): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider: PROVIDER,
    displayName: 'とりふね公式',
    handle: '@torifune',
    credential: null,
    ...(withCredentials
      ? { credentials: { identifier: IDENTIFIER, appPassword: APP_PASSWORD } }
      : {}),
    status: 'connected',
  });
  return account.id;
}

async function makePost(
  accountId: string,
  overrides: { readonly body?: string; readonly deliveryMode?: 'auto' | 'manual' } = {},
): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: overrides.body ?? 'Bluesky へ届く本文',
    scheduledAt: new Date(Date.now() - 60_000),
    status: 'scheduled',
    deliveryMode: overrides.deliveryMode ?? 'auto',
  });
  return post.id;
}

interface PostRow {
  readonly status: string;
  readonly failure_reason: string | null;
  readonly attempt_count: number;
  readonly external_id: string | null;
  readonly external_url: string | null;
  readonly next_attempt_at: Date | null;
}

async function postRow(id: string): Promise<PostRow> {
  const row = await withConnection((connection) =>
    connection.db
      .selectFrom('social_posts')
      .select([
        'status',
        'failure_reason',
        'attempt_count',
        'external_id',
        'external_url',
        'next_attempt_at',
      ])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`投稿が無い: ${id}`);
  return row as PostRow;
}

/** 後ろへ送られた予定を過去へ戻す（実時間で待たないため）。 */
async function rewindNextAttempt(id: string): Promise<void> {
  await withConnection(async (connection) => {
    await connection.db
      .updateTable('social_posts')
      .set({ next_attempt_at: new Date(Date.now() - 1_000) })
      .where('id', '=', id)
      .execute();
  });
}

async function run() {
  return withConnection((connection) => publishDuePosts(connection));
}

beforeAll(async () => {
  scratch = await useScratchDatabase('snsbluesky');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  realFetch = globalThis.fetch;
  admin = await contextFor(['administrator']);
});

afterEach(async () => {
  // **戻し忘れると後続のテストが道連れになる**（実装プラン §7 の 8）。
  globalThis.fetch = realFetch;
  resetPluginRuntime();
  resetPublisherRegistry();
  resetPermissionRegistry();
  resetEventHandlers();
  resetLogger();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('job_runs').execute();
    await connection.db.deleteFrom('plugin_store').execute();
    await connection.db.deleteFrom('plugins').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #13〜#15 導入・有効化・登録簿                                                */
/* -------------------------------------------------------------------------- */

describe('#13 導入・有効化で publisher が引ける', () => {
  it('#13 有効化すると findPublisher("bluesky") が引ける', async () => {
    await activate();

    expect(findPublisher(PROVIDER)).not.toBeNull();
  });

  it('#13 その pluginId が sns-bluesky', async () => {
    await activate();

    expect(findPublisher(PROVIDER)?.pluginId).toBe(PLUGIN_ID);
  });

  it('#13 無効化すると null に戻る', async () => {
    // 外さないと、無効化したはずの Plugin へ資格情報が渡り続ける。
    await activate();

    await deactivate();

    expect(findPublisher(PROVIDER)).toBeNull();
  });
});

describe('#14 social を宣言していない Manifest では有効化できない', () => {
  /**
   * **`plugin.json` を書き換えない**（実装プラン §8 の 7）。
   * 実ファイルを書き換えると、他のテストが道連れになる。
   */
  async function enableWithoutSocial(): Promise<{
    readonly outcome: { ok: boolean; reason?: string };
    readonly captured: unknown;
  }> {
    const { manifest, plugin } = entry();
    const stripped: PluginManifest = { ...manifest, extensions: ['ui'] };
    let captured: unknown = null;

    const wrapped: Plugin = {
      async activate(context) {
        try {
          await plugin.activate(context);
        } catch (error) {
          captured = error;
          throw error;
        }
      },
    };

    const outcome = await withConnection(async (connection) => {
      await installPlugin(connection, stripped);
      return enablePlugin({
        connection,
        manifest: stripped,
        plugin: wrapped,
        authorization: admin,
        candidates: candidatesOf(stripped, false),
      });
    });

    return { outcome, captured };
  }

  it('#14 registerPublisher が PluginExtensionNotDeclaredError を投げる', async () => {
    const { captured } = await enableWithoutSocial();

    expect(captured).toBeInstanceOf(PluginExtensionNotDeclaredError);
  });

  it('#14 その kind が social', async () => {
    const { captured } = await enableWithoutSocial();

    expect((captured as PluginExtensionNotDeclaredError).kind).toBe('social');
  });

  it('#14 有効化に失敗する', async () => {
    const { outcome } = await enableWithoutSocial();

    expect(outcome.ok).toBe(false);
  });

  it('#14 Plugin が disabled に落ちる', async () => {
    await enableWithoutSocial();

    const record = await withConnection((c) => findPluginRecord(c, PLUGIN_ID));
    expect(record?.status).toBe('disabled');
  });

  it('#14 publisher は登録されない', async () => {
    await enableWithoutSocial();

    expect(findPublisher(PROVIDER)).toBeNull();
  });
});

describe('#15 provider の表示名', () => {
  it('#15 providerLabel("bluesky", publisherLabels()) が Bluesky', async () => {
    await activate();

    expect(providerLabel(PROVIDER, publisherLabels())).toBe('Bluesky');
  });
});

/* -------------------------------------------------------------------------- */
/* #63〜#66 Core のジョブを通した配信                                           */
/* -------------------------------------------------------------------------- */

describe('#63 ジョブを通して配信できる', () => {
  async function publishOnce(): Promise<{
    readonly postId: string;
    readonly summary: Awaited<ReturnType<typeof run>>;
    readonly urls: readonly string[];
  }> {
    const urls = useFakePds();
    await activate();
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    const summary = await run();
    return { postId, summary, urls };
  }

  it('#63 summary.published が 1', async () => {
    const { summary } = await publishOnce();

    expect(summary.published).toBe(1);
  });

  it('#63 投稿が published になる', async () => {
    const { postId } = await publishOnce();

    expect((await postRow(postId)).status).toBe('published');
  });

  it('#63 external_id に rkey が入る', async () => {
    const { postId } = await publishOnce();

    expect((await postRow(postId)).external_id).toBe(RKEY);
  });

  it('#63 external_url に createSession のハンドルで組んだ URL が入る', async () => {
    // **`account.handle` ではなく `createSession` の応答**を使う（設計 §6.4）。
    const { postId } = await publishOnce();

    expect((await postRow(postId)).external_url).toBe(
      `https://bsky.app/profile/${SESSION_HANDLE}/post/${RKEY}`,
    );
  });

  it('#63 PDS へ出た要求は createSession と createRecord の2本だけ', async () => {
    const { urls } = await publishOnce();

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain(SESSION_NSID);
    expect(urls[1]).toContain(RECORD_NSID);
  });

  it('#63 既定の PDS（bsky.social）へ出る', async () => {
    const { urls } = await publishOnce();

    expect(urls[0]).toBe(`https://bsky.social/xrpc/${SESSION_NSID}`);
  });
});

describe('#64 資格情報の読み出しが監査に残る', () => {
  it('#64 audit_logs に credential_read が1行入る', async () => {
    // Core の経路（復号 → 監査 → `publish()`）が通ったことの証（035 §6.5.8）。
    useFakePds();
    await activate();
    const accountId = await accountFor();
    await makePost(accountId);

    await run();

    const rows = await withConnection((connection) =>
      connection.db
        .selectFrom('audit_logs')
        .select(['resource_id'])
        .where('action', '=', 'credential_read')
        .execute(),
    );
    expect(rows).toHaveLength(1);
  });
});

describe('#65 retryable: true のときは再試行へ回る', () => {
  async function failWith503(): Promise<{
    readonly postId: string;
    readonly summary: Awaited<ReturnType<typeof run>>;
  }> {
    useFakePds({ session: () => json({ error: 'InternalServerError' }, 503) });
    await activate();
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    const summary = await run();
    return { postId, summary };
  }

  it('#65 投稿は scheduled のまま', async () => {
    const { postId } = await failWith503();

    expect((await postRow(postId)).status).toBe('scheduled');
  });

  it('#65 next_attempt_at が入る', async () => {
    const { postId } = await failWith503();

    expect((await postRow(postId)).next_attempt_at).toBeInstanceOf(Date);
  });

  it('#65 attempt_count が 1', async () => {
    const { postId } = await failWith503();

    expect((await postRow(postId)).attempt_count).toBe(1);
  });

  it('#65 summary.retried が 1', async () => {
    const { summary } = await failWith503();

    expect(summary.retried).toBe(1);
  });
});

describe('#66 retryable: false のときは failed になる', () => {
  async function failWith401(): Promise<string> {
    useFakePds({
      session: () =>
        json({ error: 'AuthenticationRequired', message: `invalid ${APP_PASSWORD}` }, 401),
    });
    await activate();
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    await run();
    return postId;
  }

  it('#66 投稿が failed になる', async () => {
    const postId = await failWith401();

    expect((await postRow(postId)).status).toBe('failed');
  });

  it('#66 failure_reason に App Password への言及がある', async () => {
    // 運用者が次に何をすればよいかが読める文言でなければ、履歴を見ても直せない。
    const postId = await failWith401();

    expect((await postRow(postId)).failure_reason).toContain('App Password');
  });

  it('#66 failure_reason に appPassword の値が含まれない', async () => {
    // PDS の `message`（自由文）は載せない（設計 §6.11）。伏せ字を当てにしない。
    const postId = await failWith401();

    expect((await postRow(postId)).failure_reason ?? '').not.toContain(APP_PASSWORD);
  });
});

/* -------------------------------------------------------------------------- */
/* #67 登録時に validate() が効く                                               */
/* -------------------------------------------------------------------------- */

describe('#67 301 文字の本文は登録できない', () => {
  const ENDPOINT = 'http://127.0.0.1:3000/api/v1/social/posts';

  async function createViaApi(body: string): Promise<{
    readonly status: number;
    readonly details: Record<string, readonly string[]>;
  }> {
    useFakePds();
    await activate();
    const accountId = await accountFor();
    const token = await createApiToken(admin, {
      name: `post-${uuidv7().slice(-8)}`,
      scopes: ['social.read', 'social.write'],
      expiresAt: null,
    });

    const response = await createSocialPostRoute(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token.plaintext}`,
        },
        body: JSON.stringify({
          socialAccountId: accountId,
          body,
          scheduledAt: new Date(Date.now() + 600_000).toISOString(),
          status: 'scheduled',
          deliveryMode: 'auto',
        }),
      }),
    );

    const text = await response.text();
    const parsed = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
    const error = parsed['error'] as
      { readonly details?: Record<string, readonly string[]> } | undefined;
    return { status: response.status, details: error?.details ?? {} };
  }

  it('#67 422 になる', async () => {
    const result = await createViaApi('あ'.repeat(301));

    expect(result.status).toBe(422);
  });

  it('#67 details の body に 300文字 が出る', async () => {
    const result = await createViaApi('あ'.repeat(301));

    expect((result.details['body'] ?? []).join(' ')).toContain('300文字');
  });

  it('#67 300 文字ちょうどなら登録できる', async () => {
    // 上限そのものを弾かない（#16 と同じ線）。
    const result = await createViaApi('あ'.repeat(300));

    expect(result.status).toBe(201);
  });
});

/* -------------------------------------------------------------------------- */
/* #68 無効化中でも予約でき、有効化すれば配信される                              */
/* -------------------------------------------------------------------------- */

describe('#68 Plugin が無効でも予約は受け付ける', () => {
  async function scheduleWhileDisabled(): Promise<{
    readonly postId: string;
    readonly summary: Awaited<ReturnType<typeof run>>;
  }> {
    await activate();
    const accountId = await accountFor();
    await deactivate();

    const postId = await makePost(accountId);
    const summary = await run();
    return { postId, summary };
  }

  it('#68 無効化した状態でも投稿を予約できる', async () => {
    const { postId } = await scheduleWhileDisabled();

    expect((await postRow(postId)).status).toBe('scheduled');
  });

  it('#68 ジョブは summary.skipped で飛ばす', async () => {
    const { summary } = await scheduleWhileDisabled();

    expect(summary.skipped).toBe(1);
  });

  it('#68 飛ばした投稿に failure_reason を書かない', async () => {
    const { postId } = await scheduleWhileDisabled();

    expect((await postRow(postId)).failure_reason).toBeNull();
  });

  it('#68 有効化すれば次の周期で配信される', async () => {
    // **裁定 #8 の要。** 断らずに受けた以上、支度が整えば配信される。
    const { postId } = await scheduleWhileDisabled();

    useFakePds();
    await activate();
    await rewindNextAttempt(postId);
    await run();

    expect((await postRow(postId)).status).toBe('published');
  });
});

/* -------------------------------------------------------------------------- */
/* #69 手動投稿                                                                 */
/* -------------------------------------------------------------------------- */

describe('#69 手動投稿の受け渡し', () => {
  it('#69 resolveManualHandoff が intent の URL を返す', async () => {
    await activate();
    const accountId = await accountFor();
    const postId = await makePost(accountId, { deliveryMode: 'manual', body: 'てがき' });

    const outcome = await resolveManualHandoff(admin, { id: postId });

    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.ok ? outcome.url : '').toBe(
      `https://bsky.app/intent/compose?text=${encodeURIComponent('てがき')}`,
    );
  });

  it('#69 note が返る', async () => {
    await activate();
    const accountId = await accountFor();
    const postId = await makePost(accountId, { deliveryMode: 'manual' });

    const outcome = await resolveManualHandoff(admin, { id: postId });

    expect(outcome.ok ? outcome.note : null).toContain('投稿画面');
  });
});

/* -------------------------------------------------------------------------- */
/* #70 provider の衝突                                                          */
/* -------------------------------------------------------------------------- */

describe('#70 同じ provider を別の Plugin が登録できない', () => {
  const RIVAL_ID = 'rival-bluesky-plugin';

  function rivalRegistration(): PublisherRegistration {
    return { provider: PROVIDER, label: '別の Bluesky', credentialFields: [] };
  }

  async function enableRival(): Promise<{
    readonly outcome: { ok: boolean; reason?: string };
    readonly captured: unknown;
  }> {
    await activate();

    const manifest: PluginManifest = {
      id: RIVAL_ID,
      name: RIVAL_ID,
      version: '1.0.0',
      apiVersion: 1,
      extensions: ['social'],
    };
    let captured: unknown = null;
    const plugin: Plugin = {
      activate(context) {
        try {
          context.social.registerPublisher(rivalRegistration());
        } catch (error) {
          captured = error;
          throw error;
        }
      },
    };

    const outcome = await withConnection(async (connection) => {
      await installPlugin(connection, manifest);
      return enablePlugin({
        connection,
        manifest,
        plugin,
        authorization: admin,
        candidates: candidatesOf(manifest, false),
      });
    });

    return { outcome, captured };
  }

  it('#70 PluginPublisherConflictError が投げられる', async () => {
    const { captured } = await enableRival();

    expect(captured).toBeInstanceOf(PluginPublisherConflictError);
  });

  it('#70 その registeredBy が sns-bluesky', async () => {
    const { captured } = await enableRival();

    expect((captured as PluginPublisherConflictError).registeredBy).toBe(PLUGIN_ID);
  });

  it('#70 後から来た Plugin の有効化は失敗する', async () => {
    const { outcome } = await enableRival();

    expect(outcome.ok).toBe(false);
  });

  it('#70 先に有効化した sns-bluesky の登録が残る', async () => {
    await enableRival();

    expect(findPublisher(PROVIDER)?.pluginId).toBe(PLUGIN_ID);
  });
});
