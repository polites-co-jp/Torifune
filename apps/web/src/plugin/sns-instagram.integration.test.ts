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
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { providerLabel } from '@/domain/social/social';
import { decryptSecret } from '@/infrastructure/crypto/cipher';
import { resetLogger } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import {
  ACCESS_TOKEN,
  CONTAINER_ID,
  IG_USER_ID,
  MEDIA_ID,
  PERMALINK,
  REFRESHED_ACCESS_TOKEN,
  containerCreated,
  containerStatus,
  graphError,
  htmlPage,
  mediaPublished,
  permalinkOf,
  toResponse,
  tokenRefreshed,
  type GraphResponseExample,
} from '@/test-support/instagram-graph';
import type { DependencyCandidate } from './dependencies';
import { disablePlugin, enablePlugin, findPluginRecord, installPlugin } from './lifecycle';
import { discoverPlugins } from './loader';
import { resetPluginRuntime } from './runtime';

/**
 * Instagram 配信 Plugin を **Core のジョブを通して**動かす（038-sns-instagram 設計 §10「B」）。
 *
 * 受け入れ条件 #16〜#18（導入・有効化・登録簿）、#81〜#86（ジョブを通した配信と延長の書き戻し）、
 * #87〜#90（登録時の検査：Core の g・l と `validate()`）、#91（provider の衝突）。
 *
 * **実装は増えない。** G1〜G3 で作ったものが、Core の `publishDuePosts` から実際に呼ばれて動くことを見る。
 * **延長の書き戻し（`rotatedCredential`）はこの Plugin が 035 の口で初めて使う経路**なので、
 * Core が資格情報を実際に書き戻し、次の配信で新しいトークンが使われるところまで見る（#82 / #83）。
 *
 * **偽の Graph API を挿す口は `globalThis.fetch` だけ**である（実装プラン §2「B 群の偽 Graph API」）。
 * `plugins/sns-instagram/index.ts` は `fetch` を注入せず既定を使うので、ここを差し替えないと
 * 本物の Instagram を叩くことになる。`afterEach` で必ず戻す。
 *
 * 既定の `wait`（実時間）を使うので、偽の R3 は最初から `FINISHED` を返す（実装プラン §7 の 10）。
 */

const PLUGIN_ID = 'sns-instagram';
const PROVIDER = 'instagram';

const DAY_MS = 24 * 60 * 60 * 1000;

const IMAGE_URL = 'https://cdn.example.test/images/integration-0.jpg';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let realFetch: typeof globalThis.fetch;

/* -------------------------------------------------------------------------- */
/* 偽の Graph API                                                               */
/* -------------------------------------------------------------------------- */

type RequestKind = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';

interface GraphCall {
  readonly kind: RequestKind;
  readonly url: string;
  readonly authorization: string | null;
}

type Route = () => GraphResponseExample;

/**
 * 偽の Graph API を用意していないテストが、**素の `globalThis.fetch` のまま走らない**ようにする（#97）。
 *
 * `useFakeGraph()` を呼んだテストだけが偽物を持つ形だと、**呼び忘れたテストは本物で走る。**
 * `beforeEach` で一律にこれを置き、`useFakeGraph()` がそのうえから上書きする。
 */
function throwingFetch(): typeof globalThis.fetch {
  return ((): never => {
    throw new Error('偽の Graph API を用意していない fetch が呼ばれた');
  }) as typeof globalThis.fetch;
}

function kindOf(url: URL, method: string, body: URLSearchParams): RequestKind {
  if (url.pathname === '/refresh_access_token') {
    return 'R6';
  }
  const parts = url.pathname.split('/').filter((part) => part !== '');
  if (method === 'POST' && parts[2] === 'media') {
    return body.get('media_type') === 'CAROUSEL' ? 'R2' : 'R1';
  }
  if (method === 'POST' && parts[2] === 'media_publish') {
    return 'R4';
  }
  if (method === 'GET' && url.searchParams.get('fields') === 'status_code') {
    return 'R3';
  }
  if (method === 'GET' && url.searchParams.get('fields') === 'permalink') {
    return 'R5';
  }
  throw new Error(`偽の Graph API が知らない要求: ${method} ${url.pathname}`);
}

const DEFAULT_ROUTES: Readonly<Record<RequestKind, Route>> = {
  R1: () => containerCreated(CONTAINER_ID),
  R2: () => containerCreated(CONTAINER_ID),
  // **最初から FINISHED。** IN_PROGRESS を返すと既定の wait が実時間で 1 秒待つ。
  R3: () => containerStatus('FINISHED'),
  R4: () => mediaPublished(),
  R5: () => permalinkOf(),
  R6: () => tokenRefreshed(),
};

/** `globalThis.fetch` を偽の Graph API に差し替える。要求の列を返す。 */
function useFakeGraph(routes: Partial<Record<RequestKind, Route>> = {}): GraphCall[] {
  const calls: GraphCall[] = [];

  globalThis.fetch = (async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin !== 'https://graph.instagram.com') {
      throw new Error(`偽の Graph API が知らない宛先: ${url.origin}`);
    }
    const method = init.method ?? 'GET';
    const body = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    const kind = kindOf(url, method, body);
    calls.push({
      kind,
      url: url.href,
      authorization: new Headers(init.headers).get('authorization'),
    });
    return toResponse((routes[kind] ?? DEFAULT_ROUTES[kind])(), init.signal);
  }) as typeof globalThis.fetch;

  return calls;
}

/* -------------------------------------------------------------------------- */
/* Plugin の導入と有効化（`sns-bluesky.integration.test.ts` の流儀）              */
/* -------------------------------------------------------------------------- */

function entry(): { readonly manifest: PluginManifest; readonly plugin: Plugin } {
  const found = discoverPlugins().plugins.find((p) => p.manifest.id === PLUGIN_ID);
  if (found === undefined) throw new Error('Instagram 配信 Plugin が読み込めていない');
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
        login_id: `i${suffix}`,
        email: `i${suffix}@example.com`,
        display_name: 'sns instagram test',
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
    loginId: `i${suffix}`,
    displayName: 'sns instagram test',
    email: `i${suffix}@example.com`,
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
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    accessTokenExpiresAt: new Date(Date.now() + days * DAY_MS).toISOString(),
  };
}

async function accountFor(credentials = credentialsExpiringIn(40)): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider: PROVIDER,
    displayName: 'とりふね公式',
    handle: 'torifune.example',
    credential: null,
    credentials,
    status: 'connected',
  });
  return account.id;
}

/** 画像 1 枚・期限の来た `auto` の投稿。 */
async function makePost(accountId: string): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: 'Instagram へ届く本文 #とりふね',
    scheduledAt: new Date(Date.now() - 60_000),
    status: 'scheduled',
    deliveryMode: 'auto',
    media: [{ url: IMAGE_URL, alt: null }],
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

async function auditRows(action: string): Promise<
  {
    readonly resource_type: string;
    readonly resource_id: string | null;
    readonly detail: Record<string, unknown>;
  }[]
> {
  return withConnection(async (connection) => {
    const rows = await connection.db
      .selectFrom('audit_logs')
      .select(['resource_type', 'resource_id', 'detail'])
      .where('action', '=', action)
      .execute();
    return rows as {
      readonly resource_type: string;
      readonly resource_id: string | null;
      readonly detail: Record<string, unknown>;
    }[];
  });
}

async function run() {
  return withConnection((connection) => publishDuePosts(connection));
}

beforeAll(async () => {
  scratch = await useScratchDatabase('snsinstagram');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  realFetch = globalThis.fetch;
  // **偽の Graph API を置く前に、まず投げる `fetch` を置く**（#97）。`useFakeGraph()` がこれを上書きする。
  globalThis.fetch = throwingFetch();
  admin = await contextFor(['administrator']);
});

afterEach(async () => {
  // **戻し忘れると後続のテストが道連れになる**（実装プラン §7 の 11）。
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
/* #16〜#18 導入・有効化・登録簿                                                */
/* -------------------------------------------------------------------------- */

describe('#16 導入・有効化で publisher が引ける', () => {
  it('#16 有効化すると findPublisher("instagram") が引ける', async () => {
    await activate();

    expect(findPublisher(PROVIDER)).not.toBeNull();
  });

  it('#16 その pluginId が sns-instagram', async () => {
    await activate();

    expect(findPublisher(PROVIDER)?.pluginId).toBe(PLUGIN_ID);
  });

  it('#16 無効化すると null に戻る', async () => {
    await activate();

    await deactivate();

    expect(findPublisher(PROVIDER)).toBeNull();
  });
});

describe('#17 social を宣言していない Manifest では有効化できない', () => {
  /**
   * **`plugin.json` を書き換えない**（実装プラン §2 の #17）。
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

  it('#17 registerPublisher が PluginExtensionNotDeclaredError（kind: social）を投げる', async () => {
    const { captured } = await enableWithoutSocial();

    expect(captured).toBeInstanceOf(PluginExtensionNotDeclaredError);
    expect((captured as PluginExtensionNotDeclaredError).kind).toBe('social');
  });

  it('#17 有効化に失敗し、Plugin が disabled に落ちる', async () => {
    const { outcome } = await enableWithoutSocial();

    expect(outcome.ok).toBe(false);
    const record = await withConnection((c) => findPluginRecord(c, PLUGIN_ID));
    expect(record?.status).toBe('disabled');
  });

  it('#17 publisher は登録されない', async () => {
    await enableWithoutSocial();

    expect(findPublisher(PROVIDER)).toBeNull();
  });
});

describe('#18 provider の表示名', () => {
  it('#18 providerLabel("instagram", publisherLabels()) が Instagram', async () => {
    await activate();

    expect(providerLabel(PROVIDER, publisherLabels())).toBe('Instagram');
  });
});

/* -------------------------------------------------------------------------- */
/* #81〜#86 Core のジョブを通した配信                                           */
/* -------------------------------------------------------------------------- */

describe('#81 ジョブを通して配信できる', () => {
  async function publishOnce(): Promise<{
    readonly postId: string;
    readonly summary: Awaited<ReturnType<typeof run>>;
    readonly calls: readonly GraphCall[];
  }> {
    const calls = useFakeGraph();
    await activate();
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    const summary = await run();
    return { postId, summary, calls };
  }

  it('#81 summary.published が 1', async () => {
    const { summary } = await publishOnce();

    expect(summary.published).toBe(1);
  });

  it('#81 投稿が published になり、external_id に media ID、external_url に permalink が入る', async () => {
    const { postId } = await publishOnce();

    const row = await postRow(postId);
    expect(row.status).toBe('published');
    expect(row.external_id).toBe(MEDIA_ID);
    expect(row.external_url).toBe(PERMALINK);
  });

  it('#81 Graph API へ出た要求は R1 → R3 → R4 → R5（期限が 40 日後なので R6 は無い）', async () => {
    const { calls } = await publishOnce();

    expect(calls.map((call) => call.kind)).toEqual(['R1', 'R3', 'R4', 'R5']);
  });

  it('#81 audit_logs に credential_read が 1 行入る', async () => {
    await publishOnce();

    expect(await auditRows('credential_read')).toHaveLength(1);
  });

  it('#81 延長しないときは資格情報の書き戻し（updated / rotated）が起きない', async () => {
    await publishOnce();

    const rotated = (await auditRows('updated')).filter(
      (row) => row.resource_type === 'social_account',
    );
    expect(rotated).toHaveLength(0);
  });
});

describe('#82 トークンの延長が Core によって書き戻される', () => {
  async function publishWithRefresh(): Promise<{
    readonly accountId: string;
    readonly postId: string;
    readonly before: Record<string, string>;
    readonly calls: readonly GraphCall[];
  }> {
    const calls = useFakeGraph();
    await activate();
    const before = credentialsExpiringIn(10);
    const accountId = await accountFor(before);
    const postId = await makePost(accountId);

    await run();
    return { accountId, postId, before, calls };
  }

  it('#82 期限 10 日後なら R5 の後に R6 を送り、投稿は published', async () => {
    const { postId, calls } = await publishWithRefresh();

    expect(calls.map((call) => call.kind)).toEqual(['R1', 'R3', 'R4', 'R5', 'R6']);
    expect((await postRow(postId)).status).toBe('published');
  });

  it('#82 social_accounts.credential を復号した accessToken が R6 の新しいトークンになる', async () => {
    const { accountId } = await publishWithRefresh();

    expect((await decryptedCredential(accountId))['accessToken']).toBe(REFRESHED_ACCESS_TOKEN);
  });

  it('#82 accessTokenExpiresAt が約 60 日後（now + expires_in）に更新される', async () => {
    const { accountId, before } = await publishWithRefresh();

    const after = (await decryptedCredential(accountId))['accessTokenExpiresAt'] ?? '';
    expect(after).not.toBe(before['accessTokenExpiresAt']);
    const remaining = Date.parse(after) - Date.now();
    expect(remaining).toBeGreaterThan(59 * DAY_MS);
    expect(remaining).toBeLessThan(61 * DAY_MS);
  });

  it('#82 igUserId は元のまま、キーは 3 項目ちょうど', async () => {
    const { accountId } = await publishWithRefresh();

    const after = await decryptedCredential(accountId);
    expect(after['igUserId']).toBe(IG_USER_ID);
    expect(Object.keys(after).sort()).toEqual(['accessToken', 'accessTokenExpiresAt', 'igUserId']);
  });

  it('#82 audit_logs に updated / rotated: true / pluginId: sns-instagram が 1 行', async () => {
    const { accountId } = await publishWithRefresh();

    const rows = (await auditRows('updated')).filter(
      (row) => row.resource_type === 'social_account',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe(accountId);
    expect(rows[0]?.detail).toEqual({
      changed: ['credential'],
      rotated: true,
      pluginId: PLUGIN_ID,
    });
  });

  it('#82 監査の detail に新旧どちらのトークンも出ない', async () => {
    await publishWithRefresh();

    const text = JSON.stringify(await auditRows('updated'));
    expect(text).not.toContain(REFRESHED_ACCESS_TOKEN);
    expect(text).not.toContain(ACCESS_TOKEN);
  });
});

describe('#83 延長された後の配信は新しいトークンを使う', () => {
  it('#83 2 件目の配信の R1 の Authorization が、Core が書き戻した新しいトークンになる', async () => {
    const calls = useFakeGraph();
    await activate();
    const accountId = await accountFor(credentialsExpiringIn(10));

    await makePost(accountId);
    await run();
    const firstRun = calls.length;
    await makePost(accountId);
    await run();

    const firstR1 = calls.slice(0, firstRun).find((call) => call.kind === 'R1');
    const secondR1 = calls.slice(firstRun).find((call) => call.kind === 'R1');
    expect(firstR1?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(secondR1?.authorization).toBe(`Bearer ${REFRESHED_ACCESS_TOKEN}`);
  });

  it('#83 2 件目は期限が約 60 日後になっているので、もう延長しない（R6 は 1 本だけ）', async () => {
    const calls = useFakeGraph();
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

describe('#84 retryable: true のときは再試行へ回り、資格情報は書き換わらない', () => {
  async function failWith503(): Promise<{
    readonly accountId: string;
    readonly postId: string;
    readonly summary: Awaited<ReturnType<typeof run>>;
    readonly before: string | null;
  }> {
    useFakeGraph({ R1: () => htmlPage(503) });
    await activate();
    // 期限が近くても、公開に失敗したら延長しない（R6 は公開の後だけ）。
    const accountId = await accountFor(credentialsExpiringIn(10));
    const before = await storedCredential(accountId);
    const postId = await makePost(accountId);

    const summary = await run();
    return { accountId, postId, summary, before };
  }

  it('#84 投稿は scheduled のまま、next_attempt_at が入る', async () => {
    const { postId } = await failWith503();

    const row = await postRow(postId);
    expect(row.status).toBe('scheduled');
    expect(row.next_attempt_at).toBeInstanceOf(Date);
  });

  it('#84 summary.retried が 1', async () => {
    const { summary } = await failWith503();

    expect(summary.retried).toBe(1);
  });

  it('#84 social_accounts.credential の暗号文が前後で変わらない', async () => {
    const { accountId, before } = await failWith503();

    expect(before).not.toBeNull();
    expect(await storedCredential(accountId)).toBe(before);
  });
});

describe('#85 トークンが無効（code 190）なら failed になり、理由に値を出さない', () => {
  async function failWith190(): Promise<string> {
    useFakeGraph({
      R1: () =>
        graphError({
          code: 190,
          subcode: 463,
          // Graph API の自由文が要求の値を混ぜ返す場合（設計 §6.11）。
          message: `Error validating access token: ${ACCESS_TOKEN}`,
          errorUserMsg: `token ${ACCESS_TOKEN} has expired`,
        }),
    });
    await activate();
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    await run();
    return postId;
  }

  it('#85 投稿が failed になる', async () => {
    const postId = await failWith190();

    expect((await postRow(postId)).status).toBe('failed');
  });

  it('#85 failure_reason に「発行し直し」がある', async () => {
    const postId = await failWith190();

    expect((await postRow(postId)).failure_reason).toContain('発行し直し');
  });

  it('#85 failure_reason に accessToken の値が含まれない', async () => {
    const postId = await failWith190();

    expect((await postRow(postId)).failure_reason ?? '').not.toContain(ACCESS_TOKEN);
  });
});

describe('#86 公開（R4）が 500 なら failed（再試行しない）', () => {
  it('#86 投稿が failed になり、再試行の予定が入らない', async () => {
    const calls = useFakeGraph({ R4: () => htmlPage(500) });
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
/* #87〜#90 登録時の検査                                                        */
/* -------------------------------------------------------------------------- */

const ENDPOINT = 'http://127.0.0.1:3000/api/v1/social/posts';

interface ApiOutcome {
  readonly status: number;
  readonly details: Record<string, readonly string[]>;
  readonly postId: string | null;
}

/** `POST /api/v1/social/posts` をルートから直接叩く（036 #67 と同じ）。 */
async function createViaApi(
  accountId: string,
  fields: Record<string, unknown>,
): Promise<ApiOutcome> {
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
        body: 'Instagram へ届く本文',
        scheduledAt: new Date(Date.now() + 600_000).toISOString(),
        status: 'scheduled',
        deliveryMode: 'auto',
        media: [{ url: IMAGE_URL, alt: null }],
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

async function postCount(): Promise<number> {
  const rows = await withConnection((connection) =>
    connection.db.selectFrom('social_posts').select(['id']).execute(),
  );
  return rows.length;
}

describe('#87 媒体なしの自動配信は登録できない（Core の l）', () => {
  it('#87 auto・media なしは 422 で、details に media がある', async () => {
    useFakeGraph();
    await activate();
    const accountId = await accountFor();

    const result = await createViaApi(accountId, { media: [] });

    expect(result.status).toBe(422);
    // **文言は比べない**（Core の文言。実装プラン §8 の 6 / 設計 §11 #13）。
    expect(result.details['media']?.length ?? 0).toBeGreaterThan(0);
    expect(await postCount()).toBe(0);
  });

  it('#87 画像 1 枚なら登録できる（対の条件）', async () => {
    useFakeGraph();
    await activate();
    const accountId = await accountFor();

    const result = await createViaApi(accountId, {});

    expect(result.status).toBe(201);
  });
});

describe('#88 手動投稿は登録できない（Core の g）', () => {
  it('#88 manual・media なしは 422 で、details.deliveryMode が「このSNSは手動投稿に対応していません。」', async () => {
    useFakeGraph();
    await activate();
    const accountId = await accountFor();

    const result = await createViaApi(accountId, { deliveryMode: 'manual', media: [] });

    expect(result.status).toBe(422);
    expect(result.details['deliveryMode']).toContain('このSNSは手動投稿に対応していません。');
    expect(await postCount()).toBe(0);
  });

  it('#88 manual・media あり・status: scheduled も 422 で登録されず、details.media（Core の f が g より先）', async () => {
    // **media があるときの 422 は Core の f（手動投稿は媒体を持てない）が g より先に返す**ので、
    // details のキーは media になる（設計 #88。f は予約の検査（checkSchedulable）を掛けるときだけ効く）。
    useFakeGraph();
    await activate();
    const accountId = await accountFor();

    const result = await createViaApi(accountId, {
      deliveryMode: 'manual',
      status: 'scheduled',
      media: [{ url: IMAGE_URL, alt: null }],
    });

    expect(result.status).toBe(422);
    expect(result.details['media']).toContain(
      '手動投稿には媒体を添付できません（投稿画面で添付してください）。',
    );
    expect(result.details['deliveryMode']).toBeUndefined();
    expect(await postCount()).toBe(0);
  });
});

describe('#89 validate() が登録時に効く', () => {
  it('#89 link 付きは 422（details.link）', async () => {
    useFakeGraph();
    await activate();
    const accountId = await accountFor();

    const result = await createViaApi(accountId, { link: 'https://example.com/campaign' });

    expect(result.status).toBe(422);
    expect(result.details['link']?.length ?? 0).toBeGreaterThan(0);
  });

  it('#89 ハッシュタグ 31 個は 422（details.body）', async () => {
    useFakeGraph();
    await activate();
    const accountId = await accountFor();
    const body = Array.from({ length: 31 }, (_, index) => `#tag${index}`).join(' ');

    const result = await createViaApi(accountId, { body });

    expect(result.status).toBe(422);
    expect(result.details['body']?.length ?? 0).toBeGreaterThan(0);
  });

  it('#89 ハッシュタグ 30 個なら登録できる（対の条件）', async () => {
    useFakeGraph();
    await activate();
    const accountId = await accountFor();
    const body = Array.from({ length: 30 }, (_, index) => `#tag${index}`).join(' ');

    const result = await createViaApi(accountId, { body });

    expect(result.status).toBe(201);
  });
});

describe('#90 無効化中に登録した媒体なしの投稿は、配信直前の再検査で failed になる', () => {
  async function registerWhileDisabled(): Promise<{
    readonly registered: ApiOutcome;
    readonly calls: readonly GraphCall[];
  }> {
    const calls = useFakeGraph();
    await activate();
    const accountId = await accountFor();
    await deactivate();

    const registered = await createViaApi(accountId, { media: [] });
    return { registered, calls };
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

  it('#90 publisher が無い間は 422 にならない（201）', async () => {
    const { registered } = await registerWhileDisabled();

    expect(registered.status).toBe(201);
    expect(registered.postId).not.toBeNull();
  });

  it('#90 有効化した後の配信で failed になり、Graph API への要求は 0 本', async () => {
    const { registered, calls } = await registerWhileDisabled();
    const postId = registered.postId ?? '';
    await makeDue(postId);

    await activate();
    const summary = await run();

    expect((await postRow(postId)).status).toBe('failed');
    expect(summary.published).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('#90 配信直前の再検査で落ちたので、資格情報を読んでいない（publish() を呼んでいない）', async () => {
    const { registered } = await registerWhileDisabled();
    const postId = registered.postId ?? '';
    await makeDue(postId);

    await activate();
    await run();

    expect(await auditRows('credential_read')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* #91 provider の衝突                                                          */
/* -------------------------------------------------------------------------- */

describe('#91 同じ provider を別の Plugin が登録できない', () => {
  const RIVAL_ID = 'rival-instagram-plugin';

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

  it('#91 PluginPublisherConflictError が投げられ、その registeredBy が sns-instagram', async () => {
    const { captured } = await enableRival();

    expect(captured).toBeInstanceOf(PluginPublisherConflictError);
    expect((captured as PluginPublisherConflictError).registeredBy).toBe(PLUGIN_ID);
  });

  it('#91 後から来た Plugin の有効化は失敗し、sns-instagram の登録が残る', async () => {
    const { outcome } = await enableRival();

    expect(outcome.ok).toBe(false);
    expect(findPublisher(PROVIDER)?.pluginId).toBe(PLUGIN_ID);
  });
});
