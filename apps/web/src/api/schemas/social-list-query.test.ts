import { describe, expect, it } from 'vitest';
import { paginationSchema } from '@/api/query';
import { accountListQuerySchema, postListQuerySchema } from '@/api/schemas/social';

/**
 * SNS の一覧のクエリ（042-social-api-input-fixes 設計 §6.2・§6.3）。
 *
 * - `page` / `perPage`（受け入れ条件 #16・#17）：共通の `paginationSchema` の規則に揃える。
 *   `page` は 1 以上、`perPage` は 1〜100 に**丸める**。整数でなければ失敗（422）。
 *   規則が `paginationSchema` とずれないことを、同じ入力を `paginationSchema.parse` に渡した結果との一致でも見る
 *   （042 実装プラン §2「テストの方法」、§8 の 1）
 * - `accountId`（受け入れ条件 #26・#27）：UUID の形（8-4-4-4-12 の 16 進、大小文字を問わない、版と variant を見ない）。
 *   それ以外は空文字も含めて失敗し、文言は `UUID の形で指定してください。`
 */

const SCHEMAS = [
  { name: 'postListQuerySchema', schema: postListQuerySchema },
  { name: 'accountListQuerySchema', schema: accountListQuerySchema },
] as const;

const UUID_MESSAGE = 'UUID の形で指定してください。';

interface PageResult {
  readonly page: unknown;
  readonly perPage: unknown;
}

function pageOf(value: unknown): PageResult {
  const object = value as Record<string, unknown>;
  return { page: object['page'], perPage: object['perPage'] };
}

/** 失敗した検査の、問題のキー（`path[0]`）の集合。 */
function issueKeysOf(result: {
  readonly success: boolean;
  readonly error?: { readonly issues: readonly { readonly path: readonly PropertyKey[] }[] };
}): string[] {
  return [...new Set((result.error?.issues ?? []).map((issue) => String(issue.path[0])))];
}

/* -------------------------------------------------------------------------- */
/* #16 page / perPage の丸め                                                   */
/* -------------------------------------------------------------------------- */

/** 設計 §10.2 の #16 の入力と、期待する `page` / `perPage`。 */
const CLAMP_CASES: readonly {
  readonly label: string;
  readonly input: Record<string, string>;
  readonly expected: PageResult;
}[] = [
  { label: '{}', input: {}, expected: { page: 1, perPage: 20 } },
  { label: "page: '0'", input: { page: '0' }, expected: { page: 1, perPage: 20 } },
  { label: "page: '-3'", input: { page: '-3' }, expected: { page: 1, perPage: 20 } },
  { label: "page: '5'", input: { page: '5' }, expected: { page: 5, perPage: 20 } },
  { label: "perPage: '0'", input: { perPage: '0' }, expected: { page: 1, perPage: 1 } },
  { label: "perPage: '-1'", input: { perPage: '-1' }, expected: { page: 1, perPage: 1 } },
  { label: "perPage: '1'", input: { perPage: '1' }, expected: { page: 1, perPage: 1 } },
  { label: "perPage: '100'", input: { perPage: '100' }, expected: { page: 1, perPage: 100 } },
  { label: "perPage: '101'", input: { perPage: '101' }, expected: { page: 1, perPage: 100 } },
  { label: "perPage: '1000'", input: { perPage: '1000' }, expected: { page: 1, perPage: 100 } },
  { label: "page: ''", input: { page: '' }, expected: { page: 1, perPage: 20 } },
  { label: "perPage: ''", input: { perPage: '' }, expected: { page: 1, perPage: 1 } },
];

describe.each(SCHEMAS)('#16 $name の page / perPage を丸める', ({ schema }) => {
  it.each(CLAMP_CASES)('#16 $label → 期待どおりに丸まる', ({ input, expected }) => {
    const result = schema.safeParse(input);

    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(pageOf(result.data)).toEqual(expected);
  });

  it.each(CLAMP_CASES)('#16 $label → paginationSchema.parse と同じ結果', ({ input }) => {
    const result = schema.safeParse(input);

    expect(pageOf(result.data)).toEqual(pageOf(paginationSchema.parse(input)));
  });
});

/* -------------------------------------------------------------------------- */
/* #17 整数でない値は失敗する                                                     */
/* -------------------------------------------------------------------------- */

describe.each(SCHEMAS)('#17 $name は整数でない page / perPage を断る', ({ schema }) => {
  it.each(['abc', '1.5'])("#17 perPage: '%s' → 失敗し、問題のキーが perPage", (value) => {
    const result = schema.safeParse({ perPage: value });

    expect(result.success).toBe(false);
    expect(issueKeysOf(result)).toEqual(['perPage']);
  });

  it("#17 page: 'abc' → 失敗し、問題のキーが page", () => {
    const result = schema.safeParse({ page: 'abc' });

    expect(result.success).toBe(false);
    expect(issueKeysOf(result)).toEqual(['page']);
  });
});

/* -------------------------------------------------------------------------- */
/* #26 accountId：UUID の形なら通る                                              */
/* -------------------------------------------------------------------------- */

describe('#26 postListQuerySchema の accountId は UUID の形なら通り、値はそのまま', () => {
  it.each([
    '0192b7a0-5c1e-7a3b-9f10-2d7c4e8a1b23',
    '0192B7A0-5C1E-7A3B-9F10-2D7C4E8A1B23',
    // 版・variant を問わない（Repository の UUID_PATTERN と同じ判定。設計 §6.3）。
    '00000000-0000-0000-0000-000000000000',
    // 版 0・variant 0。z.uuid() は断るが z.guid() は通す（版と variant を見ないことの判別。042 検証 軽微 1）
    '0192b7a0-5c1e-0a3b-0f10-2d7c4e8a1b23',
  ])('#26 %s → 成功し、値はそのまま', (value) => {
    const result = postListQuerySchema.safeParse({ accountId: value });

    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect((result.data as Record<string, unknown> | undefined)?.['accountId']).toBe(value);
  });

  it('#26 省略すれば従来どおり成功する（絞り込みなし）', () => {
    const result = postListQuerySchema.safeParse({});

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown> | undefined)?.['accountId']).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* #27 accountId：UUID の形でなければ失敗する                                     */
/* -------------------------------------------------------------------------- */

describe('#27 postListQuerySchema の accountId は UUID の形でなければ失敗する', () => {
  const INVALID: readonly { readonly label: string; readonly value: string }[] = [
    { label: 'abc', value: 'abc' },
    { label: '空文字', value: '' },
    { label: '末尾が 16 進でない', value: '0192b7a0-5c1e-7a3b-9f10-2d7c4e8a1b2g' },
    { label: 'ハイフンなし', value: '0192b7a05c1e7a3b9f102d7c4e8a1b23' },
    { label: '65 文字', value: 'a'.repeat(65) },
  ];

  it.each(INVALID)('#27 $label → 失敗し、問題のキーが accountId', ({ value }) => {
    const result = postListQuerySchema.safeParse({ accountId: value });

    expect(result.success).toBe(false);
    expect(issueKeysOf(result)).toEqual(['accountId']);
  });

  it.each(INVALID)(
    '#27 $label → accountId の問題の文言がすべて「UUID の形で指定してください。」',
    ({ value }) => {
      const result = postListQuerySchema.safeParse({ accountId: value });
      const messages = (result.error?.issues ?? [])
        .filter((issue) => issue.path[0] === 'accountId')
        .map((issue) => issue.message);

      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) {
        expect(message).toBe(UUID_MESSAGE);
      }
    },
  );
});
