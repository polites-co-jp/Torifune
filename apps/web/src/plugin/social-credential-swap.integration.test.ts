import type { Plugin, PluginManifest } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PATCH as updateSocialAccountRoute } from '@/app/api/v1/social/accounts/[id]/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { resetEventHandlers } from '@/application/events';
import { publishDuePosts } from '@/application/social/publish';
import { listPublishers, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { resetLogger } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import {
  IMAGE_ORIGIN,
  imageFetched,
  mediaUploaded,
  toResponse,
  tweetCreated,
  type XResponseExample,
} from '@/test-support/x-api';
import {
  clearCredentialBody,
  credentialInputOf,
  setCredentialBody,
} from '@/ui/social/credential-form';
import { buildProviderOptions } from '@/ui/social/provider-options';
import type { ProviderOption } from '@/ui/social/social-accounts';
import type { DependencyCandidate } from './dependencies';
import { disablePlugin, enablePlugin, installPlugin } from './lifecycle';
import { discoverPlugins } from './loader';
import { resetPluginRuntime } from './runtime';

/**
 * X の 2 つの配信 Plugin の入れ替えを、画面の組み立てと画面が送る本文で通す
 * （039-social-credential-fields 設計 §7.6 / §10.6、受け入れ条件 #32〜#34、#53）。
 *
 * * 選択肢は**本物の登録簿**から `buildProviderOptions(listPublishers())` で組む（`page.tsx` と同じ）
 * * `PATCH` の本文は `setCredentialBody` / `clearCredentialBody` で作る（画面が送る本文そのもの）
 * * 配信は Core のジョブ（`publishDuePosts`）を通す。偽の X API は `globalThis.fetch` の差し替えで、
 *   **未知の宛先では投げる**（`037` #91 と同じ）。`beforeEach` で「呼ばれたら投げる」を置き、
 *   `afterEach` で必ず戻す
 *
 * **ファイル名を `sns-x` で始めない。** `037` #89 が `sns-x*.test.ts` を 7 本ちょうどに固定している。
 *
 * 資格情報の値に `torifune` を含めない（`DATABASE_URL` の password と同じ綴りは Core が伏せる）。
 */

const PROVIDER = 'x';
const MANUAL_ID = 'sns-x-manual';
const API_ID = 'sns-x-api';
type XPluginId = typeof MANUAL_ID | typeof API_ID;

const X_API_ORIGIN = 'https://api.x.com';

/** `sns-x-api` の宣言の順（`037` 設計 §5.1）。 */
const API_KEYS = ['apiKey', 'apiKeySecret', 'accessToken', 'accessTokenSecret'] as const;

const SWAP_CREDENTIAL: Readonly<Record<(typeof API_KEYS)[number], string>> = {
  apiKey: 'swapConsumerKey39a1',
  apiKeySecret: 'swapConsumerSecret39b2',
  accessToken: '1790000000000000039-swapAccessToken39c3',
  accessTokenSecret: 'swapAccessTokenSecret39d4',
};

/** 無料版の間に汎用の欄へ入った値（`039` より前にありえた経路）。 */
const STRAY = 'stray';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let realFetch: typeof globalThis.fetch;

/* -------------------------------------------------------------------------- */
/* 偽の X API                                                                   */
/* -------------------------------------------------------------------------- */

type XRequestKind = 'R1' | 'R2' | 'R3';

interface XCall {
  readonly kind: XRequestKind;
  readonly authorization: string | null;
}

/** 偽の X API を用意していないテストが、素の `fetch` のまま外へ出ないようにする。 */
function throwingFetch(): typeof globalThis.fetch {
  return ((): never => {
    throw new Error('偽の X API を用意していない fetch が呼ばれた');
  }) as typeof globalThis.fetch;
}

/** R1（画像の取得）/ R2（媒体のアップロード）/ R3（投稿）。**それ以外の宛先では投げる。** */
function kindOf(url: URL, method: string): XRequestKind {
  if (url.origin === IMAGE_ORIGIN && method === 'GET' && url.pathname.startsWith('/images/')) {
    return 'R1';
  }
  if (url.origin === X_API_ORIGIN && method === 'POST' && url.pathname === '/2/media/upload') {
    return 'R2';
  }
  if (url.origin === X_API_ORIGIN && method === 'POST' && url.pathname === '/2/tweets') {
    return 'R3';
  }
  throw new Error(`偽の X API が知らない宛先: ${method} ${url.origin}${url.pathname}`);
}

const ROUTES: Readonly<Record<XRequestKind, () => XResponseExample>> = {
  R1: () => imageFetched(),
  R2: () => mediaUploaded(),
  R3: () => tweetCreated(),
};

function useFakeXApi(): XCall[] {
  const calls: XCall[] = [];
  globalThis.fetch = ((input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const kind = kindOf(url, method);
    calls.push({ kind, authorization: new Headers(init.headers).get('authorization') });
    return Promise.resolve(toResponse(ROUTES[kind](), init.signal));
  }) as typeof globalThis.fetch;
  return calls;
}

/* -------------------------------------------------------------------------- */
/* Plugin の導入・有効化・無効化（`/plugins` の操作）                                */
/* -------------------------------------------------------------------------- */

function entryOf(id: string): { readonly manifest: PluginManifest; readonly plugin: Plugin } {
  const found = discoverPlugins().plugins.find((p) => p.manifest.id === id);
  if (found === undefined) throw new Error(`Plugin が読み込めていない: ${id}`);
  return found;
}

function candidatesOf(
  manifest: PluginManifest,
  enabled: boolean,
): Map<string, DependencyCandidate> {
  return new Map([[manifest.id, { manifest, enabled }]]);
}

/** 「導入」と「有効化」。失敗したら落とす（入れ替えの順序は `037` #78 が見ている）。 */
async function activate(id: XPluginId): Promise<void> {
  const { manifest, plugin } = entryOf(id);
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
  if (!outcome.ok) throw new Error(`有効化に失敗: ${id}: ${outcome.reason ?? ''}`);
}

/** 「無効化」。 */
async function deactivate(id: XPluginId): Promise<void> {
  const { manifest, plugin } = entryOf(id);
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

/** 無料版 → 有料版（`037` §7.2 の 2〜3）。 */
async function swapManualToApi(): Promise<void> {
  await deactivate(MANUAL_ID);
  await activate(API_ID);
}

/* -------------------------------------------------------------------------- */
/* 画面の組み立て                                                                 */
/* -------------------------------------------------------------------------- */

/** `page.tsx` と同じ組み立ての x の選択肢。 */
function xOption(): ProviderOption {
  const option = buildProviderOptions(listPublishers()).find((o) => o.value === PROVIDER);
  if (option === undefined) throw new Error('x の選択肢が無い');
  return option;
}

/** 入れ直しの「保存」で送る本文（4 値）。 */
function saveBody(): object {
  const option = xOption();
  const result = setCredentialBody(
    credentialInputOf(option),
    option.credentialFields,
    SWAP_CREDENTIAL,
    '',
  );
  if (!result.ok) throw new Error(`本文を作れない: ${result.message}`);
  return result.body;
}

/** 「資格情報を消す」で送る本文。 */
function clearBody(): object {
  return clearCredentialBody(credentialInputOf(xOption()));
}

/* -------------------------------------------------------------------------- */
/* 利用者・アカウント・投稿                                                        */
/* -------------------------------------------------------------------------- */

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `s${suffix}`,
        email: `s${suffix}@example.com`,
        display_name: 'social credential swap test',
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
    loginId: `s${suffix}`,
    displayName: 'social credential swap test',
    email: `s${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

async function accountFor(
  credentials: Readonly<Record<string, string>> | null = null,
): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider: PROVIDER,
    displayName: 'X 公式（入れ替え）',
    handle: '@x_swap_handle',
    credential: null,
    ...(credentials === null ? {} : { credentials }),
    status: 'connected',
  });
  return account.id;
}

/** 期限の来た `auto` の予約（画像なし）。 */
async function makeDuePost(accountId: string): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: '入れ替えの後に届く本文',
    scheduledAt: new Date(Date.now() - 60_000),
    status: 'scheduled',
    deliveryMode: 'auto',
  });
  return post.id;
}

interface PostRow {
  readonly status: string;
  readonly failure_reason: string | null;
  readonly skip_reason: string | null;
}

async function postRow(id: string): Promise<PostRow> {
  const row = await withConnection((connection) =>
    connection.db
      .selectFrom('social_posts')
      .select(['status', 'failure_reason', 'skip_reason'])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`投稿が無い: ${id}`);
  return row as PostRow;
}

async function run() {
  return withConnection((connection) => publishDuePosts(connection));
}

/** `PATCH /api/v1/social/accounts/{id}`（Bearer。`social.write`）。 */
async function patchAccount(id: string, body: unknown): Promise<number> {
  const token = await createApiToken(admin, {
    name: `swap-${uuidv7().slice(-8)}`,
    scopes: ['social.read', 'social.write'],
    expiresAt: null,
  });
  const response = await updateSocialAccountRoute(
    new Request(`http://127.0.0.1:3000/api/v1/social/accounts/${id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token.plaintext}`,
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  await response.text();
  return response.status;
}

/* -------------------------------------------------------------------------- */
/* 準備と後始末                                                                 */
/* -------------------------------------------------------------------------- */

beforeAll(async () => {
  scratch = await useScratchDatabase('socialcredswap');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  realFetch = globalThis.fetch;
  // 偽の X API を置く前に、まず投げる fetch を置く。`useFakeXApi()` がこれを上書きする。
  globalThis.fetch = throwingFetch();
  admin = await contextFor(['administrator']);
});

afterEach(async () => {
  // 戻し忘れると後続のテストが道連れになる。
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
/* #32 入れ替えで入力の形が変わる                                                  */
/* -------------------------------------------------------------------------- */

describe('#32 登録簿から組んだ x の入力の形が、有効な Plugin に従う', () => {
  it("#32 sns-x-manual が有効なら 'none'", async () => {
    await activate(MANUAL_ID);

    expect(credentialInputOf(xOption())).toBe('none');
  });

  it("#32 sns-x-manual を無効化して sns-x-api を有効化すると 'fields'", async () => {
    await activate(MANUAL_ID);
    await swapManualToApi();

    expect(credentialInputOf(xOption())).toBe('fields');
  });

  it('#32 sns-x-api の項目のキーが apiKey / apiKeySecret / accessToken / accessTokenSecret の順', async () => {
    await activate(MANUAL_ID);
    await swapManualToApi();

    expect(xOption().credentialFields.map((field) => field.key)).toEqual([...API_KEYS]);
  });

  it("#32 両方とも無効なら 'free'", async () => {
    await activate(MANUAL_ID);
    await deactivate(MANUAL_ID);

    expect(credentialInputOf(xOption())).toBe('free');
  });

  it("#32 どちらも導入していなければ 'free'", () => {
    expect(credentialInputOf(xOption())).toBe('free');
  });

  it("#32 sns-x-api を無効化した後も 'free'", async () => {
    await activate(API_ID);
    await deactivate(API_ID);

    expect(credentialInputOf(xOption())).toBe('free');
  });
});

/* -------------------------------------------------------------------------- */
/* #33 無料版の間に入った値を、入れ替えの後に画面の本文で入れ直す                         */
/* -------------------------------------------------------------------------- */

describe('#33 無料版の間に stray を保存したアカウントを、入れ替え後に入れ直すと配信される', () => {
  /** 無料版の間に自由文字列を入れ（`039` より前の汎用の欄の経路）、有料版へ入れ替える。 */
  async function strayThenSwap(): Promise<string> {
    await activate(MANUAL_ID);
    const accountId = await accountFor();
    expect(await patchAccount(accountId, { credential: STRAY })).toBe(200);
    await swapManualToApi();
    return accountId;
  }

  it("#33 入れ替えの後の入れ直しの本文は、4 つのキーちょうどの credentials と 'connected'", async () => {
    await strayThenSwap();

    expect(saveBody()).toStrictEqual({ credentials: { ...SWAP_CREDENTIAL }, status: 'connected' });
  });

  it('#33 入れ直しの PATCH は 200', async () => {
    const accountId = await strayThenSwap();

    expect(await patchAccount(accountId, saveBody())).toBe(200);
  });

  it('#33 入れ直した後の期限の来た auto の投稿は published', async () => {
    const accountId = await strayThenSwap();
    expect(await patchAccount(accountId, saveBody())).toBe(200);
    const calls = useFakeXApi();
    const postId = await makeDuePost(accountId);

    const summary = await run();

    expect(summary.published).toBe(1);
    expect((await postRow(postId)).status).toBe('published');
    expect(calls.map((call) => call.kind)).toEqual(['R3']);
  });

  it('#33 入れ直した 4 値で署名される（stray ではない）', async () => {
    const accountId = await strayThenSwap();
    expect(await patchAccount(accountId, saveBody())).toBe(200);
    const calls = useFakeXApi();
    await makeDuePost(accountId);

    await run();

    const r3 = calls.find((call) => call.kind === 'R3');
    expect(r3?.authorization ?? '').toContain(`oauth_consumer_key="${SWAP_CREDENTIAL.apiKey}"`);
  });

  it('#33 入れ直さずに走らせると failed（直す前との対比）', async () => {
    const accountId = await strayThenSwap();
    const calls = useFakeXApi();
    const postId = await makeDuePost(accountId);

    await run();

    expect((await postRow(postId)).status).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('#33 入れ直さずに走らせた failed の理由に 4 つのキー名が出る', async () => {
    const accountId = await strayThenSwap();
    useFakeXApi();
    const postId = await makeDuePost(accountId);

    await run();

    const reason = (await postRow(postId)).failure_reason ?? '';
    for (const key of API_KEYS) {
      expect(reason, key).toContain(key);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #34 消した後は「未設定」で待たされる                                             */
/* -------------------------------------------------------------------------- */

describe('#34 sns-x-api の間に画面の消去の本文で消すと、auto は credential_missing で後ろへ送られる', () => {
  async function clearUnderApi(): Promise<{ accountId: string; status: number }> {
    await activate(API_ID);
    const accountId = await accountFor(SWAP_CREDENTIAL);
    const status = await patchAccount(accountId, clearBody());
    return { accountId, status };
  }

  it("#34 消去の本文は { credentials: {}, status: 'disconnected' }", async () => {
    await activate(API_ID);

    expect(clearBody()).toStrictEqual({ credentials: {}, status: 'disconnected' });
  });

  it('#34 消去の PATCH は 200', async () => {
    const { status } = await clearUnderApi();

    expect(status).toBe(200);
  });

  it("#34 期限の来た auto の投稿の skip_reason が 'credential_missing'", async () => {
    const { accountId } = await clearUnderApi();
    const calls = useFakeXApi();
    const postId = await makeDuePost(accountId);

    const summary = await run();

    expect(summary.skipped).toBe(1);
    expect((await postRow(postId)).skip_reason).toBe('credential_missing');
    expect(calls).toHaveLength(0);
  });

  it('#34 その投稿は failed にならない（scheduled のまま後ろへ送られる）', async () => {
    const { accountId } = await clearUnderApi();
    useFakeXApi();
    const postId = await makeDuePost(accountId);

    await run();

    expect((await postRow(postId)).status).toBe('scheduled');
  });
});

/* -------------------------------------------------------------------------- */
/* #53 Plugin の description が画面の選択肢まで届く                                */
/* -------------------------------------------------------------------------- */

describe('#53 sns-x-api の宣言の description が選択肢に届く', () => {
  it('#53 accessToken の項目の description に「Read and write」が含まれる', async () => {
    await activate(API_ID);

    const accessToken = xOption().credentialFields.find((field) => field.key === 'accessToken');

    expect(accessToken?.description ?? '').toContain('Read and write');
  });
});
