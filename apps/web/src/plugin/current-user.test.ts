import { afterEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import type { UserIdentity } from '@/authentication/identity';
import type { Connection } from '@/database/provider';
import { buildPluginContext } from './context';
import { resetPluginRegistry } from './registry';

/**
 * Plugin から見える「いまの利用者」（00_システム概要.md §8）。
 *
 * **型で除いただけでは足りない。** 実装が生の `UserIdentity` をそのまま
 * 渡せば、型に無い項目も実行時には付いてくる。実際の値で確かめる。
 */

const MANIFEST = { id: 'seo-plugin', name: 'x', version: '1.0.0', apiVersion: 1 };

// この文脈では DB を触らない。
const connection = {} as Connection;

function contextFor(authorization: AuthorizationContext) {
  return buildPluginContext({ manifest: MANIFEST, connection, authorization });
}

function signedIn(): AuthorizationContext {
  const identity: UserIdentity = {
    userId: 'u1',
    loginId: 'admin',
    displayName: '管理者',
    email: 'secret@example.com',
    providerId: 'local',
    externalUserId: null,
  };

  return {
    identity,
    permissions: new Set(['site.read', 'site.write']),
  } as unknown as AuthorizationContext;
}

afterEach(() => {
  resetPluginRegistry();
});

describe('currentUser', () => {
  it('ログインしていれば、表示に要るものが取れる', () => {
    const { currentUser } = contextFor(signedIn());

    expect(currentUser).toEqual({
      userId: 'u1',
      loginId: 'admin',
      displayName: '管理者',
      permissions: ['site.read', 'site.write'],
    });
  });

  /**
   * **`login.methods` は認証前のログイン画面で描かれる。**
   * ここを null にできないと、ログイン画面が落ちる。
   */
  it('認証前は null', () => {
    const authorization = {
      identity: null,
      permissions: new Set<string>(),
    } as unknown as AuthorizationContext;

    expect(contextFor(authorization).currentUser).toBeNull();
  });

  it('メールアドレスを渡さない', () => {
    const { currentUser } = contextFor(signedIn());

    expect(JSON.stringify(currentUser)).not.toContain('secret@example.com');
    expect(Object.keys(currentUser ?? {})).not.toContain('email');
  });

  /** 内部の識別子を Plugin の判断材料にさせない。 */
  it('providerId と externalUserId を渡さない', () => {
    const keys = Object.keys(contextFor(signedIn()).currentUser ?? {});

    expect(keys).not.toContain('providerId');
    expect(keys).not.toContain('externalUserId');
  });

  /** 書き換えても本体の認可には影響しない（渡すのは写し）。 */
  it('権限の集合そのものを渡さない', () => {
    const authorization = signedIn();
    const { currentUser } = contextFor(authorization);

    (currentUser?.permissions as string[]).push('system.manage');

    expect(authorization.permissions.has('system.manage')).toBe(false);
  });
});
