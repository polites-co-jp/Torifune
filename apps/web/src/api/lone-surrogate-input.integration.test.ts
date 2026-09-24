import type { PublisherRegistration, PublisherValidationProblem } from '@torifune/plugin-api';
import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GET as getPluginSettingsRoute,
  PUT as savePluginSettingsRoute,
} from '@/app/api/v1/plugins/[id]/settings/route';
import { GET as getSettingsRoute, PUT as updateSettingsRoute } from '@/app/api/v1/settings/route';
import { POST as createSiteRoute } from '@/app/api/v1/sites/route';
import { PATCH as updatePostRoute } from '@/app/api/v1/social/posts/[id]/route';
import { POST as createPostRoute } from '@/app/api/v1/social/posts/route';
import { POST as createWebhookRoute } from '@/app/api/v1/webhooks/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { resetEventHandlers } from '@/application/events';
import { savePluginSettings } from '@/application/plugin/plugin-settings-use-cases';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { updateSystemSettings } from '@/application/system-settings/system-settings-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { enablePlugin, installPlugin } from '@/plugin/lifecycle';
import { discoverPlugins } from '@/plugin/loader';
import { resetPluginRegistry } from '@/plugin/registry';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 対になっていないサロゲート（片割れ）の HTTP の入力（046-input-500-nul-and-ranges 設計 §6.2・§6.7・§6.8、受け入れ条件 #18〜#21。ユーザー裁定 2）。
 *
 * - #18：`jsonb` の項目（`providerOptions` の値・キー、`media[].alt`、`PATCH` の `providerOptions`）→ いまの 500 ではなく 422
 *   （キーは `providerOptions` / `media`、サロゲートの文言）。投稿が増えず・変わらない
 * - #19：`PUT /settings` の `serviceName`・`PUT /plugins/example-plugin/settings` の `values.greeting` → 422。後の `GET` が前の値
 * - #20：`text` 列で**いま 2xx のもの**（`POST /sites` の `name`・`POST /webhooks` の `url`・`validate()` を持たない provider の `body`・
 *   Token で送る `externalRef`）→ 422（動作の変更）。行が増えない。`POST /webhooks` は `audit_logs` も増えない
 * - #21：配信 Plugin との順序。片割れを `body` の問題として返す `validate()` を持つ偽の provider で、`body` の片割れは
 *   Core の文言の 422 `details.body` になり、`validate()` は**呼ばれない**。`link` の片割れは 422 `details.link`。
 *   絵文字（対になったサロゲート）を含む `body`・`providerOptions` は 201 で、そのまま保存・返される
 *
 * ルートを直接叩く。認証は Bearer の API Token。本文は `JSON.stringify` が片割れを `\ud800` のエスケープで書く（手で JSON を書かない）。
 * **ソースに壊れた文字を置かない。** 片割れはエスケープで書き、絵文字は `String.fromCodePoint` で作る。
 */

const ORIGIN = 'http://127.0.0.1:3000';
const BASE = `${ORIGIN}/api/v1`;
const PLUGIN_ID = 'example-plugin';
const SURROGATE_TEXT = '使用できない文字（対になっていないサロゲート）が含まれています。';
/** 配信 Plugin（`037`・`040`・`042`）が返す片割れの文言。Core が先に断るので、もう返らない。 */
const PLUGIN_SURROGATE_TEXT = '本文に扱えない文字が含まれています。';
/** U+1F44D（対になったサロゲート）。 */
const EMOJI = String.fromCodePoint(0x1f44d);

/** validate() を持つ偽の provider。 */
const VALIDATING_PROVIDER = 'testsns';
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let token: string;
/** `validate()` を持たない provider（`x`）のアカウント。 */
let plainAccountId: string;
let postId: string;

interface JsonResult {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

function detailsOf(result: JsonResult): Record<string, readonly string[]> {
  const error = result.body['error'] as
    { readonly details?: Record<string, readonly string[]> } | undefined;
  return error?.details ?? {};
}

function dataOf(result: JsonResult): Record<string, unknown> {
  return (result.body['data'] ?? {}) as Record<string, unknown>;
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `ls${suffix}`,
        email: `ls${suffix}@example.com`,
        display_name: 'lone surrogate input test',
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
    loginId: `ls${suffix}`,
    displayName: 'lone surrogate input test',
    email: `ls${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
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

async function call(
  route: Route,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  options: { readonly body?: unknown; readonly params?: Record<string, string> } = {},
): Promise<JsonResult> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const response = await route(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    options.params === undefined ? undefined : { params: Promise.resolve(options.params) },
  );
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function tableRows(table: string): Promise<readonly string[]> {
  return withConnection(async (connection) => {
    const result = await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(table)}`.execute(
      connection.db,
    );
    return result.rows.map((row) => JSON.stringify(row)).sort();
  });
}

/**
 * 片割れを `body` の問題として返す `validate()` を持つ偽の provider（`037`・`040` の配信 Plugin と同じ振る舞い）。
 * 呼ばれた回数を数える。
 */
function useValidatingPublisher(): { readonly calls: () => number } {
  let count = 0;
  const registration: PublisherRegistration = {
    provider: VALIDATING_PROVIDER,
    label: 'テストSNS',
    credentialFields: [],
    validate: ({ post }) => {
      count += 1;
      const problems: PublisherValidationProblem[] = [];
      if (LONE_SURROGATE.test(post.body) || LONE_SURROGATE.test(post.link ?? '')) {
        problems.push({ field: 'body', message: PLUGIN_SURROGATE_TEXT });
      }
      return problems;
    },
  };
  registerPublisher('test-plugin', registration);
  return { calls: () => count };
}

async function validatingAccount(): Promise<string> {
  return (
    await createSocialAccount(admin, {
      provider: VALIDATING_PROVIDER,
      displayName: 'テストSNS のアカウント',
      handle: '@testsns',
      credential: null,
      status: 'connected',
    })
  ).id;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('lonesurrogateinput');
  admin = await contextFor(['administrator']);
  token = (
    await createApiToken(admin, {
      name: 'lone surrogate token',
      scopes: [
        'site.read',
        'site.write',
        'social.read',
        'social.write',
        'system.manage',
        'plugin.manage',
      ],
      expiresAt: null,
    })
  ).plaintext;
  await activateExamplePlugin();
});

afterAll(async () => {
  resetPluginRegistry();
  resetPermissionRegistry();
  await scratch.dispose();
});

beforeEach(async () => {
  plainAccountId = (
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
      socialAccountId: plainAccountId,
      body: '本文',
      scheduledAt: null,
      status: 'draft',
    })
  ).post.id;
});

afterEach(async () => {
  resetPublisherRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('webhooks').execute();
    await connection.db.deleteFrom('sites').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #18 jsonb の項目                                                              */
/* -------------------------------------------------------------------------- */

describe('#18 jsonb の項目の片割れは 500 ではなく 422', () => {
  const CREATE_CASES = [
    {
      name: "providerOptions: { opt: 'v\\ud800' }",
      body: () => ({ providerOptions: { opt: 'v\ud800' } }),
      key: 'providerOptions',
    },
    {
      name: "providerOptions のキー 'k\\ud800'",
      body: () => ({ providerOptions: { 'k\ud800': 'v' } }),
      key: 'providerOptions',
    },
    {
      name: "media: [{ url, alt: 'a\\ud800' }]",
      body: () => ({ media: [{ url: 'https://x.example.com/a.png', alt: 'a\ud800' }] }),
      key: 'media',
    },
  ] as const;

  it.each(CREATE_CASES)(
    '#18 POST /social/posts の $name → 422、details.$key がサロゲートの文言',
    async ({ body, key }) => {
      const result = await call(createPostRoute, 'POST', '/social/posts', {
        body: { socialAccountId: plainAccountId, body: '本文', ...body() },
      });

      expect(result.status, result.text).toBe(422);
      expect(detailsOf(result)).toEqual({ [key]: [SURROGATE_TEXT] });
    },
  );

  it.each(CREATE_CASES)('#18 POST /social/posts の $name → 投稿が増えない', async ({ body }) => {
    const before = await tableRows('social_posts');

    await call(createPostRoute, 'POST', '/social/posts', {
      body: { socialAccountId: plainAccountId, body: '本文', ...body() },
    });

    expect(await tableRows('social_posts')).toEqual(before);
  });

  it("#18 PATCH /social/posts/{id} の providerOptions: { opt: 'v\\ud800' } → 422、details.providerOptions", async () => {
    const result = await call(updatePostRoute, 'PATCH', `/social/posts/${postId}`, {
      params: { id: postId },
      body: { providerOptions: { opt: 'v\ud800' } },
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ providerOptions: [SURROGATE_TEXT] });
  });

  it("#18 PATCH /social/posts/{id} の providerOptions: { opt: 'v\\ud800' } → 投稿が変わらない", async () => {
    const before = await tableRows('social_posts');

    await call(updatePostRoute, 'PATCH', `/social/posts/${postId}`, {
      params: { id: postId },
      body: { providerOptions: { opt: 'v\ud800' } },
    });

    expect(await tableRows('social_posts')).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* #19 システム設定・Plugin の設定                                                */
/* -------------------------------------------------------------------------- */

describe('#19 設定の片割れは 422 で、前の値のまま', () => {
  it("#19 PUT /settings の serviceName: 'S\\ud800' → 422、details.serviceName", async () => {
    const result = await call(updateSettingsRoute, 'PUT', '/settings', {
      body: { serviceName: 'S\ud800' },
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ serviceName: [SURROGATE_TEXT] });
  });

  it("#19 PUT /settings の serviceName: 'S\\ud800' の後、GET /settings が前の値", async () => {
    await updateSystemSettings(admin, { serviceName: '前のサービス名' });

    await call(updateSettingsRoute, 'PUT', '/settings', { body: { serviceName: 'S\ud800' } });
    const after = await call(getSettingsRoute, 'GET', '/settings');

    expect(after.status, after.text).toBe(200);
    expect(dataOf(after)['serviceName']).toBe('前のサービス名');
  });

  it("#19 PUT /plugins/example-plugin/settings の values.greeting: 'g\\ud800' → 422、details.values", async () => {
    const result = await call(savePluginSettingsRoute, 'PUT', `/plugins/${PLUGIN_ID}/settings`, {
      params: { id: PLUGIN_ID },
      body: { values: { greeting: 'g\ud800' } },
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ values: [SURROGATE_TEXT] });
  });

  it("#19 PUT /plugins/example-plugin/settings の values.greeting: 'g\\ud800' の後、GET の値が前の値", async () => {
    await savePluginSettings(admin, { pluginId: PLUGIN_ID, values: { greeting: '前のあいさつ' } });

    await call(savePluginSettingsRoute, 'PUT', `/plugins/${PLUGIN_ID}/settings`, {
      params: { id: PLUGIN_ID },
      body: { values: { greeting: 'g\ud800' } },
    });
    const after = await call(getPluginSettingsRoute, 'GET', `/plugins/${PLUGIN_ID}/settings`, {
      params: { id: PLUGIN_ID },
    });

    expect(after.status, after.text).toBe(200);
    const fields = dataOf(after)['fields'] as readonly {
      readonly key: string;
      readonly value: string | null;
    }[];
    expect(fields.find((field) => field.key === 'greeting')?.value).toBe('前のあいさつ');
  });
});

/* -------------------------------------------------------------------------- */
/* #20 text 列でいま 2xx のもの                                                   */
/* -------------------------------------------------------------------------- */

describe('#20 text 列でいま 2xx の片割れも 422（動作の変更）', () => {
  it("#20 POST /sites の name: 'サイト\\ud800' → 422、details.name、行が増えない", async () => {
    const before = await tableRows('sites');

    const result = await call(createSiteRoute, 'POST', '/sites', {
      body: { name: 'サイト\ud800', url: 'https://s20.example.com' },
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ name: [SURROGATE_TEXT] });
    expect(await tableRows('sites')).toEqual(before);
  });

  it('#20 POST /webhooks の url に片割れ → 422、details.url、行が増えない', async () => {
    const before = await tableRows('webhooks');

    const result = await call(createWebhookRoute, 'POST', '/webhooks', {
      body: { name: 'Webhook', url: 'https://hooks.example.com/t\ud800', events: [] },
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ url: [SURROGATE_TEXT] });
    expect(await tableRows('webhooks')).toEqual(before);
  });

  it('#20 POST /webhooks の url に片割れ → audit_logs も増えない', async () => {
    const before = await tableRows('audit_logs');

    await call(createWebhookRoute, 'POST', '/webhooks', {
      body: { name: 'Webhook', url: 'https://hooks.example.com/t\ud800', events: [] },
    });

    expect(await tableRows('audit_logs')).toEqual(before);
  });

  it('#20 POST /social/posts の body に片割れ（validate() を持たない provider）→ 422、details.body、行が増えない', async () => {
    const before = await tableRows('social_posts');

    const result = await call(createPostRoute, 'POST', '/social/posts', {
      body: { socialAccountId: plainAccountId, body: `本文\ud83d` },
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ body: [SURROGATE_TEXT] });
    expect(await tableRows('social_posts')).toEqual(before);
  });

  it('#20 Token で送る externalRef に片割れ → 422、details.externalRef、行が増えない', async () => {
    const before = await tableRows('social_posts');

    const result = await call(createPostRoute, 'POST', '/social/posts', {
      body: { socialAccountId: plainAccountId, body: '本文', externalRef: 'ref-\ud800' },
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ externalRef: [SURROGATE_TEXT] });
    expect(await tableRows('social_posts')).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* #21 配信 Plugin の validate() との順序                                         */
/* -------------------------------------------------------------------------- */

describe('#21 片割れは配信 Plugin の validate() より先に Core が断る', () => {
  it('#21 前提：偽の provider の validate() は、片割れの無い本文では呼ばれて 201', async () => {
    const publisher = useValidatingPublisher();
    const accountId = await validatingAccount();

    const result = await call(createPostRoute, 'POST', '/social/posts', {
      body: { socialAccountId: accountId, body: '本文' },
    });

    expect(result.status, result.text).toBe(201);
    expect(publisher.calls()).toBeGreaterThan(0);
  });

  it('#21 body に片割れ → 422 details.body がサロゲートの文言（Plugin の文言ではない）', async () => {
    useValidatingPublisher();
    const accountId = await validatingAccount();

    const result = await call(createPostRoute, 'POST', '/social/posts', {
      body: { socialAccountId: accountId, body: `本文\ud83d` },
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ body: [SURROGATE_TEXT] });
    expect(result.text).not.toContain(PLUGIN_SURROGATE_TEXT);
  });

  it('#21 body に片割れ → validate() が呼ばれない', async () => {
    const publisher = useValidatingPublisher();
    const accountId = await validatingAccount();

    await call(createPostRoute, 'POST', '/social/posts', {
      body: { socialAccountId: accountId, body: `本文\ud83d` },
    });

    expect(publisher.calls()).toBe(0);
  });

  it('#21 link に片割れ → 422 details.link（body ではない）', async () => {
    useValidatingPublisher();
    const accountId = await validatingAccount();

    const result = await call(createPostRoute, 'POST', '/social/posts', {
      body: { socialAccountId: accountId, body: '本文', link: 'https://x.example.com/\ud800' },
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ link: [SURROGATE_TEXT] });
  });

  it('#21 link に片割れ → validate() が呼ばれない', async () => {
    const publisher = useValidatingPublisher();
    const accountId = await validatingAccount();

    await call(createPostRoute, 'POST', '/social/posts', {
      body: { socialAccountId: accountId, body: '本文', link: 'https://x.example.com/\ud800' },
    });

    expect(publisher.calls()).toBe(0);
  });

  it('#21 変わらないもの：絵文字を含む body・providerOptions → 201 で、そのまま保存・返される', async () => {
    useValidatingPublisher();
    const accountId = await validatingAccount();
    const body = `いいね${EMOJI}`;
    const providerOptions = { reaction: EMOJI, [`k${EMOJI}`]: `v${EMOJI}` };

    const result = await call(createPostRoute, 'POST', '/social/posts', {
      body: { socialAccountId: accountId, body, providerOptions },
    });

    expect(result.status, result.text).toBe(201);
    expect(dataOf(result)['body']).toBe(body);
    expect(dataOf(result)['providerOptions']).toEqual(providerOptions);

    const stored = await withConnection(async (connection) =>
      connection.db
        .selectFrom('social_posts')
        .select(['body', 'provider_options'])
        .where('id', '=', String(dataOf(result)['id']))
        .executeTakeFirstOrThrow(),
    );
    expect(stored.body).toBe(body);
    expect(stored.provider_options).toEqual(providerOptions);
  });
});
