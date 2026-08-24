import type {
  PluginDatabaseConnection,
  PluginDatabaseProvider,
  PluginLogger,
} from '@torifune/plugin-api';

/**
 * ログを出すだけのダミー Database Provider。
 *
 * **差し替えが成立することの実証**であって、実用のものではない。
 * 実際の接続は行わず、流れてきた SQL を記録するだけ。
 *
 * 本物の Provider を書くときは、この形のまま
 * `query` を実際の接続へ繋ぎ、`transaction` で境界を張る。
 */

export interface RecordedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface DummyDatabaseProvider extends PluginDatabaseProvider {
  /** 記録したクエリ。テストと観察のために公開する。 */
  readonly recorded: readonly RecordedQuery[];
}

export function createDummyDatabaseProvider(logger: PluginLogger): DummyDatabaseProvider {
  const recorded: RecordedQuery[] = [];

  function connectionOf(): PluginDatabaseConnection {
    return {
      query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
        recorded.push({ sql, params });
        // **値そのものは記録しない。** 資格情報が SQL の引数に乗ることがある。
        logger.debug('query', { sql, paramCount: params.length });
        return Promise.resolve([] as readonly T[]);
      },

      async transaction<T>(fn: (tx: PluginDatabaseConnection) => Promise<T>): Promise<T> {
        logger.debug('transaction begin');
        try {
          const result = await fn(connectionOf());
          logger.debug('transaction commit');
          return result;
        } catch (error) {
          logger.debug('transaction rollback');
          throw error;
        }
      },
    };
  }

  return {
    id: 'example-plugin.dummy',
    recorded,

    connect(): Promise<PluginDatabaseConnection> {
      logger.info('ダミー Database Provider へ接続した');
      return Promise.resolve(connectionOf());
    },

    disconnect(): Promise<void> {
      logger.info('ダミー Database Provider を切断した');
      return Promise.resolve();
    },

    healthCheck(): Promise<boolean> {
      // **例外を投げない。** Readiness プローブから呼ばれる。
      return Promise.resolve(true);
    },
  };
}
