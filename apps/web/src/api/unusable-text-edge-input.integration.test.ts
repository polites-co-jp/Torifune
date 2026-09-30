import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GET as authorizeRoute } from '@/app/api/v1/auth/authorize/route';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { POST as collectRoute } from '@/app/api/v1/collect/route';
import { GET as listSitesRoute, POST as createSiteRoute } from '@/app/api/v1/sites/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * HTTP の使えない文字の検査（L1）の、検証で見つかった取りこぼし（046 実装プラン §8「検証の指摘への処置（2026-09-25）」）。
 *
 * - **M1**：`Object.prototype` の名前（`__proto__`・`constructor`・`toString`・`valueOf`・`hasOwnProperty`）の項目に
 *   NUL・片割れがあっても 500 にならず、**その名前をキーにした 422** になる。認証の要らない口（`/auth/login`・`/collect`・
 *   `/auth/authorize` のクエリ）と、認証のある口（`/sites`）で確かめる。
 *   `JSON.parse` は `"__proto__"` を自分のプロパティとして作るので、本文は**JSON の文字列をそのまま**送る。
 *   クエリに片割れは載らない（パーセント符号化の不正なバイトは U+FFFD になる。設計 §6.2）ので、クエリは NUL だけ
 * - **M2**：10,000 段の入れ子（約 10〜50KB）を送っても 500 にならない。底に NUL があれば 422（NUL の文言）、無ければ従来どおりの
 *   Zod の 422（型の誤り）
 * - **security L2**：422 の `details` のキーは**先頭の 50 個まで**（設計 §6.2 の規則 3 の追記）。応答の大きさを送った項目の数で膨らませない
 * - **N1**（2 回目の検証）：本文の `csrfToken` が文字列でなければ CSRF の失敗（403 `CSRF_FAILED`）。文字列にしようとして
 *   `TypeError`（`{"toString":1}`）・`RangeError`（1 万段の配列）で 500 にならない。Bearer の無い `/auth/login` と `POST /sites` で確かめる
 *
 * **ソースに壊れた文字を置かない。** 本文の NUL・片割れは JSON のエスケープ（`\u0000`・`\ud800` の 6 文字）で書く。
 */

const ORIGIN = 'http://127.0.0.1:3000';
const BASE = `${ORIGIN}/api/v1`;
const CSRF_TOKEN = 'csrf-token-for-unusable-text-edge';
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const NUL_TEXT = '使用できない文字（NUL）が含まれています。';
const SURROGATE_TEXT = '使用できない文字（対になっていないサロゲート）が含まれています。';

/** 設計 §6.2 の規則 3 の追記（検証の指摘 security L2）。 */
const MAX_DETAIL_KEYS = 50;
const DEPTH = 10_000;

const PROTOTYPE_NAMES = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];

const VARIANTS = [
  { label: 'NUL', escaped: '\\u0000', text: NUL_TEXT },
  { label: '片割れ', escaped: '\\ud800', text: SURROGATE_TEXT },
] as const;

let scratch: ScratchDatabase;
let siteToken: string;
let ipCounter = 0;

/** Rate Limit のキー（IP）を要求ごとに変える。 */
function nextIp(): string {
  ipCounter += 1;
  return `198.18.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

interface JsonResult {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

interface ErrorPart {
  readonly code?: string;
  readonly details?: Record<string, readonly string[]>;
}

function errorOf(result: JsonResult): ErrorPart {
  return (result.body['error'] ?? {}) as ErrorPart;
}

/** `details` の自分のプロパティ（原型の名前と区別するため `Object.entries` で見る）。 */
function detailEntries(result: JsonResult): [string, readonly string[]][] {
  return Object.entries(errorOf(result).details ?? {});
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

type Route = (request: Request) => Promise<Response>;

/** `csrf-body` は同一オリジンと Cookie だけ付け、トークンを `x-csrf-token` ヘッダで送らない（本文の `csrfToken` で送る経路）。 */
type Auth = 'csrf' | 'csrf-body' | 'none' | 'bearer';

function headersFor(auth: Auth, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'x-forwarded-for': nextIp(),
    'user-agent': BROWSER,
  };
  if (hasBody) {
    headers['content-type'] = 'application/json';
  }
  if (auth === 'csrf' || auth === 'csrf-body') {
    headers['x-forwarded-host'] = '127.0.0.1:3000';
    headers['origin'] = ORIGIN;
    headers['cookie'] = `torifune_csrf=${CSRF_TOKEN}`;
  }
  if (auth === 'csrf') {
    headers['x-csrf-token'] = CSRF_TOKEN;
  }
  if (auth === 'bearer') {
    headers['authorization'] = `Bearer ${siteToken}`;
  }
  return headers;
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
  return { status: response.status, text, body };
}

/** JSON の文字列をそのまま本文にして送る。 */
async function postRaw(
  route: Route,
  path: string,
  rawJson: string,
  auth: Auth,
): Promise<JsonResult> {
  const response = await route(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: headersFor(auth, true),
      body: rawJson,
    }),
  );
  return resultOf(response);
}

async function get(route: Route, pathWithQuery: string, auth: Auth): Promise<JsonResult> {
  const response = await route(
    new Request(`${BASE}${pathWithQuery}`, { method: 'GET', headers: headersFor(auth, false) }),
  );
  return resultOf(response);
}

async function adminContext(): Promise<AuthorizationContext> {
  const id = uuidv7();
  const loginId = `u${id.replaceAll('-', '').slice(-12)}`;
  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'edge input',
      })
      .execute();
    const role = await roleRepository.findByName(connection, 'administrator');
    if (role === null) throw new Error('ロールが無い: administrator');
    await connection.db
      .insertInto('user_roles')
      .values({ user_id: id, role_id: role.id })
      .execute();
  });
  const identity: UserIdentity = {
    userId: id,
    loginId,
    displayName: 'edge input',
    email: `${loginId}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** 本文を送る口（`/auth/login`・`/collect` は認証が要らない。`/sites` は Token）。 */
const BODY_ROUTES: readonly {
  readonly name: string;
  readonly route: Route;
  readonly path: string;
  readonly auth: Auth;
}[] = [
  { name: 'POST /auth/login', route: loginRoute, path: '/auth/login', auth: 'csrf' },
  { name: 'POST /collect', route: collectRoute, path: '/collect', auth: 'none' },
  { name: 'POST /sites', route: createSiteRoute, path: '/sites', auth: 'bearer' },
];

/** クエリを宣言した口（`/auth/authorize` は認証が要らない。`/sites` は Token）。 */
const QUERY_ROUTES: readonly {
  readonly name: string;
  readonly route: Route;
  readonly path: string;
  readonly auth: Auth;
}[] = [
  { name: 'GET /auth/authorize', route: authorizeRoute, path: '/auth/authorize', auth: 'none' },
  { name: 'GET /sites', route: listSitesRoute, path: '/sites', auth: 'bearer' },
];

beforeAll(async () => {
  scratch = await useScratchDatabase('unusabletextedge');
  const admin = await adminContext();
  const created = await createApiToken(admin, {
    name: 'edge-input',
    scopes: ['site.read', 'site.write'],
    expiresAt: null,
  });
  siteToken = created.plaintext;
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(() => {
  resetLogger();
  resetEventHandlers();
});

/* -------------------------------------------------------------------------- */
/* M1 原型の名前の項目                                                           */
/* -------------------------------------------------------------------------- */

const BODY_KEY_MATRIX = BODY_ROUTES.flatMap((route) =>
  PROTOTYPE_NAMES.flatMap((key) => VARIANTS.map((variant) => ({ ...route, key, ...variant }))),
);

describe('M1 本文の項目名が原型の名前でも 500 にならず、その名前をキーにした 422', () => {
  it.each(BODY_KEY_MATRIX)('M1 $name の $key に $label → 422', async (entry) => {
    const result = await postRaw(
      entry.route,
      entry.path,
      `{"${entry.key}":"v${entry.escaped}x"}`,
      entry.auth,
    );

    expect(result.status, result.text).toBe(422);
    expect(errorOf(result).code).toBe('VALIDATION_ERROR');
  });

  it.each(BODY_KEY_MATRIX)(
    'M1 $name の $key に $label → details がその名前 1 つだけ',
    async (entry) => {
      const result = await postRaw(
        entry.route,
        entry.path,
        `{"${entry.key}":"v${entry.escaped}x"}`,
        entry.auth,
      );

      expect(detailEntries(result)).toEqual([[entry.key, [entry.text]]]);
    },
  );

  it.each(BODY_KEY_MATRIX)(
    'M1 $name の $key に $label → unhandled error in route のログが出ない',
    async (entry) => {
      const { records } = capture();

      await postRaw(entry.route, entry.path, `{"${entry.key}":"v${entry.escaped}x"}`, entry.auth);

      expect(records.map((record) => record.message)).not.toContain('unhandled error in route');
    },
  );

  it('M1 対照：原型の名前の項目に使えない文字が無ければ従来どおり（POST /collect は Zod の 422 で key を返す）', async () => {
    const result = await postRaw(collectRoute, '/collect', '{"constructor":"v"}', 'none');

    expect(result.status, result.text).toBe(422);
    expect(detailEntries(result).map(([key]) => key)).toContain('key');
  });
});

const QUERY_KEY_MATRIX = QUERY_ROUTES.flatMap((route) =>
  PROTOTYPE_NAMES.map((key) => ({ ...route, key })),
);

describe('M1 クエリの名前が原型の名前でも 500 にならず、その名前をキーにした 422', () => {
  it.each(QUERY_KEY_MATRIX)(
    'M1 $name?$key=%00 → 422、details がその名前 1 つだけ',
    async (entry) => {
      const result = await get(entry.route, `${entry.path}?${entry.key}=v%00x`, entry.auth);

      expect(result.status, result.text).toBe(422);
      expect(detailEntries(result)).toEqual([[entry.key, [NUL_TEXT]]]);
    },
  );

  it.each(QUERY_KEY_MATRIX)(
    'M1 $name?$key=%00 → unhandled error in route のログが出ない',
    async (entry) => {
      const { records } = capture();

      await get(entry.route, `${entry.path}?${entry.key}=v%00x`, entry.auth);

      expect(records.map((record) => record.message)).not.toContain('unhandled error in route');
    },
  );
});

/* -------------------------------------------------------------------------- */
/* M2 深い入れ子                                                                */
/* -------------------------------------------------------------------------- */

function nestedArrays(leafJson: string): string {
  return `${'['.repeat(DEPTH)}${leafJson}${']'.repeat(DEPTH)}`;
}

function nestedObjects(leafJson: string): string {
  return `${'{"a":'.repeat(DEPTH)}${leafJson}${'}'.repeat(DEPTH)}`;
}

const NESTINGS = [
  { shape: '配列', nest: nestedArrays },
  { shape: 'オブジェクト', nest: nestedObjects },
] as const;

/** 深い入れ子を置く項目（その口の文字列の項目）。 */
const DEEP_ROUTES = [
  { ...BODY_ROUTES[0]!, field: 'loginId', rest: ',"password":"x"' },
  { ...BODY_ROUTES[1]!, field: 'key', rest: ',"path":"/"' },
  { ...BODY_ROUTES[2]!, field: 'name', rest: ',"url":"https://example.com"' },
];

const DEEP_MATRIX = DEEP_ROUTES.flatMap((route) =>
  NESTINGS.map((nesting) => ({ ...route, ...nesting })),
);

describe('M2 10,000 段の入れ子でも 500 にならない', () => {
  it.each(DEEP_MATRIX)(
    'M2 $name の $field に 10,000 段の$shape、底に NUL → 422、details が NUL の文言',
    async (entry) => {
      const raw = `{"${entry.field}":${entry.nest('"v\\u0000x"')}${entry.rest}}`;

      const result = await postRaw(entry.route, entry.path, raw, entry.auth);

      expect(result.status, result.text).toBe(422);
      expect(detailEntries(result)).toEqual([[entry.field, [NUL_TEXT]]]);
    },
  );

  it.each(DEEP_MATRIX)(
    'M2 $name の $field に 10,000 段の$shape、使えない文字なし → 従来どおり Zod の 422（型の誤り）',
    async (entry) => {
      const raw = `{"${entry.field}":${entry.nest('"v"')}${entry.rest}}`;

      const result = await postRaw(entry.route, entry.path, raw, entry.auth);

      expect(result.status, result.text).toBe(422);
      const details = Object.fromEntries(detailEntries(result));
      expect(Object.keys(details)).toContain(entry.field);
      expect(details[entry.field]).not.toContain(NUL_TEXT);
    },
  );

  it.each(DEEP_MATRIX)(
    'M2 $name の $field に 10,000 段の$shape → unhandled error in route のログが出ない',
    async (entry) => {
      const { records } = capture();

      await postRaw(
        entry.route,
        entry.path,
        `{"${entry.field}":${entry.nest('"v\\ud800x"')}${entry.rest}}`,
        entry.auth,
      );

      expect(records.map((record) => record.message)).not.toContain('unhandled error in route');
    },
  );
});

/* -------------------------------------------------------------------------- */
/* security L2 details のキーは先頭の 50 個まで                                    */
/* -------------------------------------------------------------------------- */

/** `f00`〜`f(n-1)`。数字だけの名前はオブジェクトのキーの順が変わるので使わない。 */
function fieldNames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `f${String(index).padStart(2, '0')}`);
}

function bodyWithNul(names: readonly string[]): string {
  return `{${names.map((name) => `"${name}":"v\\u0000"`).join(',')}}`;
}

describe('security L2 422 の details のキーは先頭の 50 個まで', () => {
  it('L2 本文の 60 項目に NUL → details は本文の順で先頭の 50 項目', async () => {
    const names = fieldNames(60);

    const result = await postRaw(collectRoute, '/collect', bodyWithNul(names), 'none');

    expect(result.status, result.text).toBe(422);
    expect(detailEntries(result).map(([key]) => key)).toEqual(names.slice(0, MAX_DETAIL_KEYS));
  });

  it('L2 本文の 60 項目に NUL → 各キーの文言は NUL の文言', async () => {
    const result = await postRaw(collectRoute, '/collect', bodyWithNul(fieldNames(60)), 'none');

    for (const [, messages] of detailEntries(result)) {
      expect(messages).toEqual([NUL_TEXT]);
    }
  });

  it('L2 境目：ちょうど 50 項目 → 50 項目すべて', async () => {
    const names = fieldNames(MAX_DETAIL_KEYS);

    const result = await postRaw(collectRoute, '/collect', bodyWithNul(names), 'none');

    expect(detailEntries(result).map(([key]) => key)).toEqual(names);
  });

  it('L2 クエリの 60 個に NUL → details は先頭の 50 個', async () => {
    const names = fieldNames(60);
    const query = names.map((name) => `${name}=v%00`).join('&');

    const result = await get(authorizeRoute, `/auth/authorize?${query}`, 'none');

    expect(result.status, result.text).toBe(422);
    expect(detailEntries(result).map(([key]) => key)).toEqual(names.slice(0, MAX_DETAIL_KEYS));
  });
});

/* -------------------------------------------------------------------------- */
/* N1 本文の csrfToken が文字列でない                                            */
/* -------------------------------------------------------------------------- */

/**
 * 本文の `csrfToken` の値（JSON の文字列のまま）。どれも文字列ではないので CSRF の失敗になる。
 * `["<トークン>"]` は文字列にすると Cookie のトークンと同じになるが、文字列ではないので通さない。
 */
const NON_STRING_TOKENS: readonly { readonly label: string; readonly raw: string }[] = [
  { label: 'toString が関数でないオブジェクト', raw: '{"toString":1}' },
  { label: 'valueOf と toString が関数でないオブジェクト', raw: '{"toString":1,"valueOf":1}' },
  { label: '空のオブジェクト', raw: '{}' },
  { label: '1 万段の配列', raw: `${'['.repeat(DEPTH)}${']'.repeat(DEPTH)}` },
  { label: '1 万段のオブジェクト', raw: `${'{"a":'.repeat(DEPTH)}1${'}'.repeat(DEPTH)}` },
  { label: 'トークンを 1 つ入れた配列', raw: `["${CSRF_TOKEN}"]` },
  { label: '数値', raw: '123' },
  { label: '真偽値', raw: 'true' },
  { label: 'null', raw: 'null' },
];

/** Bearer の無い、CSRF を検証する口。 */
const CSRF_ROUTES: readonly {
  readonly name: string;
  readonly route: Route;
  readonly path: string;
}[] = [
  { name: 'POST /auth/login', route: loginRoute, path: '/auth/login' },
  { name: 'POST /sites', route: createSiteRoute, path: '/sites' },
];

const CSRF_MATRIX = CSRF_ROUTES.flatMap((route) =>
  NON_STRING_TOKENS.map((token) => ({ ...route, ...token })),
);

function bodyWithToken(rawToken: string): string {
  return `{"loginId":"n1-user","password":"n1-password","name":"N1","url":"https://n1.example.com","csrfToken":${rawToken}}`;
}

describe('N1 本文の csrfToken が文字列でなければ CSRF の失敗（403）で、500 にならない', () => {
  it.each(CSRF_MATRIX)('N1 $name の csrfToken が$label → 403 CSRF_FAILED', async (entry) => {
    const result = await postRaw(entry.route, entry.path, bodyWithToken(entry.raw), 'csrf-body');

    expect(result.status, result.text).toBe(403);
    expect(errorOf(result).code).toBe('CSRF_FAILED');
  });

  it.each(CSRF_MATRIX)('N1 $name の csrfToken が$label → エラーのログが出ない', async (entry) => {
    const { records } = capture();

    await postRaw(entry.route, entry.path, bodyWithToken(entry.raw), 'csrf-body');

    expect(records.map((record) => record.message)).not.toContain('unhandled error in route');
    expect(records.filter((record) => record.level === 'error')).toEqual([]);
  });

  it.each(CSRF_MATRIX)(
    'N1 $name の csrfToken が$label → x-csrf-token ヘッダが正しくても 403 CSRF_FAILED',
    async (entry) => {
      const result = await postRaw(entry.route, entry.path, bodyWithToken(entry.raw), 'csrf');

      expect(result.status, result.text).toBe(403);
      expect(errorOf(result).code).toBe('CSRF_FAILED');
    },
  );

  it('N1 対照：本文の csrfToken が Cookie と同じ文字列なら CSRF を通る（403 にならない）', async () => {
    const result = await postRaw(
      loginRoute,
      '/auth/login',
      bodyWithToken(`"${CSRF_TOKEN}"`),
      'csrf-body',
    );

    expect(result.status, result.text).not.toBe(403);
    expect(result.status, result.text).not.toBe(500);
  });

  it('N1 対照：本文の csrfToken が Cookie と違う文字列なら 403 CSRF_FAILED（従来どおり）', async () => {
    const result = await postRaw(
      loginRoute,
      '/auth/login',
      bodyWithToken('"other-token"'),
      'csrf-body',
    );

    expect(result.status, result.text).toBe(403);
    expect(errorOf(result).code).toBe('CSRF_FAILED');
  });
});
