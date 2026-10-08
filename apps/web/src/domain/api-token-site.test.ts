import { describe, expect, it } from 'vitest';

/**
 * サイトのトークンの純関数（053-site-scoped-social 設計 §7.2・§8.5.3・§8.5.6、受け入れ条件 #12〜#14・#80）。
 *
 * * #12：`SITE_TOKEN_SCOPES` が SNS の 4 つ（順も）
 * * #13：`siteTokenUsable` — サイトの消えた・無い・アーカイブされたサイトのトークンは使えない。`paused` は使える
 * * #14：`effectiveSiteTokenPermissions` — 所有者 ∩ Scope ∩ `SITE_TOKEN_SCOPES`
 * * #80：`resolveTokenSiteChange` — 設計 §8.5.6 の表の 2〜7（1 の 404 は UseCase）
 *
 * `domain/api-token.ts` にまだ無い値なので、**呼ぶ直前に動的に読む**（`approval-static-checks.test.ts` と同じ）。
 * 入力・出力の形は実装プラン T5 と §8 の 17 から写す。`requestedScopes` の省略はキーを渡さないことで表す。
 */

type SiteStatus = 'active' | 'paused' | 'archived';

interface SiteTokenUsableInput {
  readonly siteScoped: boolean;
  readonly siteId: string | null;
  /** サイトが無ければ null。 */
  readonly siteStatus: SiteStatus | null;
}

interface ResolveTokenSiteChangeInput {
  readonly current: { readonly revokedAt: Date | null; readonly scopes: readonly string[] };
  readonly requestedSiteId: string | null;
  readonly requestedScopes?: readonly string[];
  /** `requestedSiteId` のサイト。無ければ null（`requestedSiteId` が null のときは見ない）。 */
  readonly site: { readonly status: SiteStatus } | null;
}

type ResolveTokenSiteChangeResult =
  | {
      readonly ok: true;
      readonly siteId: string | null;
      readonly siteScoped: boolean;
      readonly scopes: readonly string[];
      readonly removedScopes: readonly string[];
    }
  | { readonly ok: false; readonly field: 'siteId' | 'scopes'; readonly message: string };

interface ApiTokenSiteModule {
  readonly SITE_TOKEN_SCOPES: readonly string[];
  siteTokenUsable(input: SiteTokenUsableInput): boolean;
  effectiveSiteTokenPermissions(
    owner: ReadonlySet<string>,
    scopes: readonly string[],
  ): ReadonlySet<string>;
  resolveTokenSiteChange(input: ResolveTokenSiteChangeInput): ResolveTokenSiteChangeResult;
}

/** 未実装の値を型検査に掛けないため、指定子は定数に置く。 */
const API_TOKEN_MODULE: string = '@/domain/api-token';

async function load(): Promise<ApiTokenSiteModule> {
  return (await import(/* @vite-ignore */ API_TOKEN_MODULE)) as ApiTokenSiteModule;
}

const A = '01900000-0000-7000-8000-00000000000a';
const B = '01900000-0000-7000-8000-00000000000b';

const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'];

/** 設計 §8.5.6 の文言。 */
const MESSAGE_REVOKED = '失効したトークンは変えられません。';
const MESSAGE_SITE_NOT_FOUND = 'Webサイトが見つかりません。';
const MESSAGE_ARCHIVED = 'アーカイブしたサイトにはトークンを紐づけられません。';
const MESSAGE_WIDEN_PREFIX = '権限を広げることはできません: ';
const MESSAGE_SNS_ONLY_PREFIX =
  'サイトに紐づけるトークンには SNS の権限だけを指定できます。外す権限を scopes で指定し直してください: ';

/* -------------------------------------------------------------------------- */
/* #12 SITE_TOKEN_SCOPES                                                         */
/* -------------------------------------------------------------------------- */

describe('#12 SITE_TOKEN_SCOPES', () => {
  it("#12 ['social.read', 'social.write', 'social.delete', 'social.approve'] と順まで一致する", async () => {
    const { SITE_TOKEN_SCOPES } = await load();

    expect(SITE_TOKEN_SCOPES).toEqual([
      'social.read',
      'social.write',
      'social.delete',
      'social.approve',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* #13 siteTokenUsable                                                           */
/* -------------------------------------------------------------------------- */

describe('#13 siteTokenUsable（設計 §8.5.3）', () => {
  it.each([
    ['siteId: null・サイト無し', { siteId: null, siteStatus: null }],
    ['siteId: null・archived', { siteId: null, siteStatus: 'archived' }],
    ['siteId: A・archived', { siteId: A, siteStatus: 'archived' }],
    ['siteId: A・サイト無し', { siteId: A, siteStatus: null }],
    ['siteId: A・active', { siteId: A, siteStatus: 'active' }],
  ] as const)('#13 siteScoped: false（共通のトークン）は %s でも真', async (_label, rest) => {
    const { siteTokenUsable } = await load();

    expect(siteTokenUsable({ siteScoped: false, ...rest })).toBe(true);
  });

  it('#13 siteScoped: true で siteId: null（サイトが削除された）は偽', async () => {
    const { siteTokenUsable } = await load();

    expect(siteTokenUsable({ siteScoped: true, siteId: null, siteStatus: null })).toBe(false);
  });

  it('#13 siteScoped: true で siteId: null なら、状態に値があっても偽', async () => {
    const { siteTokenUsable } = await load();

    expect(siteTokenUsable({ siteScoped: true, siteId: null, siteStatus: 'active' })).toBe(false);
  });

  it('#13 siteScoped: true でサイトが無い（siteStatus: null）は偽', async () => {
    const { siteTokenUsable } = await load();

    expect(siteTokenUsable({ siteScoped: true, siteId: A, siteStatus: null })).toBe(false);
  });

  it('#13 siteScoped: true で archived は偽（裁定 8）', async () => {
    const { siteTokenUsable } = await load();

    expect(siteTokenUsable({ siteScoped: true, siteId: A, siteStatus: 'archived' })).toBe(false);
  });

  it('#13 siteScoped: true で paused は真（paused は影響しない）', async () => {
    const { siteTokenUsable } = await load();

    expect(siteTokenUsable({ siteScoped: true, siteId: A, siteStatus: 'paused' })).toBe(true);
  });

  it('#13 siteScoped: true で active は真', async () => {
    const { siteTokenUsable } = await load();

    expect(siteTokenUsable({ siteScoped: true, siteId: A, siteStatus: 'active' })).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #14 effectiveSiteTokenPermissions                                             */
/* -------------------------------------------------------------------------- */

describe('#14 effectiveSiteTokenPermissions（所有者 ∩ Scope ∩ SITE_TOKEN_SCOPES）', () => {
  it('#14 所有者 {social.read, site.read}・Scope [social.read, site.read] → {social.read}', async () => {
    // DB の制約をすり抜けた値（site.read）も落とす（設計 §7.2 の 3 か所の守りの 2 つ目）。
    const { effectiveSiteTokenPermissions } = await load();

    const result = effectiveSiteTokenPermissions(new Set(['social.read', 'site.read']), [
      'social.read',
      'site.read',
    ]);

    expect([...result].sort()).toEqual(['social.read']);
  });

  it('#14 所有者が持たない SNS の権限は Scope にあっても落ちる（所有者との交差）', async () => {
    const { effectiveSiteTokenPermissions } = await load();

    const result = effectiveSiteTokenPermissions(new Set(['social.read']), [
      'social.read',
      'social.write',
    ]);

    expect([...result].sort()).toEqual(['social.read']);
  });

  it('#14 所有者が SNS の 4 つを持ち、Scope が 4 つなら 4 つとも残る', async () => {
    const { effectiveSiteTokenPermissions } = await load();

    const result = effectiveSiteTokenPermissions(
      new Set([...SNS_SCOPES, 'site.read', 'system.manage', 'token.manage']),
      SNS_SCOPES,
    );

    expect([...result].sort()).toEqual([...SNS_SCOPES].sort());
  });

  it('#14 Scope が SNS 以外だけなら空', async () => {
    const { effectiveSiteTokenPermissions } = await load();

    const result = effectiveSiteTokenPermissions(new Set(['system.manage', 'token.manage']), [
      'system.manage',
      'token.manage',
    ]);

    expect([...result]).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* #80 resolveTokenSiteChange                                                    */
/* -------------------------------------------------------------------------- */

describe('#80 resolveTokenSiteChange（設計 §8.5.6 の表の 2〜7）', () => {
  const active = { status: 'active' } as const;
  const notRevoked = (scopes: readonly string[]) => ({ revokedAt: null, scopes });

  it('#80 失効している → 422 siteId「失効したトークンは変えられません。」', async () => {
    const { resolveTokenSiteChange } = await load();

    expect(
      resolveTokenSiteChange({
        current: { revokedAt: new Date('2026-10-01T00:00:00Z'), scopes: SNS_SCOPES },
        requestedSiteId: B,
        site: active,
      }),
    ).toEqual({ ok: false, field: 'siteId', message: MESSAGE_REVOKED });
  });

  it('#80 失効していれば共通へ（null）でも 422 siteId', async () => {
    const { resolveTokenSiteChange } = await load();

    expect(
      resolveTokenSiteChange({
        current: { revokedAt: new Date('2026-10-01T00:00:00Z'), scopes: SNS_SCOPES },
        requestedSiteId: null,
        site: null,
      }),
    ).toEqual({ ok: false, field: 'siteId', message: MESSAGE_REVOKED });
  });

  it('#80 scopes に今の Scope に無いもの → 422 scopes「権限を広げることはできません: <最初の 1 つ>」', async () => {
    const { resolveTokenSiteChange } = await load();

    expect(
      resolveTokenSiteChange({
        current: notRevoked(['social.read']),
        requestedSiteId: B,
        requestedScopes: ['social.read', 'social.delete', 'social.approve'],
        site: active,
      }),
    ).toEqual({ ok: false, field: 'scopes', message: `${MESSAGE_WIDEN_PREFIX}social.delete` });
  });

  it('#80 存在しないサイト（site: null）→ 422 siteId「Webサイトが見つかりません。」', async () => {
    const { resolveTokenSiteChange } = await load();

    expect(
      resolveTokenSiteChange({
        current: notRevoked(SNS_SCOPES),
        requestedSiteId: B,
        site: null,
      }),
    ).toEqual({ ok: false, field: 'siteId', message: MESSAGE_SITE_NOT_FOUND });
  });

  it('#80 アーカイブしたサイト → 422 siteId「アーカイブしたサイトにはトークンを紐づけられません。」', async () => {
    const { resolveTokenSiteChange } = await load();

    expect(
      resolveTokenSiteChange({
        current: notRevoked(SNS_SCOPES),
        requestedSiteId: B,
        site: { status: 'archived' },
      }),
    ).toEqual({ ok: false, field: 'siteId', message: MESSAGE_ARCHIVED });
  });

  it('#80 paused のサイトへは変えられる（アーカイブだけを断る）', async () => {
    const { resolveTokenSiteChange } = await load();

    const result = resolveTokenSiteChange({
      current: notRevoked(SNS_SCOPES),
      requestedSiteId: B,
      site: { status: 'paused' },
    });

    expect(result.ok).toBe(true);
  });

  it('#80 サイトへ・今の Scope が SNS だけ → ok・siteScoped: true・removedScopes: []', async () => {
    const { resolveTokenSiteChange } = await load();

    expect(
      resolveTokenSiteChange({
        current: notRevoked(['social.read', 'social.write']),
        requestedSiteId: B,
        site: active,
      }),
    ).toEqual({
      ok: true,
      siteId: B,
      siteScoped: true,
      scopes: ['social.read', 'social.write'],
      removedScopes: [],
    });
  });

  it('#80 サイトへ・今の Scope に site.read・scopes 省略 → 422 scopes（文言に site.read）', async () => {
    const { resolveTokenSiteChange } = await load();

    const result = resolveTokenSiteChange({
      current: notRevoked(['social.read', 'site.read']),
      requestedSiteId: B,
      site: active,
    });

    expect(result).toEqual({
      ok: false,
      field: 'scopes',
      message: expect.stringContaining('site.read'),
    });
    expect(result.ok === false && result.message.startsWith(MESSAGE_SNS_ONLY_PREFIX)).toBe(true);
  });

  it('#80 外れる権限が複数なら、文言にすべて並ぶ', async () => {
    const { resolveTokenSiteChange } = await load();

    const result = resolveTokenSiteChange({
      current: notRevoked(['social.read', 'site.read', 'campaign.read']),
      requestedSiteId: B,
      site: active,
    });

    expect(result.ok).toBe(false);
    const message = result.ok ? '' : result.message;
    expect(message.startsWith(MESSAGE_SNS_ONLY_PREFIX)).toBe(true);
    expect(message).toContain('site.read');
    expect(message).toContain('campaign.read');
    expect(message).not.toContain('social.read');
  });

  it("#80 同じで scopes: ['social.read'] → ok・removedScopes: ['site.read']", async () => {
    const { resolveTokenSiteChange } = await load();

    expect(
      resolveTokenSiteChange({
        current: notRevoked(['social.read', 'site.read']),
        requestedSiteId: B,
        requestedScopes: ['social.read'],
        site: active,
      }),
    ).toEqual({
      ok: true,
      siteId: B,
      siteScoped: true,
      scopes: ['social.read'],
      removedScopes: ['site.read'],
    });
  });

  it('#80 狭めた scopes にまだ SNS 以外が残れば 422 scopes', async () => {
    const { resolveTokenSiteChange } = await load();

    const result = resolveTokenSiteChange({
      current: notRevoked(['social.read', 'site.read', 'campaign.read']),
      requestedSiteId: B,
      requestedScopes: ['social.read', 'site.read'],
      site: active,
    });

    expect(result.ok === false ? result.field : null).toBe('scopes');
    expect(result.ok === false ? result.message : '').toContain('site.read');
  });

  it('#80 共通へ（null）→ ok・siteScoped: false（Scope の制限は掛からない）', async () => {
    const { resolveTokenSiteChange } = await load();

    expect(
      resolveTokenSiteChange({
        current: notRevoked(['social.read', 'site.read']),
        requestedSiteId: null,
        site: null,
      }),
    ).toEqual({
      ok: true,
      siteId: null,
      siteScoped: false,
      scopes: ['social.read', 'site.read'],
      removedScopes: [],
    });
  });

  it('#80 共通へでも scopes で狭められる（広げられないだけ）', async () => {
    const { resolveTokenSiteChange } = await load();

    expect(
      resolveTokenSiteChange({
        current: notRevoked(['social.read', 'site.read']),
        requestedSiteId: null,
        requestedScopes: ['social.read'],
        site: null,
      }),
    ).toEqual({
      ok: true,
      siteId: null,
      siteScoped: false,
      scopes: ['social.read'],
      removedScopes: ['site.read'],
    });
  });

  it('#80 共通へでも scopes を広げれば 422 scopes', async () => {
    const { resolveTokenSiteChange } = await load();

    expect(
      resolveTokenSiteChange({
        current: notRevoked(['social.read']),
        requestedSiteId: null,
        requestedScopes: ['social.read', 'site.read'],
        site: null,
      }),
    ).toEqual({ ok: false, field: 'scopes', message: `${MESSAGE_WIDEN_PREFIX}site.read` });
  });

  it('#80 scopes を空にしてサイトへ → ok・scopes: []・removedScopes は今の Scope のすべて', async () => {
    const { resolveTokenSiteChange } = await load();

    const result = resolveTokenSiteChange({
      current: notRevoked(['social.read', 'site.read']),
      requestedSiteId: A,
      requestedScopes: [],
      site: active,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scopes).toEqual([]);
    expect([...result.removedScopes].sort()).toEqual(['site.read', 'social.read']);
  });

  /* 判定の順（設計 §8.5.6 の表の 2 → 3 → 4 → 5 → 6） */

  it('#80 順：失効（2）は Scope を広げる（3）より先', async () => {
    const { resolveTokenSiteChange } = await load();

    const result = resolveTokenSiteChange({
      current: { revokedAt: new Date('2026-10-01T00:00:00Z'), scopes: ['social.read'] },
      requestedSiteId: B,
      requestedScopes: ['social.read', 'site.read'],
      site: null,
    });

    expect(result).toEqual({ ok: false, field: 'siteId', message: MESSAGE_REVOKED });
  });

  it('#80 順：Scope を広げる（3）は存在しないサイト（4）より先', async () => {
    const { resolveTokenSiteChange } = await load();

    const result = resolveTokenSiteChange({
      current: notRevoked(['social.read']),
      requestedSiteId: B,
      requestedScopes: ['social.write'],
      site: null,
    });

    expect(result).toEqual({
      ok: false,
      field: 'scopes',
      message: `${MESSAGE_WIDEN_PREFIX}social.write`,
    });
  });

  it('#80 順：存在しないサイト（4）は SNS 以外の Scope（6）より先', async () => {
    const { resolveTokenSiteChange } = await load();

    const result = resolveTokenSiteChange({
      current: notRevoked(['social.read', 'site.read']),
      requestedSiteId: B,
      site: null,
    });

    expect(result).toEqual({ ok: false, field: 'siteId', message: MESSAGE_SITE_NOT_FOUND });
  });

  it('#80 順：アーカイブ（5）は SNS 以外の Scope（6）より先', async () => {
    const { resolveTokenSiteChange } = await load();

    const result = resolveTokenSiteChange({
      current: notRevoked(['social.read', 'site.read']),
      requestedSiteId: B,
      site: { status: 'archived' },
    });

    expect(result).toEqual({ ok: false, field: 'siteId', message: MESSAGE_ARCHIVED });
  });
});
