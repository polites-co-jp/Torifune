import type { ManualInput, PublisherRegistration } from '@torifune/plugin-api';
import { sql, type RawBuilder } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as bulkApproveRoute } from '@/app/api/v1/social/posts/bulk/approve/route';
import { GET as getSocialPostRoute } from '@/app/api/v1/social/posts/[id]/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { login } from '@/application/auth/login';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { hashPassword } from '@/authentication/password';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 手動投稿の投稿画面の URL を取る `GET /api/v1/social/posts/{id}/manual-handoff`
 * （057-social-bulk-post 設計 §5.3・§6・§8、受け入れ条件 #43〜#48）。
 *
 * **ルートを直接叩く結合テスト（C）**（`social-post-manual-outcome.integration.test.ts` の準備を写す。import はしない）。
 * 準備（設計 §12.8 の前書き）：`acc`（`manual` を持つ偽物の provider。`manual()` を数え、本文を URL に入れる）・
 * `accAuto`（`publish` だけ）・`accThrow`（`manual()` が例外を投げる）、管理者・閲覧者・ロールの無い利用者
 * （`social.read` が無い）のセッション、API トークン（`social.read`）。
 *
 * * #43 管理者・閲覧者で予約済みの手動投稿（予約時刻の前・後）→ 200 `{ ok: true, url, note }`。`manual()` が呼ばれる
 * * #44 承認待ち・下書き・配信済み・失敗の手動投稿 → 200 `{ ok: false, reason: 'not_scheduled' }`。`manual()` は呼ばれない
 * * #45 自動配信の投稿 → 422（キー `deliveryMode`）。存在しない UUID・UUID の形でない `{id}` → 404
 * * #46 Plugin の無い provider → `unsupported`。`manual()` が例外 → `plugin_error`（例外の文言を応答に載せない）
 * * #47 Bearer（有効なトークンでも）→ 401。セッションも Bearer も無い → 401。`social.read` の無いセッション → 403
 * * #48 承認待ちを `bulk/approve`（`publishTiming: 'now'`）で承認した後は `ok: true`（URL が本文を含む）。承認の前は `not_scheduled`
 *
 * `GET` なので CSRF のヘッダは付けない（設計 §6：`GET` に CSRF は掛からない）。Rate Limit を避けるため要求ごとに
 * `x-forwarded-for` を変える。ルート（`manual-handoff/route.ts`）はまだ無いので、指定子を `string` の定数に置いた動的 import で読む。
 */

const BASE = 'http://127.0.0.1:3000/api/v1/social/posts';
const ORIGIN = 'http://127.0.0.1:3000';
const CSRF = 'csrf-token-for-social-manual-handoff';
const PASSWORD = 'social manual handoff correct horse battery staple';

const MANUAL_PROVIDER = 'mh_manual';
const AUTO_PROVIDER = 'mh_auto';
const THROW_PROVIDER = 'mh_throw';

const HOUR = 60 * 60_000;
const NOTE = '画像は投稿画面で添付してください';
const THROWN_MESSAGE = 'manual() の中の秘密の文言 sk-test-0057';
const NOT_MANUAL_MESSAGE = '手動投稿ではありません。';

const MANUAL_HANDOFF_ROUTE: string = '@/app/api/v1/social/posts/[id]/manual-handoff/route';

let scratch: ScratchDatabase;
let admin: TestUser;
let adminSession: string;
let viewerSession: string;
let noRoleSession: string;
let acc: string;
let accAuto: string;
let accThrow: string;
let readToken: string;
let ipSequence = 0;
/** 偽物の `manual()` が呼ばれた回数と、渡された投稿の ID。 */
let manualCalls: string[] = [];

interface TestUser {
  readonly id: string;
  readonly loginId: string;
  readonly context: AuthorizationContext;
}

interface JsonResult {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

function nextIp(): string {
  ipSequence += 1;
  return `10.57.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
}

function dataOf(result: JsonResult): Record<string, unknown> {
  return (result.body['data'] ?? {}) as Record<string, unknown>;
}

function errorOf(result: JsonResult): {
  readonly code?: string;
  readonly message?: string;
  readonly details?: Record<string, readonly string[]>;
} {
  return (result.body['error'] ?? {}) as {
    readonly code?: string;
    readonly message?: string;
    readonly details?: Record<string, readonly string[]>;
  };
}

async function toResult(response: Response): Promise<JsonResult> {
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function createUser(roleNames: readonly string[]): Promise<TestUser> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `h${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'social manual handoff test',
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
    displayName: 'social manual handoff test',
    email: `${loginId}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
  const context = await withConnection((connection) =>
    authorizationContextFor(connection, identity),
  );
  return { id, loginId, context };
}

async function issueSessionToken(loginId: string): Promise<string> {
  const outcome = await login({
    loginId,
    password: PASSWORD,
    request: { ipAddress: nextIp(), userAgent: 'vitest' },
  });
  if (!outcome.ok) throw new Error(`ログインに失敗した: ${outcome.reason}`);
  return outcome.sessionToken;
}

function manualPublisher(): PublisherRegistration {
  return {
    provider: MANUAL_PROVIDER,
    label: '手動（テスト）',
    credentialFields: [],
    publish: async () => ({ ok: true, externalId: 'e1' }),
    manual: (input: ManualInput) => {
      manualCalls.push(input.post.id);
      return {
        url: `https://example.com/intent/post?text=${encodeURIComponent(input.post.body)}`,
        note: NOTE,
      };
    },
  };
}

function autoPublisher(): PublisherRegistration {
  return {
    provider: AUTO_PROVIDER,
    label: '自動だけ（テスト）',
    credentialFields: [],
    publish: async () => ({ ok: true, externalId: 'e2' }),
  };
}

function throwingPublisher(): PublisherRegistration {
  return {
    provider: THROW_PROVIDER,
    label: '投げる（テスト）',
    credentialFields: [],
    publish: async () => ({ ok: true, externalId: 'e3' }),
    manual: () => {
      throw new Error(THROWN_MESSAGE);
    },
  };
}

type Auth =
  | { readonly kind: 'session'; readonly session: string }
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'none' };

/** 取得の口を呼ぶ（動的に読む。冒頭の注記）。 */
async function callHandoff(
  id: string,
  options: { readonly auth?: Auth } = {},
): Promise<JsonResult> {
  const { GET } = (await import(/* @vite-ignore */ MANUAL_HANDOFF_ROUTE)) as {
    readonly GET: (
      request: Request,
      context: { readonly params: Promise<{ readonly id: string }> },
    ) => Promise<Response>;
  };
  const how: Auth = options.auth ?? { kind: 'session', session: adminSession };
  const headers: Record<string, string> = { 'x-forwarded-for': nextIp() };
  if (how.kind === 'token') {
    headers['authorization'] = `Bearer ${how.token}`;
  }
  if (how.kind === 'session') {
    headers['x-forwarded-host'] = '127.0.0.1:3000';
    headers['cookie'] = `torifune_session=${how.session}`;
  }
  const response = await GET(new Request(`${BASE}/${id}/manual-handoff`, { headers }), {
    params: Promise.resolve({ id }),
  });
  return toResult(response);
}

async function callBulkApprove(body: unknown): Promise<JsonResult> {
  const response = await bulkApproveRoute(
    new Request(`${BASE}/bulk/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': nextIp(),
        'x-forwarded-host': '127.0.0.1:3000',
        origin: ORIGIN,
        cookie: `torifune_session=${adminSession}; torifune_csrf=${CSRF}`,
        'x-csrf-token': CSRF,
      },
      body: JSON.stringify(body),
    }),
  );
  return toResult(response);
}

async function updatedAtOf(id: string): Promise<string> {
  const response = await getSocialPostRoute(
    new Request(`${BASE}/${id}`, {
      headers: { authorization: `Bearer ${readToken}`, 'x-forwarded-for': nextIp() },
    }),
    { params: Promise.resolve({ id }) },
  );
  const data = ((await response.json()) as { data: Record<string, unknown> }).data;
  return String(data['updatedAt']);
}

interface MakeOptions {
  readonly accountId?: string;
  readonly deliveryMode?: 'auto' | 'manual';
  readonly scheduledAt?: Date | null;
  readonly kind?: 'scheduled' | 'awaiting' | 'draft';
  readonly body?: string;
}

/** 既定は「手動・予約時刻を 1 時間過ぎた予約」（手動投稿待ち）。 */
async function makePost(options: MakeOptions = {}): Promise<string> {
  const kind = options.kind ?? 'scheduled';
  const base = {
    socialAccountId: options.accountId ?? acc,
    body: options.body ?? `手動で投稿する本文です。${uuidv7().slice(-6)}`,
    scheduledAt:
      options.scheduledAt === undefined ? new Date(Date.now() - HOUR) : options.scheduledAt,
    deliveryMode: options.deliveryMode ?? 'manual',
  };
  const input =
    kind === 'awaiting'
      ? { ...base, publishTiming: 'after_approval' as const }
      : { ...base, status: kind };
  const { post } = await createSocialPost(admin.context, input);
  return post.id;
}

async function rewrite(id: string, set: RawBuilder<unknown>): Promise<void> {
  await withConnection(async (connection) => {
    await sql`UPDATE social_posts SET ${set} WHERE id = ${id}`.execute(connection.db);
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialmanualhandoff');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  manualCalls = [];
  admin = await createUser(['administrator']);
  adminSession = await issueSessionToken(admin.loginId);
  viewerSession = await issueSessionToken((await createUser(['viewer'])).loginId);
  noRoleSession = await issueSessionToken((await createUser([])).loginId);
  registerPublisher('test-plugin', manualPublisher());
  registerPublisher('test-plugin', autoPublisher());
  registerPublisher('test-plugin', throwingPublisher());
  const account = async (provider: string, handle: string): Promise<string> =>
    (
      await createSocialAccount(admin.context, {
        provider,
        displayName: handle,
        handle,
        credential: null,
        status: 'connected',
      })
    ).id;
  acc = await account(MANUAL_PROVIDER, '@manual');
  accAuto = await account(AUTO_PROVIDER, '@auto');
  accThrow = await account(THROW_PROVIDER, '@throw');
  readToken = (
    await createApiToken(admin.context, {
      name: `t-${uuidv7().slice(-8)}`,
      scopes: ['social.read'],
      expiresAt: null,
    })
  ).plaintext;
});

afterEach(async () => {
  resetPublisherRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('login_attempts').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

// ---------------------------------------------------------------------------
// #43 予約済みの手動投稿
// ---------------------------------------------------------------------------

describe('#43 予約済みの手動投稿は URL を返す', () => {
  it.each([
    ['予約時刻の後', -HOUR],
    ['予約時刻の前', HOUR],
  ] as const)('#43 管理者・%s：200 { data: { ok: true, url, note } }', async (_label, offset) => {
    const id = await makePost({ scheduledAt: new Date(Date.now() + offset) });

    const result = await callHandoff(id);

    expect(result.status).toBe(200);
    expect(dataOf(result)['ok']).toBe(true);
    expect(String(dataOf(result)['url'])).toMatch(/^https:\/\/example\.com\/intent\/post\?text=/);
    expect(dataOf(result)['note']).toBe(NOTE);
  });

  it('#43 閲覧者（social.read）でも 200 { ok: true }', async () => {
    const id = await makePost();

    const result = await callHandoff(id, { auth: { kind: 'session', session: viewerSession } });

    expect(result.status).toBe(200);
    expect(dataOf(result)['ok']).toBe(true);
  });

  it('#43 偽物の manual() がその投稿で 1 回呼ばれる', async () => {
    const id = await makePost();

    await callHandoff(id);

    expect(manualCalls).toEqual([id]);
  });

  it('#43 note の無い Plugin では note が null', async () => {
    resetPublisherRegistry();
    registerPublisher('test-plugin', {
      ...manualPublisher(),
      manual: () => ({ url: 'https://example.com/intent/post?text=x' }),
    });
    const id = await makePost();

    const result = await callHandoff(id);

    expect(dataOf(result)).toEqual({
      ok: true,
      url: 'https://example.com/intent/post?text=x',
      note: null,
    });
  });

  it('#43 応答の data は ok・url・note だけ（資格情報・changed を返さない）', async () => {
    const id = await makePost();

    expect(Object.keys(dataOf(await callHandoff(id))).sort()).toEqual(['note', 'ok', 'url']);
  });
});

// ---------------------------------------------------------------------------
// #44 予約でない手動投稿
// ---------------------------------------------------------------------------

describe('#44 予約でない手動投稿は not_scheduled', () => {
  const cases: readonly [string, () => Promise<string>][] = [
    ['承認待ち', () => makePost({ kind: 'awaiting', scheduledAt: new Date(Date.now() + HOUR) })],
    ['下書き', () => makePost({ kind: 'draft', scheduledAt: null })],
    [
      '配信済み',
      async () => {
        const id = await makePost();
        await rewrite(id, sql`status = 'published', published_at = now()`);
        return id;
      },
    ],
    [
      '失敗',
      async () => {
        const id = await makePost();
        await rewrite(
          id,
          sql`status = 'failed', failed_at = now(), failure_reason = '配信に失敗しました'`,
        );
        return id;
      },
    ],
  ];

  it.each(cases)(
    '#44 %s：200 { data: { ok: false, reason: not_scheduled } }',
    async (_label, make) => {
      const id = await make();

      const result = await callHandoff(id);

      expect(result.status).toBe(200);
      expect(dataOf(result)).toEqual({ ok: false, reason: 'not_scheduled' });
    },
  );

  it.each(cases)('#44 %s：manual() は呼ばれない', async (_label, make) => {
    const id = await make();

    await callHandoff(id);

    expect(manualCalls).toEqual([]);
  });

  it('#44 承認待ちの応答に URL の手がかり（本文を含む url）を載せない', async () => {
    const body = `承認待ちの本文の印 ${uuidv7().slice(-6)}`;
    const id = await makePost({ kind: 'awaiting', body, scheduledAt: new Date(Date.now() + HOUR) });

    const result = await callHandoff(id);

    expect(result.text).not.toContain(encodeURIComponent(body));
    expect(Object.keys(dataOf(result)).sort()).toEqual(['ok', 'reason']);
  });
});

// ---------------------------------------------------------------------------
// #45 自動・無い ID
// ---------------------------------------------------------------------------

describe('#45 自動配信の投稿と無い ID', () => {
  it('#45 自動配信の投稿 → 422（キー deliveryMode）', async () => {
    const id = await makePost({
      accountId: accAuto,
      deliveryMode: 'auto',
      scheduledAt: new Date(Date.now() + HOUR),
    });

    const result = await callHandoff(id);

    expect(result.status).toBe(422);
    expect(Object.keys(errorOf(result).details ?? {})).toEqual(['deliveryMode']);
    expect(errorOf(result).details?.['deliveryMode']).toContain(NOT_MANUAL_MESSAGE);
  });

  it('#45 自動配信の投稿では manual() を呼ばない', async () => {
    const id = await makePost({
      accountId: accAuto,
      deliveryMode: 'auto',
      scheduledAt: new Date(Date.now() + HOUR),
    });

    await callHandoff(id);

    expect(manualCalls).toEqual([]);
  });

  it('#45 存在しない UUID → 404', async () => {
    const result = await callHandoff(uuidv7());

    expect(result.status).toBe(404);
    expect(errorOf(result).code).toBe('NOT_FOUND');
  });

  it.each(['not-a-uuid', '123', '01900000-0000-7000-8000'])(
    '#45 UUID の形でない {id}（%s）→ 404',
    async (id) => {
      expect((await callHandoff(id)).status).toBe(404);
    },
  );
});

// ---------------------------------------------------------------------------
// #46 Plugin の無い provider・manual() の例外
// ---------------------------------------------------------------------------

describe('#46 Plugin が無い・manual() が投げる', () => {
  it('#46 Plugin の無い provider → 200 { ok: false, reason: unsupported }', async () => {
    const id = await makePost();
    // 投稿を作った後に Plugin が外れた（無効化・削除）場面。自動の provider だけを登録し直す。
    resetPublisherRegistry();
    registerPublisher('test-plugin', autoPublisher());

    const result = await callHandoff(id);

    expect(result.status).toBe(200);
    expect(dataOf(result)).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('#46 manual() が例外を投げる → 200 { ok: false, reason: plugin_error }', async () => {
    const id = await makePost({ accountId: accThrow });

    const result = await callHandoff(id);

    expect(result.status).toBe(200);
    expect(dataOf(result)).toEqual({ ok: false, reason: 'plugin_error' });
  });

  it('#46 例外の文言を応答に載せない', async () => {
    const id = await makePost({ accountId: accThrow });

    const result = await callHandoff(id);

    expect(result.text).not.toContain(THROWN_MESSAGE);
    expect(result.text).not.toContain('sk-test-0057');
  });
});

// ---------------------------------------------------------------------------
// #47 認証・Permission
// ---------------------------------------------------------------------------

describe('#47 認証と Permission', () => {
  it('#47 有効な API トークン（Bearer・social.read）→ 401 UNAUTHENTICATED', async () => {
    const id = await makePost();

    const result = await callHandoff(id, { auth: { kind: 'token', token: readToken } });

    expect(result.status).toBe(401);
    expect(errorOf(result).code).toBe('UNAUTHENTICATED');
  });

  it('#47 Bearer では manual() を呼ばない', async () => {
    const id = await makePost();

    await callHandoff(id, { auth: { kind: 'token', token: readToken } });

    expect(manualCalls).toEqual([]);
  });

  it('#47 セッションも Bearer も無い → 401', async () => {
    const id = await makePost();

    expect((await callHandoff(id, { auth: { kind: 'none' } })).status).toBe(401);
  });

  it('#47 social.read の無いセッション → 403', async () => {
    const id = await makePost();

    const result = await callHandoff(id, { auth: { kind: 'session', session: noRoleSession } });

    expect(result.status).toBe(403);
    expect(manualCalls).toEqual([]);
  });

  it('#47 対照：同じ投稿を管理者のセッションなら 200', async () => {
    const id = await makePost();

    expect((await callHandoff(id)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// #48 一括承認の後
// ---------------------------------------------------------------------------

describe('#48 承認待ちの手動投稿を一括承認した後', () => {
  it('#48 承認の前は not_scheduled、bulk/approve（now）の後は ok: true で URL が本文を含む', async () => {
    const body = `承認して投稿する本文 ${uuidv7().slice(-6)}`;
    const id = await makePost({ kind: 'awaiting', body, scheduledAt: new Date(Date.now() + HOUR) });

    expect(dataOf(await callHandoff(id))).toEqual({ ok: false, reason: 'not_scheduled' });

    const approved = await callBulkApprove({
      publishTiming: 'now',
      items: [{ id, expectedUpdatedAt: await updatedAtOf(id) }],
    });
    expect(approved.status, approved.text).toBe(200);

    const result = await callHandoff(id);

    expect(result.status).toBe(200);
    expect(dataOf(result)['ok']).toBe(true);
    expect(String(dataOf(result)['url'])).toContain(encodeURIComponent(body));
    expect(manualCalls).toEqual([id]);
  });
});
