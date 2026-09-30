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
  updateSocialAccount,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { providerLabel } from '@/domain/social/social';
import { decryptSecret } from '@/infrastructure/crypto/cipher';
import { resetLogger } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import {
  ACCESS_TOKEN,
  MEDIA_ID,
  PERMALINK,
  REFRESHED_ACCESS_TOKEN,
  THREADS_API_ORIGIN,
  THREADS_USER_ID,
  defaultThreadsReply,
  htmlPage,
  leakyError,
  mediaUrlOf,
  threadsPublished,
  threadsRequestKind,
  toResponse,
  type ThreadsRequestKind,
  type ThreadsResponseExample,
} from '@/test-support/threads-api';
import { THREADS_MANUAL_NOTE } from '../../../../plugins/sns-threads/threads-text';
import type { DependencyCandidate } from './dependencies';
import { disablePlugin, enablePlugin, findPluginRecord, installPlugin } from './lifecycle';
import { discoverPlugins } from './loader';
import { resetPluginRuntime } from './runtime';

/**
 * Threads 配信 Plugin を **Core を通して**動かす（040-sns-threads 設計 §10.3「B」・§10.14「B / C」・§10.16）。
 *
 * 受け入れ条件 #18〜#21（導入・有効化・登録簿・表示名・provider の衝突）、
 * #94〜#97（ジョブを通した配信・延長の書き戻し・比較更新で捨てられる場合・失敗の記録）、
 * #98〜#99（`POST /api/v1/social/posts` の 422・403・401）、#100（手動投稿の受け渡し）、
 * #101（無効化中に登録した予約の配信直前の再検査）、#107（B 側：偽 Threads API は未知の宛先で投げる）。
 *
 * **実装は増えない。** G1〜G7 で作った Plugin が、Core の `publishDuePosts` / 登録の UseCase / ルートから
 * 実際に呼ばれて動くことを見る。
 *
 * **偽の Threads API を挿す口は `globalThis.fetch` だけ**である（実装プラン §2「B 群の偽 Threads API」）。
 * `plugins/sns-threads/index.ts` は `fetch` を注入せず既定を使うので、ここを差し替えないと本物の Threads を叩く。
 * `beforeEach` でまず「呼ばれたら投げる」`fetch` を置き、`useFakeThreadsApi()` がそれを上書きする。`afterEach` で必ず戻す。
 *
 * 既定の `wait`（実時間）を使うので、偽の R3 は最初から `FINISHED` を返す（`defaultThreadsReply`）。
 * 既定の `now`（実時間）を使うので、トークンの期限は `Date.now()` からの相対で作る。
 *
 * **資格情報の値に `torifune` を含めない**（CI の `DATABASE_URL` の password。Core の伏せ字が値を `***` に替え、
 * 「値が出ない」の検査が Plugin と無関係に通ってしまう）。値は `test-support/threads-api.ts` の架空のもの。
 */

const PLUGIN_ID = 'sns-threads';
const PROVIDER = 'threads';

const DAY_MS = 24 * 60 * 60 * 1000;

/** #96 で配信中に運用者が入れ直す、別の 3 項目の資格情報（どの値も元とも延長後とも違う）。 */
const OPERATOR_CREDENTIALS = {
  threadsUserId: '31415926000000002',
  accessToken: 'Op5Yd|kL2~sW-8.n_Fx!Mb',
  accessTokenExpiresAt: '2026-12-01T00:00:00.000Z',
} as const;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let realFetch: typeof globalThis.fetch;

/* -------------------------------------------------------------------------- */
/* 偽の Threads API                                                             */
/* -------------------------------------------------------------------------- */

interface ThreadsCall {
  readonly kind: ThreadsRequestKind;
  readonly url: string;
  /** POST は form の本体、GET はクエリの `access_token`。 */
  readonly accessToken: string | null;
}

type Route = () => ThreadsResponseExample | Promise<ThreadsResponseExample>;

/**
 * 偽の Threads API を用意していないテストが、**素の `globalThis.fetch` のまま走らない**ようにする（#107）。
 *
 * `useFakeThreadsApi()` を呼んだテストだけが偽物を持つ形だと、呼び忘れたテストは本物で走る。
 * `beforeEach` で一律にこれを置き、`useFakeThreadsApi()` がそのうえから上書きする。
 */
function throwingFetch(): typeof globalThis.fetch {
  return ((): never => {
    throw new Error('偽の Threads API を用意していない fetch が呼ばれた');
  }) as typeof globalThis.fetch;
}

/**
 * `globalThis.fetch` を偽の Threads API に差し替える。要求の列を返す。
 *
 * **未知の宛先・未知の要求では同期で投げる**（#107。`threadsRequestKind` が見分ける）。投げた要求は列に積まない。
 */
function useFakeThreadsApi(routes: Partial<Record<ThreadsRequestKind, Route>> = {}): ThreadsCall[] {
  const calls: ThreadsCall[] = [];

  globalThis.fetch = ((input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    // 知らない宛先・知らない要求はここで投げる（Promise を返す前）。
    const kind = threadsRequestKind(url, method, form);
    calls.push({
      kind,
      url: url.href,
      accessToken:
        method === 'POST' ? form.get('access_token') : url.searchParams.get('access_token'),
    });
    const route = routes[kind];
    return (async () => {
      const example =
        route === undefined ? defaultThreadsReply(kind, { url, form }) : await route();
      return toResponse(example, init.signal);
    })();
  }) as typeof globalThis.fetch;

  return calls;
}

/* -------------------------------------------------------------------------- */
/* Plugin の導入と有効化（`sns-instagram.integration.test.ts` の流儀）             */
/* -------------------------------------------------------------------------- */

function entry(): { readonly manifest: PluginManifest; readonly plugin: Plugin } {
  const found = discoverPlugins().plugins.find((p) => p.manifest.id === PLUGIN_ID);
  if (found === undefined) throw new Error('Threads 配信 Plugin が読み込めていない');
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
        login_id: `t${suffix}`,
        email: `t${suffix}@example.com`,
        display_name: 'sns threads test',
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
    loginId: `t${suffix}`,
    displayName: 'sns threads test',
    email: `t${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

/* -------------------------------------------------------------------------- */
/* 投稿とアカウント                                                             */
/* -------------------------------------------------------------------------- */

/** 期限を「今から days 日後」にした 3 項目の資格情報（既定の時計は実時間なので、実時間からの相対で作る）。 */
function credentialsExpiringIn(days: number): Record<string, string> {
  return {
    threadsUserId: THREADS_USER_ID,
    accessToken: ACCESS_TOKEN,
    accessTokenExpiresAt: new Date(Date.now() + days * DAY_MS).toISOString(),
  };
}

async function accountFor(credentials = credentialsExpiringIn(40)): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider: PROVIDER,
    displayName: 'Threads の公式アカウント',
    handle: 'yamada.example',
    credential: null,
    credentials,
    status: 'connected',
  });
  return account.id;
}

interface PostOptions {
  readonly body?: string;
  readonly link?: string | null;
  readonly media?: readonly { readonly url: string; readonly alt: string | null }[];
  readonly deliveryMode?: 'auto' | 'manual';
  readonly scheduledAt?: Date;
}

/** 期限の来た投稿（既定は画像 1 枚の `auto`）。 */
async function makePost(accountId: string, options: PostOptions = {}): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: options.body ?? 'Threads へ届く本文 #テスト',
    scheduledAt: options.scheduledAt ?? new Date(Date.now() - 60_000),
    status: 'scheduled',
    deliveryMode: options.deliveryMode ?? 'auto',
    media: options.media ?? [{ url: mediaUrlOf(0), alt: '代替テキスト' }],
    ...(options.link === undefined ? {} : { link: options.link }),
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

/** `social_accounts.credential`（暗号文）。 */
async function storedCredential(accountId: string): Promise<string | null> {
  const row = await withConnection((connection) =>
    connection.db
      .selectFrom('social_accounts')
      .select(['credential'])
      .where('id', '=', accountId)
      .executeTakeFirst(),
  );
  return (row as { credential: string | null } | undefined)?.credential ?? null;
}

/** 暗号文を復号して JSON として読む。 */
async function decryptedCredential(accountId: string): Promise<Record<string, string>> {
  const decrypted = decryptSecret((await storedCredential(accountId)) ?? '');
  if (!decrypted.ok) throw new Error('資格情報を復号できない');
  return JSON.parse(decrypted.secret.expose()) as Record<string, string>;
}

interface AuditRow {
  readonly resource_type: string;
  readonly resource_id: string | null;
  readonly detail: Record<string, unknown>;
}

async function auditRows(action: string): Promise<AuditRow[]> {
  return withConnection(async (connection) => {
    const rows = await connection.db
      .selectFrom('audit_logs')
      .select(['resource_type', 'resource_id', 'detail'])
      .where('action', '=', action)
      .execute();
    return rows as AuditRow[];
  });
}

/** 延長の書き戻しの監査（`updated` で `detail.rotated === true`）。 */
async function rotatedAuditRows(): Promise<AuditRow[]> {
  return (await auditRows('updated')).filter(
    (row) => row.resource_type === 'social_account' && row.detail['rotated'] === true,
  );
}

async function postCount(): Promise<number> {
  const rows = await withConnection((connection) =>
    connection.db.selectFrom('social_posts').select(['id']).execute(),
  );
  return rows.length;
}

/** 予約時刻を過去へ戻す（実時間で待たないため）。 */
async function makeDue(postId: string): Promise<void> {
  await withConnection(async (connection) => {
    await connection.db
      .updateTable('social_posts')
      .set({ scheduled_at: new Date(Date.now() - 60_000) })
      .where('id', '=', postId)
      .execute();
  });
}

async function run() {
  return withConnection((connection) => publishDuePosts(connection));
}

/* -------------------------------------------------------------------------- */
/* API（ルートを直接叩く。036 #67・038 #87・037 #72 と同じ）                        */
/* -------------------------------------------------------------------------- */

const ENDPOINT = 'http://127.0.0.1:3000/api/v1/social/posts';
const CSRF_TOKEN = 'csrf-token-for-sns-threads';

interface ApiOutcome {
  readonly status: number;
  readonly details: Record<string, readonly string[]>;
  readonly postId: string | null;
}

async function issueToken(scopes: readonly string[]): Promise<string> {
  const token = await createApiToken(admin, {
    name: `threads-${uuidv7().slice(-8)}`,
    scopes: [...scopes],
    expiresAt: null,
  });
  return token.plaintext;
}

interface CallOptions {
  /** Bearer の平文。`null` なら Authorization を付けない（未認証）。 */
  readonly token?: string | null;
}

/** `POST /api/v1/social/posts` をルートから直接叩く。既定はテキストだけの `auto`。 */
async function createViaApi(
  accountId: string,
  fields: Record<string, unknown>,
  options: CallOptions = {},
): Promise<ApiOutcome> {
  const token =
    options.token === undefined ? await issueToken(['social.read', 'social.write']) : options.token;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token === null) {
    // Bearer が無い経路は CSRF を通らないと 403 になり、401 を確かめられない（social-post-create の流儀）。
    headers['x-forwarded-host'] = '127.0.0.1:3000';
    headers['origin'] = 'http://127.0.0.1:3000';
    headers['cookie'] = `torifune_csrf=${CSRF_TOKEN}`;
    headers['x-csrf-token'] = CSRF_TOKEN;
  } else {
    headers['authorization'] = `Bearer ${token}`;
  }

  const response = await createSocialPostRoute(
    new Request(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        socialAccountId: accountId,
        body: 'Threads へ届く本文',
        scheduledAt: new Date(Date.now() + 600_000).toISOString(),
        status: 'scheduled',
        deliveryMode: 'auto',
        ...fields,
      }),
    }),
  );

  const text = await response.text();
  const parsed = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  const error = parsed['error'] as
    { readonly details?: Record<string, readonly string[]> } | undefined;
  const data = parsed['data'] as { readonly id?: string } | undefined;
  return {
    status: response.status,
    details: error?.details ?? {},
    postId: data?.id ?? null,
  };
}

/**
 * **`String.length` では 499、設計 §9.4 の数え方では 501** になる本文（実装プラン §8 の 16）。
 * `'a'.repeat(501)` では `String.length` で数える誤った実装でも断れてしまい、§9.4 の数え方が効いたかを読めない。
 */
const BODY_501_BY_THREADS_COUNT = 'a'.repeat(497) + '👍';

/* -------------------------------------------------------------------------- */
/* 準備と後始末                                                                 */
/* -------------------------------------------------------------------------- */

beforeAll(async () => {
  scratch = await useScratchDatabase('snsthreads');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  realFetch = globalThis.fetch;
  // **偽の Threads API を置く前に、まず投げる `fetch` を置く**（#107）。`useFakeThreadsApi()` がこれを上書きする。
  globalThis.fetch = throwingFetch();
  admin = await contextFor(['administrator']);
});

afterEach(async () => {
  // **戻し忘れると後続のテストが道連れになる**（実装プラン §7 の 16）。
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
/* #107（B 側）偽 Threads API は未知の宛先で投げる                                   */
/* -------------------------------------------------------------------------- */

describe('#107 結合テストの偽 Threads API は未知の宛先で投げる', () => {
  it('#107 知らないホスト（https://example.test/）への要求は同期で投げる', () => {
    useFakeThreadsApi();

    expect(() => globalThis.fetch('https://example.test/')).toThrow(/知らない宛先/);
  });

  it('#107 graph.threads.com（別の有効な宛先）も知らない宛先として投げる', () => {
    // 宛先は graph.threads.net に固定（設計 §6.1）。もう一方へ出たら偽物が止める。
    useFakeThreadsApi();

    expect(() => globalThis.fetch('https://graph.threads.com/v1.0/me')).toThrow(/知らない宛先/);
  });

  it('#107 graph.threads.net でも知らない要求（GET /v1.0/me?fields=id）は投げる', () => {
    useFakeThreadsApi();

    expect(() => globalThis.fetch(`${THREADS_API_ORIGIN}/v1.0/me?fields=id`)).toThrow(
      /知らない要求/,
    );
  });

  it('#107 投げた要求は要求の列に積まれない', () => {
    const calls = useFakeThreadsApi();

    expect(() => globalThis.fetch('https://example.test/')).toThrow();
    expect(calls).toHaveLength(0);
  });

  it('#107 知っている要求（POST /v1.0/{id}/threads_publish）には応答を返す（対の条件）', async () => {
    const calls = useFakeThreadsApi();

    const response = await globalThis.fetch(
      `${THREADS_API_ORIGIN}/v1.0/${THREADS_USER_ID}/threads_publish`,
      { method: 'POST', body: 'creation_id=1' },
    );

    expect(response.status).toBe(200);
    expect(calls.map((call) => call.kind)).toEqual(['R4']);
  });

  it('#107 偽の Threads API を置いていないテストでは、fetch が呼ばれた時点で投げる', () => {
    expect(() => globalThis.fetch(`${THREADS_API_ORIGIN}/v1.0/me`)).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* #18〜#21 導入・有効化・登録簿・表示名                                           */
/* -------------------------------------------------------------------------- */

describe('#18 導入・有効化で publisher が引ける', () => {
  it('#18 有効化に成功する', async () => {
    const outcome = await activate();

    expect(outcome.ok, outcome.reason).toBe(true);
  });

  it('#18 有効化すると findPublisher("threads") が引け、その pluginId が sns-threads', async () => {
    await activate();

    expect(findPublisher(PROVIDER)).not.toBeNull();
    expect(findPublisher(PROVIDER)?.pluginId).toBe(PLUGIN_ID);
  });

  it('#18 無効化すると null に戻る', async () => {
    await activate();

    await deactivate();

    expect(findPublisher(PROVIDER)).toBeNull();
  });
});

describe('#19 social を宣言していない Manifest では有効化できない', () => {
  /**
   * **`plugin.json` を書き換えない**（実装プラン §2 の #19）。
   * `extensions` は省略可なので、空配列でも有効な Manifest になる。
   */
  async function enableWithoutSocial(): Promise<{
    readonly outcome: { ok: boolean; reason?: string };
    readonly captured: unknown;
  }> {
    const { manifest, plugin } = entry();
    const stripped: PluginManifest = { ...manifest, extensions: [] };
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

  it('#19 registerPublisher が PluginExtensionNotDeclaredError（kind: social）を投げる', async () => {
    const { captured } = await enableWithoutSocial();

    expect(captured).toBeInstanceOf(PluginExtensionNotDeclaredError);
    expect((captured as PluginExtensionNotDeclaredError).kind).toBe('social');
  });

  it('#19 有効化に失敗し、Plugin が disabled に落ちる', async () => {
    const { outcome } = await enableWithoutSocial();

    expect(outcome.ok).toBe(false);
    const record = await withConnection((c) => findPluginRecord(c, PLUGIN_ID));
    expect(record?.status).toBe('disabled');
  });

  it('#19 publisher は登録されない', async () => {
    await enableWithoutSocial();

    expect(findPublisher(PROVIDER)).toBeNull();
  });
});

describe('#20 provider の表示名（ユーザー裁定：無効な間は生の値）', () => {
  it('#20 有効化した状態で providerLabel("threads", publisherLabels()) が Threads', async () => {
    await activate();

    expect(providerLabel(PROVIDER, publisherLabels())).toBe('Threads');
  });

  it('#20 無効化した状態では生の値 threads（Core の KNOWN_PROVIDERS に足さない。設計 §11 #1）', async () => {
    await activate();
    await deactivate();

    expect(providerLabel(PROVIDER, publisherLabels())).toBe('threads');
  });

  it('#20 一度も有効化していない状態でも threads', () => {
    expect(providerLabel(PROVIDER, publisherLabels())).toBe('threads');
  });
});

describe('#21 同じ provider: threads を別の Plugin が登録できない', () => {
  const RIVAL_ID = 'rival-threads-plugin';

  function rivalRegistration(): PublisherRegistration {
    return { provider: PROVIDER, label: 'x', credentialFields: [] };
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

  it('#21 PluginPublisherConflictError が投げられ、その registeredBy が sns-threads', async () => {
    const { captured } = await enableRival();

    expect(captured).toBeInstanceOf(PluginPublisherConflictError);
    expect((captured as PluginPublisherConflictError).registeredBy).toBe(PLUGIN_ID);
  });

  it('#21 後から来た Plugin の有効化は失敗し、sns-threads の登録が残る', async () => {
    const { outcome } = await enableRival();

    expect(outcome.ok).toBe(false);
    expect(findPublisher(PROVIDER)?.pluginId).toBe(PLUGIN_ID);
  });
});

/* -------------------------------------------------------------------------- */
/* #94〜#97 Core のジョブを通した配信                                             */
/* -------------------------------------------------------------------------- */

describe('#94 ジョブを通して配信できる', () => {
  const SHAPES = [
    { label: '画像 1 枚', media: [{ url: mediaUrlOf(0), alt: '代替テキスト' }] },
    { label: 'テキストだけ', media: [] },
  ] as const;

  async function publishOnce(media: PostOptions['media']): Promise<{
    readonly postId: string;
    readonly summary: Awaited<ReturnType<typeof run>>;
    readonly calls: readonly ThreadsCall[];
  }> {
    const calls = useFakeThreadsApi();
    await activate();
    const accountId = await accountFor();
    const postId = await makePost(accountId, { media });

    const summary = await run();
    return { postId, summary, calls };
  }

  it.each(SHAPES)('#94 $label：summary.published が 1', async ({ media }) => {
    const { summary } = await publishOnce(media);

    expect(summary.published).toBe(1);
  });

  it.each(SHAPES)(
    '#94 $label：投稿が published になり、external_id に media ID、external_url に permalink が入る',
    async ({ media }) => {
      const { postId } = await publishOnce(media);

      const row = await postRow(postId);
      expect(row.status).toBe('published');
      expect(row.external_id).toBe(MEDIA_ID);
      expect(row.external_url).toBe(PERMALINK);
    },
  );

  it.each(SHAPES)(
    '#94 $label：Threads API へ出た要求は R1 → R3 → R4 → R5（期限が 40 日後なので R6 は無い）',
    async ({ media }) => {
      const { calls } = await publishOnce(media);

      expect(calls.map((call) => call.kind)).toEqual(['R1', 'R3', 'R4', 'R5']);
    },
  );

  it.each(SHAPES)('#94 $label：audit_logs に credential_read が 1 行入る', async ({ media }) => {
    await publishOnce(media);

    expect(await auditRows('credential_read')).toHaveLength(1);
  });

  it('#94 延長しないときは資格情報の書き戻し（rotated: true の監査）が起きない', async () => {
    await publishOnce(SHAPES[0].media);

    expect(await rotatedAuditRows()).toHaveLength(0);
  });
});

describe('#95 トークンの延長が Core によって書き戻される', () => {
  async function publishWithRefresh(): Promise<{
    readonly accountId: string;
    readonly postId: string;
    readonly before: Record<string, string>;
    readonly calls: readonly ThreadsCall[];
  }> {
    const calls = useFakeThreadsApi();
    await activate();
    const before = credentialsExpiringIn(10);
    const accountId = await accountFor(before);
    const postId = await makePost(accountId);

    await run();
    return { accountId, postId, before, calls };
  }

  it('#95 期限 10 日後なら R5 の後に R6 を送り、投稿は published', async () => {
    const { postId, calls } = await publishWithRefresh();

    expect(calls.map((call) => call.kind)).toEqual(['R1', 'R3', 'R4', 'R5', 'R6']);
    expect((await postRow(postId)).status).toBe('published');
  });

  it('#95 social_accounts.credential を復号した accessToken が R6 の新しいトークンになる', async () => {
    const { accountId } = await publishWithRefresh();

    expect((await decryptedCredential(accountId))['accessToken']).toBe(REFRESHED_ACCESS_TOKEN);
  });

  it('#95 accessTokenExpiresAt が約 60 日後（now + expires_in）に更新される', async () => {
    const { accountId, before } = await publishWithRefresh();

    const after = (await decryptedCredential(accountId))['accessTokenExpiresAt'] ?? '';
    expect(after).not.toBe(before['accessTokenExpiresAt']);
    const remaining = Date.parse(after) - Date.now();
    expect(remaining).toBeGreaterThan(59 * DAY_MS);
    expect(remaining).toBeLessThan(61 * DAY_MS);
  });

  it('#95 threadsUserId は元のまま、キーは 3 項目ちょうど', async () => {
    const { accountId } = await publishWithRefresh();

    const after = await decryptedCredential(accountId);
    expect(after['threadsUserId']).toBe(THREADS_USER_ID);
    expect(Object.keys(after).sort()).toEqual([
      'accessToken',
      'accessTokenExpiresAt',
      'threadsUserId',
    ]);
  });

  it('#95 audit_logs に updated / rotated: true / pluginId: sns-threads が 1 行', async () => {
    const { accountId } = await publishWithRefresh();

    const rows = await rotatedAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe(accountId);
    expect(rows[0]?.detail).toEqual({
      changed: ['credential'],
      rotated: true,
      pluginId: PLUGIN_ID,
    });
  });

  it('#95 監査の detail に新旧どちらのトークンも出ない', async () => {
    await publishWithRefresh();

    const text = JSON.stringify(await auditRows('updated'));
    expect(text).not.toContain(REFRESHED_ACCESS_TOKEN);
    expect(text).not.toContain(ACCESS_TOKEN);
  });

  it('#95 延長された後の 2 件目の配信で、R1 の form の access_token が新しいトークン', async () => {
    const calls = useFakeThreadsApi();
    await activate();
    const accountId = await accountFor(credentialsExpiringIn(10));

    await makePost(accountId);
    await run();
    const firstRun = calls.length;
    await makePost(accountId);
    await run();

    const firstR1 = calls.slice(0, firstRun).find((call) => call.kind === 'R1');
    const secondR1 = calls.slice(firstRun).find((call) => call.kind === 'R1');
    expect(firstR1?.accessToken).toBe(ACCESS_TOKEN);
    expect(secondR1?.accessToken).toBe(REFRESHED_ACCESS_TOKEN);
  });

  it('#95 2 件目は期限が約 60 日後になっているので、もう延長しない（R6 は 1 本だけ）', async () => {
    const calls = useFakeThreadsApi();
    await activate();
    const accountId = await accountFor(credentialsExpiringIn(10));

    await makePost(accountId);
    await run();
    await makePost(accountId);
    await run();

    expect(calls.filter((call) => call.kind === 'R6')).toHaveLength(1);
    expect(calls.filter((call) => call.kind === 'R4')).toHaveLength(2);
  });
});

/**
 * #96。**比較更新で捨てられる**（`039` §6.1）。#95 がその対照（差し替えが無ければ書き戻される）。
 *
 * 手は `publish-rotation.integration.test.ts` を写す：偽 Threads API の **R4 の応答を返す前に**
 * UseCase `updateSocialAccount` を `await` して運用者の差し替えを確定させる。時間に頼らず決定的に重なる。
 * 期限は 10 日後にして R6 が走り、`rotatedCredential` が**実際に返っている**形にする
 * （返っていない形で「捨てられた」を見ても判別力が無い。R6 の本数で確かめる）。
 */
describe('#96 配信中に運用者が資格情報を差し替えると、延長したトークンは捨てられる', () => {
  async function publishWhileOperatorReplaces(): Promise<{
    readonly accountId: string;
    readonly postId: string;
    readonly calls: readonly ThreadsCall[];
  }> {
    const operator = await contextFor(['administrator']);
    let accountId = '';
    const calls = useFakeThreadsApi({
      R4: async () => {
        await updateSocialAccount(operator, {
          id: accountId,
          credentials: { ...OPERATOR_CREDENTIALS },
        });
        return threadsPublished();
      },
    });
    await activate();
    accountId = await accountFor(credentialsExpiringIn(10));
    const postId = await makePost(accountId);

    await run();
    return { accountId, postId, calls };
  }

  it('#96 前提：Plugin は延長した（R6 を 1 本送った）', async () => {
    const { calls } = await publishWhileOperatorReplaces();

    expect(calls.filter((call) => call.kind === 'R6')).toHaveLength(1);
  });

  it('#96 投稿は published のまま', async () => {
    const { postId } = await publishWhileOperatorReplaces();

    expect((await postRow(postId)).status).toBe('published');
  });

  it('#96 DB を復号すると、運用者が差し替えた 3 項目ちょうど', async () => {
    const { accountId } = await publishWhileOperatorReplaces();

    expect(await decryptedCredential(accountId)).toEqual(OPERATOR_CREDENTIALS);
  });

  it('#96 延長したトークンは保存されていない', async () => {
    const { accountId } = await publishWhileOperatorReplaces();

    expect((await decryptedCredential(accountId))['accessToken']).not.toBe(REFRESHED_ACCESS_TOKEN);
  });

  it('#96 rotated: true の監査の行が無い', async () => {
    await publishWhileOperatorReplaces();

    expect(await rotatedAuditRows()).toHaveLength(0);
  });
});

describe('#97 R1 が 503 なら再試行へ回り、資格情報は書き換わらない', () => {
  async function failWith503(): Promise<{
    readonly accountId: string;
    readonly postId: string;
    readonly summary: Awaited<ReturnType<typeof run>>;
    readonly before: string | null;
    readonly calls: readonly ThreadsCall[];
  }> {
    const calls = useFakeThreadsApi({ R1: () => htmlPage(503) });
    await activate();
    // 期限が近くても、公開に失敗したら延長しない（R6 は公開の後だけ）。
    const accountId = await accountFor(credentialsExpiringIn(10));
    const before = await storedCredential(accountId);
    const postId = await makePost(accountId);

    const summary = await run();
    return { accountId, postId, summary, before, calls };
  }

  it('#97 投稿は scheduled のまま、next_attempt_at が入る', async () => {
    const { postId } = await failWith503();

    const row = await postRow(postId);
    expect(row.status).toBe('scheduled');
    expect(row.next_attempt_at).toBeInstanceOf(Date);
  });

  it('#97 summary.retried が 1', async () => {
    const { summary } = await failWith503();

    expect(summary.retried).toBe(1);
  });

  it('#97 social_accounts.credential の暗号文が前後で変わらない', async () => {
    const { accountId, before } = await failWith503();

    expect(before).not.toBeNull();
    expect(await storedCredential(accountId)).toBe(before);
  });

  it('#97 R1 の後に何も送らない（R3 / R4 / R6 が無い）', async () => {
    const { calls } = await failWith503();

    expect(calls.map((call) => call.kind)).toEqual(['R1']);
  });
});

describe('#97 R1 が 400 code 190 なら failed になり、理由に案内はあっても資格情報の値は無い', () => {
  async function failWith190(): Promise<string> {
    // Graph API の自由文が要求の値を混ぜ返す場合（設計 §6.11）。message に accessToken、error_user_msg に要求の URL。
    useFakeThreadsApi({
      R1: () =>
        leakyError(
          `${THREADS_API_ORIGIN}/v1.0/${THREADS_USER_ID}/threads?access_token=${encodeURIComponent(ACCESS_TOKEN)}`,
        ),
    });
    await activate();
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    await run();
    return postId;
  }

  it('#97 投稿が failed になる', async () => {
    const postId = await failWith190();

    expect((await postRow(postId)).status).toBe('failed');
  });

  it('#97 failure_reason に「発行し直し」がある', async () => {
    const postId = await failWith190();

    expect((await postRow(postId)).failure_reason).toContain('発行し直し');
  });

  it('#97 failure_reason に accessToken の値（とその符号化した値）が含まれない', async () => {
    const postId = await failWith190();

    const reason = (await postRow(postId)).failure_reason ?? '';
    expect(reason).not.toContain(ACCESS_TOKEN);
    expect(reason).not.toContain(encodeURIComponent(ACCESS_TOKEN));
  });

  it('#97 failure_reason に Core の伏せ字（***）も無い（Plugin が最初から値を載せていない）', async () => {
    // 値を載せて Core が伏せたのなら `***` が残る。Plugin の段で載せていないことを見る。
    const postId = await failWith190();

    expect((await postRow(postId)).failure_reason ?? '').not.toContain('***');
  });
});

describe('#97 公開（R4）が 500 なら failed（再試行しない）', () => {
  it('#97 投稿が failed になり、再試行の予定が入らず、延長もしない', async () => {
    const calls = useFakeThreadsApi({ R4: () => htmlPage(500) });
    await activate();
    const accountId = await accountFor(credentialsExpiringIn(10));
    const postId = await makePost(accountId);

    const summary = await run();

    const row = await postRow(postId);
    expect(row.status).toBe('failed');
    expect(summary.failed).toBe(1);
    expect(summary.retried).toBe(0);
    // 公開に失敗したら延長しない。
    expect(calls.map((call) => call.kind)).toEqual(['R1', 'R3', 'R4']);
  });
});

/* -------------------------------------------------------------------------- */
/* #98〜#99 登録時の検査（API）と権限                                             */
/* -------------------------------------------------------------------------- */

describe('#98 sns-threads が有効な状態で、validate() と Core の検査が登録時に効く', () => {
  async function prepared(): Promise<string> {
    useFakeThreadsApi();
    await activate();
    return accountFor();
  }

  it('#98 本文 501（§9.4 の数え。String.length では 499）は 422（details.body に「500」）', async () => {
    const accountId = await prepared();

    const result = await createViaApi(accountId, { body: BODY_501_BY_THREADS_COUNT });

    expect(result.status).toBe(422);
    expect(result.details['body']?.some((message) => message.includes('500'))).toBe(true);
    expect(await postCount()).toBe(0);
  });

  it('#98 異なる URL 6 本は 422（details.body に「5本」）', async () => {
    const accountId = await prepared();
    const body = Array.from({ length: 6 }, (_, index) => `https://a.example/${index}`).join(' ');

    const result = await createViaApi(accountId, { body });

    expect(result.status).toBe(422);
    expect(result.details['body']?.some((message) => message.includes('5本'))).toBe(true);
    expect(await postCount()).toBe(0);
  });

  it('#98 providerOptions: { replyTo: "1" } は 422（details["providerOptions.replyTo"]）', async () => {
    const accountId = await prepared();

    const result = await createViaApi(accountId, { providerOptions: { replyTo: '1' } });

    expect(result.status).toBe(422);
    expect(result.details['providerOptions.replyTo']?.length ?? 0).toBeGreaterThan(0);
    expect(await postCount()).toBe(0);
  });

  it('#98 media 11 件は 422（Core のスキーマ）', async () => {
    const accountId = await prepared();
    const media = Array.from({ length: 11 }, (_, index) => ({ url: mediaUrlOf(index), alt: null }));

    const result = await createViaApi(accountId, { media });

    expect(result.status).toBe(422);
    expect(await postCount()).toBe(0);
  });

  it('#98 media なしの auto は 201（mediaRequired を宣言しない）', async () => {
    const accountId = await prepared();

    const result = await createViaApi(accountId, {});

    expect(result.status).toBe(201);
    expect(result.postId).not.toBeNull();
  });

  it('#98 本文 500（§9.4 の数え）ちょうどは 201（対の条件）', async () => {
    const accountId = await prepared();

    const result = await createViaApi(accountId, { body: 'a'.repeat(496) + '👍' });

    expect(result.status).toBe(201);
  });

  it('#98 deliveryMode: manual ＋ media 1 件は 422（details.media。Core の f）', async () => {
    const accountId = await prepared();

    const result = await createViaApi(accountId, {
      deliveryMode: 'manual',
      media: [{ url: mediaUrlOf(0), alt: null }],
    });

    expect(result.status).toBe(422);
    // **文言は比べない**（Core の文言。実装プラン T26 の注意）。
    expect(result.details['media']?.length ?? 0).toBeGreaterThan(0);
    expect(await postCount()).toBe(0);
  });

  it('#98 登録の 422 では Threads API へ 1 本も要求が出ない', async () => {
    const calls = useFakeThreadsApi();
    await activate();
    const accountId = await accountFor();

    await createViaApi(accountId, { body: BODY_501_BY_THREADS_COUNT });

    expect(calls).toHaveLength(0);
  });
});

describe('#99 Threads のアカウントについても Core の認可がそのまま効く', () => {
  async function prepared(): Promise<string> {
    useFakeThreadsApi();
    await activate();
    return accountFor();
  }

  it('#99 social.write を持つ Token なら 201（対の条件）', async () => {
    const accountId = await prepared();

    const result = await createViaApi(accountId, {});

    expect(result.status).toBe(201);
  });

  it('#99 social.write の無い Token（social.read だけ）は 403', async () => {
    const accountId = await prepared();
    const readOnly = await issueToken(['social.read']);

    const result = await createViaApi(accountId, {}, { token: readOnly });

    expect(result.status).toBe(403);
    expect(await postCount()).toBe(0);
  });

  it('#99 認証なし（Authorization もセッションも無い）は 401', async () => {
    const accountId = await prepared();

    const result = await createViaApi(accountId, {}, { token: null });

    expect(result.status).toBe(401);
    expect(await postCount()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* #100 手動投稿の受け渡し                                                       */
/* -------------------------------------------------------------------------- */

describe('#100 手動投稿の受け渡し（resolveManualHandoff）', () => {
  const BODY = '予約した Threads の投稿 #テスト & 100%';
  const LINK = 'https://example.test/lp?a=1&b=2';

  async function handoff(link: string | null = null) {
    const calls = useFakeThreadsApi();
    await activate();
    // **資格情報を持つアカウント**でも、手動投稿は資格情報を復号させない。
    const accountId = await accountFor(credentialsExpiringIn(10));
    const postId = await makePost(accountId, {
      deliveryMode: 'manual',
      body: BODY,
      link,
      media: [],
      scheduledAt: new Date(Date.now() + 600_000),
    });
    const outcome = await resolveManualHandoff(admin, { id: postId });
    return { outcome, calls };
  }

  it('#100 resolveManualHandoff が ok: true を返す', async () => {
    const { outcome } = await handoff();

    expect(outcome).toMatchObject({ ok: true });
  });

  it('#100 url が https://www.threads.com/intent/post?text=<本文を encodeURIComponent したもの>', async () => {
    const { outcome } = await handoff();

    expect(outcome.ok ? outcome.url : '').toBe(
      `https://www.threads.com/intent/post?text=${encodeURIComponent(BODY)}`,
    );
  });

  it('#100 link があれば、改行して本文の末尾に足したものが text に入る', async () => {
    const { outcome } = await handoff(LINK);

    expect(outcome.ok ? outcome.url : '').toBe(
      `https://www.threads.com/intent/post?text=${encodeURIComponent(`${BODY}\n${LINK}`)}`,
    );
  });

  it('#100 note が THREADS_MANUAL_NOTE', async () => {
    const { outcome } = await handoff();

    expect(outcome.ok ? outcome.note : null).toBe(THREADS_MANUAL_NOTE);
  });

  it('#100 資格情報を持つアカウントでも credential_read が出ない', async () => {
    await handoff();

    expect(await auditRows('credential_read')).toHaveLength(0);
  });

  it('#100 Threads API へ 1 本も要求が出ない', async () => {
    const { calls } = await handoff();

    expect(calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* #101 無効化中に登録した予約                                                    */
/* -------------------------------------------------------------------------- */

describe('#101 無効化中に登録した本文 501 の auto は、有効化した後の配信直前の再検査で failed になる', () => {
  async function registerWhileDisabled(): Promise<{
    readonly registered: ApiOutcome;
    readonly calls: readonly ThreadsCall[];
  }> {
    const calls = useFakeThreadsApi();
    await activate();
    const accountId = await accountFor();
    await deactivate();

    const registered = await createViaApi(accountId, { body: BODY_501_BY_THREADS_COUNT });
    return { registered, calls };
  }

  it('#101 publisher が無い間は validate() が掛からず 201 で受け付けられる', async () => {
    const { registered } = await registerWhileDisabled();

    expect(registered.status).toBe(201);
    expect(registered.postId).not.toBeNull();
  });

  it('#101 有効化した後の配信で failed になり、Threads API への要求は 0 本', async () => {
    const { registered, calls } = await registerWhileDisabled();
    const postId = registered.postId ?? '';
    await makeDue(postId);

    await activate();
    const summary = await run();

    expect((await postRow(postId)).status).toBe('failed');
    expect(summary.published).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('#101 配信直前の再検査で落ちたので、資格情報を読んでいない（publish() を呼んでいない）', async () => {
    const { registered } = await registerWhileDisabled();
    const postId = registered.postId ?? '';
    await makeDue(postId);

    await activate();
    await run();

    expect(await auditRows('credential_read')).toHaveLength(0);
  });
});
