import { describe, expect, it } from 'vitest';
import { campaignListQuerySchema } from '@/api/schemas/campaign';
import { siteListQuerySchema } from '@/api/schemas/site';
import { userListQuerySchema } from '@/api/schemas/user';

/**
 * SNS 以外の一覧のクエリ（043-api-input-fixes-rest 設計 §6.2・§6.3）。
 *
 * - `page` / `perPage`（受け入れ条件 #1・#2）：042 で SNS の一覧に使った規則に揃える。
 *   `page` は 1 以上、`perPage` は 1〜100 に**丸める**（422 にしない）。整数でなければ失敗（422）
 *
 * 対象は `siteListQuerySchema`・`userListQuerySchema`・`campaignListQuerySchema` の 3 つ。
 */

const SCHEMAS = [
  { name: 'siteListQuerySchema', schema: siteListQuerySchema },
  { name: 'userListQuerySchema', schema: userListQuerySchema },
  { name: 'campaignListQuerySchema', schema: campaignListQuerySchema },
] as const;

interface PageResult {
  readonly page: unknown;
  readonly perPage: unknown;
}

function pageOf(value: unknown): PageResult {
  const object = (value ?? {}) as Record<string, unknown>;
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
/* #1 page / perPage の丸め                                                    */
/* -------------------------------------------------------------------------- */

/** 設計 §10.1 の #1 の入力と、期待する `page` / `perPage`。 */
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
  {
    label: "perPage: '100000000'",
    input: { perPage: '100000000' },
    expected: { page: 1, perPage: 100 },
  },
  { label: "page: ''", input: { page: '' }, expected: { page: 1, perPage: 20 } },
  { label: "perPage: ''", input: { perPage: '' }, expected: { page: 1, perPage: 1 } },
];

describe.each(SCHEMAS)('#1 $name の page / perPage を丸める', ({ schema }) => {
  it.each(CLAMP_CASES)('#1 $label → 期待どおりに丸まる', ({ input, expected }) => {
    const result = schema.safeParse(input);

    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(pageOf(result.data)).toEqual(expected);
  });
});

/* -------------------------------------------------------------------------- */
/* #2 整数でない値は失敗する                                                     */
/* -------------------------------------------------------------------------- */

describe.each(SCHEMAS)('#2 $name は整数でない page / perPage を断る', ({ schema }) => {
  it.each(['abc', '1.5'])("#2 perPage: '%s' → 失敗し、問題のキーが perPage", (value) => {
    const result = schema.safeParse({ perPage: value });

    expect(result.success).toBe(false);
    expect(issueKeysOf(result)).toEqual(['perPage']);
  });

  it("#2 page: 'abc' → 失敗し、問題のキーが page", () => {
    const result = schema.safeParse({ page: 'abc' });

    expect(result.success).toBe(false);
    expect(issueKeysOf(result)).toEqual(['page']);
  });
});
