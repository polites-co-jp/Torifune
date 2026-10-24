import { describe, expect, it } from 'vitest';

/**
 * SNS 画面のタブと URL の純関数（055-social-pending-tab 設計 §5.1・§5.7・§9.1・§9.6・§9.12、
 * 受け入れ条件 #40、実装プラン §8 の 18・19・26・49）。
 *
 * * #40：`parseSocialTab` は文字列で `posts` / `accounts` / `history` のどれかのときだけそのタブ。
 *   無い・`'pending'`・知らない値・空・配列は送信待ち（設定画面の `toTab` の `String(value)` は写さない。§8 の 26）。
 *   `socialTabHref('pending')` は `/social`（`tab` を書かない）、他は `/social?tab=<key>`
 * * §8 の 18：`postFormReturnTo(from)` は `'pending'` だけ `/social`、他はすべて `/social?tab=posts`
 *   （許す値は 2 つだけ。任意の URL を受け取らない＝オープンリダイレクトにしない。設計 §5.7）
 * * §8 の 19・49：`historyListHref({ status, page })` は配信履歴タブの URL。すべて・1 ページ目は `/social?tab=history`
 *
 * `ui/social/social-tabs.ts` はまだ無いので、指定子を `string` の定数に置いた動的 import で読む
 * （054 実装プラン §8 の 43）。口の形は設計 §9.12・実装プラン §8 の 18・19 から写す。
 * `historyListHref` の `status` は、`SocialHistory` の props の `status`（`''` はすべて。設計 §9.6）と
 * Server Component の `historyStatus`（`published` / `failed` 以外は `null`。§8 の 49）の両方から呼べるよう、
 * `''` と `null` のどちらも「すべて」と読む（実装プラン §8 の 58）。
 */

type SocialTabKey = 'pending' | 'posts' | 'accounts' | 'history';

type QueryValue = string | readonly string[] | undefined;

interface SocialTabsModule {
  readonly SOCIAL_TAB_KEYS: readonly SocialTabKey[];
  readonly parseSocialTab: (value: QueryValue) => SocialTabKey;
  readonly socialTabHref: (key: SocialTabKey) => string;
  readonly postFormReturnTo: (from: QueryValue) => string;
  readonly historyListHref: (input: {
    readonly status: string | null;
    readonly page: number;
  }) => string;
}

const MODULE: string = '@/ui/social/social-tabs';

async function load(): Promise<SocialTabsModule> {
  const module = (await import(/* @vite-ignore */ MODULE)) as Partial<SocialTabsModule>;
  for (const name of [
    'parseSocialTab',
    'socialTabHref',
    'postFormReturnTo',
    'historyListHref',
  ] as const) {
    if (typeof module[name] !== 'function') {
      throw new Error(`ui/social/social-tabs.ts に ${name} が無い`);
    }
  }
  if (!Array.isArray(module.SOCIAL_TAB_KEYS)) {
    throw new Error('ui/social/social-tabs.ts に SOCIAL_TAB_KEYS が無い');
  }
  return module as SocialTabsModule;
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
// #40 タブのキー・parseSocialTab・socialTabHref
// ---------------------------------------------------------------------------

describe('#40 SOCIAL_TAB_KEYS', () => {
  it('#40 タブは送信待ち・投稿・アカウント・配信履歴の 4 つで、この順（設計 §5.1）', async () => {
    const { SOCIAL_TAB_KEYS } = await load();

    expect([...SOCIAL_TAB_KEYS]).toEqual(['pending', 'posts', 'accounts', 'history']);
  });
});

describe('#40 parseSocialTab', () => {
  it.each([
    ['無い（undefined）', undefined],
    ["'pending'", 'pending'],
    ["知らない値 'xxx'", 'xxx'],
    ["配列 ['posts']", ['posts']],
    ["空 ''", ''],
  ] as const)('#40 %s → pending（送信待ち）', async (_label, value) => {
    const { parseSocialTab } = await load();

    expect(parseSocialTab(value)).toBe('pending');
  });

  it.each(['posts', 'accounts', 'history'] as const)('#40 %s → そのまま', async (value) => {
    const { parseSocialTab } = await load();

    expect(parseSocialTab(value)).toBe(value);
  });

  it("#40 大文字の 'POSTS' は知らない値（送信待ち）", async () => {
    const { parseSocialTab } = await load();

    expect(parseSocialTab('POSTS')).toBe('pending');
  });
});

describe('#40 socialTabHref', () => {
  it('#40 pending → /social（tab を書かない）', async () => {
    const { socialTabHref } = await load();

    expect(socialTabHref('pending')).toBe('/social');
  });

  it.each(['posts', 'accounts', 'history'] as const)('#40 %s → /social?tab=%s', async (key) => {
    const { socialTabHref } = await load();

    expect(socialTabHref(key)).toBe(`/social?tab=${key}`);
  });

  it('#40 書いた href を parseSocialTab で読み直すと元のタブに戻る', async () => {
    const { SOCIAL_TAB_KEYS, parseSocialTab, socialTabHref } = await load();

    for (const key of SOCIAL_TAB_KEYS) {
      expect(parseSocialTab(parseHref(socialTabHref(key)).query['tab']), key).toBe(key);
    }
  });

  it('#40 どのタブの href もアンカーを付けない', async () => {
    const { SOCIAL_TAB_KEYS, socialTabHref } = await load();

    for (const key of SOCIAL_TAB_KEYS) {
      expect(socialTabHref(key), key).not.toContain('#');
    }
  });
});

// ---------------------------------------------------------------------------
// §8 の 18 postFormReturnTo
// ---------------------------------------------------------------------------

describe('postFormReturnTo（設計 §5.7・§9.12、実装プラン §8 の 18）', () => {
  it("'pending' → /social（送信待ちタブ）", async () => {
    const { postFormReturnTo } = await load();

    expect(postFormReturnTo('pending')).toBe('/social');
  });

  it.each([
    ['無い（undefined）', undefined],
    ["'posts'", 'posts'],
    ['任意の URL', 'https://example.com'],
    ["配列 ['pending']", ['pending']],
    ["空 ''", ''],
    ['パス', '/settings'],
  ] as const)('%s → /social?tab=posts（許す値は 2 つだけ）', async (_label, value) => {
    const { postFormReturnTo } = await load();

    expect(postFormReturnTo(value)).toBe('/social?tab=posts');
  });
});

// ---------------------------------------------------------------------------
// §8 の 19 historyListHref
// ---------------------------------------------------------------------------

describe('historyListHref（設計 §9.6・§9.12、実装プラン §8 の 19・49）', () => {
  it('すべて（null）・1 ページ目 → /social?tab=history', async () => {
    const { historyListHref } = await load();

    expect(historyListHref({ status: null, page: 1 })).toBe('/social?tab=history');
  });

  it("すべて（''）・1 ページ目 → /social?tab=history（SocialHistory の props の status）", async () => {
    const { historyListHref } = await load();

    expect(historyListHref({ status: '', page: 1 })).toBe('/social?tab=history');
  });

  it('failed・3 ページ目 → /social?tab=history&historyStatus=failed&historyPage=3', async () => {
    const { historyListHref } = await load();

    expect(historyListHref({ status: 'failed', page: 3 })).toBe(
      '/social?tab=history&historyStatus=failed&historyPage=3',
    );
  });

  it('published・1 ページ目は historyPage を書かない', async () => {
    const { historyListHref } = await load();

    expect(parseHref(historyListHref({ status: 'published', page: 1 })).query).toEqual({
      tab: 'history',
      historyStatus: 'published',
    });
  });

  it('すべて・2 ページ目は historyStatus を書かない', async () => {
    const { historyListHref } = await load();

    expect(parseHref(historyListHref({ status: null, page: 2 })).query).toEqual({
      tab: 'history',
      historyPage: '2',
    });
  });

  it('送信待ち・投稿のクエリ（status・page）の名前を使わない', async () => {
    const { historyListHref } = await load();
    const { query } = parseHref(historyListHref({ status: 'failed', page: 2 }));

    expect(Object.keys(query).sort()).toEqual(['historyPage', 'historyStatus', 'tab']);
  });

  it('アンカーを付けない', async () => {
    const { historyListHref } = await load();

    expect(historyListHref({ status: 'failed', page: 2 })).not.toContain('#');
  });
});
