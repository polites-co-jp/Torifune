import { describe, expect, it } from 'vitest';
import {
  UnauthenticatedError,
  type AuthorizationContext,
} from '@/application/authorization/authorize';
import { scopeOf } from '@/application/social/access-scope';

/**
 * 区画を決める唯一の入口 `scopeOf`（053-site-scoped-social 設計 §8.1。受け入れ条件 #101）。
 *
 * 文脈の `apiToken` は `buildApiTokenContext` がトークンの行から積む。サイトの消えたサイトのトークン
 * （`siteScoped: true`・`siteId: null`）はそこで未認証にするので、普通は `scopeOf` まで届かない。
 * それでも届いたとき（文脈を作る経路が増えた・判定が漏れた）に、**共通の区画へ化けずに断る**（fail closed）ことを固定する。
 *
 * 文脈は値だけを組む（DB に触れない）。`apiToken.siteScoped` は 053 の検証の指摘の修正で足した項目なので、
 * 形を写した型で組んでから `AuthorizationContext` として渡す。
 */

interface ApiTokenShape {
  readonly id: string;
  readonly name: string;
  readonly siteId: string | null;
  readonly siteScoped: boolean;
}

function contextWith(apiToken: ApiTokenShape | undefined): AuthorizationContext {
  return {
    identity: null,
    permissions: new Set(),
    connection: {},
    ...(apiToken === undefined ? {} : { apiToken }),
  } as unknown as AuthorizationContext;
}

const SITE_A = '01900000-0000-7000-8000-0000000000a1';

describe('#101 scopeOf は文脈の apiToken から区画を決め、サイトの消えたサイトのトークンでは断る', () => {
  it('#101 apiToken が無い（セッション・内部処理）→ all', () => {
    expect(scopeOf(contextWith(undefined))).toEqual({ kind: 'all' });
  });

  it('#101 共通のトークン（siteScoped: false・siteId: null）→ common', () => {
    expect(
      scopeOf(contextWith({ id: 't', name: 'common', siteId: null, siteScoped: false })),
    ).toEqual({ kind: 'common' });
  });

  it('#101 サイトのトークン（siteScoped: true・siteId: A）→ site:A', () => {
    expect(
      scopeOf(contextWith({ id: 't', name: 'site', siteId: SITE_A, siteScoped: true })),
    ).toEqual({ kind: 'site', siteId: SITE_A });
  });

  it('#101 サイトの消えたサイトのトークン（siteScoped: true・siteId: null）は common に化けず UnauthenticatedError', () => {
    const context = contextWith({ id: 't', name: 'gone', siteId: null, siteScoped: true });

    expect(() => scopeOf(context)).toThrow(UnauthenticatedError);
  });
});
