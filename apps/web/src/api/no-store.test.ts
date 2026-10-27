import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as healthRoute } from '@/app/api/health/route';
import { GET as trackingScriptRoute } from '@/app/t.js/route';
import { defineRoute } from './route';

/**
 * API の応答の `Cache-Control: no-store`（058-api-no-store 設計 §5、受け入れ条件 #1〜#10）。
 *
 * - #1〜#6（A）：`defineRoute` の **DB に届く前に返る出口**（Rate Limit の 429・CSRF の 403・`sessionOnly` の 401）にも
 *   `no-store` が付き、同じ応答に載る他のヘッダ（`Retry-After`・CORS・非推奨の告知）は今のまま残る
 * - #7〜#10（A）：`defineRoute` を通らないルート（`/t.js`・`/api/v1/openapi.json`・`/api/health`）は**今のまま**（設計 §5.5）
 *
 * 「`no-store` が付く」は `cache-control` が `'no-store'` **ちょうど**（他の指示が混ざらない。設計 §10 の冒頭）。
 * 値は実装の定数を import せず、文字列で比べる（実装プラン §8 の 1）。
 *
 * どの件も DB に触れない。テスト用のルートは CSRF トークンを付けない POST などで、認可の文脈を作る前に返す
 * （`deprecation.test.ts` の「エラー応答にもヘッダが付く」の形）。
 */

const API = 'https://example.com/api/v1';

let sequence = 0;

/** Rate Limit の状態はルートの定義ごとに持つので、operationId を件ごとに分ける（実装プラン §7 の 4）。 */
function uniqueOperationId(label: string): string {
  sequence += 1;
  return `noStore${label}${sequence}${Math.random().toString(36).slice(2, 8)}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('defineRoute の DB に届く前の出口（§10.1）', () => {
  /** #1 */
  it('#1 Rate Limit を超えた要求の 429 に no-store が付き、Retry-After は今のまま', async () => {
    const handle = defineRoute({
      operationId: uniqueOperationId('RateLimit'),
      method: 'POST',
      path: '/__test/no-store/rate-limit',
      summary: '検証用',
      permission: null,
      reason: '検証用のルート。認可の判断をしない',
      documented: false,
      rateLimit: { windowMs: 60_000, max: 1 },
      handler: async () => new Response(null, { status: 200 }),
    });
    const request = (): Request =>
      new Request(`${API}/__test/no-store/rate-limit`, {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.58' },
      });

    // 1 回目は CSRF の 403（Rate Limit の枠を 1 つ使う）。2 回目が 429。
    await handle(request());
    const response = await handle(request());

    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  /** #2 */
  it('#2 CSRF トークンの無い POST の 403（CSRF_FAILED）に no-store が付く', async () => {
    const handle = defineRoute({
      operationId: uniqueOperationId('CsrfMissing'),
      method: 'POST',
      path: '/__test/no-store/csrf',
      summary: '検証用',
      permission: null,
      reason: '検証用のルート。認可の判断をしない',
      documented: false,
      handler: async () => new Response(null, { status: 200 }),
    });

    const response = await handle(new Request(`${API}/__test/no-store/csrf`, { method: 'POST' }));

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('CSRF_FAILED');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #3 */
  it('#3 本文の csrfToken が文字列でない POST の 403 に no-store が付く', async () => {
    const handle = defineRoute({
      operationId: uniqueOperationId('CsrfNotString'),
      method: 'POST',
      path: '/__test/no-store/csrf-type',
      summary: '検証用',
      permission: null,
      reason: '検証用のルート。認可の判断をしない',
      documented: false,
      handler: async () => new Response(null, { status: 200 }),
    });

    const response = await handle(
      new Request(`${API}/__test/no-store/csrf-type`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csrfToken: 1 }),
      }),
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('CSRF_FAILED');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #4 */
  it('#4 sessionOnly のルートを Bearer で叩いた 401 に no-store が付く', async () => {
    const handle = defineRoute({
      operationId: uniqueOperationId('SessionOnly'),
      method: 'GET',
      path: '/__test/no-store/session-only',
      summary: '検証用',
      permission: null,
      reason: '検証用のルート。認可の判断をしない',
      documented: false,
      sessionOnly: true,
      handler: async () => new Response(null, { status: 200 }),
    });

    const response = await handle(
      new Request(`${API}/__test/no-store/session-only`, {
        headers: { authorization: 'Bearer tfn_no_store_probe_token' },
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #5。CSRF の 403 は `try` の中で `cors` を付ける出口（実装プラン §8 の 3）。 */
  it('#5 許可された Origin からの要求の 403 に CORS のヘッダと no-store の両方が付く', async () => {
    vi.stubEnv('TORIFUNE_CORS_ORIGINS', 'https://app.example');
    const handle = defineRoute({
      operationId: uniqueOperationId('Cors'),
      method: 'POST',
      path: '/__test/no-store/cors',
      summary: '検証用',
      permission: null,
      reason: '検証用のルート。認可の判断をしない',
      documented: false,
      handler: async () => new Response(null, { status: 200 }),
    });

    const response = await handle(
      new Request(`${API}/__test/no-store/cors`, {
        method: 'POST',
        headers: { origin: 'https://app.example' },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('vary')).toContain('Origin');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #6 */
  it('#6 deprecated を書いたルートの 403 に Deprecation・Sunset と no-store の両方が付く', async () => {
    const handle = defineRoute({
      operationId: uniqueOperationId('Deprecated'),
      method: 'POST',
      path: '/__test/no-store/deprecated',
      summary: '検証用',
      permission: null,
      reason: '検証用のルート。認可の判断をしない',
      documented: false,
      deprecated: { since: '2026-09-01', removeAfter: '2027-03-01' },
      handler: async () => new Response(null, { status: 200 }),
    });

    const response = await handle(
      new Request(`${API}/__test/no-store/deprecated`, { method: 'POST' }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('deprecation')).toBe(`@${Date.UTC(2026, 8, 1) / 1000}`);
    expect(response.headers.get('sunset')).toBe(new Date('2027-03-01T00:00:00Z').toUTCString());
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('defineRoute を通らないルートは今のまま（§10.2・設計 §5.5）', () => {
  /** #7 */
  it('#7 GET /t.js の 200 の Cache-Control は public, max-age=3600 のまま、ETag も付く', async () => {
    const response = await trackingScriptRoute(new Request('https://example.com/t.js'));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(response.headers.get('etag')).toBeTruthy();
  });

  /** #8。#7 の ETag を If-None-Match に入れる（実装プラン §8 の 4）。 */
  it('#8 GET /t.js に一致する If-None-Match を送った 304 は今のまま（Cache-Control を足さない）', async () => {
    const first = await trackingScriptRoute(new Request('https://example.com/t.js'));
    const etag = first.headers.get('etag') ?? '';
    expect(etag).not.toBe('');

    const response = await trackingScriptRoute(
      new Request('https://example.com/t.js', { headers: { 'if-none-match': etag } }),
    );

    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe(etag);
    expect(response.headers.get('cache-control')).toBeNull();
  });

  /**
   * #9。ルートは `@/api/endpoints` を読み込む（全ルートの定義が登録される）ので、件の中で動的に読む
   * （実装プラン §8 の 5。このファイルでは `resetEndpointRegistry` を呼ばない）。
   */
  it('#9 GET /api/v1/openapi.json の Cache-Control は no-store のまま', async () => {
    const { GET } = await import('@/app/api/v1/openapi.json/route');

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #10 */
  it('#10 GET /api/health の応答に Cache-Control が無い（今のまま）', () => {
    const response = healthRoute();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBeNull();
  });
});
