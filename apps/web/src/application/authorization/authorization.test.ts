import { afterEach, describe, expect, it } from 'vitest';
import type { UserIdentity } from '../../authentication/identity';
import type { Connection } from '../../database/provider';
import {
  ForbiddenError,
  hasPermission,
  requireAuthenticated,
  requirePermission,
  UnauthenticatedError,
  type AuthorizationContext,
} from './authorize';
import {
  listPermissions,
  PermissionRegistrationError,
  registerPermission,
  resetPermissionRegistry,
  UnknownPermissionError,
  unregisterPermissionsOf,
} from './permission-registry';
import {
  defineUseCase,
  listUnprotectedUseCases,
  resetUseCaseRegistry,
  UseCaseDefinitionError,
} from './use-case';

const identity: UserIdentity = {
  userId: 'u1',
  loginId: 'alice',
  displayName: 'Alice',
  email: 'alice@example.com',
  providerId: 'local',
  externalUserId: null,
};

const connection = {} as Connection;

function context(permissions: string[], authenticated = true): AuthorizationContext {
  return {
    identity: authenticated ? identity : null,
    permissions: new Set(permissions),
    connection,
  };
}

afterEach(() => {
  resetPermissionRegistry();
  resetUseCaseRegistry();
});

describe('Permission レジストリ', () => {
  it('本体の Permission 12 種が最初から登録されている', () => {
    expect(listPermissions()).toHaveLength(12);
  });

  it('Plugin の Permission を登録できる', () => {
    registerPermission({
      name: 'seo.report.read',
      displayName: 'SEO レポートの参照',
      description: '',
      owner: 'seo-plugin',
    });

    expect(listPermissions().map((p) => p.name)).toContain('seo.report.read');
  });

  it('形式が不正な名前の登録を拒否する', () => {
    expect(() =>
      registerPermission({ name: 'BAD', displayName: 'x', description: '', owner: 'p' }),
    ).toThrowError(PermissionRegistrationError);
  });

  it('二重登録を拒否する', () => {
    expect(() =>
      registerPermission({ name: 'site.read', displayName: 'x', description: '', owner: null }),
    ).toThrowError(PermissionRegistrationError);
  });

  it('Plugin が system.* を取ることを拒否する', () => {
    // Plugin が「システム管理相当の権限」を勝手に定義できてしまうため。
    expect(() =>
      registerPermission({
        name: 'system.takeover',
        displayName: 'x',
        description: '',
        owner: 'evil-plugin',
      }),
    ).toThrowError(PermissionRegistrationError);
  });

  it('本体は system.* を登録できる', () => {
    expect(() =>
      registerPermission({
        name: 'system.backup',
        displayName: 'x',
        description: '',
        owner: null,
      }),
    ).not.toThrow();
  });

  it('Plugin の Permission をまとめて取り下げられる', () => {
    registerPermission({ name: 'seo.a.read', displayName: 'x', description: '', owner: 'seo' });
    registerPermission({ name: 'seo.b.read', displayName: 'x', description: '', owner: 'seo' });

    unregisterPermissionsOf('seo');

    expect(listPermissions().map((p) => p.name)).not.toContain('seo.a.read');
    expect(listPermissions()).toHaveLength(12);
  });

  it('一覧が名前順である', () => {
    const names = listPermissions().map((p) => p.name);
    expect(names).toEqual([...names].sort());
  });
});

describe('requirePermission', () => {
  it('Permission を持っていれば通す', () => {
    expect(() => requirePermission(context(['site.read']), 'site.read')).not.toThrow();
  });

  it('Permission を持っていなければ ForbiddenError', () => {
    expect(() => requirePermission(context(['content.read']), 'site.read')).toThrowError(
      ForbiddenError,
    );
  });

  it('未認証なら UnauthenticatedError', () => {
    expect(() => requirePermission(context([], false), 'site.read')).toThrowError(
      UnauthenticatedError,
    );
  });

  it('未認証は、Permission を持っていても UnauthenticatedError', () => {
    // 未認証なのに permissions が入っている状態は組み立て側の誤り。
    // 認証を先に見ることで、その誤りが認可の穴にならない。
    expect(() => requirePermission(context(['site.read'], false), 'site.read')).toThrowError(
      UnauthenticatedError,
    );
  });

  it('未登録の Permission を要求すると UnknownPermissionError', () => {
    // 常に 403 になる「存在しない権限」を要求している実装の誤りを、はっきり落とす。
    expect(() => requirePermission(context(['x.y']), 'x.y')).toThrowError(UnknownPermissionError);
  });

  it('ForbiddenError のメッセージに Permission 名が含まれない', () => {
    try {
      requirePermission(context([]), 'site.read');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('site.read');
    }
  });
});

describe('hasPermission', () => {
  it('持っていれば true', () => {
    expect(hasPermission(context(['site.read']), 'site.read')).toBe(true);
  });

  it('持っていなければ false', () => {
    expect(hasPermission(context([]), 'site.read')).toBe(false);
  });

  it('未認証なら false', () => {
    expect(hasPermission(context(['site.read'], false), 'site.read')).toBe(false);
  });
});

describe('requireAuthenticated', () => {
  it('認証済みなら identity を返す', () => {
    expect(requireAuthenticated(context([])).userId).toBe('u1');
  });

  it('未認証なら UnauthenticatedError', () => {
    expect(() => requireAuthenticated(context([], false))).toThrowError(UnauthenticatedError);
  });
});

describe('defineUseCase', () => {
  it('Permission を持つユーザーの呼び出しが成功する', async () => {
    const useCase = defineUseCase({
      name: 'test.protected',
      permission: 'site.read',
      handler: async () => 'ok',
    });

    await expect(useCase(context(['site.read']), undefined)).resolves.toBe('ok');
  });

  it('Permission が無ければ ForbiddenError', async () => {
    const useCase = defineUseCase({
      name: 'test.protected2',
      permission: 'site.read',
      handler: async () => 'ok',
    });

    await expect(useCase(context([]), undefined)).rejects.toThrowError(ForbiddenError);
  });

  it('未認証なら UnauthenticatedError', async () => {
    const useCase = defineUseCase({
      name: 'test.protected3',
      permission: 'site.read',
      handler: async () => 'ok',
    });

    await expect(useCase(context([], false), undefined)).rejects.toThrowError(UnauthenticatedError);
  });

  it('権限が無いとき handler が実行されない', async () => {
    let called = false;
    const useCase = defineUseCase({
      name: 'test.protected4',
      permission: 'site.read',
      handler: async () => {
        called = true;
        return 'ok';
      },
    });

    await expect(useCase(context([]), undefined)).rejects.toThrowError();
    expect(called).toBe(false);
  });

  it('permission が null で reason が無ければ定義できない', () => {
    expect(() =>
      defineUseCase({ name: 'test.unsafe', permission: null, handler: async () => 'x' }),
    ).toThrowError(UseCaseDefinitionError);
  });

  it('permission が null でも reason があれば定義できる', () => {
    expect(() =>
      defineUseCase({
        name: 'test.public',
        permission: null,
        reason: '認証前に呼ばれるため',
        handler: async () => 'x',
      }),
    ).not.toThrow();
  });

  it('名前の重複を拒否する', () => {
    defineUseCase({ name: 'test.dup', permission: 'site.read', handler: async () => 'x' });
    expect(() =>
      defineUseCase({ name: 'test.dup', permission: 'site.read', handler: async () => 'x' }),
    ).toThrowError(UseCaseDefinitionError);
  });

  it('認可を必要としない UseCase を列挙できる', () => {
    defineUseCase({ name: 'test.a', permission: 'site.read', handler: async () => 'x' });
    defineUseCase({
      name: 'test.b',
      permission: null,
      reason: '認証前に呼ばれるため',
      handler: async () => 'x',
    });

    expect(listUnprotectedUseCases().map((u) => u.name)).toEqual(['test.b']);
  });

  it('列挙した UseCase から理由を読める', () => {
    defineUseCase({
      name: 'test.c',
      permission: null,
      reason: 'ログイン処理そのもの',
      handler: async () => 'x',
    });

    expect(listUnprotectedUseCases()[0]?.reason).toBe('ログイン処理そのもの');
  });
});

describe('権限昇格の防止', () => {
  it('入力に permissions を入れても判定に影響しない', async () => {
    const useCase = defineUseCase({
      name: 'test.escalation',
      permission: 'system.manage',
      handler: async () => 'ok',
    });

    // クライアントが送ってきたつもりの値。AuthorizationContext とは別物。
    const input = { permissions: ['system.manage'], roles: ['administrator'] };

    await expect(useCase(context(['site.read']), input)).rejects.toThrowError(ForbiddenError);
  });
});
