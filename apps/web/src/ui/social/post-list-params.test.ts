import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 投稿一覧の URL のクエリと登録元の選択肢の純関数（054-bulk-post-actions 設計 §5.6・§9.2・§9.8、
 * 受け入れ条件 #75、#74 の発行日の添え字、#76 の `openPostListPage`）。
 *
 * * #75：`parsePostListParams` が設計 §9.2 の表のとおりに読み、誤った値は無視して既定にする。`postListHref` は既定値を
 *   書かず `#posts` で終わり、1 ページ目なら `postPage` を書かない
 * * #74：`postSourceOptionsOf` が、名前の重なるトークンにだけ「（発行 YYYY-MM-DD）」を添え、失効は「（失効）」。
 *   「削除されたトークン」は `hasDeletedTokenPosts` のときだけ
 * * #76：`openPostListPage(filters, page)` が絞り込みを保った `postListHref` を `window.location.assign` で開く
 *   （`window` を差し替えて確かめる）
 *
 * `ui/social/post-list-params.ts` はまだ無いので、指定子を `string` の定数に置いた動的 import で読む
 * （053 実装プラン §8 の 19）。口の形は実装プラン T8・§8 の 18・19 から写す。
 */

type PostStatus = 'draft' | 'awaiting_approval' | 'scheduled' | 'published' | 'failed';

type PostSourceFilter =
  | { readonly kind: 'screen' }
  | { readonly kind: 'token'; readonly tokenId: string }
  | { readonly kind: 'deleted_token' };

type PostSource =
  | { readonly kind: 'screen' }
  | {
      readonly kind: 'token';
      readonly tokenId: string;
      readonly name: string;
      readonly revoked: boolean;
    }
  | { readonly kind: 'deleted_token'; readonly name: string };

interface PostListFilters {
  readonly status: PostStatus | null;
  readonly accountId: string | null;
  readonly source: PostSourceFilter | null;
  readonly perPage: number;
  readonly page: number;
}

interface SocialPostSources {
  readonly tokens: readonly {
    readonly id: string;
    readonly name: string;
    readonly revoked: boolean;
    readonly createdAt: Date;
  }[];
  readonly hasScreenPosts: boolean;
  readonly hasDeletedTokenPosts: boolean;
}

interface Option {
  readonly value: string;
  readonly label: string;
}

type SearchParams = Record<string, string | readonly string[] | undefined>;

interface PostListParamsModule {
  readonly parsePostListParams: (params: SearchParams) => PostListFilters;
  readonly postListHref: (filters: PostListFilters) => string;
  readonly openPostListPage: (filters: PostListFilters, page: number) => void;
  readonly postSourceOptionsOf: (
    sources: SocialPostSources,
    formatIssuedDate: (date: Date) => string,
  ) => readonly Option[];
  readonly postSourceViewOf: (source: PostSource) => Record<string, unknown>;
}

const MODULE: string = '@/ui/social/post-list-params';

async function load(): Promise<PostListParamsModule> {
  const module = (await import(/* @vite-ignore */ MODULE)) as Partial<PostListParamsModule>;
  for (const name of [
    'parsePostListParams',
    'postListHref',
    'openPostListPage',
    'postSourceOptionsOf',
    'postSourceViewOf',
  ] as const) {
    if (typeof module[name] !== 'function') {
      throw new Error(`ui/social/post-list-params.ts に ${name} が無い`);
    }
  }
  return module as PostListParamsModule;
}

const ACCOUNT = '01920000-0000-7000-8000-0000000000ac';
const TOKEN = '01920000-0000-7000-8000-00000000b106';

const DEFAULTS: PostListFilters = {
  status: null,
  accountId: null,
  source: null,
  perPage: 20,
  page: 1,
};

function filters(overrides: Partial<PostListFilters> = {}): PostListFilters {
  return { ...DEFAULTS, ...overrides };
}

/** href を相対 URL として読む（クエリの並びに依らず比べる）。 */
function parseHref(href: string): {
  readonly pathname: string;
  readonly hash: string;
  readonly query: Record<string, string>;
} {
  const url = new URL(href, 'http://127.0.0.1:3000');
  return {
    pathname: url.pathname,
    hash: url.hash,
    query: Object.fromEntries(url.searchParams.entries()),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// #75 parsePostListParams
// ---------------------------------------------------------------------------

describe('#75 parsePostListParams（設計 §9.2 の表）', () => {
  it('#75 クエリが無い → すべて・20 件・1 ページ目', async () => {
    const { parsePostListParams } = await load();

    expect(parsePostListParams({})).toEqual(DEFAULTS);
  });

  it.each(['draft', 'awaiting_approval', 'scheduled', 'published', 'failed'] as const)(
    '#75 postStatus=%s → status',
    async (status) => {
      const { parsePostListParams } = await load();

      expect(parsePostListParams({ postStatus: status }).status).toBe(status);
    },
  );

  it.each([
    ['xxx', 'xxx'],
    ['空', ''],
    ['配列', ['draft', 'scheduled']],
  ] as const)('#75 postStatus が %s → 無視（null）', async (_label, value) => {
    const { parsePostListParams } = await load();

    expect(parsePostListParams({ postStatus: value }).status).toBeNull();
  });

  it('#75 postAccount が UUID の形 → accountId', async () => {
    const { parsePostListParams } = await load();

    expect(parsePostListParams({ postAccount: ACCOUNT }).accountId).toBe(ACCOUNT);
  });

  it.each([
    ['abc', 'abc'],
    ['空', ''],
    ['配列', [ACCOUNT]],
  ] as const)('#75 postAccount が %s → 無視（null）', async (_label, value) => {
    const { parsePostListParams } = await load();

    expect(parsePostListParams({ postAccount: value }).accountId).toBeNull();
  });

  it.each([
    ['screen', { kind: 'screen' }],
    ['deleted', { kind: 'deleted_token' }],
    [`token:${TOKEN}`, { kind: 'token', tokenId: TOKEN }],
  ] as const)('#75 postSource=%s → source', async (value, expected) => {
    const { parsePostListParams } = await load();

    expect(parsePostListParams({ postSource: value }).source).toEqual(expected);
  });

  it.each([
    ['token:zzz', 'token:zzz'],
    ['token:', 'token:'],
    ['other', 'other'],
    ['空', ''],
  ] as const)('#75 postSource が %s → 無視（null）', async (_label, value) => {
    const { parsePostListParams } = await load();

    expect(parsePostListParams({ postSource: value }).source).toBeNull();
  });

  it.each([
    ['20', 20],
    ['50', 50],
    ['100', 100],
  ] as const)('#75 postPerPage=%s → %i', async (value, expected) => {
    const { parsePostListParams } = await load();

    expect(parsePostListParams({ postPerPage: value }).perPage).toBe(expected);
  });

  it.each([
    ['abc', 'abc'],
    ['30', '30'],
    ['1000', '1000'],
    ['0', '0'],
    ['空', ''],
  ] as const)('#75 postPerPage が %s → 無視（20）', async (_label, value) => {
    const { parsePostListParams } = await load();

    expect(parsePostListParams({ postPerPage: value }).perPage).toBe(20);
  });

  it.each([
    ['3', 3],
    ['abc', 1],
    ['0', 1],
    ['-2', 1],
  ] as const)('#75 postPage=%s → %i（既存の normalizePage どおり）', async (value, expected) => {
    const { parsePostListParams } = await load();

    expect(parsePostListParams({ postPage: value }).page).toBe(expected);
  });

  it('#75 誤ったクエリを混ぜても、正しい項目だけを読む', async () => {
    const { parsePostListParams } = await load();

    expect(
      parsePostListParams({
        postStatus: 'xxx',
        postPerPage: 'abc',
        postSource: 'token:zzz',
        postAccount: ACCOUNT,
      }),
    ).toEqual(filters({ accountId: ACCOUNT }));
  });
});

// ---------------------------------------------------------------------------
// #75 postListHref
// ---------------------------------------------------------------------------

describe('#75 postListHref', () => {
  it('#75 既定値だけなら /social#posts（クエリを書かない）', async () => {
    const { postListHref } = await load();

    expect(postListHref(DEFAULTS)).toBe('/social#posts');
  });

  it('#75 #posts で終わる（条件があっても）', async () => {
    const { postListHref } = await load();

    expect(
      postListHref(filters({ status: 'awaiting_approval', perPage: 50, page: 2 })).endsWith(
        '#posts',
      ),
    ).toBe(true);
  });

  it('#75 条件を持つ項目だけをクエリに書く（既定値は書かない）', async () => {
    const { postListHref } = await load();

    const href = parseHref(
      postListHref(
        filters({
          status: 'awaiting_approval',
          accountId: ACCOUNT,
          source: { kind: 'token', tokenId: TOKEN },
          perPage: 100,
        }),
      ),
    );

    expect(href).toEqual({
      pathname: '/social',
      hash: '#posts',
      query: {
        postStatus: 'awaiting_approval',
        postAccount: ACCOUNT,
        postSource: `token:${TOKEN}`,
        postPerPage: '100',
      },
    });
  });

  it('#75 表示件数 20（既定）は postPerPage を書かない', async () => {
    const { postListHref } = await load();

    expect(parseHref(postListHref(filters({ status: 'draft' }))).query).toEqual({
      postStatus: 'draft',
    });
  });

  it('#75 1 ページ目（条件を変えたとき）は postPage を書かない', async () => {
    const { postListHref } = await load();

    expect(parseHref(postListHref(filters({ source: { kind: 'screen' }, page: 1 }))).query).toEqual(
      { postSource: 'screen' },
    );
  });

  it('#75 2 ページ目以降は postPage を書く', async () => {
    const { postListHref } = await load();

    expect(parseHref(postListHref(filters({ page: 3 }))).query).toEqual({ postPage: '3' });
  });

  it('#75 登録元「削除されたトークン」は postSource=deleted', async () => {
    const { postListHref } = await load();

    expect(parseHref(postListHref(filters({ source: { kind: 'deleted_token' } }))).query).toEqual({
      postSource: 'deleted',
    });
  });

  it('#75 書いた href をクエリとして読み直すと元の条件に戻る', async () => {
    const { parsePostListParams, postListHref } = await load();
    const original = filters({
      status: 'scheduled',
      accountId: ACCOUNT,
      source: { kind: 'token', tokenId: TOKEN },
      perPage: 50,
      page: 4,
    });

    expect(parsePostListParams(parseHref(postListHref(original)).query)).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// #76 openPostListPage
// ---------------------------------------------------------------------------

describe('#76 openPostListPage', () => {
  it('#76 絞り込みを保ったまま、指定のページの postListHref を window.location.assign で開く', async () => {
    const { openPostListPage, postListHref } = await load();
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    const current = filters({
      status: 'awaiting_approval',
      source: { kind: 'token', tokenId: TOKEN },
      perPage: 50,
      page: 1,
    });

    openPostListPage(current, 2);

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(postListHref({ ...current, page: 2 }));
  });

  it('#76 開く URL に絞り込みのクエリと postPage が入る', async () => {
    const { openPostListPage } = await load();
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });

    openPostListPage(filters({ status: 'draft', perPage: 100 }), 3);

    expect(parseHref(String(assign.mock.calls[0]?.[0])).query).toEqual({
      postStatus: 'draft',
      postPerPage: '100',
      postPage: '3',
    });
  });

  it('#76 1 ページ目へ戻るときは postPage を書かない', async () => {
    const { openPostListPage } = await load();
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });

    openPostListPage(filters({ status: 'draft', page: 2 }), 1);

    expect(parseHref(String(assign.mock.calls[0]?.[0])).query).toEqual({ postStatus: 'draft' });
  });
});

// ---------------------------------------------------------------------------
// #74 登録元の選択肢（発行日の添え字）
// ---------------------------------------------------------------------------

const TOKEN_A = '01920000-0000-7000-8000-00000000000a';
const TOKEN_B = '01920000-0000-7000-8000-00000000000b';
const TOKEN_C = '01920000-0000-7000-8000-00000000000c';

/** 単体テスト用の固定の書式（Server Component は基準のタイムゾーンで作る。実装プラン §8 の 18）。 */
function formatIssuedDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sources(overrides: Partial<SocialPostSources> = {}): SocialPostSources {
  return {
    tokens: [],
    hasScreenPosts: true,
    hasDeletedTokenPosts: false,
    ...overrides,
  };
}

describe('#74 postSourceOptionsOf', () => {
  it('#74 先頭は「すべて」（値は空文字）', async () => {
    const { postSourceOptionsOf } = await load();

    expect(postSourceOptionsOf(sources(), formatIssuedDate)[0]).toEqual({
      value: '',
      label: 'すべて',
    });
  });

  it('#74 すべて・管理画面・トークン（渡した順）・削除されたトークンを並べ、値は postSource のクエリの値', async () => {
    const { postSourceOptionsOf } = await load();

    const options = postSourceOptionsOf(
      sources({
        tokens: [
          {
            id: TOKEN_A,
            name: 'ショップ連携',
            revoked: false,
            createdAt: new Date('2026-09-01T00:00:00Z'),
          },
          {
            id: TOKEN_B,
            name: 'ブログ連携',
            revoked: false,
            createdAt: new Date('2026-10-01T00:00:00Z'),
          },
        ],
        hasScreenPosts: true,
        hasDeletedTokenPosts: true,
      }),
      formatIssuedDate,
    );

    expect(options).toEqual([
      { value: '', label: 'すべて' },
      { value: 'screen', label: '管理画面' },
      { value: `token:${TOKEN_A}`, label: 'ショップ連携' },
      { value: `token:${TOKEN_B}`, label: 'ブログ連携' },
      { value: 'deleted', label: '削除されたトークン' },
    ]);
  });

  it('#74 名前が重ならなければ「（発行 …）」を付けない', async () => {
    const { postSourceOptionsOf } = await load();

    const labels = postSourceOptionsOf(
      sources({
        tokens: [
          { id: TOKEN_A, name: 'ショップ連携', revoked: false, createdAt: new Date('2026-09-01') },
          { id: TOKEN_B, name: 'ブログ連携', revoked: false, createdAt: new Date('2026-10-01') },
        ],
      }),
      formatIssuedDate,
    ).map((option) => option.label);

    expect(labels.some((label) => label.includes('発行'))).toBe(false);
  });

  it('#74 同じ名前のトークンには、それぞれ「（発行 YYYY-MM-DD）」を付ける', async () => {
    const { postSourceOptionsOf } = await load();

    const options = postSourceOptionsOf(
      sources({
        tokens: [
          {
            id: TOKEN_A,
            name: 'ブログ連携',
            revoked: false,
            createdAt: new Date('2026-09-01T00:00:00Z'),
          },
          {
            id: TOKEN_B,
            name: 'ブログ連携',
            revoked: false,
            createdAt: new Date('2026-10-01T00:00:00Z'),
          },
          {
            id: TOKEN_C,
            name: 'ショップ連携',
            revoked: false,
            createdAt: new Date('2026-10-02T00:00:00Z'),
          },
        ],
      }),
      formatIssuedDate,
    );

    expect(options.find((option) => option.value === `token:${TOKEN_A}`)?.label).toBe(
      'ブログ連携（発行 2026-09-01）',
    );
    expect(options.find((option) => option.value === `token:${TOKEN_B}`)?.label).toBe(
      'ブログ連携（発行 2026-10-01）',
    );
    expect(options.find((option) => option.value === `token:${TOKEN_C}`)?.label).toBe(
      'ショップ連携',
    );
  });

  it('#74 発行日は渡した書式の関数で作る', async () => {
    const { postSourceOptionsOf } = await load();
    const format = vi.fn(() => '2026/10/01');

    const options = postSourceOptionsOf(
      sources({
        tokens: [
          { id: TOKEN_A, name: 'ブログ連携', revoked: false, createdAt: new Date('2026-09-01') },
          { id: TOKEN_B, name: 'ブログ連携', revoked: false, createdAt: new Date('2026-10-01') },
        ],
      }),
      format,
    );

    expect(format).toHaveBeenCalled();
    expect(options.find((option) => option.value === `token:${TOKEN_A}`)?.label).toBe(
      'ブログ連携（発行 2026/10/01）',
    );
  });

  it('#74 失効したトークンは名前に「（失効）」を付ける', async () => {
    const { postSourceOptionsOf } = await load();

    const options = postSourceOptionsOf(
      sources({
        tokens: [
          { id: TOKEN_A, name: 'ショップ連携', revoked: true, createdAt: new Date('2026-09-01') },
        ],
      }),
      formatIssuedDate,
    );

    expect(options.find((option) => option.value === `token:${TOKEN_A}`)?.label).toBe(
      'ショップ連携（失効）',
    );
  });

  it('#74 hasDeletedTokenPosts: false なら「削除されたトークン」を出さない', async () => {
    const { postSourceOptionsOf } = await load();

    const options = postSourceOptionsOf(sources({ hasDeletedTokenPosts: false }), formatIssuedDate);

    expect(options.some((option) => option.value === 'deleted')).toBe(false);
  });

  it('#74 hasScreenPosts: true なら「管理画面」を出す', async () => {
    const { postSourceOptionsOf } = await load();

    const options = postSourceOptionsOf(sources({ hasScreenPosts: true }), formatIssuedDate);

    expect(options).toContainEqual({ value: 'screen', label: '管理画面' });
  });
});

// ---------------------------------------------------------------------------
// 行の登録元の表示（設計 §9.8 の PostSourceView。実装プラン T8）
// ---------------------------------------------------------------------------

describe('postSourceViewOf（行にトークンの ID を渡さない。設計 §5.6・§9.8）', () => {
  it('token → kind・名前・失効だけ（tokenId を含まない）', async () => {
    const { postSourceViewOf } = await load();

    const view = postSourceViewOf({
      kind: 'token',
      tokenId: TOKEN_A,
      name: 'ブログ連携',
      revoked: true,
    });

    expect(view).toMatchObject({ kind: 'token', label: 'ブログ連携', revoked: true });
    expect(JSON.stringify(view)).not.toContain(TOKEN_A);
  });

  it('deleted_token → kind と名前', async () => {
    const { postSourceViewOf } = await load();

    expect(postSourceViewOf({ kind: 'deleted_token', name: '消えた連携' })).toEqual({
      kind: 'deleted_token',
      label: '消えた連携',
    });
  });

  it('screen → kind だけ', async () => {
    const { postSourceViewOf } = await load();

    expect(postSourceViewOf({ kind: 'screen' })).toEqual({ kind: 'screen' });
  });
});
