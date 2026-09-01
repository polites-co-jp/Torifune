import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assertValidDeprecation,
  deprecationDescription,
  deprecationHeaders,
  DeprecationNoticeError,
} from './deprecation';
import { defineRoute, RouteDefinitionError } from './route';
import { listEndpoints, resetEndpointRegistry } from './registry';

/**
 * 非推奨（Deprecated）の告知（05_API設計.md §41）。
 *
 * **告知が「書いたつもり」で終わらないこと**を確かめる。
 */

describe('非推奨の定義を検証する', () => {
  it('日付だけでも成立する', () => {
    expect(() => assertValidDeprecation('x', { since: '2026-09-01' })).not.toThrow();
  });

  it('移行先と削除予定日を書ける', () => {
    expect(() =>
      assertValidDeprecation('x', {
        since: '2026-09-01',
        replacedBy: '/analytics',
        removeAfter: '2027-03-01',
      }),
    ).not.toThrow();
  });

  it('since の形式が違えば拒否する', () => {
    expect(() => assertValidDeprecation('x', { since: '2026/09/01' })).toThrowError(
      DeprecationNoticeError,
    );
    expect(() => assertValidDeprecation('x', { since: 'いつか' })).toThrowError(
      DeprecationNoticeError,
    );
  });

  it('実在しない日付を拒否する', () => {
    // Date は 2026-02-31 を 3/3 へ繰り上げてしまう。黙って別の日にしない。
    expect(() => assertValidDeprecation('x', { since: '2026-02-31' })).toThrowError(
      DeprecationNoticeError,
    );
  });

  it('removeAfter が since より前なら拒否する', () => {
    // 移行できる期間が無い告知は、告知になっていない。
    expect(() =>
      assertValidDeprecation('x', { since: '2026-09-01', removeAfter: '2026-08-31' }),
    ).toThrowError(DeprecationNoticeError);
  });

  it('同じ日は許す', () => {
    expect(() =>
      assertValidDeprecation('x', { since: '2026-09-01', removeAfter: '2026-09-01' }),
    ).not.toThrow();
  });

  it('replacedBy がパスでなければ拒否する', () => {
    expect(() =>
      assertValidDeprecation('x', { since: '2026-09-01', replacedBy: 'analytics' }),
    ).toThrowError(DeprecationNoticeError);
  });
});

describe('非推奨のヘッダ', () => {
  it('Deprecation は RFC 9745 の Date（@ + Unix秒）', () => {
    const headers = deprecationHeaders({ since: '2026-09-01' });
    expect(headers['Deprecation']).toBe(`@${Date.UTC(2026, 8, 1) / 1000}`);
  });

  it('削除予定日があれば Sunset を出す（RFC 8594 の HTTP-date）', () => {
    const headers = deprecationHeaders({ since: '2026-09-01', removeAfter: '2027-03-01' });
    expect(headers['Sunset']).toBe(new Date('2027-03-01T00:00:00Z').toUTCString());
  });

  it('削除予定日が無ければ Sunset を出さない', () => {
    // 「未定」を適当な日付で埋めない。
    expect(deprecationHeaders({ since: '2026-09-01' })['Sunset']).toBeUndefined();
  });

  it('移行先があれば Link で指す', () => {
    const headers = deprecationHeaders({ since: '2026-09-01', replacedBy: '/analytics' });
    expect(headers['Link']).toBe('</api/v1/analytics>; rel="successor-version"');
  });

  it('移行先が無ければ Link を出さない', () => {
    expect(deprecationHeaders({ since: '2026-09-01' })['Link']).toBeUndefined();
  });
});

describe('非推奨の説明', () => {
  it('移行先と削除予定日を文にする', () => {
    const text = deprecationDescription({
      since: '2026-09-01',
      replacedBy: '/analytics',
      removeAfter: '2027-03-01',
    });
    expect(text).toContain('2026-09-01');
    expect(text).toContain('/analytics');
    expect(text).toContain('2027-03-01');
  });

  it('削除予定日が無ければ未定と書く', () => {
    expect(deprecationDescription({ since: '2026-09-01' })).toContain('未定');
  });
});

describe('defineRoute の非推奨', () => {
  it('登録されたエンドポイントに残る', () => {
    resetEndpointRegistry();
    defineRoute({
      operationId: 'deprecatedProbe',
      method: 'GET',
      path: '/probe',
      summary: '検証用',
      permission: null,
      reason: 'テスト用の定義',
      deprecated: { since: '2026-09-01', replacedBy: '/probe2', removeAfter: '2027-03-01' },
      handler: async () => new Response(null, { status: 200 }),
    });

    const spec = listEndpoints().find((entry) => entry.operationId === 'deprecatedProbe');
    expect(spec?.deprecated).toEqual({
      since: '2026-09-01',
      replacedBy: '/probe2',
      removeAfter: '2027-03-01',
    });
  });

  it('成立しない告知は定義時に落とす', () => {
    expect(() =>
      defineRoute({
        operationId: 'brokenDeprecation',
        method: 'GET',
        path: '/probe',
        summary: '検証用',
        permission: null,
        reason: 'テスト用の定義',
        deprecated: { since: 'そのうち' },
        handler: async () => new Response(null, { status: 200 }),
      }),
    ).toThrowError(DeprecationNoticeError);
  });

  it('204 に応答スキーマは書けない', () => {
    expect(() =>
      defineRoute({
        operationId: 'brokenSuccessStatus',
        method: 'DELETE',
        path: '/probe',
        summary: '検証用',
        permission: null,
        reason: 'テスト用の定義',
        successStatus: 204,
        response: z.object({ data: z.string() }),
        handler: async () => new Response(null, { status: 204 }),
      }),
    ).toThrowError(RouteDefinitionError);
  });

  /**
   * **成功時だけにしない。**
   * 認証に失敗し続けているクライアントには、成功応答が一度も返らない。
   */
  it('エラー応答にもヘッダが付く', async () => {
    const handle = defineRoute({
      operationId: 'deprecatedErrorProbe',
      method: 'POST',
      path: '/probe',
      summary: '検証用',
      permission: null,
      reason: 'テスト用の定義',
      deprecated: { since: '2026-09-01', removeAfter: '2027-03-01' },
      handler: async () => new Response(null, { status: 200 }),
    });

    // CSRF トークンを付けずに叩く。認証やDBへ触れる前に 403 で返る。
    const response = await handle(
      new Request('https://example.com/api/v1/probe', { method: 'POST' }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('Deprecation')).toBe(`@${Date.UTC(2026, 8, 1) / 1000}`);
    expect(response.headers.get('Sunset')).toBe(new Date('2027-03-01T00:00:00Z').toUTCString());
  });

  it('非推奨でなければヘッダを付けない', async () => {
    const handle = defineRoute({
      operationId: 'plainProbe',
      method: 'POST',
      path: '/probe',
      summary: '検証用',
      permission: null,
      reason: 'テスト用の定義',
      handler: async () => new Response(null, { status: 200 }),
    });

    const response = await handle(
      new Request('https://example.com/api/v1/probe', { method: 'POST' }),
    );
    expect(response.headers.get('Deprecation')).toBeNull();
    expect(response.headers.get('Sunset')).toBeNull();
  });
});
