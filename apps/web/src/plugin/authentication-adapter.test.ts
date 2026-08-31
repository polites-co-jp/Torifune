import type { PluginAuthenticationProvider, PluginManifest } from '@torifune/plugin-api';
import { PluginExtensionNotDeclaredError } from '@torifune/plugin-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticationContext, SessionIssuer } from '@/authentication/provider';
import { getAuthenticationProvider, setAuthenticationProvider } from '@/authentication/registry';
import type { Connection } from '@/database/provider';
import type { User } from '@/domain/user';
import { userRepository } from '@/infrastructure/user-repository';
import { adaptPluginAuthenticationProvider } from './authentication-adapter';
import { buildPluginContext } from './context';
import { resetPluginRegistry } from './registry';

/**
 * Plugin の Authentication Provider の差し替え（04_認証設計.md §15）。
 *
 * **最も高い権限の拡張点。** ここを握れば誰にでもなりすませる。
 * 確かめるのは次の3つ。
 *
 * 1. 宣言していない Plugin は差し替えられない
 * 2. **Plugin が名乗った userId が実在しなければログインさせない**
 * 3. **セッションの発行は Core に残る**（Plugin へ渡さない）
 */

const EXISTING_USER: User = {
  id: '01900000-0000-7000-8000-0000000000aa',
  loginId: 'existing',
  displayName: '実在するユーザー',
  email: 'existing@example.com',
  passwordHash: 'argon2id$dummy',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
  lastLoginAt: null,
};

function authContextOf(): AuthenticationContext {
  return {
    connection: {} as Connection,
    ipAddress: '127.0.0.1',
    userAgent: 'test',
    now: new Date(),
  };
}

function pluginProvider(identityUserId: string): PluginAuthenticationProvider {
  return {
    id: 'test.auth',
    authenticate: (credentials) =>
      Promise.resolve(
        credentials.password === 'correct'
          ? {
              ok: true,
              identity: {
                userId: identityUserId,
                loginId: 'claimed-login-id',
                displayName: '名乗った表示名',
                email: 'claimed@example.com',
                providerId: 'someone.else',
                externalUserId: 'ext-1',
              },
            }
          : { ok: false, reason: 'invalid_credentials' },
      ),
    getIdentity: () => Promise.resolve(null),
    logout: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
  };
}

const sessionIssuer: SessionIssuer = {
  issue: () => Promise.resolve({ token: 'core-issued-token', expiresAt: new Date() }),
};

afterEach(() => {
  vi.restoreAllMocks();
  setAuthenticationProvider(null);
  resetPluginRegistry();
});

describe('Plugin の Authentication Provider', () => {
  it('実在するユーザーなら認証が通り、本体のユーザー情報で上書きされる', async () => {
    vi.spyOn(userRepository, 'findById').mockResolvedValue(EXISTING_USER);

    const adapted = adaptPluginAuthenticationProvider({
      provider: pluginProvider(EXISTING_USER.id),
      sessionIssuer,
    });

    const result = await adapted.authenticate(
      { loginId: 'anything', password: 'correct' },
      authContextOf(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // **Plugin が名乗った表示名・メール・providerId を信用しない。**
    // 信用すると、画面に出る名前を Plugin が自由に決められる。
    expect(result.identity.userId).toBe(EXISTING_USER.id);
    expect(result.identity.loginId).toBe(EXISTING_USER.loginId);
    expect(result.identity.displayName).toBe(EXISTING_USER.displayName);
    expect(result.identity.email).toBe(EXISTING_USER.email);
    expect(result.identity.providerId).toBe('test.auth');
    // 外部側の識別子だけは Plugin の申告を持ち込む。
    expect(result.identity.externalUserId).toBe('ext-1');
  });

  it('**実在しない userId を名乗っても認証が通らない**', async () => {
    vi.spyOn(userRepository, 'findById').mockResolvedValue(null);

    const adapted = adaptPluginAuthenticationProvider({
      provider: pluginProvider('01900000-0000-7000-8000-0000000000ff'),
      sessionIssuer,
    });

    const result = await adapted.authenticate(
      { loginId: 'anything', password: 'correct' },
      authContextOf(),
    );

    expect(result.ok).toBe(false);
  });

  it('実在しないことを理由の違いで漏らさない', async () => {
    vi.spyOn(userRepository, 'findById').mockResolvedValue(null);
    const adapted = adaptPluginAuthenticationProvider({
      provider: pluginProvider('01900000-0000-7000-8000-0000000000ff'),
      sessionIssuer,
    });

    const missing = await adapted.authenticate(
      { loginId: 'anything', password: 'correct' },
      authContextOf(),
    );
    const wrongPassword = await adapted.authenticate(
      { loginId: 'anything', password: 'wrong' },
      authContextOf(),
    );

    expect(missing.ok).toBe(false);
    expect(wrongPassword.ok).toBe(false);
    if (missing.ok || wrongPassword.ok) return;
    // 「そのユーザーは居ない」と「パスワードが違う」を区別できると、
    // 外部の識別子から Torifune の利用者を探れる。
    expect(missing.reason).toBe(wrongPassword.reason);
  });

  it('セッションの発行は差し替え前のものを使う', async () => {
    const issue = vi.fn(sessionIssuer.issue);
    const adapted = adaptPluginAuthenticationProvider({
      provider: pluginProvider(EXISTING_USER.id),
      sessionIssuer: { issue },
    });

    const session = await adapted.issue(EXISTING_USER.id, authContextOf());

    expect(issue).toHaveBeenCalledOnce();
    expect(session.token).toBe('core-issued-token');
  });

  it('公開契約にセッション発行の口が無い', () => {
    // 契約へ `issue` を足すと、Session Fixation 対策と失効の責任が
    // Plugin ごとにばらける（04_認証設計.md §22）。
    const provider: object = pluginProvider(EXISTING_USER.id);
    expect(Object.keys(provider)).not.toContain('issue');
    expect('issue' in provider).toBe(false);
  });
});

describe('宣言していない Plugin は差し替えられない', () => {
  function contextOf(extensions: PluginManifest['extensions']) {
    const manifest = {
      id: 'test-plugin',
      name: 'テスト',
      version: '1.0.0',
      apiVersion: 1,
      ...(extensions === undefined ? {} : { extensions }),
    } as PluginManifest;

    return buildPluginContext({
      manifest,
      connection: {} as Connection,
      authorization: { identity: null, permissions: new Set(), connection: {} as Connection },
    });
  }

  it('extensions に authentication が無ければ拒否する', () => {
    const context = contextOf(['ui']);
    expect(() => context.authentication.registerProvider(pluginProvider('x'))).toThrow(
      PluginExtensionNotDeclaredError,
    );
  });

  it('拒否されたとき Provider は差し替わっていない', () => {
    const before = getAuthenticationProvider();
    const context = contextOf(['ui']);

    expect(() => context.authentication.registerProvider(pluginProvider('x'))).toThrow();
    expect(getAuthenticationProvider()).toBe(before);
  });

  it('宣言していれば差し替わる', () => {
    const context = contextOf(['authentication']);
    context.authentication.registerProvider(pluginProvider(EXISTING_USER.id));

    expect(getAuthenticationProvider().id).toBe('test.auth');
  });
});
