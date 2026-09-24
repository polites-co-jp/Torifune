import type { Plugin, PluginManifest } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PATCH as updateSocialPostRoute } from '@/app/api/v1/social/posts/[id]/route';
import { POST as createSocialPostRoute } from '@/app/api/v1/social/posts/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { resetEventHandlers } from '@/application/events';
import { resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { resetLogger } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import type { DependencyCandidate } from './dependencies';
import { enablePlugin, installPlugin } from './lifecycle';
import { discoverPlugins } from './loader';
import { resetPluginRuntime } from './runtime';

/**
 * Bluesky の手動投稿の URL の長さを、**API の登録・更新の経路で**確かめる
 * （042-social-api-input-fixes 設計 §6.1・§9.2、受け入れ条件 #12〜#15）。
 *
 * Core の登録（`POST /social/posts`）と更新（`PATCH /social/posts/{id}`）は、配信 Plugin の `validate()` を
 * 呼ぶ（`035` 設計 §6.1 の 8b）。Bluesky の Plugin を有効にしたうえでルートを直接叩く。
 *
 * - 日本語だけの本文なら 223 文字まで（`37 + 223 × 9 = 2044`、224 文字で 2053）
 * - 作成時は `draft` でも配信 Plugin の検査が掛かる
 * - 自動配信（`auto`）では URL の長さを見ない
 *
 * 注：
 * - ファイル名を `sns-bluesky` で始めない（042 実装プラン §4「静的検査の本数」）。
 *   Plugin の有効化・Token の作り方は `sns-bluesky.integration.test.ts` から写し、共有しない
 * - `beforeEach` で `globalThis.fetch` を「呼ばれたら投げる」に置く（本物の Bluesky を叩かない）
 */

const PLUGIN_ID = 'sns-bluesky';
const PROVIDER = 'bluesky';
const BASE = 'http://127.0.0.1:3000/api/v1/social/posts';

const IDENTIFIER = 'torifune-042.bsky.example';
const APP_PASSWORD = 'wwww-xxxx-yyyy-zzzz';

/** 日本語だけで URL が 2048 文字を超える本文（2053 文字）。 */
const TOO_LONG_BODY = 'あ'.repeat(224);
/** 日本語だけで URL が 2048 文字に収まる本文（2044 文字）。 */
const LONGEST_BODY = 'あ'.repeat(223);

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let realFetch: typeof globalThis.fetch;

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function detailsOf(result: JsonResult): Record<string, readonly string[]> {
  const error = result.body['error'] as
    { readonly details?: Record<string, readonly string[]> } | undefined;
  return error?.details ?? {};
}

async function jsonOf(response: Response): Promise<JsonResult> {
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/* -------------------------------------------------------------------------- */
/* Plugin の導入と有効化（`sns-bluesky.integration.test.ts` から写した）          */
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

async function activate(): Promise<void> {
  const { manifest, plugin } = entry();
  const result = await withConnection(async (connection) => {
    await installPlugin(connection, manifest);
    return enablePlugin({
      connection,
      manifest,
      plugin,
      authorization: admin,
      candidates: candidatesOf(manifest, false),
    });
  });
  if (!result.ok) throw new Error(`Bluesky 配信 Plugin を有効にできない: ${String(result.reason)}`);
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `m${suffix}`,
        email: `m${suffix}@example.com`,
        display_name: 'bluesky manual url test',
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
    loginId: `m${suffix}`,
    displayName: 'bluesky manual url test',
    email: `m${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

/** Plugin を有効にし、Bluesky のアカウントと Bearer の Token を用意する。 */
async function prepare(): Promise<{ readonly accountId: string; readonly token: string }> {
  await activate();
  const account = await createSocialAccount(admin, {
    provider: PROVIDER,
    displayName: 'とりふね公式',
    handle: '@torifune',
    credential: null,
    credentials: { identifier: IDENTIFIER, appPassword: APP_PASSWORD },
    status: 'connected',
  });
  const token = await createApiToken(admin, {
    name: `bluesky-manual-${uuidv7().slice(-8)}`,
    scopes: ['social.read', 'social.write'],
    expiresAt: null,
  });
  return { accountId: account.id, token: token.plaintext };
}

interface CreateOptions {
  readonly body: string;
  readonly status?: 'draft' | 'scheduled';
  readonly deliveryMode?: 'auto' | 'manual';
}

async function createViaApi(options: CreateOptions): Promise<JsonResult> {
  const { accountId, token } = await prepare();

  const response = await createSocialPostRoute(
    new Request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        socialAccountId: accountId,
        body: options.body,
        scheduledAt: new Date(Date.now() + 600_000).toISOString(),
        status: options.status ?? 'scheduled',
        deliveryMode: options.deliveryMode ?? 'manual',
      }),
    }),
  );
  return jsonOf(response);
}

async function patchViaApi(id: string, body: unknown, token: string): Promise<JsonResult> {
  const response = await updateSocialPostRoute(
    new Request(`${BASE}/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return jsonOf(response);
}

/**
 * 042 より前に登録された手動投稿の下書きを、**検査を通さずに DB へ直接**作る。
 * UseCase・API を通すと 042 の検査で作れない（042 実装プラン §8 の 8）。
 */
async function insertLegacyManualDraft(accountId: string): Promise<string> {
  const id = uuidv7();
  await withConnection(async (connection) => {
    await connection.db
      .insertInto('social_posts')
      .values({
        id,
        social_account_id: accountId,
        body: TOO_LONG_BODY,
        scheduled_at: new Date(Date.now() + 600_000),
        status: 'draft',
        delivery_mode: 'manual',
      })
      .execute();
  });
  return id;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('blueskymanualurl');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((): never => {
    throw new Error('偽の PDS を用意していない fetch が呼ばれた');
  }) as typeof globalThis.fetch;
  admin = await contextFor(['administrator']);
});

afterEach(async () => {
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
/* #12 手動投稿の予約                                                             */
/* -------------------------------------------------------------------------- */

describe('#12 手動投稿の予約は URL が長すぎる本文を 422 body で断る', () => {
  it('#12 あ×224 の manual・scheduled → 422', async () => {
    const result = await createViaApi({ body: TOO_LONG_BODY });

    expect(result.status).toBe(422);
  });

  it('#12 あ×224 の manual・scheduled → details.body に「投稿画面の URL」が出る', async () => {
    const result = await createViaApi({ body: TOO_LONG_BODY });

    expect((detailsOf(result)['body'] ?? []).join(' ')).toContain('投稿画面の URL');
  });

  it('#12 あ×223 の manual・scheduled → 201', async () => {
    const result = await createViaApi({ body: LONGEST_BODY });

    expect(result.status).toBe(201);
  });
});

/* -------------------------------------------------------------------------- */
/* #13 作成時は draft でも検査が掛かる                                             */
/* -------------------------------------------------------------------------- */

describe('#13 作成時は draft でも配信 Plugin の検査が掛かる', () => {
  it('#13 あ×224 の manual・draft → 422', async () => {
    const result = await createViaApi({ body: TOO_LONG_BODY, status: 'draft' });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('body');
  });
});

/* -------------------------------------------------------------------------- */
/* #14 自動配信では URL の長さを見ない                                             */
/* -------------------------------------------------------------------------- */

describe('#14 自動配信では URL の長さを見ない', () => {
  it('#14 あ×224 の auto・scheduled → 201', async () => {
    const result = await createViaApi({ body: TOO_LONG_BODY, deliveryMode: 'auto' });

    expect(result.status).toBe(201);
  });
});

/* -------------------------------------------------------------------------- */
/* #15 042 より前に登録された手動投稿の更新                                        */
/* -------------------------------------------------------------------------- */

describe('#15 042 より前に登録された長すぎる手動投稿の更新', () => {
  it('#15 { status: scheduled } へ移す PATCH → 422 body', async () => {
    const { accountId, token } = await prepare();
    const id = await insertLegacyManualDraft(accountId);

    const result = await patchViaApi(id, { status: 'scheduled' }, token);

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('body');
  });

  it('#15 { status: draft, body: 短い本文 } の PATCH → 200', async () => {
    const { accountId, token } = await prepare();
    const id = await insertLegacyManualDraft(accountId);

    const result = await patchViaApi(id, { status: 'draft', body: '短い本文' }, token);

    expect(result.status).toBe(200);
  });
});
