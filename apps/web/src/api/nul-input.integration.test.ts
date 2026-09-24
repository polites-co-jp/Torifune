import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GET as breakdownRoute } from '@/app/api/v1/analytics/breakdown/route';
import { GET as analyticsRoute } from '@/app/api/v1/analytics/route';
import { POST as createApiTokenRoute } from '@/app/api/v1/api-tokens/route';
import { GET as callbackRoute } from '@/app/api/v1/auth/callback/route';
import {
  GET as getCampaignRoute,
  PATCH as updateCampaignRoute,
} from '@/app/api/v1/campaigns/[id]/route';
import {
  GET as listCampaignsRoute,
  POST as createCampaignRoute,
} from '@/app/api/v1/campaigns/route';
import { PUT as savePluginSettingsRoute } from '@/app/api/v1/plugins/[id]/settings/route';
import { GET as getPluginOperationRoute } from '@/app/api/v1/plugins/operations/[id]/route';
import { GET as registryRoute } from '@/app/api/v1/plugins/registry/route';
import { PUT as updateSettingsRoute } from '@/app/api/v1/settings/route';
import { GET as getSiteRoute, PATCH as updateSiteRoute } from '@/app/api/v1/sites/[id]/route';
import { GET as listSitesRoute, POST as createSiteRoute } from '@/app/api/v1/sites/route';
import { PATCH as updateAccountRoute } from '@/app/api/v1/social/accounts/[id]/route';
import {
  GET as listAccountsRoute,
  POST as createAccountRoute,
} from '@/app/api/v1/social/accounts/route';
import { PATCH as updatePostRoute } from '@/app/api/v1/social/posts/[id]/route';
import { POST as createPostRoute } from '@/app/api/v1/social/posts/route';
import { PATCH as updateUserRoute } from '@/app/api/v1/users/[id]/route';
import { GET as listUsersRoute, POST as createUserRoute } from '@/app/api/v1/users/route';
import { DELETE as deleteWebhookRoute } from '@/app/api/v1/webhooks/[id]/route';
import { POST as createWebhookRoute } from '@/app/api/v1/webhooks/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { login } from '@/application/auth/login';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { createCampaign } from '@/application/campaign/campaign-use-cases';
import { resetEventHandlers } from '@/application/events';
import { createSite } from '@/application/site/site-use-cases';
import { resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import { createUser } from '@/application/user/user-use-cases';
import type { UserIdentity } from '@/authentication/identity';
import { hashPassword } from '@/authentication/password';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { enablePlugin, installPlugin } from '@/plugin/lifecycle';
import { discoverPlugins } from '@/plugin/loader';
import { resetPluginRegistry } from '@/plugin/registry';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * HTTP の本文・クエリの使えない文字（L1。046-input-500-nul-and-ranges 設計 §6.2・§8・§10.2、受け入れ条件 #7〜#12）。
 *
 * - #7：設計 §1.2.1 **表 H の 36 件**（いま NUL で 500 になる本文の項目）を、値に NUL（U+0000）を足したものと
 *   対になっていないサロゲート（片割れ）を足したものの 2 通りで送る。どちらも 422 `VALIDATION_ERROR`、`details` が
 *   **ちょうど 1 つのキー**（最上位の項目名。`media[].alt` は `media`、`providerOptions` のキーは `providerOptions`）で、
 *   値がそれぞれ `[NUL の文言]` / `[サロゲートの文言]`。作成は行が増えず、更新は対象が変わらない
 * - #8：クエリ 7 か所の `%00` → 422、`details` が `{ <名前>: [NUL の文言] }` だけ
 * - #9：複数の項目・同じ項目に両方・`siteIds` の要素・本文の最上位のキー・Zod を走らせないこと
 * - #10：認可が先（401・403・`CSRF_FAILED`）
 * - #11：422 の本文に送った値が無い。`unhandled error in route` のログが出ない
 * - #12：変わらないもの（パスの `{id}` の NUL は 404、`/auth/callback` は 302）
 *
 * **ルートを直接叩く**（`non-uuid-id.integration.test.ts` のセッションと CSRF の組み方を写した）。
 * 表 H の本文は「通る本文」を土台に 1 か所だけ値を足す。**土台だけを送ると 2xx になること**を同じ表で確かめる（実装プラン §7 の 6）。
 * `POST /social/posts` の `externalRef` は Bearer の Token で送る（冪等キーは Token のときだけ意味を持つ）。
 * **ソースに壊れた文字を置かない。** NUL と片割れはエスケープで書く。
 */

const ORIGIN = 'http://127.0.0.1:3000';
const BASE = `${ORIGIN}/api/v1`;
const PASSWORD = 'nul input correct horse battery staple';
const CSRF_TOKEN = 'csrf-token-for-nul-input';
const PLUGIN_ID = 'example-plugin';

const NUL_TEXT = '使用できない文字（NUL）が含まれています。';
const SURROGATE_TEXT = '使用できない文字（対になっていないサロゲート）が含まれています。';
/** 送った値が応答に載らないことを確かめる目印。 */
const MARKER = 'marker-046';

type Variant = 'nul' | 'surrogate';

const VARIANTS: readonly { readonly variant: Variant; readonly text: string }[] = [
  { variant: 'nul', text: NUL_TEXT },
  { variant: 'surrogate', text: SURROGATE_TEXT },
];

/** 値の末尾に目印と NUL か片割れを足す（`値marker-046\u0000x` / `値marker-046\ud800x`）。 */
function inject(value: string, variant: Variant): string {
  return variant === 'nul' ? `${value}${MARKER}\u0000x` : `${value}${MARKER}\ud800x`;
}

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let adminLoginId: string;
/** 管理者のセッショントークン。 */
let session: string;
/** `social.read`・`social.write` を持つ Token（`externalRef` を送るため）。 */
let socialToken: string;

let siteId: string;
let campaignId: string;
let accountId: string;
let postId: string;
let targetUserId: string;

interface JsonResult {
  readonly status: number;
  readonly text: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

function errorOf(result: JsonResult): {
  readonly code?: string;
  readonly details?: Record<string, readonly string[]>;
} {
  return (result.body['error'] ?? {}) as {
    readonly code?: string;
    readonly details?: Record<string, readonly string[]>;
  };
}

function detailsOf(result: JsonResult): Record<string, readonly string[]> {
  return errorOf(result).details ?? {};
}

function capture(): { records: LogRecord[] } {
  const records: LogRecord[] = [];
  setLogger({
    log(level, message, fields) {
      records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    },
  });
  return { records };
}

async function insertUser(roleNames: readonly string[]): Promise<UserIdentity> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `n${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'nul input test',
        password_hash: passwordHash,
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

  return {
    userId: id,
    loginId,
    displayName: 'nul input test',
    email: `${loginId}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
}

/** 実際にログインして、有効なセッショントークンを得る。 */
async function issueSessionToken(loginId: string): Promise<string> {
  const outcome = await login({
    loginId,
    password: PASSWORD,
    request: { ipAddress: '203.0.113.46', userAgent: 'vitest' },
  });
  if (!outcome.ok) throw new Error(`ログインに失敗した: ${outcome.reason}`);
  return outcome.sessionToken;
}

async function issueToken(scopes: readonly string[]): Promise<string> {
  const created = await createApiToken(admin, {
    name: `t-${uuidv7().slice(-8)}`,
    scopes,
    expiresAt: null,
  });
  return created.plaintext;
}

/** サンプル Plugin を導入して有効にする（`example-plugin.integration.test.ts` の `activate` を写した）。 */
async function activateExamplePlugin(): Promise<void> {
  const entry = discoverPlugins().plugins.find((p) => p.manifest.id === PLUGIN_ID);
  if (entry === undefined) throw new Error('サンプル Plugin が読み込めていない');
  await withConnection(async (connection) => {
    await installPlugin(connection, entry.manifest);
    const outcome = await enablePlugin({
      connection,
      manifest: entry.manifest,
      plugin: entry.plugin,
      authorization: admin,
      candidates: new Map([[PLUGIN_ID, { manifest: entry.manifest, enabled: false }]]),
    });
    if (!outcome.ok) throw new Error(`有効化に失敗: ${outcome.reason}`);
  });
}

type Route = (
  request: Request,
  args?: { params?: Promise<Record<string, string>> },
) => Promise<Response>;

/** 認証の付け方。 */
type Auth =
  | { readonly kind: 'session'; readonly csrf?: boolean }
  | { readonly kind: 'bearer'; readonly token: string }
  /** Cookie のセッションを付けない（CSRF は通す）。401 を確かめる。 */
  | { readonly kind: 'none' };

const SESSION: Auth = { kind: 'session' };

function headersFor(auth: Auth, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hasBody) {
    headers['content-type'] = 'application/json';
  }
  if (auth.kind === 'bearer') {
    headers['authorization'] = `Bearer ${auth.token}`;
    return headers;
  }
  const cookies = auth.kind === 'session' ? [`torifune_session=${session}`] : [];
  if (auth.kind === 'none' || auth.csrf !== false) {
    // Bearer が無い経路は CSRF を通らないと 403 になる。
    headers['x-forwarded-host'] = '127.0.0.1:3000';
    headers['origin'] = ORIGIN;
    headers['x-csrf-token'] = CSRF_TOKEN;
    cookies.push(`torifune_csrf=${CSRF_TOKEN}`);
  }
  if (cookies.length > 0) {
    headers['cookie'] = cookies.join('; ');
  }
  return headers;
}

async function call(
  route: Route,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options: {
    readonly body?: unknown;
    readonly params?: Record<string, string>;
    readonly auth?: Auth;
  } = {},
): Promise<JsonResult> {
  const auth = options.auth ?? SESSION;
  const response = await route(
    new Request(`${BASE}${path}`, {
      method,
      headers: headersFor(auth, options.body !== undefined),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    options.params === undefined ? undefined : { params: Promise.resolve(options.params) },
  );
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text !== '') {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  return { status: response.status, text, headers: response.headers, body };
}

/** 表の全行（並べ替えた JSON）。「書かれない」「変わらない」を前後で比べる。 */
async function tableRows(table: string): Promise<readonly string[]> {
  return withConnection(async (connection) => {
    const result = await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(table)}`.execute(
      connection.db,
    );
    return result.rows.map((row) => JSON.stringify(row)).sort();
  });
}

function uniqueSuffix(): string {
  return uuidv7().replaceAll('-', '').slice(-12);
}

/* -------------------------------------------------------------------------- */
/* 表 H（設計 §1.2.1）                                                           */
/* -------------------------------------------------------------------------- */

interface BodyCase {
  /** 操作と項目（表示用）。 */
  readonly name: string;
  readonly route: Route;
  readonly method: 'POST' | 'PATCH' | 'PUT';
  readonly path: () => string;
  readonly params?: () => Record<string, string>;
  readonly auth?: () => Auth;
  /** 通る本文。`variant` を渡すと 1 か所だけ値を足す。 */
  readonly body: (variant?: Variant) => Record<string, unknown>;
  /** 期待する `details` のキー（最上位の項目名）。 */
  readonly key: string;
  /** 前後で比べる表。 */
  readonly table: string;
}

/** `variant` があれば値を足し、無ければそのまま。 */
function maybe(value: string, variant: Variant | undefined): string {
  return variant === undefined ? value : inject(value, variant);
}

const TABLE_H: readonly BodyCase[] = [
  // サイト（4）
  ...(['name', 'description'] as const).map((field): BodyCase => ({
    name: `POST /sites の ${field}`,
    route: createSiteRoute,
    method: 'POST',
    path: () => '/sites',
    body: (v) => ({
      name: 'サイト',
      url: `https://s${uniqueSuffix()}.example.com`,
      description: '',
      [field]: maybe(field === 'name' ? 'サイト' : '説明', v),
    }),
    key: field,
    table: 'sites',
  })),
  ...(['name', 'description'] as const).map((field): BodyCase => ({
    name: `PATCH /sites/{id} の ${field}`,
    route: updateSiteRoute,
    method: 'PATCH',
    path: () => `/sites/${siteId}`,
    params: () => ({ id: siteId }),
    body: (v) => ({ [field]: maybe(field === 'name' ? 'サイト改' : '説明改', v) }),
    key: field,
    table: 'sites',
  })),
  // キャンペーン（4）
  ...(['name', 'description'] as const).map((field): BodyCase => ({
    name: `POST /campaigns の ${field}`,
    route: createCampaignRoute,
    method: 'POST',
    path: () => '/campaigns',
    body: (v) => ({
      name: 'キャンペーン',
      startsOn: '2026-01-01',
      [field]: maybe(field === 'name' ? 'キャンペーン' : '説明', v),
    }),
    key: field,
    table: 'campaigns',
  })),
  ...(['name', 'description'] as const).map((field): BodyCase => ({
    name: `PATCH /campaigns/{id} の ${field}`,
    route: updateCampaignRoute,
    method: 'PATCH',
    path: () => `/campaigns/${campaignId}`,
    params: () => ({ id: campaignId }),
    body: (v) => ({ [field]: maybe(field === 'name' ? 'キャンペーン改' : '説明改', v) }),
    key: field,
    table: 'campaigns',
  })),
  // SNS アカウント（4）
  ...(['displayName', 'handle'] as const).map((field): BodyCase => ({
    name: `POST /social/accounts の ${field}`,
    route: createAccountRoute,
    method: 'POST',
    path: () => '/social/accounts',
    body: (v) => ({
      provider: 'x',
      displayName: '表示名',
      handle: '@handle',
      status: 'connected',
      [field]: maybe(field === 'displayName' ? '表示名' : '@handle', v),
    }),
    key: field,
    table: 'social_accounts',
  })),
  ...(['displayName', 'handle'] as const).map((field): BodyCase => ({
    name: `PATCH /social/accounts/{id} の ${field}`,
    route: updateAccountRoute,
    method: 'PATCH',
    path: () => `/social/accounts/${accountId}`,
    params: () => ({ id: accountId }),
    body: (v) => ({ [field]: maybe(field === 'displayName' ? '表示名改' : '@handle2', v) }),
    key: field,
    table: 'social_accounts',
  })),
  // SNS 投稿の作成（7）
  {
    name: 'POST /social/posts の body',
    route: createPostRoute,
    method: 'POST',
    path: () => '/social/posts',
    body: (v) => ({ socialAccountId: accountId, body: maybe('本文', v) }),
    key: 'body',
    table: 'social_posts',
  },
  {
    name: 'POST /social/posts の link',
    route: createPostRoute,
    method: 'POST',
    path: () => '/social/posts',
    body: (v) => ({
      socialAccountId: accountId,
      body: '本文',
      link: maybe('https://x.example.com/l/', v),
    }),
    key: 'link',
    table: 'social_posts',
  },
  {
    name: 'POST /social/posts の externalRef（Token）',
    route: createPostRoute,
    method: 'POST',
    path: () => '/social/posts',
    auth: () => ({ kind: 'bearer', token: socialToken }),
    body: (v) => ({
      socialAccountId: accountId,
      body: '本文',
      externalRef: maybe(`ref-${uniqueSuffix()}`, v),
    }),
    key: 'externalRef',
    table: 'social_posts',
  },
  {
    name: 'POST /social/posts の media[].url',
    route: createPostRoute,
    method: 'POST',
    path: () => '/social/posts',
    body: (v) => ({
      socialAccountId: accountId,
      body: '本文',
      media: [{ url: maybe('https://x.example.com/a.png?', v), alt: null }],
    }),
    key: 'media',
    table: 'social_posts',
  },
  {
    name: 'POST /social/posts の media[].alt',
    route: createPostRoute,
    method: 'POST',
    path: () => '/social/posts',
    body: (v) => ({
      socialAccountId: accountId,
      body: '本文',
      media: [{ url: 'https://x.example.com/a.png', alt: maybe('代替', v) }],
    }),
    key: 'media',
    table: 'social_posts',
  },
  {
    name: 'POST /social/posts の providerOptions の値',
    route: createPostRoute,
    method: 'POST',
    path: () => '/social/posts',
    body: (v) => ({
      socialAccountId: accountId,
      body: '本文',
      providerOptions: { opt: maybe('v', v) },
    }),
    key: 'providerOptions',
    table: 'social_posts',
  },
  {
    name: 'POST /social/posts の providerOptions のキー',
    route: createPostRoute,
    method: 'POST',
    path: () => '/social/posts',
    body: (v) => ({
      socialAccountId: accountId,
      body: '本文',
      providerOptions: { [maybe('k', v)]: 'v' },
    }),
    key: 'providerOptions',
    table: 'social_posts',
  },
  // SNS 投稿の更新（8）
  {
    name: 'PATCH /social/posts/{id} の body',
    route: updatePostRoute,
    method: 'PATCH',
    path: () => `/social/posts/${postId}`,
    params: () => ({ id: postId }),
    body: (v) => ({ body: maybe('本文改', v) }),
    key: 'body',
    table: 'social_posts',
  },
  {
    name: 'PATCH /social/posts/{id} の link',
    route: updatePostRoute,
    method: 'PATCH',
    path: () => `/social/posts/${postId}`,
    params: () => ({ id: postId }),
    body: (v) => ({ link: maybe('https://x.example.com/l2/', v) }),
    key: 'link',
    table: 'social_posts',
  },
  {
    name: 'PATCH /social/posts/{id} の media[].url',
    route: updatePostRoute,
    method: 'PATCH',
    path: () => `/social/posts/${postId}`,
    params: () => ({ id: postId }),
    body: (v) => ({ media: [{ url: maybe('https://x.example.com/b.png?', v), alt: null }] }),
    key: 'media',
    table: 'social_posts',
  },
  {
    name: 'PATCH /social/posts/{id} の media[].alt',
    route: updatePostRoute,
    method: 'PATCH',
    path: () => `/social/posts/${postId}`,
    params: () => ({ id: postId }),
    body: (v) => ({ media: [{ url: 'https://x.example.com/b.png', alt: maybe('代替2', v) }] }),
    key: 'media',
    table: 'social_posts',
  },
  {
    name: 'PATCH /social/posts/{id} の providerOptions',
    route: updatePostRoute,
    method: 'PATCH',
    path: () => `/social/posts/${postId}`,
    params: () => ({ id: postId }),
    body: (v) => ({ providerOptions: { opt: maybe('v2', v) } }),
    key: 'providerOptions',
    table: 'social_posts',
  },
  {
    name: 'PATCH /social/posts/{id} の externalId',
    route: updatePostRoute,
    method: 'PATCH',
    path: () => `/social/posts/${postId}`,
    params: () => ({ id: postId }),
    body: (v) => ({ externalId: maybe('ext-1', v) }),
    key: 'externalId',
    table: 'social_posts',
  },
  {
    name: 'PATCH /social/posts/{id} の externalUrl',
    route: updatePostRoute,
    method: 'PATCH',
    path: () => `/social/posts/${postId}`,
    params: () => ({ id: postId }),
    body: (v) => ({ externalUrl: maybe('https://x.example.com/p/', v) }),
    key: 'externalUrl',
    table: 'social_posts',
  },
  {
    name: 'PATCH /social/posts/{id} の failureReason',
    route: updatePostRoute,
    method: 'PATCH',
    path: () => `/social/posts/${postId}`,
    params: () => ({ id: postId }),
    body: (v) => ({ failureReason: maybe('理由', v) }),
    key: 'failureReason',
    table: 'social_posts',
  },
  // 利用者（4）
  ...(['displayName', 'email'] as const).map((field): BodyCase => ({
    name: `POST /users の ${field}`,
    route: createUserRoute,
    method: 'POST',
    path: () => '/users',
    body: (v) => {
      const loginId = `u${uniqueSuffix()}`;
      return {
        loginId,
        displayName: '利用者',
        email: `${loginId}@example.com`,
        password: PASSWORD,
        roles: [],
        [field]: maybe(field === 'displayName' ? '利用者' : `${loginId}@example.com`, v),
      };
    },
    key: field,
    table: 'users',
  })),
  ...(['displayName', 'email'] as const).map((field): BodyCase => ({
    name: `PATCH /users/{id} の ${field}`,
    route: updateUserRoute,
    method: 'PATCH',
    path: () => `/users/${targetUserId}`,
    params: () => ({ id: targetUserId }),
    body: (v) => ({
      [field]: maybe(field === 'displayName' ? '利用者改' : `t${uniqueSuffix()}@example.com`, v),
    }),
    key: field,
    table: 'users',
  })),
  // Webhook（2）
  ...(['name', 'url'] as const).map((field): BodyCase => ({
    name: `POST /webhooks の ${field}`,
    route: createWebhookRoute,
    method: 'POST',
    path: () => '/webhooks',
    body: (v) => ({
      name: 'Webhook',
      url: 'https://hooks.example.com/torifune',
      events: [],
      [field]: maybe(field === 'name' ? 'Webhook' : 'https://hooks.example.com/t/', v),
    }),
    key: field,
    table: 'webhooks',
  })),
  // API Token（1。セッションのみ）
  {
    name: 'POST /api-tokens の name',
    route: createApiTokenRoute,
    method: 'POST',
    path: () => '/api-tokens',
    body: (v) => ({ name: maybe('token', v), scopes: ['site.read'] }),
    key: 'name',
    table: 'api_tokens',
  },
  // システム設定（1）
  {
    name: 'PUT /settings の serviceName',
    route: updateSettingsRoute,
    method: 'PUT',
    path: () => '/settings',
    body: (v) => ({ serviceName: maybe('とりふね', v) }),
    key: 'serviceName',
    table: 'system_settings',
  },
  // Plugin の設定（1。text の項目）
  {
    name: 'PUT /plugins/{id}/settings の values（text の項目）',
    route: savePluginSettingsRoute,
    method: 'PUT',
    path: () => `/plugins/${PLUGIN_ID}/settings`,
    params: () => ({ id: PLUGIN_ID }),
    body: (v) => ({ values: { greeting: maybe('hi', v) } }),
    key: 'values',
    table: 'plugin_store',
  },
];

const TABLE_H_MATRIX = TABLE_H.flatMap((entry) =>
  VARIANTS.map(({ variant, text }) => ({
    ...entry,
    variant,
    text,
    label: `${entry.name} に${variant === 'nul' ? ' NUL' : '片割れ'}`,
  })),
);

function send(entry: BodyCase, variant?: Variant): Promise<JsonResult> {
  return call(entry.route, entry.method, entry.path(), {
    body: entry.body(variant),
    ...(entry.params === undefined ? {} : { params: entry.params() }),
    ...(entry.auth === undefined ? {} : { auth: entry.auth() }),
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('nulinput');

  const identity = await insertUser(['administrator']);
  adminLoginId = identity.loginId;
  admin = await withConnection((connection) => authorizationContextFor(connection, identity));
  session = await issueSessionToken(adminLoginId);
  socialToken = await issueToken(['social.read', 'social.write']);

  siteId = (
    await createSite(admin, {
      name: 'サイト',
      url: 'https://site.example.com',
      description: '',
      status: 'active',
    })
  ).id;
  campaignId = (
    await createCampaign(admin, {
      name: 'キャンペーン',
      description: '',
      status: 'draft',
      startsOn: '2026-01-01',
      endsOn: null,
      siteIds: [],
    })
  ).id;
  accountId = (
    await createSocialAccount(admin, {
      provider: 'x',
      displayName: 'とりふね公式',
      handle: '@torifune',
      credential: null,
      status: 'connected',
    })
  ).id;
  postId = (
    await createSocialPost(admin, {
      socialAccountId: accountId,
      body: '本文',
      scheduledAt: null,
      status: 'draft',
    })
  ).post.id;
  targetUserId = (
    await createUser(admin, {
      loginId: 'nulinputtarget',
      displayName: '対象の利用者',
      email: 'nulinputtarget@example.com',
      password: PASSWORD,
      roles: [],
      request: null,
    })
  ).user.id;

  await activateExamplePlugin();
});

afterAll(async () => {
  resetPluginRegistry();
  resetPermissionRegistry();
  resetPublisherRegistry();
  resetEventHandlers();
  await scratch.dispose();
});

afterEach(() => {
  resetLogger();
});

/* -------------------------------------------------------------------------- */
/* #7 表 H の 36 件                                                             */
/* -------------------------------------------------------------------------- */

describe('#7 表 H の 36 件の本文の NUL・片割れは 422', () => {
  it('#7 表 H が 36 件', () => {
    expect(TABLE_H).toHaveLength(36);
  });

  it.each(TABLE_H)('#7 前提：$name の土台の本文だけを送ると 2xx', async (entry) => {
    const result = await send(entry);

    expect(result.status, result.text).toBeGreaterThanOrEqual(200);
    expect(result.status, result.text).toBeLessThan(300);
  });

  it.each(TABLE_H_MATRIX)(
    '#7 $label → 422 VALIDATION_ERROR、details がちょうど { $key: [文言] }',
    async (entry) => {
      const result = await send(entry, entry.variant);

      expect(result.status, result.text).toBe(422);
      expect(errorOf(result).code).toBe('VALIDATION_ERROR');
      expect(detailsOf(result)).toEqual({ [entry.key]: [entry.text] });
    },
  );

  it.each(TABLE_H_MATRIX)('#7 $label → 行が増えず・変わらない', async (entry) => {
    const before = await tableRows(entry.table);

    await send(entry, entry.variant);

    expect(await tableRows(entry.table)).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* #8 クエリ                                                                    */
/* -------------------------------------------------------------------------- */

const QUERY_CASES: readonly {
  readonly name: string;
  readonly route: Route;
  readonly path: string;
  readonly key: string;
}[] = [
  { name: 'GET /sites?q=', route: listSitesRoute, path: '/sites?q=a%00b', key: 'q' },
  { name: 'GET /campaigns?q=', route: listCampaignsRoute, path: '/campaigns?q=a%00b', key: 'q' },
  { name: 'GET /users?q=', route: listUsersRoute, path: '/users?q=a%00b', key: 'q' },
  {
    name: 'GET /social/accounts?provider=',
    route: listAccountsRoute,
    path: '/social/accounts?provider=x%00',
    key: 'provider',
  },
  {
    name: 'GET /analytics/breakdown?source=',
    route: breakdownRoute,
    path: '/analytics/breakdown?from=2026-09-01&to=2026-09-02&metric=path_pageviews&source=a%00b',
    key: 'source',
  },
  {
    name: 'GET /analytics?source=',
    route: analyticsRoute,
    path: '/analytics?from=2026-09-01&to=2026-09-02&source=a%00b',
    key: 'source',
  },
  {
    name: 'GET /plugins/registry?q=',
    route: registryRoute,
    path: '/plugins/registry?q=a%00b',
    key: 'q',
  },
];

describe('#8 クエリの NUL は 422', () => {
  it.each(QUERY_CASES)(
    '#8 $name に %00 → 422、details が { $key: [NUL の文言] } だけ',
    async ({ route, path, key }) => {
      const result = await call(route, 'GET', path);

      expect(result.status, result.text).toBe(422);
      expect(errorOf(result).code).toBe('VALIDATION_ERROR');
      expect(detailsOf(result)).toEqual({ [key]: [NUL_TEXT] });
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #9 複数・入れ子・Zod を走らせない                                              */
/* -------------------------------------------------------------------------- */

describe('#9 複数の項目・同じ項目に両方・入れ子・最上位のキー', () => {
  it('#9 POST /sites の name に NUL、description に片割れ → details に 2 つのキー（それぞれの文言）', async () => {
    const result = await call(createSiteRoute, 'POST', '/sites', {
      body: { name: 'a\u0000', url: 'https://x9.example.com', description: 'b\ud800' },
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ name: [NUL_TEXT], description: [SURROGATE_TEXT] });
  });

  it('#9 POST /sites の name に NUL と片割れの両方 → details.name が 2 つの文言（NUL が先）', async () => {
    const result = await call(createSiteRoute, 'POST', '/sites', {
      body: { name: 'a\ud800b\u0000', url: 'https://x9.example.com' },
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ name: [NUL_TEXT, SURROGATE_TEXT] });
  });

  it("#9 POST /campaigns の siteIds: ['\\u0000'] → details.siteIds が NUL の文言（UUID の形の文言ではない）", async () => {
    const result = await call(createCampaignRoute, 'POST', '/campaigns', {
      body: { name: 'キャンペーン', startsOn: '2026-01-01', siteIds: ['\u0000'] },
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ siteIds: [NUL_TEXT] });
  });

  it('#9 本文の最上位に NUL を含むキー → details._ が NUL の文言', async () => {
    const result = await call(createSiteRoute, 'POST', '/sites', {
      body: { 'na\u0000me': 'x', name: 'N', url: 'https://x9.example.com' },
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ _: [NUL_TEXT] });
  });

  it("#9 name に NUL で status: 'bogus' → details は name だけ（Zod を走らせない）", async () => {
    const result = await call(createSiteRoute, 'POST', '/sites', {
      body: { name: 'a\u0000', url: 'https://x9.example.com', status: 'bogus' },
    });

    expect(result.status, result.text).toBe(422);
    expect(Object.keys(detailsOf(result))).toEqual(['name']);
  });

  it('#9 name に NUL で url が欠けていても details は name だけ（Zod を走らせない）', async () => {
    const result = await call(createSiteRoute, 'POST', '/sites', { body: { name: 'a\u0000' } });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ name: [NUL_TEXT] });
  });

  it('#9 csrfToken に片割れを含む本文 → details.csrfToken（Bearer なので CSRF は検証しない）', async () => {
    const token = await issueToken(['site.read', 'site.write']);

    const result = await call(createSiteRoute, 'POST', '/sites', {
      body: { name: 'N', url: 'https://x9.example.com', csrfToken: 'c\ud800' },
      auth: { kind: 'bearer', token },
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ csrfToken: [SURROGATE_TEXT] });
  });
});

/* -------------------------------------------------------------------------- */
/* #10 認可が先                                                                 */
/* -------------------------------------------------------------------------- */

describe('#10 認可は使えない文字の検査より先', () => {
  const NUL_SITE = { name: 'a\u0000', url: 'https://x10.example.com' };

  it('#10 POST /sites の name に NUL を認証なし（CSRF は通す）で → 401', async () => {
    const result = await call(createSiteRoute, 'POST', '/sites', {
      body: NUL_SITE,
      auth: { kind: 'none' },
    });

    expect(result.status, result.text).toBe(401);
    expect(errorOf(result).code).toBe('UNAUTHENTICATED');
  });

  it('#10 POST /sites の name に NUL を site.write を持たない Token で → 403', async () => {
    const token = await issueToken(['site.read']);

    const result = await call(createSiteRoute, 'POST', '/sites', {
      body: NUL_SITE,
      auth: { kind: 'bearer', token },
    });

    expect(result.status, result.text).toBe(403);
    expect(errorOf(result).code).toBe('FORBIDDEN');
  });

  it('#10 POST /sites の name に NUL を CSRF を付けないセッションで → 403 CSRF_FAILED', async () => {
    const result = await call(createSiteRoute, 'POST', '/sites', {
      body: NUL_SITE,
      auth: { kind: 'session', csrf: false },
    });

    expect(result.status, result.text).toBe(403);
    expect(errorOf(result).code).toBe('CSRF_FAILED');
  });

  it('#10 GET /sites?q=%00 を認証なしで → 401', async () => {
    const result = await call(listSitesRoute, 'GET', '/sites?q=a%00b', { auth: { kind: 'none' } });

    expect(result.status, result.text).toBe(401);
  });

  it('#10 GET /sites?q=%00 を site.read を持たない Token で → 403', async () => {
    const token = await issueToken(['campaign.read']);

    const result = await call(listSitesRoute, 'GET', '/sites?q=a%00b', {
      auth: { kind: 'bearer', token },
    });

    expect(result.status, result.text).toBe(403);
  });

  it('#10 POST /sites の name に片割れを site.write を持たない Token で → 403', async () => {
    const token = await issueToken(['site.read']);

    const result = await call(createSiteRoute, 'POST', '/sites', {
      body: { name: 'a\ud800', url: 'https://x10.example.com' },
      auth: { kind: 'bearer', token },
    });

    expect(result.status, result.text).toBe(403);
  });
});

/* -------------------------------------------------------------------------- */
/* #11 値を載せない・500 のログが無い                                             */
/* -------------------------------------------------------------------------- */

describe('#11 422 の応答に送った値が無く、500 のログが出ない', () => {
  it.each(TABLE_H_MATRIX)('#11 $label → 応答の本文に marker-046 が無い', async (entry) => {
    const result = await send(entry, entry.variant);

    expect(result.text).not.toContain(MARKER);
  });

  it.each(TABLE_H_MATRIX)('#11 $label → unhandled error in route のログが出ない', async (entry) => {
    const { records } = capture();

    await send(entry, entry.variant);

    expect(records.map((record) => record.message)).not.toContain('unhandled error in route');
  });

  it.each(QUERY_CASES)(
    '#11 $name に %00 → unhandled error in route のログが出ない',
    async ({ route, path }) => {
      const { records } = capture();

      await call(route, 'GET', path);

      expect(records.map((record) => record.message)).not.toContain('unhandled error in route');
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #12 変わらないもの                                                           */
/* -------------------------------------------------------------------------- */

describe('#12 パスの {id} と /auth/callback は変わらない', () => {
  it('#12 GET /sites/{id} の id に NUL → 404', async () => {
    const id = `${siteId}\u0000`;

    const result = await call(getSiteRoute, 'GET', `/sites/${encodeURIComponent(id)}`, {
      params: { id },
    });

    expect(result.status, result.text).toBe(404);
  });

  it('#12 GET /campaigns/{id} の id に NUL → 404', async () => {
    const id = `${campaignId}\u0000`;

    const result = await call(getCampaignRoute, 'GET', `/campaigns/${encodeURIComponent(id)}`, {
      params: { id },
    });

    expect(result.status, result.text).toBe(404);
  });

  it('#12 DELETE /webhooks/{id} の id に NUL → 404', async () => {
    const id = `${uuidv7()}\u0000`;

    const result = await call(deleteWebhookRoute, 'DELETE', `/webhooks/${encodeURIComponent(id)}`, {
      params: { id },
    });

    expect(result.status, result.text).toBe(404);
  });

  it('#12 GET /plugins/operations/{id} の id に NUL → 404', async () => {
    const id = `${uuidv7()}\u0000`;

    const result = await call(
      getPluginOperationRoute,
      'GET',
      `/plugins/operations/${encodeURIComponent(id)}`,
      { params: { id } },
    );

    expect(result.status, result.text).toBe(404);
  });

  it('#12 PUT /plugins/{id}/settings の id に NUL（本文は正しい）→ 404', async () => {
    const id = `${PLUGIN_ID}\u0000`;

    const result = await call(
      savePluginSettingsRoute,
      'PUT',
      `/plugins/${encodeURIComponent(id)}/settings`,
      { params: { id }, body: { values: { greeting: 'hi' } } },
    );

    expect(result.status, result.text).toBe(404);
  });

  it('#12 GET /auth/callback?state=%00&code=%00 → 302（/login?error=authorization_failed）', async () => {
    const result = await call(callbackRoute, 'GET', '/auth/callback?state=%00&code=%00', {
      auth: { kind: 'none' },
    });

    expect(result.status, result.text).toBe(302);
    expect(result.headers.get('location')).toBe('/login?error=authorization_failed');
  });
});
