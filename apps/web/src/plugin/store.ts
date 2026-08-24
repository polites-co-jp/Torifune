import {
  MAX_VALUE_BYTES,
  PluginStoreError,
  isValidStoreKey,
  type PluginStore,
} from '@torifune/plugin-api';
import { Secret } from '@/domain/secret';
import type { Connection } from '@/database/provider';
import { decryptSecret, encryptSecret } from '@/infrastructure/crypto/cipher';

/**
 * Plugin ごとの Key-Value Store の実装。
 *
 * **`pluginId` はここで閉じ込める。** Plugin から指定させない。
 * 指定できると、他の Plugin の資格情報を読めてしまう。
 *
 * 契約は `packages/plugin-api` の `PluginStore`。
 */

/** Secret を保存するときの内部表現。 */
interface SecretEnvelope {
  readonly __secret: true;
  readonly value: string;
}

function isSecretEnvelope(value: unknown): value is SecretEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['__secret'] === true &&
    typeof (value as Record<string, unknown>)['value'] === 'string'
  );
}

function assertKey(key: string): void {
  if (!isValidStoreKey(key)) {
    throw new PluginStoreError('キーの形式が不正（英小文字・数字・. _ / - で128文字以内）', key);
  }
}

function serialize(key: string, value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value ?? null);
  } catch {
    throw new PluginStoreError('JSON にできない値', key);
  }

  if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) {
    // 上限を設けないと、Plugin ひとつでデータベースを埋められる。
    throw new PluginStoreError(`値が大きすぎる（上限 ${MAX_VALUE_BYTES} バイト）`, key);
  }

  return json;
}

export interface PluginStoreDeps {
  readonly connection: Connection;
  readonly pluginId: string;
}

export function createPluginStore({ connection, pluginId }: PluginStoreDeps): PluginStore {
  const db = connection.db;

  async function readRow(key: string): Promise<{ value: unknown; is_secret: boolean } | null> {
    const row = await db
      .selectFrom('plugin_store')
      .select(['value', 'is_secret'])
      // **plugin_id は常にここで固定する。** 引数から来ない。
      .where('plugin_id', '=', pluginId)
      .where('key', '=', key)
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }
    return { value: row.value as unknown, is_secret: row.is_secret };
  }

  async function write(key: string, json: string, isSecret: boolean): Promise<void> {
    await db
      .insertInto('plugin_store')
      .values({ plugin_id: pluginId, key, value: json, is_secret: isSecret })
      .onConflict((oc) =>
        oc.columns(['plugin_id', 'key']).doUpdateSet({
          value: json,
          is_secret: isSecret,
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      assertKey(key);
      const row = await readRow(key);
      if (row === null) {
        return null;
      }
      // **Secret は get() では取り出せない。** getSecret() を使わせる。
      // 取れてしまうと、うっかり一覧や画面へ載る。
      if (row.is_secret) {
        return null;
      }
      return row.value as T;
    },

    async set<T = unknown>(key: string, value: T): Promise<void> {
      assertKey(key);
      await write(key, serialize(key, value), false);
    },

    async delete(key: string): Promise<void> {
      assertKey(key);
      await db
        .deleteFrom('plugin_store')
        .where('plugin_id', '=', pluginId)
        .where('key', '=', key)
        .execute();
    },

    async keys(prefix?: string): Promise<string[]> {
      let query = db
        .selectFrom('plugin_store')
        .select('key')
        .where('plugin_id', '=', pluginId)
        .orderBy('key');

      if (prefix !== undefined && prefix !== '') {
        // 前方一致。`%` と `_` はエスケープする。
        const escaped = prefix.replace(/[\\%_]/g, (m) => `\\${m}`);
        query = query.where('key', 'like', `${escaped}%`);
      }

      const rows = await query.execute();
      return rows.map((row) => row.key);
    },

    async setSecret(key: string, value: string): Promise<void> {
      assertKey(key);
      const envelope: SecretEnvelope = { __secret: true, value: encryptSecret(value) };
      await write(key, serialize(key, envelope), true);
    },

    async getSecret(key: string): Promise<string | null> {
      assertKey(key);
      const row = await readRow(key);
      if (row === null || !row.is_secret || !isSecretEnvelope(row.value)) {
        return null;
      }

      const decrypted = decryptSecret(row.value.value);
      // 復号できない値は「無い」として扱う。例外にすると、
      // 鍵を入れ替えた直後に Plugin が一切動かなくなる。
      return decrypted.ok ? decrypted.secret.expose() : null;
    },

    async hasSecret(key: string): Promise<boolean> {
      assertKey(key);
      const row = await readRow(key);
      return row !== null && row.is_secret;
    },
  };
}

/** 内部処理が Secret として受け取りたいとき用。 */
export async function readPluginSecret(store: PluginStore, key: string): Promise<Secret | null> {
  const value = await store.getSecret(key);
  return value === null ? null : new Secret(value);
}
