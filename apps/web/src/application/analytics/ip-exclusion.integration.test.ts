import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import '@/api/endpoints';
import { listEndpoints } from '@/api/registry';
import {
  isAccessLogExcluded,
  resetAccessLogIpExclusionsForTests,
} from '@/application/analytics/ip-exclusion';
import {
  getAccessLogIpExclusions,
  updateAccessLogIpExclusions,
} from '@/application/analytics/ip-exclusion-use-cases';
import {
  ForbiddenError,
  UnauthenticatedError,
  type AuthorizationContext,
} from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { getSystemSettings } from '@/application/system-settings/system-settings-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { IP_EXCLUSION_MAX_RULES } from '@/domain/analytics/ip-exclusion';
import { ValidationError } from '@/domain/repository';
import { SYSTEM_SETTING_KEYS } from '@/domain/system-settings';
import { roleRepository } from '@/infrastructure/role-repository';
import { systemSettingsRepository } from '@/infrastructure/system-settings-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 除外IPの UseCase と API 宣言
 * （033-analytics-ip-exclusion 設計 §8 / §9、受け入れ条件 #61〜#75）。
 *
 * **リストそのものが秘密である**（設計 §2）。社内の IP 帯・VPN の出口が書かれる。
 * 参照にも `system.manage` を要求し、未認証で読める口には載せない。
 */

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let viewer: AuthorizationContext;

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `t${suffix}`,
        email: `t${suffix}@example.com`,
        display_name: 'ip exclusion test',
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
    loginId: `t${suffix}`,
    displayName: 'ip exclusion test',
    email: `t${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** 未認証の文脈。`identity` が null。 */
async function anonymousContext(): Promise<AuthorizationContext> {
  return withConnection(async (connection) => ({
    identity: null,
    permissions: new Set<string>(),
    connection,
  }));
}

async function storedRules(): Promise<unknown> {
  const stored = await withConnection((connection) => systemSettingsRepository.loadAll(connection));
  return stored.get(SYSTEM_SETTING_KEYS.accessLogExcludedIps);
}

interface AuditRow {
  readonly action: string;
  readonly resource_type: string;
  readonly detail: Record<string, unknown> | null;
}

async function auditRows(): Promise<AuditRow[]> {
  return withConnection(async (connection) => {
    const result = await sql<AuditRow>`
      SELECT action, resource_type, detail FROM audit_logs ORDER BY occurred_at DESC, id DESC
    `.execute(connection.db);
    return result.rows;
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('ipexclusion');
  admin = await contextFor('administrator');
  viewer = await contextFor('viewer');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(() => {
  resetAccessLogIpExclusionsForTests();
});

afterEach(async () => {
  // **TTL 30 秒のキャッシュはテストをまたいで効く**（`processState` は globalThis に置かれる）。
  resetAccessLogIpExclusionsForTests();

  await withConnection(async (connection) => {
    await sql`DELETE FROM system_settings`.execute(connection.db);
    await sql`DELETE FROM audit_logs`.execute(connection.db);
  });
});

describe('getAccessLogIpExclusions', () => {
  it('保存されていなければ空', async () => {
    await expect(getAccessLogIpExclusions(admin, {})).resolves.toEqual({ rules: [] });
  });

  it('保存済みのリストを返す', async () => {
    await updateAccessLogIpExclusions(admin, { rules: ['203.0.113.10', '198.51.100.0/24'] });

    await expect(getAccessLogIpExclusions(admin, {})).resolves.toEqual({
      rules: ['203.0.113.10', '198.51.100.0/24'],
    });
  });

  /** #61。**参照にも権限が要る。** リストそのものが秘密である。 */
  it('system.manage が無ければ ForbiddenError', async () => {
    await expect(getAccessLogIpExclusions(viewer, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  /** #61。未認証は 403 ではなく 401（ログインを促せなくなる）。 */
  it('未認証なら UnauthenticatedError', async () => {
    const anonymous = await anonymousContext();

    await expect(getAccessLogIpExclusions(anonymous, {})).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });
});

describe('updateAccessLogIpExclusions', () => {
  /** #62 */
  it('system.manage が無ければ ForbiddenError', async () => {
    await expect(
      updateAccessLogIpExclusions(viewer, { rules: ['203.0.113.10'] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('未認証なら UnauthenticatedError', async () => {
    const anonymous = await anonymousContext();

    await expect(
      updateAccessLogIpExclusions(anonymous, { rules: ['203.0.113.10'] }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  /** #63 */
  it('正規化して保存する', async () => {
    const result = await updateAccessLogIpExclusions(admin, {
      rules: ['203.0.113.10/24', '2001:0DB8:0:0:0:0:0:1/128', ' 198.51.100.1 '],
    });

    expect(result.rules).toEqual(['203.0.113.0/24', '2001:db8::1', '198.51.100.1']);
    await expect(storedRules()).resolves.toEqual(['203.0.113.0/24', '2001:db8::1', '198.51.100.1']);
  });

  it('重複と空行を落とす', async () => {
    const result = await updateAccessLogIpExclusions(admin, {
      rules: ['203.0.113.0/24', '', '  ', '203.0.113.77/24'],
    });

    expect(result.rules).toEqual(['203.0.113.0/24']);
  });

  /** #64。**1 行でも読めなければ保存しない。** */
  it('読めない行があれば ValidationError で、何も保存しない', async () => {
    await updateAccessLogIpExclusions(admin, { rules: ['203.0.113.10'] });

    await expect(
      updateAccessLogIpExclusions(admin, { rules: ['198.51.100.1', 'not-an-ip'] }),
    ).rejects.toBeInstanceOf(ValidationError);

    // 直前に保存した内容のまま。一部だけ通っていない。
    await expect(storedRules()).resolves.toEqual(['203.0.113.10']);
  });

  /** #65 */
  it('エラーメッセージに不正な行を 3 件まで挙げる', async () => {
    const invalid = ['bad-1', 'bad-2', 'bad-3', 'bad-4'];

    await expect(updateAccessLogIpExclusions(admin, { rules: invalid })).rejects.toMatchObject({
      detail: expect.stringContaining('bad-1') as unknown as string,
    });

    const error = await updateAccessLogIpExclusions(admin, { rules: invalid }).catch(
      (caught: unknown) => caught,
    );
    const detail = (error as ValidationError).detail;

    expect(detail).toContain('bad-3');
    expect(detail).not.toContain('bad-4');
    expect(detail).toContain('ほか 1 件');
  });

  /** #66 */
  it('上限を超えると ValidationError', async () => {
    const rules = Array.from(
      { length: IP_EXCLUSION_MAX_RULES + 1 },
      (_value, index) => `198.51.${Math.floor(index / 256)}.${index % 256}`,
    );

    await expect(updateAccessLogIpExclusions(admin, { rules })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('上限ちょうどは保存できる', async () => {
    const rules = Array.from(
      { length: IP_EXCLUSION_MAX_RULES },
      (_value, index) => `198.51.${Math.floor(index / 256)}.${index % 256}`,
    );

    const result = await updateAccessLogIpExclusions(admin, { rules });
    expect(result.rules).toHaveLength(IP_EXCLUSION_MAX_RULES);
  });

  /** #67 */
  it('空配列で全解除できる', async () => {
    await updateAccessLogIpExclusions(admin, { rules: ['203.0.113.10'] });

    await expect(updateAccessLogIpExclusions(admin, { rules: [] })).resolves.toEqual({ rules: [] });
    await expect(storedRules()).resolves.toEqual([]);
  });

  /** #68。保存したプロセスへ即座に効く（TTL の 30 秒を待たない）。 */
  it('保存直後から collect の判定に効く', async () => {
    await expect(isAccessLogExcluded('203.0.113.10')).resolves.toBe(false);

    await updateAccessLogIpExclusions(admin, { rules: ['203.0.113.0/24'] });

    await expect(isAccessLogExcluded('203.0.113.10')).resolves.toBe(true);
  });

  it('解除も保存直後から効く', async () => {
    await updateAccessLogIpExclusions(admin, { rules: ['203.0.113.0/24'] });
    await updateAccessLogIpExclusions(admin, { rules: [] });

    await expect(isAccessLogExcluded('203.0.113.10')).resolves.toBe(false);
  });

  /**
   * #69。**IP そのものを監査ログに書かない**（設計 §9.2）。
   *
   * このリストは `system.manage` でしか読めない設定であり、
   * 監査ログはそれとは別の経路で読まれ・持ち出されうる。
   */
  it('監査ログに IP を残さず、件数だけ残す', async () => {
    await updateAccessLogIpExclusions(admin, { rules: ['203.0.113.10', '10.0.0.0/8'] });

    const rows = await auditRows();
    const row = rows[0];

    expect(row?.action).toBe('updated');
    expect(row?.resource_type).toBe('system_settings');
    expect(row?.detail).toMatchObject({
      setting: SYSTEM_SETTING_KEYS.accessLogExcludedIps,
      count: 2,
    });
    expect(JSON.stringify(rows)).not.toContain('203.0.113.10');
    expect(JSON.stringify(rows)).not.toContain('10.0.0.0');
  });

  it('失敗した保存は監査ログに残らない', async () => {
    await expect(
      updateAccessLogIpExclusions(admin, { rules: ['not-an-ip'] }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(auditRows()).resolves.toEqual([]);
  });
});

/**
 * API の宣言（設計 §8、受け入れ条件 #70・#72・#74）。
 *
 * **経路ごとに認可を書かない**（CLAUDE.md）。ここで見るのは
 * 「宣言が設計どおりか」であって、認可そのものは UseCase 側の検査で見ている。
 */
describe('PUT /api/v1/settings/access-log-ips', () => {
  const endpoints = listEndpoints();
  const spec = endpoints.find((endpoint) => endpoint.operationId === 'updateAccessLogIpExclusions');

  /** #70 */
  it('system.manage を要求する PUT として登録されている', () => {
    expect(spec).toBeDefined();
    expect(spec?.method).toBe('PUT');
    expect(spec?.path).toBe('/settings/access-log-ips');
    expect(spec?.permission).toBe('system.manage');
  });

  /** #71 */
  it('応答スキーマを宣言している', () => {
    expect(spec?.responseSchema).toBeDefined();
  });

  /** #72。長さと件数は Zod で落とす（形式の判定は Domain に置く）。 */
  it('64 文字を超える行と 101 件以上を受け付けない', () => {
    const body = spec?.bodySchema;
    expect(body).toBeDefined();

    expect(body?.safeParse({ rules: ['203.0.113.10'] }).success).toBe(true);
    expect(body?.safeParse({ rules: ['a'.repeat(65)] }).success).toBe(false);
    expect(
      body?.safeParse({ rules: new Array<string>(IP_EXCLUSION_MAX_RULES + 1).fill('203.0.113.10') })
        .success,
    ).toBe(false);
  });

  /**
   * #72 の裏。**形式はここで見ない。** 判定を 2 か所に置くと片方だけ直る。
   * 読めない行は UseCase（Domain 経由）が 422 にする（#73）。
   */
  it('形式の判定を Zod でしない', () => {
    expect(spec?.bodySchema?.safeParse({ rules: ['not-an-ip'] }).success).toBe(true);
  });

  /** #74。秘密を返す口は、要るまで生やさない。 */
  it('同じパスに GET が無い', () => {
    const get = endpoints.find(
      (endpoint) => endpoint.path === '/settings/access-log-ips' && endpoint.method === 'GET',
    );

    expect(get).toBeUndefined();
  });
});

/**
 * #75。**未認証で読める口に載せない**（設計 §5、032 設計 §6.5.1 と同じ理由）。
 *
 * `GET /api/v1/settings` は `permission: null` で Cookie 無しでも叩ける。
 */
describe('GET /api/v1/settings に除外IPが出ない', () => {
  it('応答に含まれない', async () => {
    await updateAccessLogIpExclusions(admin, { rules: ['203.0.113.10', '10.0.0.0/8'] });

    const anonymous = await anonymousContext();
    const settings = await getSystemSettings(anonymous, {});

    expect(Object.keys(settings).sort()).toEqual(['rememberMeEnabled', 'serviceName']);
    expect(JSON.stringify(settings)).not.toContain('203.0.113.10');
    expect(JSON.stringify(settings)).not.toContain('10.0.0.0');
  });
});
