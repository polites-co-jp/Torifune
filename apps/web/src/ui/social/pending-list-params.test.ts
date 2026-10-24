import { describe, expect, it } from 'vitest';

/**
 * 送信待ちタブの URL のクエリ（055-social-pending-tab 設計 §9.2、受け入れ条件 #41）。
 *
 * * `parsePendingListParams`：設計 §9.2 の表のとおりに読み、誤った値は無視して既定にする
 *   （`pendingSort` の `'TIME'`・`'xxx'`・配列 → `action`）
 * * `pendingListHref`：既定値（すべて・20・手が要るもの順・1 ページ目）は書かず、既定だけなら `/social`。
 *   `sort: 'time'` で `pendingSort=time`。`tab` を書かず、アンカーを付けず、1 ページ目は `pendingPage` を書かない
 *
 * `ui/social/pending-list-params.ts` はまだ無いので、指定子を `string` の定数に置いた動的 import で読む
 * （054 実装プラン §8 の 43）。条件の形は設計が決めていないので、054 の `PostListFilters` に並び順を足した形
 * （`status`・`accountId`・`source`・`perPage`・`sort`・`page`）と読んだ（実装プラン §8 の 59）。
 * `status` は送信待ちの区分（`PendingKind`）。登録元・表示件数の読み方は `post-list-params.ts` と同じ（設計 §6）。
 */

type PendingKind = 'manual_pending' | 'awaiting_approval' | 'scheduled';
type PendingSort = 'action' | 'time';

type PostSourceFilter =
  | { readonly kind: 'screen' }
  | { readonly kind: 'token'; readonly tokenId: string }
  | { readonly kind: 'deleted_token' };

interface PendingListFilters {
  readonly status: PendingKind | null;
  readonly accountId: string | null;
  readonly source: PostSourceFilter | null;
  readonly perPage: number;
  readonly sort: PendingSort;
  readonly page: number;
}

type SearchParams = Record<string, string | readonly string[] | undefined>;

interface PendingListParamsModule {
  readonly parsePendingListParams: (params: SearchParams) => PendingListFilters;
  readonly pendingListHref: (filters: PendingListFilters) => string;
}

const MODULE: string = '@/ui/social/pending-list-params';

async function load(): Promise<PendingListParamsModule> {
  const module = (await import(/* @vite-ignore */ MODULE)) as Partial<PendingListParamsModule>;
  for (const name of ['parsePendingListParams', 'pendingListHref'] as const) {
    if (typeof module[name] !== 'function') {
      throw new Error(`ui/social/pending-list-params.ts に ${name} が無い`);
    }
  }
  return module as PendingListParamsModule;
}

const ACCOUNT = '01920000-0000-7000-8000-0000000055ac';
const TOKEN = '01920000-0000-7000-8000-00000055b106';

const DEFAULTS: PendingListFilters = {
  status: null,
  accountId: null,
  source: null,
  perPage: 20,
  sort: 'action',
  page: 1,
};

function filters(overrides: Partial<PendingListFilters> = {}): PendingListFilters {
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

// ---------------------------------------------------------------------------
// #41 parsePendingListParams（設計 §9.2 の表）
// ---------------------------------------------------------------------------

describe('#41 parsePendingListParams（設計 §9.2 の表）', () => {
  it('#41 クエリが無い → すべて・20 件・手が要るもの順・1 ページ目', async () => {
    const { parsePendingListParams } = await load();

    expect(parsePendingListParams({})).toEqual(DEFAULTS);
  });

  it.each(['awaiting_approval', 'manual_pending', 'scheduled'] as const)(
    '#41 pendingStatus=%s → status',
    async (value) => {
      const { parsePendingListParams } = await load();

      expect(parsePendingListParams({ pendingStatus: value }).status).toBe(value);
    },
  );

  it.each([
    ['下書き（送信待ちでない状態）', 'draft'],
    ['配信済み', 'published'],
    ['知らない値', 'xxx'],
    ['大文字', 'MANUAL_PENDING'],
    ['空', ''],
    ['配列', ['scheduled']],
  ] as const)('#41 pendingStatus が %s → 無視（null）', async (_label, value) => {
    const { parsePendingListParams } = await load();

    expect(parsePendingListParams({ pendingStatus: value }).status).toBeNull();
  });

  it('#41 pendingAccount が UUID の形 → accountId', async () => {
    const { parsePendingListParams } = await load();

    expect(parsePendingListParams({ pendingAccount: ACCOUNT }).accountId).toBe(ACCOUNT);
  });

  it.each([
    ['UUID の形でない', 'abc'],
    ['空', ''],
    ['配列', [ACCOUNT]],
  ] as const)('#41 pendingAccount が %s → 無視（null）', async (_label, value) => {
    const { parsePendingListParams } = await load();

    expect(parsePendingListParams({ pendingAccount: value }).accountId).toBeNull();
  });

  it.each([
    ['screen', { kind: 'screen' }],
    ['deleted', { kind: 'deleted_token' }],
    [`token:${TOKEN}`, { kind: 'token', tokenId: TOKEN }],
  ] as const)(
    '#41 pendingSource=%s → source（054 の postSource と同じ）',
    async (value, expected) => {
      const { parsePendingListParams } = await load();

      expect(parsePendingListParams({ pendingSource: value }).source).toEqual(expected);
    },
  );

  it.each([
    ['知らない値', 'xxx'],
    ['token: の後が UUID でない', 'token:abc'],
    ['配列', ['screen']],
  ] as const)('#41 pendingSource が %s → 無視（null）', async (_label, value) => {
    const { parsePendingListParams } = await load();

    expect(parsePendingListParams({ pendingSource: value }).source).toBeNull();
  });

  it.each([
    ['20', 20],
    ['50', 50],
    ['100', 100],
  ] as const)('#41 pendingPerPage=%s → %i', async (value, expected) => {
    const { parsePendingListParams } = await load();

    expect(parsePendingListParams({ pendingPerPage: value }).perPage).toBe(expected);
  });

  it.each([
    ['範囲外', '30'],
    ['数でない', 'abc'],
    ['配列', ['50']],
  ] as const)('#41 pendingPerPage が %s → 無視（20）', async (_label, value) => {
    const { parsePendingListParams } = await load();

    expect(parsePendingListParams({ pendingPerPage: value }).perPage).toBe(20);
  });

  it.each(['action', 'time'] as const)('#41 pendingSort=%s → sort', async (value) => {
    const { parsePendingListParams } = await load();

    expect(parsePendingListParams({ pendingSort: value }).sort).toBe(value);
  });

  it.each([
    ['大文字の TIME', 'TIME'],
    ['知らない値', 'xxx'],
    ['空', ''],
    ['配列', ['time']],
  ] as const)('#41 pendingSort が %s → 無視（action）', async (_label, value) => {
    const { parsePendingListParams } = await load();

    expect(parsePendingListParams({ pendingSort: value }).sort).toBe('action');
  });

  it.each([
    ['2', 2],
    ['0', 1],
    ['abc', 1],
  ] as const)('#41 pendingPage=%s → %i（normalizePage で丸める）', async (value, expected) => {
    const { parsePendingListParams } = await load();

    expect(parsePendingListParams({ pendingPage: value }).page).toBe(expected);
  });

  it('#41 投稿タブ・配信履歴タブのクエリは読まない（互いに干渉しない。設計 §5.1）', async () => {
    const { parsePendingListParams } = await load();

    expect(
      parsePendingListParams({
        postStatus: 'awaiting_approval',
        postAccount: ACCOUNT,
        postSource: 'screen',
        postPerPage: '50',
        postPage: '3',
        historyStatus: 'failed',
        historyPage: '2',
        status: 'scheduled',
        page: '4',
      }),
    ).toEqual(DEFAULTS);
  });

  it('#41 誤ったクエリを混ぜても、正しい項目だけを読む', async () => {
    const { parsePendingListParams } = await load();

    expect(
      parsePendingListParams({
        pendingStatus: 'manual_pending',
        pendingAccount: 'abc',
        pendingSource: 'screen',
        pendingPerPage: '30',
        pendingSort: 'time',
      }),
    ).toEqual(filters({ status: 'manual_pending', source: { kind: 'screen' }, sort: 'time' }));
  });
});

// ---------------------------------------------------------------------------
// #41 pendingListHref
// ---------------------------------------------------------------------------

describe('#41 pendingListHref', () => {
  it('#41 既定値だけなら /social（pendingSort=action も書かない）', async () => {
    const { pendingListHref } = await load();

    expect(pendingListHref(DEFAULTS)).toBe('/social');
  });

  it("#41 sort: 'time' で pendingSort=time を書く", async () => {
    const { pendingListHref } = await load();

    expect(parseHref(pendingListHref(filters({ sort: 'time' })))).toEqual({
      pathname: '/social',
      hash: '',
      query: { pendingSort: 'time' },
    });
  });

  it('#41 条件を持つ項目だけをクエリに書く（既定値は書かない）', async () => {
    const { pendingListHref } = await load();

    expect(
      parseHref(
        pendingListHref(
          filters({
            status: 'awaiting_approval',
            accountId: ACCOUNT,
            source: { kind: 'token', tokenId: TOKEN },
            perPage: 100,
            sort: 'time',
            page: 2,
          }),
        ),
      ),
    ).toEqual({
      pathname: '/social',
      hash: '',
      query: {
        pendingStatus: 'awaiting_approval',
        pendingAccount: ACCOUNT,
        pendingSource: `token:${TOKEN}`,
        pendingPerPage: '100',
        pendingSort: 'time',
        pendingPage: '2',
      },
    });
  });

  it('#41 tab を書かない（送信待ちは既定のタブ）', async () => {
    const { pendingListHref } = await load();

    expect(
      parseHref(pendingListHref(filters({ status: 'scheduled', sort: 'time', page: 3 }))).query,
    ).not.toHaveProperty('tab');
  });

  it('#41 アンカーを付けない（条件があっても）', async () => {
    const { pendingListHref } = await load();

    expect(
      pendingListHref(filters({ status: 'manual_pending', perPage: 50, sort: 'time', page: 2 })),
    ).not.toContain('#');
    expect(pendingListHref(DEFAULTS)).not.toContain('#');
  });

  it('#41 1 ページ目（条件を変えたとき）は pendingPage を書かない', async () => {
    const { pendingListHref } = await load();

    expect(parseHref(pendingListHref(filters({ status: 'scheduled', page: 1 }))).query).toEqual({
      pendingStatus: 'scheduled',
    });
  });

  it('#41 表示件数 20（既定）は pendingPerPage を書かない', async () => {
    const { pendingListHref } = await load();

    expect(parseHref(pendingListHref(filters({ source: { kind: 'screen' } }))).query).toEqual({
      pendingSource: 'screen',
    });
  });

  it('#41 登録元「削除されたトークン」は pendingSource=deleted', async () => {
    const { pendingListHref } = await load();

    expect(
      parseHref(pendingListHref(filters({ source: { kind: 'deleted_token' } }))).query,
    ).toEqual({ pendingSource: 'deleted' });
  });

  it('#41 投稿タブ・配信履歴タブのクエリの名前を使わない', async () => {
    const { pendingListHref } = await load();
    const keys = Object.keys(
      parseHref(
        pendingListHref(
          filters({
            status: 'scheduled',
            accountId: ACCOUNT,
            source: { kind: 'screen' },
            perPage: 50,
            sort: 'time',
            page: 2,
          }),
        ),
      ).query,
    );

    for (const key of keys) {
      expect(key, key).toMatch(/^pending/);
    }
  });

  it('#41 書いた href をクエリとして読み直すと元の条件に戻る', async () => {
    const { parsePendingListParams, pendingListHref } = await load();
    const original = filters({
      status: 'manual_pending',
      accountId: ACCOUNT,
      source: { kind: 'token', tokenId: TOKEN },
      perPage: 50,
      sort: 'time',
      page: 4,
    });

    expect(parsePendingListParams(parseHref(pendingListHref(original)).query)).toEqual(original);
  });
});
