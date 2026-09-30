import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as authorizeRoute } from '@/app/api/v1/auth/authorize/route';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { POST as confirmResetRoute } from '@/app/api/v1/auth/password-reset/confirm/route';
import { POST as requestResetRoute } from '@/app/api/v1/auth/password-reset/request/route';
import { POST as collectRoute } from '@/app/api/v1/collect/route';
import { POST as setupRoute } from '@/app/api/v1/setup/route';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { createSite } from '@/application/site/site-use-cases';
import { withConnection } from '@/application/transaction';
import { hashPassword } from '@/authentication/password';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 認証の要らない口の使えない文字（046-input-500-nul-and-ranges 設計 §6.3、受け入れ条件 #13〜#17）。
 *
 * NUL（U+0000）と対になっていないサロゲート（片割れ）は、どの口でも **422**（401・204・404 にしない）。
 * 判定は入力の文字だけで決まり、利用者の有無・キーの当たり・セットアップの状態を漏らさない。
 *
 * - #13：`POST /auth/login`。存在しない `loginId` と存在する利用者の `loginId` のどちらに NUL を足しても同じ 422 `details.loginId`（応答の本文が同じ）。
 *   `password` の NUL・片割れ → 422 `details.password`。`login_attempts`・`auth_audit_logs` の行が増えず、セッションの Cookie が付かない
 * - #14：`POST /auth/password-reset/request` の `email` → 422、`password_reset_tokens` が増えない。`/confirm` の `token`・`newPassword` → 422
 * - #15：`POST /setup`（利用者が 0 人）の 4 項目 → 422、利用者は 0 人のまま。閉じているときも NUL → 422、NUL が無ければ従来どおり 404
 * - #16：`POST /collect` の `key`・`path`・`referrer` → 422、`access_logs` が増えない。正しい要求は 204 で 1 行増える
 * - #17：`GET /auth/authorize?returnTo=%2Fx%00` → 422 `details.returnTo`
 *
 * ルートを直接叩く。Bearer を付けない POST は CSRF を通すヘッダを付ける（`/collect` は CSRF を見ない）。
 * ルートの Rate Limit に当たらないよう、要求ごとに `X-Forwarded-For` を変える（実装プラン §7 の 8）。
 * **ソースに壊れた文字を置かない。** NUL と片割れはエスケープで書く。
 */

const ORIGIN = 'http://127.0.0.1:3000';
const BASE = `${ORIGIN}/api/v1`;
const CSRF_TOKEN = 'csrf-token-for-nul-public-input';
const PASSWORD = 'nul public input correct horse battery staple';
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const NUL_TEXT = '使用できない文字（NUL）が含まれています。';
const SURROGATE_TEXT = '使用できない文字（対になっていないサロゲート）が含まれています。';

type Variant = 'nul' | 'surrogate';

const VARIANTS: readonly {
  readonly variant: Variant;
  readonly text: string;
  readonly label: string;
}[] = [
  { variant: 'nul', text: NUL_TEXT, label: 'NUL' },
  { variant: 'surrogate', text: SURROGATE_TEXT, label: '片割れ' },
];

function inject(value: string, variant: Variant): string {
  return variant === 'nul' ? `${value}\u0000x` : `${value}\ud800x`;
}

let scratch: ScratchDatabase;
let ipCounter = 0;

/** Rate Limit のキー（IP）を要求ごとに変える。 */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

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

type Route = (request: Request) => Promise<Response>;

async function post(route: Route, path: string, body: unknown, csrf = true): Promise<JsonResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': nextIp(),
    'user-agent': BROWSER,
  };
  if (csrf) {
    headers['x-forwarded-host'] = '127.0.0.1:3000';
    headers['origin'] = ORIGIN;
    headers['x-csrf-token'] = CSRF_TOKEN;
    headers['cookie'] = `torifune_csrf=${CSRF_TOKEN}`;
  }
  const response = await route(
    new Request(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  );
  return resultOf(response);
}

async function resultOf(response: Response): Promise<JsonResult> {
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

async function countOf(table: string): Promise<number> {
  return withConnection(async (connection) => {
    const result = await sql<{
      count: string;
    }>`SELECT count(*) AS count FROM ${sql.table(table)}`.execute(connection.db);
    return Number(result.rows[0]?.count ?? 0);
  });
}

/** セッションの Cookie が付いていないこと。 */
function hasSessionCookie(result: JsonResult): boolean {
  return (result.headers.get('set-cookie') ?? '').includes('torifune_session=');
}

/** 利用者と、利用者に紐づく記録を消す（`/setup` が開く状態にする）。 */
async function clearUsers(): Promise<void> {
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('password_reset_tokens').execute();
    await connection.db.deleteFrom('login_attempts').execute();
    await connection.db.deleteFrom('auth_audit_logs').execute();
    await connection.db.deleteFrom('sessions').execute();
    await connection.db.deleteFrom('user_roles').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
}

/** 管理者を 1 人作る（ログイン・再設定の相手、`/setup` を閉じる）。 */
async function insertAdmin(): Promise<{ readonly loginId: string; readonly email: string }> {
  const id = uuidv7();
  const loginId = `p${id.replaceAll('-', '').slice(-12)}`;
  const email = `${loginId}@example.com`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email,
        display_name: 'nul public input test',
        password_hash: passwordHash,
      })
      .execute();
    const role = await roleRepository.findByName(connection, 'administrator');
    if (role === null) throw new Error('ロールが無い: administrator');
    await connection.db
      .insertInto('user_roles')
      .values({ user_id: id, role_id: role.id })
      .execute();
  });

  return { loginId, email };
}

beforeAll(async () => {
  scratch = await useScratchDatabase('nulpublicinput');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(() => {
  resetEventHandlers();
});

/* -------------------------------------------------------------------------- */
/* #15 /setup（利用者が 0 人のときを先に見る）                                     */
/* -------------------------------------------------------------------------- */

describe('#15 POST /setup の NUL・片割れは 422（開いていても閉じていても）', () => {
  beforeEach(async () => {
    await clearUsers();
  });

  function setupBody(): Record<string, string> {
    return {
      loginId: 'setupadmin',
      displayName: '最初の管理者',
      email: 'setupadmin@example.com',
      password: PASSWORD,
    };
  }

  const FIELDS = ['loginId', 'displayName', 'email', 'password'] as const;
  const MATRIX = FIELDS.flatMap((field) => VARIANTS.map((variant) => ({ field, ...variant })));

  it.each(MATRIX)(
    '#15 利用者が 0 人で $field に $label → 422、details.$field',
    async ({ field, variant, text }) => {
      const body = setupBody();

      const result = await post(setupRoute, '/setup', {
        ...body,
        [field]: inject(body[field] ?? '', variant),
      });

      expect(result.status, result.text).toBe(422);
      expect(detailsOf(result)).toEqual({ [field]: [text] });
    },
  );

  it.each(MATRIX)(
    '#15 利用者が 0 人で $field に $label → 利用者は 0 人のまま',
    async ({ field, variant }) => {
      const body = setupBody();

      await post(setupRoute, '/setup', { ...body, [field]: inject(body[field] ?? '', variant) });

      expect(await countOf('users')).toBe(0);
    },
  );

  it('#15 閉じている（利用者がいる）ときに NUL → 422（404 ではない。状態を漏らさない）', async () => {
    await insertAdmin();

    const result = await post(setupRoute, '/setup', {
      ...setupBody(),
      loginId: 'setup\u0000admin',
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ loginId: [NUL_TEXT] });
  });

  it('#15 閉じているときに NUL が無ければ従来どおり 404', async () => {
    await insertAdmin();

    const result = await post(setupRoute, '/setup', setupBody());

    expect(result.status, result.text).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/* #13 /auth/login                                                              */
/* -------------------------------------------------------------------------- */

describe('#13 POST /auth/login の NUL・片割れは 422（利用者の有無で変わらない）', () => {
  let existing: { readonly loginId: string; readonly email: string };

  beforeEach(async () => {
    await clearUsers();
    existing = await insertAdmin();
  });

  it('#13 存在しない loginId に NUL → 422、details.loginId が NUL の文言', async () => {
    const result = await post(loginRoute, '/auth/login', {
      loginId: 'nobody-here\u0000',
      password: PASSWORD,
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ loginId: [NUL_TEXT] });
  });

  it('#13 存在する利用者の loginId に NUL → 422、details.loginId が NUL の文言', async () => {
    const result = await post(loginRoute, '/auth/login', {
      loginId: `${existing.loginId}\u0000`,
      password: PASSWORD,
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ loginId: [NUL_TEXT] });
  });

  it('#13 存在する・しない loginId の NUL で応答の本文が同じ', async () => {
    const missing = await post(loginRoute, '/auth/login', {
      loginId: 'nobody-here\u0000',
      password: PASSWORD,
    });
    const present = await post(loginRoute, '/auth/login', {
      loginId: `${existing.loginId}\u0000`,
      password: PASSWORD,
    });

    expect(present.status).toBe(missing.status);
    expect(present.text).toBe(missing.text);
  });

  it.each(VARIANTS)('#13 loginId に $label → 422、details.loginId', async ({ variant, text }) => {
    const result = await post(loginRoute, '/auth/login', {
      loginId: inject(existing.loginId, variant),
      password: PASSWORD,
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ loginId: [text] });
  });

  it.each(VARIANTS)('#13 password に $label → 422、details.password', async ({ variant, text }) => {
    const result = await post(loginRoute, '/auth/login', {
      loginId: existing.loginId,
      password: inject(PASSWORD, variant),
    });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ password: [text] });
  });

  const ATTEMPTS = [
    { field: 'loginId', variant: 'nul' as Variant },
    { field: 'loginId', variant: 'surrogate' as Variant },
    { field: 'password', variant: 'nul' as Variant },
    { field: 'password', variant: 'surrogate' as Variant },
  ];

  it.each(ATTEMPTS)(
    '#13 $field に $variant → login_attempts と auth_audit_logs の行が増えない',
    async ({ field, variant }) => {
      const attempts = await countOf('login_attempts');
      const audits = await countOf('auth_audit_logs');

      await post(loginRoute, '/auth/login', {
        loginId: field === 'loginId' ? inject(existing.loginId, variant) : existing.loginId,
        password: field === 'password' ? inject(PASSWORD, variant) : PASSWORD,
      });

      expect(await countOf('login_attempts')).toBe(attempts);
      expect(await countOf('auth_audit_logs')).toBe(audits);
    },
  );

  it.each(ATTEMPTS)(
    '#13 $field に $variant → セッションの Cookie が付かない',
    async ({ field, variant }) => {
      const result = await post(loginRoute, '/auth/login', {
        loginId: field === 'loginId' ? inject(existing.loginId, variant) : existing.loginId,
        password: field === 'password' ? inject(PASSWORD, variant) : PASSWORD,
      });

      expect(hasSessionCookie(result)).toBe(false);
    },
  );

  it('#13 対照：正しい loginId と password → 200 でセッションの Cookie が付く', async () => {
    const result = await post(loginRoute, '/auth/login', {
      loginId: existing.loginId,
      password: PASSWORD,
    });

    expect(result.status, result.text).toBe(200);
    expect(hasSessionCookie(result)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #14 /auth/password-reset                                                     */
/* -------------------------------------------------------------------------- */

describe('#14 POST /auth/password-reset/* の NUL・片割れは 422', () => {
  let existing: { readonly loginId: string; readonly email: string };

  beforeEach(async () => {
    await clearUsers();
    existing = await insertAdmin();
  });

  it.each(VARIANTS)(
    '#14 request の email に $label → 422、details.email',
    async ({ variant, text }) => {
      const result = await post(requestResetRoute, '/auth/password-reset/request', {
        email: inject(existing.email, variant),
      });

      expect(result.status, result.text).toBe(422);
      expect(detailsOf(result)).toEqual({ email: [text] });
    },
  );

  it.each(VARIANTS)(
    '#14 request の email に $label → password_reset_tokens が増えない',
    async ({ variant }) => {
      const before = await countOf('password_reset_tokens');

      await post(requestResetRoute, '/auth/password-reset/request', {
        email: inject(existing.email, variant),
      });

      expect(await countOf('password_reset_tokens')).toBe(before);
    },
  );

  it.each(VARIANTS)(
    '#14 confirm の token に $label → 422、details.token',
    async ({ variant, text }) => {
      const result = await post(confirmResetRoute, '/auth/password-reset/confirm', {
        token: inject('reset-token', variant),
        newPassword: `${PASSWORD} new`,
      });

      expect(result.status, result.text).toBe(422);
      expect(detailsOf(result)).toEqual({ token: [text] });
    },
  );

  it.each(VARIANTS)(
    '#14 confirm の newPassword に $label → 422、details.newPassword',
    async ({ variant, text }) => {
      const result = await post(confirmResetRoute, '/auth/password-reset/confirm', {
        token: 'reset-token',
        newPassword: inject(`${PASSWORD} new`, variant),
      });

      expect(result.status, result.text).toBe(422);
      expect(detailsOf(result)).toEqual({ newPassword: [text] });
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #16 /collect                                                                 */
/* -------------------------------------------------------------------------- */

describe('#16 POST /collect の NUL・片割れは 422 で、何も記録しない', () => {
  let publicKey: string;

  beforeEach(async () => {
    await clearUsers();
    await insertAdmin();
    await withConnection((connection) => connection.db.deleteFrom('access_logs').execute());
    await withConnection((connection) => connection.db.deleteFrom('sites').execute());

    const identity = await withConnection(async (connection) => {
      const row = await connection.db
        .selectFrom('users')
        .select(['id', 'login_id', 'email', 'display_name'])
        .executeTakeFirstOrThrow();
      return authorizationContextFor(connection, {
        userId: row.id,
        loginId: row.login_id,
        displayName: row.display_name,
        email: row.email,
        providerId: 'local',
        externalUserId: null,
      });
    });
    const site = await createSite(identity, {
      name: '計測するサイト',
      url: 'https://collect.example.com',
      description: '',
      status: 'active',
    });
    publicKey = await withConnection(async (connection) => {
      const row = await connection.db
        .selectFrom('sites')
        .select('public_key')
        .where('id', '=', site.id)
        .executeTakeFirstOrThrow();
      return row.public_key;
    });
  });

  function collectBody(): Record<string, string> {
    return { key: publicKey, path: '/landing', referrer: 'https://ref.example.com/page' };
  }

  const FIELDS = ['key', 'path', 'referrer'] as const;
  const MATRIX = FIELDS.flatMap((field) => VARIANTS.map((variant) => ({ field, ...variant })));

  it.each(MATRIX)(
    '#16 $field に $label → 422、details.$field',
    async ({ field, variant, text }) => {
      const body = collectBody();

      const result = await post(
        collectRoute,
        '/collect',
        { ...body, [field]: inject(body[field] ?? '', variant) },
        false,
      );

      expect(result.status, result.text).toBe(422);
      expect(detailsOf(result)).toEqual({ [field]: [text] });
    },
  );

  it.each(MATRIX)('#16 $field に $label → access_logs が増えない', async ({ field, variant }) => {
    const body = collectBody();
    const before = await countOf('access_logs');

    await post(
      collectRoute,
      '/collect',
      { ...body, [field]: inject(body[field] ?? '', variant) },
      false,
    );

    expect(await countOf('access_logs')).toBe(before);
  });

  it('#16 対照：正しい要求は 204 で access_logs が 1 行増える', async () => {
    const before = await countOf('access_logs');

    const result = await post(collectRoute, '/collect', collectBody(), false);

    expect(result.status, result.text).toBe(204);
    expect(await countOf('access_logs')).toBe(before + 1);
  });
});

/* -------------------------------------------------------------------------- */
/* #17 /auth/authorize                                                          */
/* -------------------------------------------------------------------------- */

describe('#17 GET /auth/authorize の returnTo の NUL は 422', () => {
  it('#17 GET /auth/authorize?returnTo=%2Fx%00 → 422、details.returnTo が NUL の文言', async () => {
    const result = await resultOf(
      await authorizeRoute(
        new Request(`${BASE}/auth/authorize?returnTo=%2Fx%00`, {
          method: 'GET',
          headers: { 'x-forwarded-for': nextIp() },
        }),
      ),
    );

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ returnTo: [NUL_TEXT] });
  });
});
