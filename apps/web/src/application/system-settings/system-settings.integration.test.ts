import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import {
  getSystemSettings,
  loadSystemSettings,
  updateSystemSettings,
} from '@/application/system-settings/system-settings-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { DEFAULT_SERVICE_NAME, SYSTEM_SETTING_KEYS } from '@/domain/system-settings';
import { ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * システム設定（06_画面設計.md §16、015b-settings 設計 §3.1-3.2）。
 */

let scratch: ScratchDatabase;

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `s${suffix}`,
        email: `s${suffix}@example.com`,
        display_name: 'settings test',
      })
      .execute();

    const role = await roleRepository.findByName(connection, roleName);
    if (role === null) throw new Error(`ロールが無い: ${roleName}`);
    await connection.db
      .insertInto('user_roles')
      .values({ user_id: id, role_id: role.id })
      .execute();
  });

  const identity: UserIdentity = {
    userId: id,
    loginId: `s${suffix}`,
    displayName: 'settings test',
    email: `s${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

beforeAll(async () => {
  scratch = await useScratchDatabase('syssettings');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(async () => {
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('system_settings').execute();
    await connection.db.deleteFrom('audit_logs').execute();
  });
});

describe('システム設定', () => {
  it('何も保存されていなければ既定を返す', async () => {
    const context = await contextFor('administrator');
    const settings = await getSystemSettings(context, {});

    expect(settings.serviceName).toBe(DEFAULT_SERVICE_NAME);
    expect(settings.rememberMeEnabled).toBe(true);
  });

  it('サービス表示名を保存して読み直せる', async () => {
    const context = await contextFor('administrator');
    await updateSystemSettings(context, { serviceName: '検証環境' });

    expect((await getSystemSettings(context, {})).serviceName).toBe('検証環境');
    // 認可の文脈を持たない読み出しでも同じ値が見える（ログイン画面などで使う）。
    expect((await loadSystemSettings()).serviceName).toBe('検証環境');
  });

  it('長期ログインの可否を保存できる', async () => {
    const context = await contextFor('administrator');
    await updateSystemSettings(context, { rememberMeEnabled: false });

    expect((await getSystemSettings(context, {})).rememberMeEnabled).toBe(false);
  });

  it('指定しなかった項目は変わらない', async () => {
    const context = await contextFor('administrator');
    await updateSystemSettings(context, { serviceName: '検証環境' });
    await updateSystemSettings(context, { rememberMeEnabled: false });

    const settings = await getSystemSettings(context, {});
    expect(settings.serviceName).toBe('検証環境');
    expect(settings.rememberMeEnabled).toBe(false);
  });

  /** `system.manage` の消費先。これまで Permission だけがあって使い道が無かった。 */
  it('system.manage が無ければ保存できない', async () => {
    const editor = await contextFor('editor');
    await expect(updateSystemSettings(editor, { serviceName: '勝手に変更' })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('権限が無くても読める', async () => {
    const viewer = await contextFor('viewer');
    await expect(getSystemSettings(viewer, {})).resolves.toBeDefined();
  });

  it('空の表示名を拒否する', async () => {
    const context = await contextFor('administrator');
    await expect(updateSystemSettings(context, { serviceName: '   ' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('長すぎる表示名を拒否する', async () => {
    const context = await contextFor('administrator');
    await expect(updateSystemSettings(context, { serviceName: 'a'.repeat(51) })).rejects.toThrow(
      ValidationError,
    );
  });

  it('変更を監査ログに残す', async () => {
    const context = await contextFor('administrator');
    await updateSystemSettings(context, { serviceName: '検証環境' });

    const rows = await withConnection(async (connection) =>
      connection.db.selectFrom('audit_logs').select(['action', 'resource_type']).execute(),
    );
    expect(rows).toEqual([{ action: 'updated', resource_type: 'system_settings' }]);
  });
});

/**
 * 追加 G：認可の文脈を持たない口の戻り値を射影型へ狭める
 * （032-timezone-setting 設計 §6.5.1、受け入れ条件 #147・#148・#153・#154）。
 *
 * **塞いだのがルート 1 ファイルだけでは足りない。**
 * `getSystemSettings`（`permission: null`）と `loadSystemSettings()` が
 * `toSystemSettings(...)` の全項目を返したままだと、将来「未認証で読める公開設定」の口を
 * もう 1 つ足す人が戻り値をそのまま返した瞬間、基準タイムゾーンがまた未認証へ出る。
 *
 * **認可の文脈を持たない口が、そもそも `analyticsTimeZone` に触れないようにする。**
 */
describe('未認証で読める設定の射影', () => {
  /** `analytics.time_zone` を保存した状態を作る（射影が効いていなければ漏れる）。 */
  async function storeTimeZone(value: string): Promise<void> {
    await withConnection((connection) =>
      connection.db
        .insertInto('system_settings')
        .values({ key: SYSTEM_SETTING_KEYS.analyticsTimeZone, value: JSON.stringify(value) })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value) }))
        .execute(),
    );
  }

  /** #147。`permission: null` の UseCase。 */
  it('getSystemSettings の戻り値が 2 項目だけで、analyticsTimeZone を持たない', async () => {
    const context = await contextFor('administrator');
    await storeTimeZone('Asia/Tokyo');

    const settings = await getSystemSettings(context, {});

    expect(Object.keys(settings).sort()).toEqual(['rememberMeEnabled', 'serviceName']);
    expect(settings).not.toHaveProperty('analyticsTimeZone');
    expect(JSON.stringify(settings)).not.toContain('Asia/Tokyo');
  });

  /** #148。認可の文脈を持たない読み出し（ログイン画面・レイアウトが使う）。 */
  it('loadSystemSettings の戻り値も 2 項目だけで、analyticsTimeZone を持たない', async () => {
    await storeTimeZone('America/Los_Angeles');

    const settings = await loadSystemSettings();

    expect(Object.keys(settings).sort()).toEqual(['rememberMeEnabled', 'serviceName']);
    expect(settings).not.toHaveProperty('analyticsTimeZone');
    expect(JSON.stringify(settings)).not.toContain('America/Los_Angeles');
  });

  /**
   * #153。**許可リストがルートに無くても漏れない。**
   *
   * `GET /api/v1/settings` は UseCase の戻り値をそのまま `dataResponse` へ渡してよい。
   * ルートが組み立て直さなくても漏れないことを、**型（射影）の側**で担保する。
   * ここではルートと同じ経路——`getSystemSettings` の戻り値をそのまま JSON にする——を
   * 再現して、それでも出ないことを見る。
   */
  it('UseCase の戻り値をそのまま JSON にしても analyticsTimeZone が出ない', async () => {
    const context = await contextFor('administrator');
    await storeTimeZone('Europe/Berlin');

    const body = JSON.stringify({ data: await getSystemSettings(context, {}) });

    expect(body).not.toContain('analyticsTimeZone');
    expect(body).not.toContain('Europe/Berlin');
    expect(JSON.parse(body)).toEqual({
      data: { serviceName: DEFAULT_SERVICE_NAME, rememberMeEnabled: true },
    });
  });

  /**
   * #154。**振る舞いを変えていない。**
   *
   * 画面の描画（`layout.tsx` / `app-shell.tsx` / `login/page.tsx`）と
   * ログイン処理（`auth/login.ts`）が読むのは、この 2 項目だけである。
   */
  it('保存した 2 項目は従来どおり読める', async () => {
    const context = await contextFor('administrator');
    await updateSystemSettings(context, { serviceName: '検証環境', rememberMeEnabled: false });
    await storeTimeZone('Asia/Tokyo');

    const viaUseCase = await getSystemSettings(context, {});
    const viaLoader = await loadSystemSettings();

    for (const settings of [viaUseCase, viaLoader]) {
      expect(settings.serviceName).toBe('検証環境');
      expect(settings.rememberMeEnabled).toBe(false);
    }
  });
});
