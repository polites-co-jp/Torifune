import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { resetEventHandlers } from '@/application/events';
import { publishDuePosts } from '@/application/social/publish';
import { resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  createSocialAccount,
  createSocialPost,
  updateSocialAccount,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { decryptSecret } from '@/infrastructure/crypto/cipher';
import { resetLogger } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import {
  CONTAINER_ID,
  IG_USER_ID,
  MEDIA_ID,
  PERMALINK,
  REFRESHED_ACCESS_TOKEN,
  containerCreated,
  containerStatus,
  meUserId,
  mediaPublished,
  permalinkOf,
  toResponse,
  tokenRefreshed,
  type GraphResponseExample,
} from '@/test-support/instagram-graph';
import type { DependencyCandidate } from './dependencies';
import { enablePlugin, installPlugin } from './lifecycle';
import { discoverPlugins } from './loader';
import { resetPluginRuntime } from './runtime';

/**
 * Instagram 配信 Plugin のユーザー ID の `auto` を **Core のジョブを通して**確かめる
 * （041-plugin-help-docs 設計 §6.4.3、ユーザー裁定 U1、受け入れ条件 #85）。
 *
 * `auto` のアカウントの配信で、Plugin が R0（`/me`）で得た数字の ID を `rotatedCredential` で返し、
 * Core が比較更新で資格情報へ書き戻す（`039` §6.1）。書き戻した後の配信は R0 を送らない。
 * 配信の間に運用者が資格情報を入れ直したら、書き戻さずに運用者の値を残す（`039` #57 と同じ見方）。
 *
 * 注：
 * - ファイル名を `sns-instagram` で始めない（041 実装プラン §8 の 19・29）。
 *   偽の Graph API は `sns-instagram.integration.test.ts` の作りを写し、R0 を足した（共有しない）
 * - **偽の Graph API を挿す口は `globalThis.fetch` だけ。** `beforeEach` でまず「呼ばれたら投げる」を置き、
 *   `useFakeGraph()` がその上から偽物を置く。`afterEach` で必ず戻す。未知の宛先には投げる
 * - 資格情報の値に `torifune` を含めない（041 実装プラン §7・T32 の注意）
 * - 既定の `wait`（実時間）を使うので、偽の R3 は最初から `FINISHED` を返す
 */

const PLUGIN_ID = 'sns-instagram';
const PROVIDER = 'instagram';

const DAY_MS = 24 * 60 * 60 * 1000;

const IMAGE_URL = 'https://cdn.example.test/images/auto-integration-0.jpg';

/** `auto` のアカウントのトークン。**`torifune` を含めない。** */
const AUTO_TOKEN = 'IGAAautoIntegrationToken3Wm8';

/** 配信の間に運用者が入れ直す値。 */
const OPERATOR_TOKEN = 'IGAAoperatorEnteredToken5Qx';
const OPERATOR_USER_ID = '17841499999999999';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let realFetch: typeof globalThis.fetch;

/* -------------------------------------------------------------------------- */
/* 偽の Graph API                                                               */
/* -------------------------------------------------------------------------- */

type RequestKind = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';

interface GraphCall {
  readonly kind: RequestKind;
  readonly url: string;
  readonly authorization: string | null;
}

type Route = () => GraphResponseExample | Promise<GraphResponseExample>;

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
  if (method === 'GET' && parts.length === 2 && parts[1] === 'me') {
    return 'R0';
  }
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
  R0: () => meUserId(IG_USER_ID),
  R1: () => containerCreated(CONTAINER_ID),
  R2: () => containerCreated(CONTAINER_ID),
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
    return toResponse(await (routes[kind] ?? DEFAULT_ROUTES[kind])(), init.signal);
  }) as typeof globalThis.fetch;

  return calls;
}

/* -------------------------------------------------------------------------- */
/* Plugin の導入と有効化                                                        */
/* -------------------------------------------------------------------------- */

async function activate(): Promise<void> {
  const found = discoverPlugins().plugins.find((p) => p.manifest.id === PLUGIN_ID);
  if (found === undefined) throw new Error('Instagram 配信 Plugin が読み込めていない');
  const { manifest, plugin } = found;
  await withConnection(async (connection) => {
    await installPlugin(connection, manifest);
    const outcome = await enablePlugin({
      connection,
      manifest,
      plugin,
      authorization: admin,
      candidates: new Map<string, DependencyCandidate>([
        [manifest.id, { manifest, enabled: false }],
      ]),
    });
    if (!outcome.ok) throw new Error(`有効化に失敗: ${outcome.reason}`);
  });
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `a${suffix}`,
        email: `a${suffix}@example.com`,
        display_name: 'instagram auto test',
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
    loginId: `a${suffix}`,
    displayName: 'instagram auto test',
    email: `a${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

/* -------------------------------------------------------------------------- */
/* アカウント・投稿・DB                                                         */
/* -------------------------------------------------------------------------- */

/** 期限を「今から days 日後」にした `auto` の資格情報（既定の時計は実時間）。 */
function autoCredentials(days: number): Record<string, string> {
  return {
    igUserId: 'auto',
    accessToken: AUTO_TOKEN,
    accessTokenExpiresAt: new Date(Date.now() + days * DAY_MS).toISOString(),
  };
}

async function accountFor(credentials: Record<string, string>): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider: PROVIDER,
    displayName: 'テストアカウント',
    handle: 'shop.example',
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
    body: 'Instagram へ届く本文',
    scheduledAt: new Date(Date.now() - 60_000),
    status: 'scheduled',
    deliveryMode: 'auto',
    media: [{ url: IMAGE_URL, alt: null }],
  });
  return post.id;
}

async function postRow(id: string): Promise<{
  readonly status: string;
  readonly external_id: string | null;
  readonly external_url: string | null;
}> {
  const row = await withConnection((connection) =>
    connection.db
      .selectFrom('social_posts')
      .select(['status', 'external_id', 'external_url'])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`投稿が無い: ${id}`);
  return row as { status: string; external_id: string | null; external_url: string | null };
}

async function decryptedCredential(accountId: string): Promise<Record<string, string>> {
  const row = await withConnection((connection) =>
    connection.db
      .selectFrom('social_accounts')
      .select(['credential'])
      .where('id', '=', accountId)
      .executeTakeFirst(),
  );
  const stored = (row as { credential: string | null } | undefined)?.credential ?? '';
  const decrypted = decryptSecret(stored);
  if (!decrypted.ok) throw new Error('資格情報を復号できない');
  return JSON.parse(decrypted.secret.expose()) as Record<string, string>;
}

async function rotatedAuditRows(): Promise<{ readonly detail: Record<string, unknown> }[]> {
  return withConnection(async (connection) => {
    const rows = await connection.db
      .selectFrom('audit_logs')
      .select(['resource_type', 'detail'])
      .where('action', '=', 'updated')
      .execute();
    return (rows as { resource_type: string; detail: Record<string, unknown> }[]).filter(
      (row) => row.resource_type === 'social_account' && row.detail['rotated'] === true,
    );
  });
}

async function run() {
  return withConnection((connection) => publishDuePosts(connection));
}

beforeAll(async () => {
  scratch = await useScratchDatabase('instagramauto');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch();
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
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('job_runs').execute();
    await connection.db.deleteFrom('plugin_store').execute();
    await connection.db.deleteFrom('plugins').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #85                                                                          */
/* -------------------------------------------------------------------------- */

describe('#85 auto のアカウントを Core のジョブで配信すると、得た ID が書き戻される', () => {
  async function publishAuto(days = 40): Promise<{
    readonly accountId: string;
    readonly postId: string;
    readonly before: Record<string, string>;
    readonly calls: readonly GraphCall[];
    readonly published: number;
  }> {
    const calls = useFakeGraph();
    await activate();
    const before = autoCredentials(days);
    const accountId = await accountFor(before);
    const postId = await makePost(accountId);

    const summary = await run();
    return { accountId, postId, before, calls, published: summary.published };
  }

  it('#85 投稿は published になり、external_id / external_url が入る', async () => {
    const { postId, published } = await publishAuto();

    expect(published).toBe(1);
    const row = await postRow(postId);
    expect(row.status).toBe('published');
    expect(row.external_id).toBe(MEDIA_ID);
    expect(row.external_url).toBe(PERMALINK);
  });

  it('#85 Graph API へ出た要求は R0 → R1 → R3 → R4 → R5 で、R1 の URL が得た ID を使う', async () => {
    const { calls } = await publishAuto();

    expect(calls.map((call) => call.kind)).toEqual(['R0', 'R1', 'R3', 'R4', 'R5']);
    expect(calls[1]?.url).toBe(`https://graph.instagram.com/v26.0/${IG_USER_ID}/media`);
    expect(calls[0]?.authorization).toBe(`Bearer ${AUTO_TOKEN}`);
  });

  it('#85 DB の資格情報を復号すると igUserId が得た ID、accessToken / accessTokenExpiresAt は入れた値のまま（3 項目ちょうど）', async () => {
    const { accountId, before } = await publishAuto();

    expect(await decryptedCredential(accountId)).toStrictEqual({
      igUserId: IG_USER_ID,
      accessToken: AUTO_TOKEN,
      accessTokenExpiresAt: before['accessTokenExpiresAt'],
    });
  });

  it('#85 延長も起きた場合（期限 10 日後）は igUserId が得た ID、accessToken と期限が延長後の値', async () => {
    const { accountId, before } = await publishAuto(10);

    const after = await decryptedCredential(accountId);
    expect(Object.keys(after).sort()).toEqual(['accessToken', 'accessTokenExpiresAt', 'igUserId']);
    expect(after['igUserId']).toBe(IG_USER_ID);
    expect(after['accessToken']).toBe(REFRESHED_ACCESS_TOKEN);
    expect(after['accessTokenExpiresAt']).not.toBe(before['accessTokenExpiresAt']);
  });

  it('#85 書き戻しは audit_logs の updated（rotated: true）として 1 行残る', async () => {
    await publishAuto();

    expect(await rotatedAuditRows()).toHaveLength(1);
  });

  it('#85 続けて別の投稿を配信すると /me への要求が無く、書き戻した ID で送る', async () => {
    const calls = useFakeGraph();
    await activate();
    const accountId = await accountFor(autoCredentials(40));

    await makePost(accountId);
    await run();
    const firstRun = calls.length;
    const secondPostId = await makePost(accountId);
    await run();

    const second = calls.slice(firstRun);
    expect(second.map((call) => call.kind)).toEqual(['R1', 'R3', 'R4', 'R5']);
    expect(second[0]?.url).toBe(`https://graph.instagram.com/v26.0/${IG_USER_ID}/media`);
    expect((await postRow(secondPostId)).status).toBe('published');
  });

  it('#85 配信の間（R4 の応答の前）に運用者が updateSocialAccount で入れ直すと、書き戻されず運用者の値が残る', async () => {
    const operatorValues = {
      igUserId: OPERATOR_USER_ID,
      accessToken: OPERATOR_TOKEN,
      accessTokenExpiresAt: 'unknown',
    };
    let accountId = '';
    useFakeGraph({
      R4: async () => {
        await updateSocialAccount(admin, { id: accountId, credentials: operatorValues });
        return mediaPublished();
      },
    });
    await activate();
    accountId = await accountFor(autoCredentials(40));
    const postId = await makePost(accountId);

    await run();

    expect((await postRow(postId)).status).toBe('published');
    expect(await decryptedCredential(accountId)).toStrictEqual(operatorValues);
    expect(await rotatedAuditRows()).toHaveLength(0);
  });

  it('#85 運用者が入れ直した値が auto のままなら、次の配信でもう一度 R0 を送る', async () => {
    const operatorValues = {
      igUserId: 'auto',
      accessToken: OPERATOR_TOKEN,
      accessTokenExpiresAt: new Date(Date.now() + 40 * DAY_MS).toISOString(),
    };
    let accountId = '';
    let entered = false;
    const calls = useFakeGraph({
      R4: async () => {
        if (!entered) {
          entered = true;
          await updateSocialAccount(admin, { id: accountId, credentials: operatorValues });
        }
        return mediaPublished();
      },
    });
    await activate();
    accountId = await accountFor(autoCredentials(40));

    await makePost(accountId);
    await run();
    const firstRun = calls.length;
    await makePost(accountId);
    await run();

    const second = calls.slice(firstRun);
    expect(second[0]?.kind).toBe('R0');
    expect(second[0]?.authorization).toBe(`Bearer ${OPERATOR_TOKEN}`);
  });
});
