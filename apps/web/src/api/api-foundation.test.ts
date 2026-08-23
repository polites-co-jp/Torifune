import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { allowedOrigins, corsHeaders, CorsConfigurationError } from './cors';
import { dataResponse, createdResponse, noContentResponse, pageResponse } from './response';
import {
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
  offsetOf,
  paginationSchema,
  parseSort,
  searchParamsToObject,
  UnknownSortFieldError,
} from './query';
import { createRateLimiter } from './rate-limit';
import { toValidationDetails, validate } from './validation';

async function bodyOf(response: Response): Promise<unknown> {
  return response.json();
}

describe('成功応答', () => {
  it('単体は { data } の形', async () => {
    const response = dataResponse({ id: '1' });
    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toEqual({ data: { id: '1' } });
  });

  it('一覧は { data, meta } の形', async () => {
    const response = pageResponse([{ id: '1' }], { page: 1, perPage: 20, total: 100 });
    await expect(bodyOf(response)).resolves.toEqual({
      data: [{ id: '1' }],
      meta: { page: 1, perPage: 20, total: 100 },
    });
  });

  it('作成成功は 201', () => {
    expect(createdResponse({ id: '1' }).status).toBe(201);
  });

  it('本文なしの成功は 204', () => {
    expect(noContentResponse().status).toBe(204);
  });

  it('ヘッダを追加できる', () => {
    const response = dataResponse({}, { headers: { 'X-Test': '1' } });
    expect(response.headers.get('X-Test')).toBe('1');
  });
});

describe('Pagination', () => {
  it('未指定なら 1 / 既定件数', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, perPage: DEFAULT_PER_PAGE });
  });

  it('指定した値を使う', () => {
    expect(paginationSchema.parse({ page: '3', perPage: '50' })).toEqual({
      page: 3,
      perPage: 50,
    });
  });

  it('perPage の上限で丸める', () => {
    expect(paginationSchema.parse({ perPage: '10000' }).perPage).toBe(MAX_PER_PAGE);
  });

  it('page が 0 以下なら 1 に丸める', () => {
    expect(paginationSchema.parse({ page: '0' }).page).toBe(1);
    expect(paginationSchema.parse({ page: '-5' }).page).toBe(1);
  });

  it('数値でない値は拒否する', () => {
    // 黙って既定値へ落とすと、打ち間違いに気づけないまま別のページを見ることになる。
    expect(paginationSchema.safeParse({ page: 'abc' }).success).toBe(false);
  });

  it('小数を拒否する', () => {
    expect(paginationSchema.safeParse({ page: '1.5' }).success).toBe(false);
  });

  it('OFFSET を計算できる', () => {
    expect(offsetOf({ page: 1, perPage: 20 })).toBe(0);
    expect(offsetOf({ page: 3, perPage: 20 })).toBe(40);
  });
});

describe('Sorting', () => {
  const allowed = { name: 'name', createdAt: 'created_at' } as const;
  const fallback = [{ field: 'created_at', direction: 'desc' as const }];

  it('昇順を解釈する', () => {
    expect(parseSort('name', allowed, fallback)).toEqual([{ field: 'name', direction: 'asc' }]);
  });

  it('先頭の - で降順になる', () => {
    expect(parseSort('-name', allowed, fallback)).toEqual([{ field: 'name', direction: 'desc' }]);
  });

  it('公開名を内部キーへ写す', () => {
    expect(parseSort('createdAt', allowed, fallback)).toEqual([
      { field: 'created_at', direction: 'asc' },
    ]);
  });

  it('複数指定できる', () => {
    expect(parseSort('name,-createdAt', allowed, fallback)).toEqual([
      { field: 'name', direction: 'asc' },
      { field: 'created_at', direction: 'desc' },
    ]);
  });

  it('未指定なら既定順', () => {
    expect(parseSort(undefined, allowed, fallback)).toEqual(fallback);
    expect(parseSort('', allowed, fallback)).toEqual(fallback);
  });

  it('ホワイトリストに無い名前を拒否する', () => {
    expect(() => parseSort('secret', allowed, fallback)).toThrowError(UnknownSortFieldError);
  });

  it('DB のカラム名を直接指定しても通らない', () => {
    // 公開名は createdAt。内部キーの created_at を指定しても拒否する。
    expect(() => parseSort('created_at', allowed, fallback)).toThrowError(UnknownSortFieldError);
  });

  it('プロトタイプ由来の名前で抜けられない', () => {
    expect(() => parseSort('toString', allowed, fallback)).toThrowError(UnknownSortFieldError);
    expect(() => parseSort('constructor', allowed, fallback)).toThrowError(UnknownSortFieldError);
  });

  it('SQL 断片を渡しても解釈されない', () => {
    expect(() => parseSort('name; DROP TABLE users', allowed, fallback)).toThrowError(
      UnknownSortFieldError,
    );
  });
});

describe('検証', () => {
  const schema = z.object({
    name: z.string().min(1, '必須です。'),
    count: z.number(),
  });

  it('正しい入力を通す', () => {
    const result = validate(schema, { name: 'a', count: 1 });
    expect(result.ok && result.value).toEqual({ name: 'a', count: 1 });
  });

  it('型が違えば失敗する', () => {
    const result = validate(schema, { name: 'a', count: 'not a number' });
    expect(result.ok).toBe(false);
  });

  it('必須が無ければフィールド名が details に出る', () => {
    const result = validate(schema, { count: 1 });
    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.details)).toContain('name');
  });

  it('未知のフィールドは無視される', () => {
    // 拒否すると、クライアントが将来のフィールドを送ったときに壊れる。
    const result = validate(schema, { name: 'a', count: 1, future: 'x' });
    expect(result.ok && result.value).toEqual({ name: 'a', count: 1 });
  });

  it('入れ子のパスが details のキーになる', () => {
    const nested = z.object({ site: z.object({ name: z.string() }) });
    const result = validate(nested, { site: {} });
    expect(!result.ok && Object.keys(result.details)).toContain('site.name');
  });

  it('ルートのエラーは _ にまとまる', () => {
    const result = validate(z.string(), 123);
    expect(!result.ok && Object.keys(result.details)).toEqual(['_']);
  });

  it('toValidationDetails が同じフィールドの複数エラーをまとめる', () => {
    const strict = z.object({
      name: z.string().min(5, '短すぎます。').startsWith('x', 'x で始めてください。'),
    });
    const parsed = strict.safeParse({ name: 'ab' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(toValidationDetails(parsed.error)['name']).toEqual([
        '短すぎます。',
        'x で始めてください。',
      ]);
    }
  });
});

describe('Rate Limit', () => {
  it('上限まで通す', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check('a', 0).allowed).toBe(true);
    }
  });

  it('上限を超えると拒否する', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3 });
    for (let i = 0; i < 3; i += 1) {
      limiter.check('a', 0);
    }
    expect(limiter.check('a', 0).allowed).toBe(false);
  });

  it('拒否のとき再試行までの秒数を返す', () => {
    const limiter = createRateLimiter({ windowMs: 10_000, max: 1 });
    limiter.check('a', 0);
    const verdict = limiter.check('a', 1000);
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBe(9);
  });

  it('時間窓を過ぎると再び通る', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
    limiter.check('a', 0);
    expect(limiter.check('a', 1001).allowed).toBe(true);
  });

  it('キーごとに独立して数える', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
    limiter.check('a', 0);
    expect(limiter.check('b', 0).allowed).toBe(true);
  });

  it('窓が滑るので古い記録だけが落ちる', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2 });
    limiter.check('a', 0);
    limiter.check('a', 900);
    expect(limiter.check('a', 950).allowed).toBe(false);
    expect(limiter.check('a', 1500).allowed).toBe(true);
  });
});

describe('CORS', () => {
  it('未設定なら許可 Origin は空', () => {
    expect(allowedOrigins({})).toEqual([]);
  });

  it('カンマ区切りを読む', () => {
    expect(
      allowedOrigins({ TORIFUNE_CORS_ORIGINS: 'https://a.example.com, https://b.example.com' }),
    ).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('* を拒否する', () => {
    // 資格情報つきのリクエストで * は使えず、
    // 使えたとしても「誰でもよい」は本番で意図した設定になりえない。
    expect(() => allowedOrigins({ TORIFUNE_CORS_ORIGINS: '*' })).toThrowError(
      CorsConfigurationError,
    );
  });

  it('形式が不正な Origin を拒否する', () => {
    expect(() => allowedOrigins({ TORIFUNE_CORS_ORIGINS: 'not a url' })).toThrowError(
      CorsConfigurationError,
    );
  });

  it('パス付きの Origin を拒否する', () => {
    expect(() =>
      allowedOrigins({ TORIFUNE_CORS_ORIGINS: 'https://a.example.com/path' }),
    ).toThrowError(CorsConfigurationError);
  });

  it('既定では CORS ヘッダを返さない', () => {
    const request = new Request('https://x/y', { headers: { origin: 'https://a.example.com' } });
    expect(corsHeaders(request, {})).toEqual({});
  });

  it('許可した Origin にだけ返す', () => {
    const env = { TORIFUNE_CORS_ORIGINS: 'https://a.example.com' };
    const allowed = new Request('https://x/y', { headers: { origin: 'https://a.example.com' } });
    const denied = new Request('https://x/y', { headers: { origin: 'https://evil.example.com' } });

    expect(corsHeaders(allowed, env)['Access-Control-Allow-Origin']).toBe('https://a.example.com');
    expect(corsHeaders(denied, env)).toEqual({});
  });

  it('Origin ヘッダが無ければ何も返さない', () => {
    expect(
      corsHeaders(new Request('https://x/y'), { TORIFUNE_CORS_ORIGINS: 'https://a.example.com' }),
    ).toEqual({});
  });
});

describe('searchParamsToObject', () => {
  it('クエリをオブジェクトへ変換する', () => {
    expect(searchParamsToObject('https://x/y?page=2&perPage=50')).toEqual({
      page: '2',
      perPage: '50',
    });
  });

  it('クエリが無ければ空', () => {
    expect(searchParamsToObject('https://x/y')).toEqual({});
  });
});
