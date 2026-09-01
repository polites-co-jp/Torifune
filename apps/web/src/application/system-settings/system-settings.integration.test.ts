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
import { DEFAULT_SERVICE_NAME } from '@/domain/system-settings';
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
