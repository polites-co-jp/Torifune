import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET, PATCH } from '@/app/api/v1/social/accounts/[id]/route';
import { login } from '@/application/auth/login';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { resetEventHandlers } from '@/application/events';
import {
  listPublishers,
  registerPublisher,
  resetPublisherRegistry,
} from '@/application/social/publisher-registry';
import { createSocialAccount } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { hashPassword } from '@/authentication/password';
import { decryptSecret } from '@/infrastructure/crypto/cipher';
import { resetLogger } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { enablePlugin, installPlugin } from '@/plugin/lifecycle';
import { discoverPlugins } from '@/plugin/loader';
import { resetPluginRuntime } from '@/plugin/runtime';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import {
  clearCredentialBody,
  credentialInputOf,
  setCredentialBody,
  type CredentialInput,
} from '@/ui/social/credential-form';
import { buildProviderOptions } from '@/ui/social/provider-options';
import type { ProviderOption } from '@/ui/social/social-accounts';

/**
 * 画面が送る本文を `PATCH /api/v1/social/accounts/{id}` に通す（039-social-credential-fields 設計 §6 / §8、
 * 受け入れ条件 #25〜#31）。
 *
 * **API・UseCase は変えない作業単位である。** ここで固定するのは「画面の関数
 * （`setCredentialBody` / `clearCredentialBody`）が作る本文そのものが、既存の経路で
 * 受け入れられ、認可・CSRF・監査が API と同じに効く」こと。送る本文は必ず G1 の関数で作る。
 *
 * `example-plugin` を有効化し、provider `example`（`handle` / `appPassword` の 2 項目）で確かめる。
 * 項目の宣言は本物の登録簿から `buildProviderOptions(listPublishers())` で引く（画面と同じ組み立て）。
 *
 * * DB の復号は `decryptSecret` で列を直接読む。**`readSocialCredential` を使わない**
 *   （`credential_read` の監査が増え、#31 と干渉する）
 * * 資格情報の値に `torifune` を含めない（`DATABASE_URL` の password と同じ綴りは Core が伏せる）
 * * 落ちたら API を直さない。設計 §2.1 の事実認識が違うので報告して止まる（実装プラン T5 の注意）
 */

const BASE = 'http://127.0.0.1:3000/api/v1/social/accounts';
const ORIGIN = 'http://127.0.0.1:3000';
const EXAMPLE_PLUGIN = 'example-plugin';
const EXAMPLE_PROVIDER = 'example';

/** 入れ直しの値。応答・監査に現れてはならない。 */
const NEW_VALUES = {
  handle: 'reset-handle-value-5d1c',
  appPassword: 'reset-app-password-value-8e2f',
} as const;

const OLD_FREE_TEXT = 'old-free-text';

const PASSWORD = 'credential reset correct horse battery staple';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let adminId: string;
let adminLoginId: string;
let writeToken: string;

interface JsonResult {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

function dataOf(result: JsonResult): Record<string, unknown> {
  return result.body['data'] as Record<string, unknown>;
}

function errorCodeOf(result: JsonResult): string | null {
  const error = result.body['error'] as { readonly code?: string } | undefined;
  return error?.code ?? null;
}

async function toResult(response: Response): Promise<JsonResult> {
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/* -------------------------------------------------------------------------- */
/* 利用者                                                                       */
/* -------------------------------------------------------------------------- */

/** ロールを付けた利用者。パスワードを持たせ、#29 で本物のセッションを発行できるようにする。 */
async function createUser(
  roleNames: readonly string[],
): Promise<{ id: string; loginId: string; context: AuthorizationContext }> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `r${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'social credential reset test',
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

  const identity: UserIdentity = {
    userId: id,
    loginId,
    displayName: 'social credential reset test',
    email: `${loginId}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  const context = await withConnection((connection) =>
    authorizationContextFor(connection, identity),
  );
  return { id, loginId, context };
}

/** 実際にログインして、有効なセッショントークンを得る（`home-destination.integration.test.ts` の手）。 */
async function issueSessionToken(loginId: string): Promise<string> {
  const outcome = await login({
    loginId,
    password: PASSWORD,
    request: { ipAddress: '203.0.113.39', userAgent: 'vitest' },
  });
  if (!outcome.ok) throw new Error(`ログインに失敗した: ${outcome.reason}`);
  return outcome.sessionToken;
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                       */
/* -------------------------------------------------------------------------- */

function exampleEntry() {
  const entry = discoverPlugins().plugins.find((p) => p.manifest.id === EXAMPLE_PLUGIN);
  if (entry === undefined) throw new Error('サンプル Plugin が読み込めていない');
  return entry;
}

/** `/plugins` の「導入」と「有効化」。 */
async function activateExample(): Promise<void> {
  const { manifest, plugin } = exampleEntry();
  await withConnection(async (connection) => {
    await installPlugin(connection, manifest);
    const outcome = await enablePlugin({
      connection,
      manifest,
      plugin,
      authorization: admin,
      candidates: new Map([[EXAMPLE_PLUGIN, { manifest, enabled: false }]]),
    });
    if (!outcome.ok) throw new Error(`有効化に失敗: ${outcome.reason}`);
  });
}

/** 画面と同じ組み立ての選択肢（本物の登録簿から）。 */
function optionOf(provider: string): ProviderOption {
  const option = buildProviderOptions(listPublishers()).find((o) => o.value === provider);
  if (option === undefined) throw new Error(`選択肢が無い: ${provider}`);
  return option;
}

/** #25 の本文：`example` の 2 項目を入れた入れ直し。 */
function resetBody(): object {
  const option = optionOf(EXAMPLE_PROVIDER);
  const result = setCredentialBody(
    credentialInputOf(option),
    option.credentialFields,
    NEW_VALUES,
    '',
  );
  if (!result.ok) throw new Error(`本文を作れない: ${result.message}`);
  return result.body;
}

/* -------------------------------------------------------------------------- */
/* アカウントと DB                                                               */
/* -------------------------------------------------------------------------- */

async function createAccount(
  provider: string,
  fields: {
    readonly credential?: string | null;
    readonly credentials?: Readonly<Record<string, string>>;
    readonly status?: 'connected' | 'disconnected';
  } = {},
): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider,
    displayName: `入れ直しの確認（${provider}）`,
    handle: '@reset_check',
    credential: fields.credential ?? null,
    ...(fields.credentials === undefined ? {} : { credentials: fields.credentials }),
    status: fields.status ?? 'connected',
  });
  return account.id;
}

interface StoredAccount {
  readonly credential: string | null;
  readonly status: string;
}

async function storedAccount(id: string): Promise<StoredAccount> {
  const row = await withConnection((connection) =>
    connection.db
      .selectFrom('social_accounts')
      .select(['credential', 'status'])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`アカウントが無い: ${id}`);
  return row as StoredAccount;
}

/** DB の暗号文を復号した平文（監査を書かない経路）。 */
async function decryptedCredential(id: string): Promise<string | null> {
  const { credential } = await storedAccount(id);
  if (credential === null) return null;
  const result = decryptSecret(credential);
  if (!result.ok) throw new Error(`復号できない: ${result.reason}`);
  return result.secret.expose();
}

async function auditRows(action: string, resourceId: string) {
  return withConnection((connection) =>
    connection.db
      .selectFrom('audit_logs')
      .select(['action', 'resource_type', 'resource_id', 'actor_user_id', 'detail'])
      .where('action', '=', action)
      .where('resource_id', '=', resourceId)
      .execute(),
  );
}

async function countCredentialReads(): Promise<number> {
  const rows = await withConnection((connection) =>
    connection.db
      .selectFrom('audit_logs')
      .select(['id'])
      .where('action', '=', 'credential_read')
      .execute(),
  );
  return rows.length;
}

/* -------------------------------------------------------------------------- */
/* 要求                                                                         */
/* -------------------------------------------------------------------------- */

async function patchWithToken(id: string, body: unknown, token: string): Promise<JsonResult> {
  const response = await PATCH(
    new Request(`${BASE}/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return toResult(response);
}

async function patch(id: string, body: unknown): Promise<JsonResult> {
  return patchWithToken(id, body, writeToken);
}

/** Cookie で送る要求。`csrf` を渡したときだけ `X-CSRF-Token` を付ける。 */
async function patchWithCookies(
  id: string,
  body: unknown,
  cookies: { readonly session?: string; readonly csrfCookie: string; readonly csrf?: string },
): Promise<JsonResult> {
  const cookie = [
    ...(cookies.session === undefined ? [] : [`torifune_session=${cookies.session}`]),
    `torifune_csrf=${cookies.csrfCookie}`,
  ].join('; ');
  const response = await PATCH(
    new Request(`${BASE}/${id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-host': '127.0.0.1:3000',
        origin: ORIGIN,
        cookie,
        ...(cookies.csrf === undefined ? {} : { 'x-csrf-token': cookies.csrf }),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return toResult(response);
}

async function getWithToken(id: string): Promise<JsonResult> {
  const response = await GET(
    new Request(`${BASE}/${id}`, { headers: { authorization: `Bearer ${writeToken}` } }),
    { params: Promise.resolve({ id }) },
  );
  return toResult(response);
}

/* -------------------------------------------------------------------------- */
/* 準備と後始末                                                                 */
/* -------------------------------------------------------------------------- */

beforeAll(async () => {
  scratch = await useScratchDatabase('socialcredreset');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  const created = await createUser(['administrator']);
  admin = created.context;
  adminId = created.id;
  adminLoginId = created.loginId;
  const token = await createApiToken(admin, {
    name: 'credential reset test',
    scopes: ['social.read', 'social.write'],
    expiresAt: null,
  });
  writeToken = token.plaintext;
  await activateExample();
});

afterEach(async () => {
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
    await connection.db.deleteFrom('plugin_store').execute();
    await connection.db.deleteFrom('plugins').execute();
    await connection.db.deleteFrom('login_attempts').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #25 入れ直し（fields）                                                         */
/* -------------------------------------------------------------------------- */

describe('#25 自由文字列の後に、画面の本文（credentials と connected）で入れ直す', () => {
  async function resetFreeText(): Promise<{ id: string; result: JsonResult }> {
    const id = await createAccount(EXAMPLE_PROVIDER, {
      credential: OLD_FREE_TEXT,
      status: 'disconnected',
    });
    const result = await patch(id, resetBody());
    return { id, result };
  }

  it("#25 画面が組む本文は credentials（宣言のキーちょうど）と status: 'connected'", () => {
    // 送る本文そのものの形（設計 §6 の表の 1 行目）。
    expect(credentialInputOf(optionOf(EXAMPLE_PROVIDER))).toBe('fields');
    expect(resetBody()).toStrictEqual({ credentials: { ...NEW_VALUES }, status: 'connected' });
  });

  it('#25 200 を返す', async () => {
    const { result } = await resetFreeText();

    expect(result.status, result.text).toBe(200);
  });

  it('#25 応答の credentialConfigured が true', async () => {
    const { result } = await resetFreeText();

    expect(dataOf(result)['credentialConfigured']).toBe(true);
  });

  it("#25 応答の status が 'connected'", async () => {
    const { result } = await resetFreeText();

    expect(dataOf(result)['status']).toBe('connected');
  });

  it('#25 応答本文に 2 つの値が無い', async () => {
    const { result } = await resetFreeText();

    expect(result.text).not.toContain(NEW_VALUES.handle);
    expect(result.text).not.toContain(NEW_VALUES.appPassword);
  });

  it('#25 DB を復号すると {"handle":…,"appPassword":…} ちょうど', async () => {
    const { id } = await resetFreeText();

    expect(JSON.parse((await decryptedCredential(id)) ?? 'null')).toStrictEqual({
      handle: NEW_VALUES.handle,
      appPassword: NEW_VALUES.appPassword,
    });
  });

  it('#25 保存済みの自由文字列（old-free-text）が残らない（丸ごと置き換わる）', async () => {
    const { id } = await resetFreeText();

    expect(await decryptedCredential(id)).not.toContain(OLD_FREE_TEXT);
  });

  it('#25 入れ直す前の DB には自由文字列が入っている（前提の確認）', async () => {
    const id = await createAccount(EXAMPLE_PROVIDER, { credential: OLD_FREE_TEXT });

    expect(await decryptedCredential(id)).toBe(OLD_FREE_TEXT);
  });
});

/* -------------------------------------------------------------------------- */
/* #26 消す（fields）                                                            */
/* -------------------------------------------------------------------------- */

describe("#26 画面の消去の本文（credentials: {} と status: 'disconnected'）で消す", () => {
  async function clearConfigured(): Promise<{ id: string; result: JsonResult }> {
    const id = await createAccount(EXAMPLE_PROVIDER, { credentials: { ...NEW_VALUES } });
    const result = await patch(id, clearCredentialBody(credentialInputOf(optionOf('example'))));
    return { id, result };
  }

  it('#26 200 を返す', async () => {
    const { result } = await clearConfigured();

    expect(result.status, result.text).toBe(200);
  });

  it('#26 応答の credentialConfigured が false', async () => {
    const { result } = await clearConfigured();

    expect(dataOf(result)['credentialConfigured']).toBe(false);
  });

  it("#26 応答の status が 'disconnected'", async () => {
    const { result } = await clearConfigured();

    expect(dataOf(result)['status']).toBe('disconnected');
  });

  it('#26 DB の credential が NULL', async () => {
    const { id } = await clearConfigured();

    expect((await storedAccount(id)).credential).toBeNull();
  });

  it('#26 消す前の DB には暗号文が入っている（前提の確認）', async () => {
    const id = await createAccount(EXAMPLE_PROVIDER, { credentials: { ...NEW_VALUES } });

    expect((await storedAccount(id)).credential).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* #27 消す（none）                                                              */
/* -------------------------------------------------------------------------- */

describe('#27 credentialFields: [] の publisher の provider で消す（status を送らない）', () => {
  /** `[]` の publisher をテストの中で登録する（`example-plugin` は変えない。設計 §3.2）。 */
  function registerEmptyPublisher(): void {
    registerPublisher('test-empty', { provider: 'x', label: 'X', credentialFields: [] });
  }

  async function clearNone(
    status: 'connected' | 'disconnected',
  ): Promise<{ id: string; input: CredentialInput; result: JsonResult }> {
    registerEmptyPublisher();
    const id = await createAccount('x', { credential: 'stray-value-6a3b', status });
    const input = credentialInputOf(optionOf('x'));
    const result = await patch(id, clearCredentialBody(input));
    return { id, input, result };
  }

  it("#27 x の入力の形は 'none'（前提の確認）", async () => {
    const { input } = await clearNone('connected');

    expect(input).toBe('none');
  });

  it('#27 200 を返し、credentialConfigured が false', async () => {
    const { result } = await clearNone('connected');

    expect(result.status, result.text).toBe(200);
    expect(dataOf(result)['credentialConfigured']).toBe(false);
  });

  it("#27 送る前が 'connected' なら 'connected' のまま", async () => {
    const { id, result } = await clearNone('connected');

    expect(dataOf(result)['status']).toBe('connected');
    expect((await storedAccount(id)).status).toBe('connected');
  });

  it("#27 送る前が 'disconnected' なら 'disconnected' のまま", async () => {
    const { id, result } = await clearNone('disconnected');

    expect(dataOf(result)['status']).toBe('disconnected');
    expect((await storedAccount(id)).status).toBe('disconnected');
  });

  it('#27 DB の credential が NULL', async () => {
    const { id } = await clearNone('connected');

    expect((await storedAccount(id)).credential).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* #28 権限なし                                                                  */
/* -------------------------------------------------------------------------- */

describe('#28 social.read だけの主体では入れ直せない', () => {
  async function readOnlyAttempt(): Promise<{
    id: string;
    before: StoredAccount;
    result: JsonResult;
  }> {
    const id = await createAccount(EXAMPLE_PROVIDER, {
      credential: OLD_FREE_TEXT,
      status: 'disconnected',
    });
    const before = await storedAccount(id);
    const readOnly = await createApiToken(admin, {
      name: 'read only',
      scopes: ['social.read'],
      expiresAt: null,
    });
    const result = await patchWithToken(id, resetBody(), readOnly.plaintext);
    return { id, before, result };
  }

  it('#28 scope が social.read だけの Token では 403', async () => {
    const { result } = await readOnlyAttempt();

    expect(result.status, result.text).toBe(403);
  });

  it('#28 DB の暗号文と status が送る前と同じ', async () => {
    const { id, before } = await readOnlyAttempt();

    expect(await storedAccount(id)).toStrictEqual(before);
  });

  it('#28 同じ本文でも social.write の Token なら 200（403 が本文のせいでないことの対照）', async () => {
    const id = await createAccount(EXAMPLE_PROVIDER, { credential: OLD_FREE_TEXT });

    expect((await patch(id, resetBody())).status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* #29 未認証と CSRF                                                             */
/* -------------------------------------------------------------------------- */

describe('#29 未認証は 401、Cookie セッションで CSRF トークンなしは 403 CSRF_FAILED', () => {
  const CSRF = 'csrf-token-for-credential-reset';

  async function accountWithFreeText(): Promise<{ id: string; before: StoredAccount }> {
    const id = await createAccount(EXAMPLE_PROVIDER, {
      credential: OLD_FREE_TEXT,
      status: 'disconnected',
    });
    return { id, before: await storedAccount(id) };
  }

  it('#29 未認証（CSRF は正しく、セッションが無い）なら 401', async () => {
    const { id } = await accountWithFreeText();

    const result = await patchWithCookies(id, resetBody(), { csrfCookie: CSRF, csrf: CSRF });

    expect(result.status, result.text).toBe(401);
  });

  it('#29 未認証のとき DB が変わらない', async () => {
    const { id, before } = await accountWithFreeText();

    await patchWithCookies(id, resetBody(), { csrfCookie: CSRF, csrf: CSRF });

    expect(await storedAccount(id)).toStrictEqual(before);
  });

  it('#29 本物のセッションの Cookie で CSRF トークンを付けないと 403 CSRF_FAILED', async () => {
    const { id } = await accountWithFreeText();
    const session = await issueSessionToken(adminLoginId);

    const result = await patchWithCookies(id, resetBody(), { session, csrfCookie: CSRF });

    expect(result.status, result.text).toBe(403);
    expect(errorCodeOf(result)).toBe('CSRF_FAILED');
  });

  it('#29 CSRF で断られたとき DB が変わらない', async () => {
    const { id, before } = await accountWithFreeText();
    const session = await issueSessionToken(adminLoginId);

    await patchWithCookies(id, resetBody(), { session, csrfCookie: CSRF });

    expect(await storedAccount(id)).toStrictEqual(before);
  });

  it('#29 同じセッションに CSRF トークンを付ければ 200（403 が認証の失敗でないことの対照）', async () => {
    const { id } = await accountWithFreeText();
    const session = await issueSessionToken(adminLoginId);

    const result = await patchWithCookies(id, resetBody(), {
      session,
      csrfCookie: CSRF,
      csrf: CSRF,
    });

    expect(result.status, result.text).toBe(200);
    expect(dataOf(result)['credentialConfigured']).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #30 無い ID                                                                  */
/* -------------------------------------------------------------------------- */

describe('#30 存在しない ID', () => {
  it('#30 画面の本文を存在しない ID に送ると 404', async () => {
    const result = await patch(uuidv7(), resetBody());

    expect(result.status, result.text).toBe(404);
  });

  it('#30 別のアカウントは変わらない', async () => {
    const id = await createAccount(EXAMPLE_PROVIDER, { credential: OLD_FREE_TEXT });
    const before = await storedAccount(id);

    await patch(uuidv7(), resetBody());

    expect(await storedAccount(id)).toStrictEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* #31 監査                                                                     */
/* -------------------------------------------------------------------------- */

describe('#31 入れ直しの監査', () => {
  async function resetAndAudit() {
    const id = await createAccount(EXAMPLE_PROVIDER, {
      credential: OLD_FREE_TEXT,
      status: 'disconnected',
    });
    const readsBefore = await countCredentialReads();
    const result = await patch(id, resetBody());
    expect(result.status, result.text).toBe(200);
    const readsAfter = await countCredentialReads();
    return { id, rows: await auditRows('updated', id), readsBefore, readsAfter };
  }

  it("#31 action = 'updated' の行がそのアカウントに 1 行", async () => {
    const { rows } = await resetAndAudit();

    expect(rows).toHaveLength(1);
  });

  it("#31 resource_type = 'social_account'、resource_id = アカウント ID", async () => {
    const { id, rows } = await resetAndAudit();

    expect(rows[0]?.resource_type).toBe('social_account');
    expect(rows[0]?.resource_id).toBe(id);
  });

  it('#31 actor_user_id = 操作者', async () => {
    const { rows } = await resetAndAudit();

    expect(rows[0]?.actor_user_id).toBe(adminId);
  });

  it('#31 detail.changed が credentials と status を含む', async () => {
    const { rows } = await resetAndAudit();
    const changed = (rows[0]?.detail as { changed?: unknown } | undefined)?.changed;

    expect(changed).toEqual(expect.arrayContaining(['credentials', 'status']));
  });

  it('#31 detail を文字列にしたものに 2 つの値が現れない', async () => {
    const { rows } = await resetAndAudit();
    const detail = JSON.stringify(rows[0]?.detail ?? null);

    expect(detail).not.toContain(NEW_VALUES.handle);
    expect(detail).not.toContain(NEW_VALUES.appPassword);
  });

  it('#31 同じ操作で credential_read の行が増えない（更新の経路は復号しない）', async () => {
    const { readsBefore, readsAfter } = await resetAndAudit();

    expect(readsAfter - readsBefore).toBe(0);
  });

  it('#31 入れ直しの後の GET も credentialConfigured だけを返し、値を返さない', async () => {
    const { id } = await resetAndAudit();

    const result = await getWithToken(id);

    expect(result.status).toBe(200);
    expect(dataOf(result)['credentialConfigured']).toBe(true);
    expect(result.text).not.toContain(NEW_VALUES.appPassword);
  });
});
