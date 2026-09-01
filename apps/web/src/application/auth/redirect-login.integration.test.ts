import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../authentication/password';
import { hashSessionToken } from '../../authentication/session-token';
import {
  getAuthenticationProvider,
  setAuthenticationProvider,
} from '../../authentication/registry';
import type {
  AuthenticationProvider,
  AuthorizationStartContext,
  SessionIssuer,
} from '../../authentication/provider';
import type { PluginAuthenticationProvider } from '@torifune/plugin-api';
import { AUTHORIZATION_STATE_LIFETIME_MS } from '../../domain/authorization-state';
import { adaptPluginAuthenticationProvider } from '../../plugin/authentication-adapter';
import { useScratchDatabase, type ScratchDatabase } from '../../test-support/database';
import { withConnection } from '../transaction';
import { completeRedirectLogin, startRedirectLogin } from './redirect-login';

/**
 * リダイレクト型ログイン（`025-redirect-authentication` 設計）。
 *
 * **往復が実際に成立すること**と、
 * **State / Redirect URI の検証を Core が持っていること**を確かめる。
 *
 * 外部サービスへは繋がない。Provider をテスト内でループバックさせる
 * （`plugins/example-plugin` のダミーと同じ形）。
 */

const request = { ipAddress: '203.0.113.20', userAgent: 'vitest' } as const;
const CALLBACK = 'https://torifune.example/api/v1/auth/callback';
const GOOD_CODE = 'good-code';

let scratch: ScratchDatabase;

/** 認可開始で Plugin が受け取った文脈。往復の検証に使う。 */
let lastStartContext: AuthorizationStartContext | null = null;

async function createUser(): Promise<string> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const passwordHash = await hashPassword('correct horse battery staple');

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `u${suffix}`,
        email: `u${suffix}@example.com`,
        display_name: `u${suffix}`,
        password_hash: passwordHash,
        status: 'active',
      })
      .execute();
  });

  return id;
}

/**
 * ループバックする Provider。
 *
 * 認可エンドポイントの代わりに、Core のコールバックへそのまま戻る URL を返す。
 * **短絡しているのは「外部 Provider が居るかどうか」だけ。**
 */
function loopbackProvider(userId: string): AuthenticationProvider & SessionIssuer {
  const base = getAuthenticationProvider();

  return {
    ...base,
    id: 'test.redirect',

    startAuthorization(context) {
      lastStartContext = context;
      const url = new URL(context.redirectUri);
      url.searchParams.set('state', context.state);
      url.searchParams.set('code', GOOD_CODE);
      return Promise.resolve({ ok: true as const, authorizationUrl: url.toString() });
    },

    completeAuthorization(callback) {
      if (callback.params['code'] !== GOOD_CODE) {
        return Promise.resolve({ ok: false as const, reason: 'invalid_credentials' as const });
      }
      return Promise.resolve({
        ok: true as const,
        identity: {
          userId,
          loginId: 'claimed',
          displayName: 'claimed',
          email: 'claimed@example.com',
          providerId: 'someone.else',
          externalUserId: 'ext-1',
        },
      });
    },
  };
}

/**
 * 公開 Plugin API だけで書いたループバック Provider。
 *
 * `plugins/example-plugin` と同じ形。**本体の型を使わない。**
 */
function pluginLoopbackProvider(userId: string): PluginAuthenticationProvider {
  return {
    id: 'test.plugin.redirect',
    authenticate: () => Promise.resolve({ ok: false, reason: 'invalid_credentials' }),
    getIdentity: () => Promise.resolve(null),
    logout: () => Promise.resolve(),
    refresh: () => Promise.resolve(),

    startAuthorization(context) {
      const url = new URL(context.redirectUri);
      url.searchParams.set('state', context.state);
      url.searchParams.set('code', GOOD_CODE);
      return Promise.resolve({ ok: true, authorizationUrl: url.toString() });
    },

    completeAuthorization(callback) {
      if (callback.params['code'] !== GOOD_CODE) {
        return Promise.resolve({ ok: false, reason: 'invalid_credentials' });
      }
      return Promise.resolve({
        ok: true,
        identity: {
          userId,
          loginId: 'claimed',
          displayName: 'claimed',
          email: 'claimed@example.com',
          providerId: 'someone.else',
          externalUserId: 'ext-plugin',
        },
      });
    },
  };
}

/** 認可URLから state を取り出す（ブラウザが往復する代わり）。 */
function paramsOf(authorizationUrl: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of new URL(authorizationUrl).searchParams) {
    params[key] = value;
  }
  return params;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('redirectlogin');
});

afterAll(async () => {
  setAuthenticationProvider(null);
  await scratch.dispose();
});

afterEach(() => {
  setAuthenticationProvider(null);
  lastStartContext = null;
});

describe('往復が成立する', () => {
  it('認可開始 → コールバックでログインが成立し、Core がセッションを発行する', async () => {
    const userId = await createUser();
    setAuthenticationProvider(loopbackProvider(userId));

    const started = await startRedirectLogin({ redirectUri: CALLBACK, request });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const completed = await completeRedirectLogin({
      params: paramsOf(started.authorizationUrl),
      redirectUri: CALLBACK,
      request,
    });

    expect(completed.ok).toBe(true);
    if (!completed.ok) return;

    expect(completed.user.id).toBe(userId);
    expect(completed.returnTo).toBe('/');

    // **Core が発行したセッションであること。** Plugin はセッションを作れない。
    const session = await withConnection((connection) =>
      connection.db
        .selectFrom('sessions')
        .select(['user_id'])
        .where('token_hash', '=', hashSessionToken(completed.sessionToken))
        .executeTakeFirst(),
    );
    expect(session?.user_id).toBe(userId);
  });

  it('State / Nonce / Redirect URI を Core が発行して Plugin へ渡す', async () => {
    const userId = await createUser();
    setAuthenticationProvider(loopbackProvider(userId));

    await startRedirectLogin({ redirectUri: CALLBACK, request });

    expect(lastStartContext).not.toBeNull();
    expect(lastStartContext!.redirectUri).toBe(CALLBACK);
    // 総当たりが成立しない長さ（256bit を base64url にしたもの）。
    expect(lastStartContext!.state.length).toBeGreaterThanOrEqual(40);
    expect(lastStartContext!.nonce.length).toBeGreaterThanOrEqual(40);
    expect(lastStartContext!.nonce).not.toBe(lastStartContext!.state);
  });

  it('**State は平文で保存しない**', async () => {
    const userId = await createUser();
    setAuthenticationProvider(loopbackProvider(userId));

    const started = await startRedirectLogin({ redirectUri: CALLBACK, request });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const state = paramsOf(started.authorizationUrl)['state']!;

    const rows = await withConnection((connection) =>
      connection.db.selectFrom('auth_authorization_states').select(['state_hash']).execute(),
    );

    expect(rows.some((row) => row.state_hash === state)).toBe(false);
    expect(rows.some((row) => row.state_hash === hashSessionToken(state))).toBe(true);
  });

  it('遷移先を保って戻す', async () => {
    const userId = await createUser();
    setAuthenticationProvider(loopbackProvider(userId));

    const started = await startRedirectLogin({
      redirectUri: CALLBACK,
      returnTo: '/sites',
      request,
    });
    if (!started.ok) return;

    const completed = await completeRedirectLogin({
      params: paramsOf(started.authorizationUrl),
      redirectUri: CALLBACK,
      request,
    });

    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.returnTo).toBe('/sites');
  });

  it('**外部への遷移先は "/" に落とす**（Open Redirect 対策）', async () => {
    const userId = await createUser();
    setAuthenticationProvider(loopbackProvider(userId));

    const started = await startRedirectLogin({
      redirectUri: CALLBACK,
      returnTo: '//evil.example/steal',
      request,
    });
    if (!started.ok) return;

    const completed = await completeRedirectLogin({
      params: paramsOf(started.authorizationUrl),
      redirectUri: CALLBACK,
      request,
    });

    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.returnTo).toBe('/');
  });
});

describe('State の検証は Core が持つ', () => {
  it('**同じ State は2回使えない**', async () => {
    const userId = await createUser();
    setAuthenticationProvider(loopbackProvider(userId));

    const started = await startRedirectLogin({ redirectUri: CALLBACK, request });
    if (!started.ok) return;
    const params = paramsOf(started.authorizationUrl);

    const first = await completeRedirectLogin({ params, redirectUri: CALLBACK, request });
    const second = await completeRedirectLogin({ params, redirectUri: CALLBACK, request });

    expect(first.ok).toBe(true);
    // 使い捨てでなければ、盗まれた State を何度でも使える。
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('invalid_state');
  });

  it('存在しない State は通らない', async () => {
    const userId = await createUser();
    setAuthenticationProvider(loopbackProvider(userId));

    const outcome = await completeRedirectLogin({
      params: { state: 'never-issued', code: GOOD_CODE },
      redirectUri: CALLBACK,
      request,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('invalid_state');
  });

  it('State が無ければ通らない', async () => {
    const userId = await createUser();
    setAuthenticationProvider(loopbackProvider(userId));

    const outcome = await completeRedirectLogin({
      params: { code: GOOD_CODE },
      redirectUri: CALLBACK,
      request,
    });

    expect(outcome.ok).toBe(false);
  });

  it('期限切れの State は通らない', async () => {
    const userId = await createUser();
    setAuthenticationProvider(loopbackProvider(userId));

    const started = await startRedirectLogin({ redirectUri: CALLBACK, request });
    if (!started.ok) return;
    const params = paramsOf(started.authorizationUrl);

    // 時計を進める代わりに、保存された期限を過去へずらす。
    await withConnection((connection) =>
      connection.db
        .updateTable('auth_authorization_states')
        .set({ expires_at: new Date(Date.now() - AUTHORIZATION_STATE_LIFETIME_MS) })
        .where('state_hash', '=', hashSessionToken(params['state']!))
        .execute(),
    );

    const outcome = await completeRedirectLogin({ params, redirectUri: CALLBACK, request });
    expect(outcome.ok).toBe(false);
  });

  it('**期限切れと存在しないを理由で区別しない**', async () => {
    const userId = await createUser();
    setAuthenticationProvider(loopbackProvider(userId));

    const started = await startRedirectLogin({ redirectUri: CALLBACK, request });
    if (!started.ok) return;
    const params = paramsOf(started.authorizationUrl);

    await withConnection((connection) =>
      connection.db
        .updateTable('auth_authorization_states')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('state_hash', '=', hashSessionToken(params['state']!))
        .execute(),
    );

    const expired = await completeRedirectLogin({ params, redirectUri: CALLBACK, request });
    const missing = await completeRedirectLogin({
      params: { state: 'never-issued' },
      redirectUri: CALLBACK,
      request,
    });

    expect(expired.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (expired.ok || missing.ok) return;
    // 区別できると、State の生死を外から探れる。
    expect(expired.reason).toBe(missing.reason);
  });
});

describe('Redirect URI の検証は Core が持つ', () => {
  it('**発行時と違う Redirect URI では通らない**', async () => {
    const userId = await createUser();
    setAuthenticationProvider(loopbackProvider(userId));

    const started = await startRedirectLogin({ redirectUri: CALLBACK, request });
    if (!started.ok) return;

    const outcome = await completeRedirectLogin({
      params: paramsOf(started.authorizationUrl),
      // 別のホストへ到達したコールバック。
      redirectUri: 'https://evil.example/api/v1/auth/callback',
      request,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('invalid_state');
  });
});

describe('Plugin の返り値を鵜呑みにしない', () => {
  it('**Plugin 経由で実在しない userId を名乗ってもログインさせない**', async () => {
    // Plugin → adapter → UseCase の経路をそのまま通す。
    setAuthenticationProvider(
      adaptPluginAuthenticationProvider({
        provider: pluginLoopbackProvider(uuidv7()),
        sessionIssuer: getAuthenticationProvider(),
      }),
    );

    const started = await startRedirectLogin({ redirectUri: CALLBACK, request });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const outcome = await completeRedirectLogin({
      params: paramsOf(started.authorizationUrl),
      redirectUri: CALLBACK,
      request,
    });

    // 名乗った ID が Torifune に居なければ、資格情報の誤りとして扱う。
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('invalid_credentials');
  });

  it('Plugin 経由でも実在するユーザーならログインが成立する', async () => {
    const userId = await createUser();
    setAuthenticationProvider(
      adaptPluginAuthenticationProvider({
        provider: pluginLoopbackProvider(userId),
        sessionIssuer: getAuthenticationProvider(),
      }),
    );

    const started = await startRedirectLogin({ redirectUri: CALLBACK, request });
    if (!started.ok) return;

    const outcome = await completeRedirectLogin({
      params: paramsOf(started.authorizationUrl),
      redirectUri: CALLBACK,
      request,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.user.id).toBe(userId);
    // **Plugin の申告ではなく、登録された Provider の ID が入る。**
    expect(outcome.user.loginId).not.toBe('claimed');
  });

  it('Plugin が失敗を返したらログインさせず、監査ログに残す', async () => {
    const userId = await createUser();
    setAuthenticationProvider(loopbackProvider(userId));

    const started = await startRedirectLogin({ redirectUri: CALLBACK, request });
    if (!started.ok) return;

    const params = paramsOf(started.authorizationUrl);
    params['code'] = 'wrong-code';

    const outcome = await completeRedirectLogin({ params, redirectUri: CALLBACK, request });

    expect(outcome.ok).toBe(false);

    const failures = await withConnection((connection) =>
      connection.db
        .selectFrom('auth_audit_logs')
        .select(['id'])
        .where('event', '=', 'login.failed')
        .execute(),
    );
    expect(failures.length).toBeGreaterThan(0);
  });

  it('成功が監査ログに残る', async () => {
    const userId = await createUser();
    setAuthenticationProvider(loopbackProvider(userId));

    const started = await startRedirectLogin({ redirectUri: CALLBACK, request });
    if (!started.ok) return;

    await completeRedirectLogin({
      params: paramsOf(started.authorizationUrl),
      redirectUri: CALLBACK,
      request,
    });

    const succeeded = await withConnection((connection) =>
      connection.db
        .selectFrom('auth_audit_logs')
        .select(['detail'])
        .where('event', '=', 'login.succeeded')
        .where('user_id', '=', userId)
        .execute(),
    );

    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]?.detail).toMatchObject({ flow: 'redirect' });
  });
});

describe('往復型を実装していない Provider', () => {
  it('標準認証では認可を開始できない', async () => {
    // 差し替えない＝標準認証。**リダイレクト往復を持たない。**
    const outcome = await startRedirectLogin({ redirectUri: CALLBACK, request });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unsupported');
  });

  it('標準認証ではコールバックも受け付けない', async () => {
    const outcome = await completeRedirectLogin({
      params: { state: 'anything', code: GOOD_CODE },
      redirectUri: CALLBACK,
      request,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unsupported');
  });
});
