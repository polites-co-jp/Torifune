import { describe, expect, it } from 'vitest';

/**
 * 区画（`AccessScope`）の純関数（053-site-scoped-social 設計 §5.2・§7.3・§8.1・§8.2.3・§8.2.4、受け入れ条件 #6〜#11）。
 *
 * * #6：`accountVisible` — 設計 §5.2 のアカウントの表の 9 通り
 * * #7：`accountManageable` — 9 通り（`ok` / `forbidden` / `not_found`）
 * * #8：`postVisible` — 設計 §5.2 の投稿の表の 15 通り（行 5 × 区画 3）
 * * #9：`originOf` — 3 通り
 * * #10：`resolveAccountSiteOnCreate` — 設計 §8.2.3 の表の各セル
 * * #11：`checkAccountSiteChange` — 設計 §8.2.4 の表
 *
 * `domain/social/access-scope.ts` はまだ無いので、**呼ぶ直前に動的に読む**（実装プラン §2 のテストの方法）。
 * 静的に import すると型検査が通らず、未実装の段階でこのファイル全体が読めなくなる。
 * 型はこのファイルの中で設計 §5.2・§8.1 から写す。
 */

type AccessScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'common' }
  | { readonly kind: 'site'; readonly siteId: string };

type Manageable = 'ok' | 'forbidden' | 'not_found';

interface PostScopeFacts {
  readonly accountSiteId: string | null;
  readonly originSiteId: string | null;
  readonly originSiteScoped: boolean;
}

interface Origin {
  readonly originSiteId: string | null;
  readonly originSiteScoped: boolean;
}

type SiteResolution =
  | { readonly ok: true; readonly siteId: string | null }
  | { readonly ok: false; readonly message: string };

type SiteChangeCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

interface AccessScopeModule {
  readonly ALL_SCOPE: AccessScope;
  accountVisible(scope: AccessScope, accountSiteId: string | null): boolean;
  accountManageable(scope: AccessScope, accountSiteId: string | null): Manageable;
  postVisible(scope: AccessScope, facts: PostScopeFacts): boolean;
  originOf(scope: AccessScope): Origin;
  resolveAccountSiteOnCreate(
    scope: AccessScope,
    requested: string | null | undefined,
  ): SiteResolution;
  checkAccountSiteChange(
    scope: AccessScope,
    currentSiteId: string | null,
    requested: string | null,
  ): SiteChangeCheck;
}

/** 未実装の段階で型検査を通すため、指定子は定数に置く。 */
const ACCESS_SCOPE_MODULE: string = '@/domain/social/access-scope';

async function load(): Promise<AccessScopeModule> {
  return (await import(/* @vite-ignore */ ACCESS_SCOPE_MODULE)) as AccessScopeModule;
}

const A = '01900000-0000-7000-8000-00000000000a';
const B = '01900000-0000-7000-8000-00000000000b';
/** どのサイトとしても存在しない ID（存在の確認は呼び出し側。#10）。 */
const MISSING = '01900000-0000-7000-8000-0000000000ff';

const ALL: AccessScope = { kind: 'all' };
const COMMON: AccessScope = { kind: 'common' };
const SITE_A: AccessScope = { kind: 'site', siteId: A };

const SCOPES = { all: ALL, common: COMMON, 'site:A': SITE_A } as const;
type ScopeName = keyof typeof SCOPES;

/** 設計 §5.2 のアカウントの行（`accountSiteId`）。 */
const ACCOUNTS = { 共通: null, A専用: A, B専用: B } as const;
type AccountName = keyof typeof ACCOUNTS;

/** 設計 §8.2.3・§8.2.4 の文言。 */
const MESSAGE_COMMON_TOKEN_CANNOT_LINK =
  'APIトークンではアカウントをサイトに紐づけられません。管理画面で紐づけてください。';
const MESSAGE_SITE_TOKEN_OTHER_SITE =
  'サイトに紐づいたトークンでは、そのサイト以外を指定できません。';
const MESSAGE_TOKEN_CANNOT_CHANGE_SITE =
  'APIトークンではアカウントのサイトを変えられません。管理画面で変えてください。';

/* -------------------------------------------------------------------------- */
/* ALL_SCOPE                                                                     */
/* -------------------------------------------------------------------------- */

describe('ALL_SCOPE', () => {
  it("ALL_SCOPE は { kind: 'all' }（画面のセッション・内部処理の区画。設計 §8.1）", async () => {
    const { ALL_SCOPE } = await load();

    expect(ALL_SCOPE).toEqual({ kind: 'all' });
  });
});

/* -------------------------------------------------------------------------- */
/* #6 accountVisible                                                             */
/* -------------------------------------------------------------------------- */

describe('#6 accountVisible（設計 §5.2 のアカウントの表の 9 通り）', () => {
  const cases: readonly (readonly [ScopeName, AccountName, boolean])[] = [
    ['all', '共通', true],
    ['all', 'A専用', true],
    ['all', 'B専用', true],
    ['common', '共通', true],
    ['common', 'A専用', false],
    ['common', 'B専用', false],
    ['site:A', '共通', true],
    ['site:A', 'A専用', true],
    ['site:A', 'B専用', false],
  ];

  it.each(cases)(
    '#6 区画 %s から %s のアカウントが見えるか → %s',
    async (scope, account, visible) => {
      const { accountVisible } = await load();

      expect(accountVisible(SCOPES[scope], ACCOUNTS[account])).toBe(visible);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #7 accountManageable                                                          */
/* -------------------------------------------------------------------------- */

describe('#7 accountManageable（ok / forbidden / not_found）', () => {
  const cases: readonly (readonly [ScopeName, AccountName, Manageable])[] = [
    ['all', '共通', 'ok'],
    ['all', 'A専用', 'ok'],
    ['all', 'B専用', 'ok'],
    ['common', '共通', 'ok'],
    ['common', 'A専用', 'not_found'],
    ['common', 'B専用', 'not_found'],
    // サイトのトークンは共通のアカウントを見えるが変えられない（設計 §5.5）。
    ['site:A', '共通', 'forbidden'],
    ['site:A', 'A専用', 'ok'],
    ['site:A', 'B専用', 'not_found'],
  ];

  it.each(cases)(
    '#7 区画 %s から %s のアカウントを変える → %s',
    async (scope, account, expected) => {
      const { accountManageable } = await load();

      expect(accountManageable(SCOPES[scope], ACCOUNTS[account])).toBe(expected);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #8 postVisible                                                                */
/* -------------------------------------------------------------------------- */

describe('#8 postVisible（設計 §5.2 の投稿の表の 15 通り）', () => {
  /** 設計 §5.2 の投稿の表の 5 行。 */
  const POSTS = {
    'A 専用アカウントの投稿': { accountSiteId: A, originSiteId: null, originSiteScoped: false },
    '共通アカウントの投稿で、A のトークンが登録': {
      accountSiteId: null,
      originSiteId: A,
      originSiteScoped: true,
    },
    '共通アカウントの投稿で、共通のトークン・画面・Plugin が登録': {
      accountSiteId: null,
      originSiteId: null,
      originSiteScoped: false,
    },
    '共通アカウントの投稿で、削除されたサイトのトークンが登録': {
      accountSiteId: null,
      originSiteId: null,
      originSiteScoped: true,
    },
    'B 専用アカウントの投稿': { accountSiteId: B, originSiteId: null, originSiteScoped: false },
  } as const satisfies Record<string, PostScopeFacts>;
  type PostName = keyof typeof POSTS;

  const cases: readonly (readonly [PostName, ScopeName, boolean])[] = [
    ['A 専用アカウントの投稿', 'all', true],
    ['A 専用アカウントの投稿', 'common', false],
    ['A 専用アカウントの投稿', 'site:A', true],
    ['共通アカウントの投稿で、A のトークンが登録', 'all', true],
    ['共通アカウントの投稿で、A のトークンが登録', 'common', false],
    ['共通アカウントの投稿で、A のトークンが登録', 'site:A', true],
    ['共通アカウントの投稿で、共通のトークン・画面・Plugin が登録', 'all', true],
    ['共通アカウントの投稿で、共通のトークン・画面・Plugin が登録', 'common', true],
    ['共通アカウントの投稿で、共通のトークン・画面・Plugin が登録', 'site:A', false],
    ['共通アカウントの投稿で、削除されたサイトのトークンが登録', 'all', true],
    ['共通アカウントの投稿で、削除されたサイトのトークンが登録', 'common', false],
    ['共通アカウントの投稿で、削除されたサイトのトークンが登録', 'site:A', false],
    ['B 専用アカウントの投稿', 'all', true],
    ['B 専用アカウントの投稿', 'common', false],
    ['B 専用アカウントの投稿', 'site:A', false],
  ];

  it.each(cases)('#8 %s は区画 %s から見えるか → %s', async (post, scope, visible) => {
    const { postVisible } = await load();

    expect(postVisible(SCOPES[scope], POSTS[post])).toBe(visible);
  });

  it('#8 共通アカウント・originSiteScoped: true・originSiteId: null は all だけ真', async () => {
    const { postVisible } = await load();
    const orphan = { accountSiteId: null, originSiteId: null, originSiteScoped: true };

    expect(
      [ALL, COMMON, SITE_A, { kind: 'site', siteId: B } as const].map((scope) =>
        postVisible(scope, orphan),
      ),
    ).toEqual([true, false, false, false]);
  });

  it('#8 A 専用アカウントの投稿は、登録元（B のトークン）によらず A の区画から見える', async () => {
    // 設計 §5.2 の 1：アカウントがサイト専用なら、そのサイト（登録したのが誰でも）。
    const { postVisible } = await load();
    const facts = { accountSiteId: A, originSiteId: B, originSiteScoped: true };

    expect(postVisible(SITE_A, facts)).toBe(true);
    expect(postVisible({ kind: 'site', siteId: B }, facts)).toBe(false);
    expect(postVisible(COMMON, facts)).toBe(false);
  });

  it('#8 A 専用アカウントの投稿は、登録元が共通の区画でも共通のトークンから見えない', async () => {
    const { postVisible } = await load();

    expect(
      postVisible(COMMON, { accountSiteId: A, originSiteId: null, originSiteScoped: false }),
    ).toBe(false);
  });

  it('#8 共通アカウントで B のトークンが登録した投稿は、A の区画から見えず B の区画から見える', async () => {
    const { postVisible } = await load();
    const facts = { accountSiteId: null, originSiteId: B, originSiteScoped: true };

    expect(postVisible(SITE_A, facts)).toBe(false);
    expect(postVisible({ kind: 'site', siteId: B }, facts)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #9 originOf                                                                   */
/* -------------------------------------------------------------------------- */

describe('#9 originOf（登録元の区画。設計 §7.3）', () => {
  it.each([
    ['all', { originSiteId: null, originSiteScoped: false }],
    ['common', { originSiteId: null, originSiteScoped: false }],
    ['site:A', { originSiteId: A, originSiteScoped: true }],
  ] as const)('#9 区画 %s → %o', async (scope, expected) => {
    const { originOf } = await load();

    expect(originOf(SCOPES[scope])).toEqual(expected);
  });
});

/* -------------------------------------------------------------------------- */
/* #10 resolveAccountSiteOnCreate                                                */
/* -------------------------------------------------------------------------- */

describe('#10 resolveAccountSiteOnCreate（設計 §8.2.3 の表）', () => {
  /** `requested` の列（省略 = undefined）。 */
  const REQUESTED = {
    省略: undefined,
    null: null,
    '自分のサイト A': A,
    '別のサイト B': B,
    存在しないサイト: MISSING,
  } as const;
  type RequestedName = keyof typeof REQUESTED;

  const ok: readonly (readonly [ScopeName, RequestedName, string | null])[] = [
    ['all', '省略', null],
    ['all', 'null', null],
    ['all', '自分のサイト A', A],
    ['all', '別のサイト B', B],
    // 存在の確認は呼び出し側（UseCase）。関数は all に対して指定値を返す。
    ['all', '存在しないサイト', MISSING],
    ['common', '省略', null],
    ['common', 'null', null],
    // サイトのトークンが作るアカウントはそのサイトに自動で紐づく。
    ['site:A', '省略', A],
    ['site:A', '自分のサイト A', A],
  ];

  it.each(ok)('#10 区画 %s で siteId が %s → ok・siteId %s', async (scope, requested, siteId) => {
    const { resolveAccountSiteOnCreate } = await load();

    expect(resolveAccountSiteOnCreate(SCOPES[scope], REQUESTED[requested])).toEqual({
      ok: true,
      siteId,
    });
  });

  const rejected: readonly (readonly [ScopeName, RequestedName, string])[] = [
    ['common', '自分のサイト A', MESSAGE_COMMON_TOKEN_CANNOT_LINK],
    ['common', '別のサイト B', MESSAGE_COMMON_TOKEN_CANNOT_LINK],
    ['common', '存在しないサイト', MESSAGE_COMMON_TOKEN_CANNOT_LINK],
    ['site:A', 'null', MESSAGE_SITE_TOKEN_OTHER_SITE],
    ['site:A', '別のサイト B', MESSAGE_SITE_TOKEN_OTHER_SITE],
    ['site:A', '存在しないサイト', MESSAGE_SITE_TOKEN_OTHER_SITE],
  ];

  it.each(rejected)(
    '#10 区画 %s で siteId が %s → ok: false（文言 %s）',
    async (scope, requested, message) => {
      const { resolveAccountSiteOnCreate } = await load();

      expect(resolveAccountSiteOnCreate(SCOPES[scope], REQUESTED[requested])).toEqual({
        ok: false,
        message,
      });
    },
  );

  it('#10 site:A で null と B の文言が同じ（サイトの存在を教えない）', async () => {
    const { resolveAccountSiteOnCreate } = await load();
    const withNull = resolveAccountSiteOnCreate(SITE_A, null);
    const withOther = resolveAccountSiteOnCreate(SITE_A, B);
    const withMissing = resolveAccountSiteOnCreate(SITE_A, MISSING);

    expect(withNull.ok).toBe(false);
    expect(withOther).toEqual(withNull);
    expect(withMissing).toEqual(withNull);
  });
});

/* -------------------------------------------------------------------------- */
/* #11 checkAccountSiteChange                                                    */
/* -------------------------------------------------------------------------- */

describe('#11 checkAccountSiteChange（設計 §8.2.4 の表）', () => {
  it.each([
    ['共通 → A', null, A],
    ['A → B', A, B],
    ['A → 共通', A, null],
    ['A → A', A, A],
    ['共通 → 共通', null, null],
    ['A → 存在しないサイト（存在の確認は呼び出し側）', A, MISSING],
  ] as const)('#11 区画 all は %s でも ok', async (_label, current, requested) => {
    const { checkAccountSiteChange } = await load();

    expect(checkAccountSiteChange(ALL, current, requested)).toEqual({ ok: true });
  });

  it.each([
    ['common', '共通 → 共通', null, null],
    ['site:A', 'A → A', A, A],
    ['site:A', '共通 → 共通', null, null],
  ] as const)('#11 区画 %s で今と同じ値（%s）は ok', async (scope, _label, current, requested) => {
    const { checkAccountSiteChange } = await load();

    expect(checkAccountSiteChange(SCOPES[scope], current, requested)).toEqual({ ok: true });
  });

  it.each([
    ['common', '共通 → A', null, A],
    ['common', '共通 → B', null, B],
    ['site:A', 'A → 共通', A, null],
    ['site:A', 'A → B', A, B],
    ['site:A', '共通 → A', null, A],
  ] as const)(
    '#11 区画 %s で違う値（%s）は ok: false',
    async (scope, _label, current, requested) => {
      const { checkAccountSiteChange } = await load();

      expect(checkAccountSiteChange(SCOPES[scope], current, requested)).toEqual({
        ok: false,
        message: MESSAGE_TOKEN_CANNOT_CHANGE_SITE,
      });
    },
  );
});
