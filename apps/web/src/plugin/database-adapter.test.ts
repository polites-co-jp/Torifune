import type { PluginDatabaseConnection, PluginDatabaseProvider } from '@torifune/plugin-api';
import { PluginExtensionNotDeclaredError } from '@torifune/plugin-api';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import type { Connection } from '@/database/provider';
import { getDatabaseProvider, setDatabaseProvider } from '@/database/registry';
import { buildPluginContext } from './context';
import { adaptPluginDatabaseProvider } from './database-adapter';
import { resetPluginRegistry } from './registry';

/**
 * Plugin の Database Provider の差し替え（013-example-plugin 設計 §5.1）。
 *
 * **高権限の拡張点。** 差し替えると本体のすべてのデータアクセスがそこを通る。
 */

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function fakeProvider(options: { failHealthCheck?: boolean } = {}) {
  const recorded: Recorded[] = [];
  let disconnected = false;

  function connectionOf(): PluginDatabaseConnection {
    return {
      query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
        recorded.push({ sql, params });
        return Promise.resolve([] as readonly T[]);
      },
      transaction<T>(fn: (tx: PluginDatabaseConnection) => Promise<T>): Promise<T> {
        return fn(connectionOf());
      },
    };
  }

  const provider: PluginDatabaseProvider = {
    id: 'test.provider',
    connect: () => Promise.resolve(connectionOf()),
    disconnect: () => {
      disconnected = true;
      return Promise.resolve();
    },
    healthCheck: () =>
      options.failHealthCheck === true
        ? Promise.reject(new Error('落ちている'))
        : Promise.resolve(true),
  };

  return {
    provider,
    recorded,
    get disconnected() {
      return disconnected;
    },
  };
}

afterEach(() => {
  // 差し替えたままにすると、以降のテストが Plugin の Provider を見てしまう。
  setDatabaseProvider(null);
  resetPluginRegistry();
});

describe('差し替えの適合', () => {
  it('Plugin の query へ SQL が届く', async () => {
    const fake = fakeProvider();
    const adapted = adaptPluginDatabaseProvider(fake.provider);

    const connection = await adapted.connect();
    await connection.db.selectFrom('sites').select('id').execute();

    expect(fake.recorded).toHaveLength(1);
    expect(fake.recorded[0]?.sql).toContain('select');
    expect(fake.recorded[0]?.sql).toContain('"sites"');
  });

  it('値はパラメータで渡る', async () => {
    // 文字列連結で組み立てさせない。
    const fake = fakeProvider();
    const adapted = adaptPluginDatabaseProvider(fake.provider);

    const connection = await adapted.connect();
    await connection.db.selectFrom('sites').select('id').where('id', '=', 'abc').execute();

    expect(fake.recorded[0]?.params).toEqual(['abc']);
    expect(fake.recorded[0]?.sql).not.toContain('abc');
  });

  it('トランザクションで BEGIN と COMMIT が流れる', async () => {
    const fake = fakeProvider();
    const adapted = adaptPluginDatabaseProvider(fake.provider);

    const connection = await adapted.connect();
    await connection.transaction(async (tx) => {
      await tx.db.selectFrom('sites').select('id').execute();
    });

    const statements = fake.recorded.map((entry) => entry.sql);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('例外で ROLLBACK が流れる', async () => {
    const fake = fakeProvider();
    const adapted = adaptPluginDatabaseProvider(fake.provider);

    const connection = await adapted.connect();
    await expect(connection.transaction(() => Promise.reject(new Error('失敗')))).rejects.toThrow(
      '失敗',
    );

    expect(fake.recorded.map((entry) => entry.sql)).toContain('ROLLBACK');
  });

  it('入れ子のトランザクションは外側へ参加する', async () => {
    // 本体の PostgreSQL Provider と同じ約束にしておかないと、
    // Provider を差し替えたときだけ壊れ方が変わる。
    const fake = fakeProvider();
    const adapted = adaptPluginDatabaseProvider(fake.provider);

    const connection = await adapted.connect();
    await connection.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await inner.db.selectFrom('sites').select('id').execute();
      });
    });

    const begins = fake.recorded.filter((entry) => entry.sql === 'BEGIN');
    expect(begins).toHaveLength(1);
  });

  it('healthCheck が例外を投げても false を返す', async () => {
    // Readiness プローブから呼ばれる。落ちてはいけない。
    const fake = fakeProvider({ failHealthCheck: true });
    const adapted = adaptPluginDatabaseProvider(fake.provider);

    await expect(adapted.healthCheck()).resolves.toBe(false);
  });

  it('切断すると Plugin 側も切れる', async () => {
    const fake = fakeProvider();
    const adapted = adaptPluginDatabaseProvider(fake.provider);

    await adapted.connect();
    await adapted.disconnect();

    expect(fake.disconnected).toBe(true);
  });
});

describe('宣言の検査', () => {
  const connection = { db: null, transaction: async () => undefined } as unknown as Connection;
  const authorization = {
    identity: null,
    permissions: new Set<string>(),
    connection,
  } as unknown as AuthorizationContext;

  it('宣言していない Plugin は差し替えられない', () => {
    // 宣言なしに差し替えられると、Plugin を入れた側が
    // 「何がデータアクセスを握っているか」を知らないまま運用することになる。
    const context = buildPluginContext({
      manifest: { id: 'sneaky-plugin', name: 'x', version: '1.0.0', apiVersion: 1 },
      connection,
      authorization,
    });

    expect(() => context.database.registerProvider(fakeProvider().provider)).toThrow(
      PluginExtensionNotDeclaredError,
    );
  });

  it('ui だけ宣言していても差し替えられない', () => {
    const context = buildPluginContext({
      manifest: {
        id: 'ui-plugin',
        name: 'x',
        version: '1.0.0',
        apiVersion: 1,
        extensions: ['ui'],
      },
      connection,
      authorization,
    });

    expect(() => context.database.registerProvider(fakeProvider().provider)).toThrow(
      PluginExtensionNotDeclaredError,
    );
  });

  it('宣言していれば差し替えられ、本体がそれを通る', () => {
    const fake = fakeProvider();
    const context = buildPluginContext({
      manifest: {
        id: 'db-plugin',
        name: 'x',
        version: '1.0.0',
        apiVersion: 1,
        extensions: ['database'],
      },
      connection,
      authorization,
    });

    context.database.registerProvider(fake.provider);

    // 本体が解決する Provider が入れ替わっている。
    expect(getDatabaseProvider()).not.toBeNull();
    expect(() => getDatabaseProvider()).not.toThrow();
  });
});
