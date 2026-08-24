import { PluginStoreError, type PluginStore } from '@torifune/plugin-api';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withConnection } from '@/application/transaction';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { createPluginStore } from './store';

let scratch: ScratchDatabase;

/** Plugin ごとの Store を作る。`pluginId` は Store が閉じ込める。 */
async function storeFor(pluginId: string): Promise<PluginStore> {
  return withConnection(async (connection) => createPluginStore({ connection, pluginId }));
}

let store: PluginStore;
let other: PluginStore;

beforeAll(async () => {
  scratch = await useScratchDatabase('pluginstore');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  store = await storeFor('seo-plugin');
  other = await storeFor('analytics-plugin');
});

afterEach(async () => {
  await withConnection((connection) => connection.db.deleteFrom('plugin_store').execute());
});

describe('値の読み書き', () => {
  it('保存して取り出せる', async () => {
    await store.set('greeting', 'hello');

    await expect(store.get('greeting')).resolves.toBe('hello');
  });

  it('保存していないキーは null', async () => {
    await expect(store.get('missing')).resolves.toBeNull();
  });

  it('上書きできる', async () => {
    await store.set('n', 1);
    await store.set('n', 2);

    await expect(store.get('n')).resolves.toBe(2);
  });

  it('削除できる', async () => {
    await store.set('gone', 'x');
    await store.delete('gone');

    await expect(store.get('gone')).resolves.toBeNull();
  });

  it('存在しないキーの削除で例外を投げない', async () => {
    await expect(store.delete('never-existed')).resolves.toBeUndefined();
  });

  it('オブジェクト・配列・数値・真偽値を往復できる', async () => {
    const value = { list: [1, 2, 3], nested: { flag: true }, count: 42, name: 'とりふね' };
    await store.set('complex', value);

    await expect(store.get('complex')).resolves.toEqual(value);
  });

  it('null を保存できる', async () => {
    await store.set('nothing', null);

    await expect(store.get('nothing')).resolves.toBeNull();
  });
});

describe('キーの一覧', () => {
  beforeEach(async () => {
    await store.set('oauth/client-id', 'a');
    await store.set('oauth/scope', 'b');
    await store.set('settings/theme', 'c');
  });

  it('すべてのキーを返す', async () => {
    await expect(store.keys()).resolves.toEqual([
      'oauth/client-id',
      'oauth/scope',
      'settings/theme',
    ]);
  });

  it('接頭辞で絞り込める', async () => {
    await expect(store.keys('oauth/')).resolves.toEqual(['oauth/client-id', 'oauth/scope']);
  });

  it('接頭辞のワイルドカードが解釈されない', async () => {
    // 解釈されると全件返ってしまう。
    await expect(store.keys('%')).resolves.toEqual([]);
  });

  it('Secret のキーも一覧に出る（値は出ない）', async () => {
    await store.setSecret('oauth/token', 'secret-value');

    const keys = await store.keys('oauth/');
    expect(keys).toContain('oauth/token');
  });
});

describe('名前空間の分離', () => {
  it('他の Plugin の値が見えない', async () => {
    await other.set('shared-key', 'analytics value');

    await expect(store.get('shared-key')).resolves.toBeNull();
  });

  it('同じキーを別の Plugin が持てる', async () => {
    await store.set('config', 'seo');
    await other.set('config', 'analytics');

    await expect(store.get('config')).resolves.toBe('seo');
    await expect(other.get('config')).resolves.toBe('analytics');
  });

  it('他の Plugin のキーが一覧に出ない', async () => {
    await other.set('analytics-only', 'x');

    await expect(store.keys()).resolves.toEqual([]);
  });

  it('他の Plugin の値を上書きできない', async () => {
    await other.set('config', 'analytics');
    await store.set('config', 'seo');

    await expect(other.get('config')).resolves.toBe('analytics');
  });

  it('他の Plugin の値を削除できない', async () => {
    await other.set('config', 'analytics');
    await store.delete('config');

    await expect(other.get('config')).resolves.toBe('analytics');
  });

  it('他の Plugin の Secret が読めない', async () => {
    await other.setSecret('token', 'analytics-secret');

    await expect(store.getSecret('token')).resolves.toBeNull();
    await expect(store.hasSecret('token')).resolves.toBe(false);
  });
});

describe('Secret', () => {
  const SECRET = 'plugin-access-token-value';

  it('保存して取り出せる', async () => {
    await store.setSecret('oauth/token', SECRET);

    await expect(store.getSecret('oauth/token')).resolves.toBe(SECRET);
  });

  it('DB 上で平文になっていない', async () => {
    await store.setSecret('oauth/token', SECRET);

    const row = await withConnection((connection) =>
      connection.db
        .selectFrom('plugin_store')
        .select('value')
        .where('plugin_id', '=', 'seo-plugin')
        .where('key', '=', 'oauth/token')
        .executeTakeFirst(),
    );

    expect(JSON.stringify(row?.value)).not.toContain(SECRET);
    expect(JSON.stringify(row?.value)).toContain('v1.');
  });

  it('get() では取り出せない', async () => {
    // 取れてしまうと、うっかり一覧や画面へ載る。
    await store.setSecret('oauth/token', SECRET);

    await expect(store.get('oauth/token')).resolves.toBeNull();
  });

  it('hasSecret が設定済みかを返す', async () => {
    await expect(store.hasSecret('oauth/token')).resolves.toBe(false);

    await store.setSecret('oauth/token', SECRET);

    await expect(store.hasSecret('oauth/token')).resolves.toBe(true);
  });

  it('通常の値に対して hasSecret は false', async () => {
    await store.set('plain', 'x');

    await expect(store.hasSecret('plain')).resolves.toBe(false);
  });

  it('Secret を削除できる', async () => {
    await store.setSecret('oauth/token', SECRET);
    await store.delete('oauth/token');

    await expect(store.getSecret('oauth/token')).resolves.toBeNull();
  });

  it('Secret を上書きできる', async () => {
    await store.setSecret('oauth/token', SECRET);
    await store.setSecret('oauth/token', 'new-value');

    await expect(store.getSecret('oauth/token')).resolves.toBe('new-value');
  });

  it('通常の値を Secret として読もうとしても null', async () => {
    await store.set('plain', 'x');

    await expect(store.getSecret('plain')).resolves.toBeNull();
  });

  it('同じ値でも毎回異なる暗号文になる', async () => {
    await store.setSecret('a', SECRET);
    const first = await withConnection((connection) =>
      connection.db
        .selectFrom('plugin_store')
        .select('value')
        .where('key', '=', 'a')
        .executeTakeFirst(),
    );

    await store.setSecret('b', SECRET);
    const second = await withConnection((connection) =>
      connection.db
        .selectFrom('plugin_store')
        .select('value')
        .where('key', '=', 'b')
        .executeTakeFirst(),
    );

    expect(JSON.stringify(first?.value)).not.toBe(JSON.stringify(second?.value));
  });
});

describe('入力の検証', () => {
  it('キーの形式が不正なら拒否する', async () => {
    await expect(store.set('BAD KEY', 'x')).rejects.toThrowError(PluginStoreError);
    await expect(store.set('../escape', 'x')).rejects.toThrowError(PluginStoreError);
    await expect(store.set('', 'x')).rejects.toThrowError(PluginStoreError);
  });

  it('階層つきのキーを受け入れる', async () => {
    await expect(store.set('oauth/tokens/access', 'x')).resolves.toBeUndefined();
  });

  it('長すぎるキーを拒否する', async () => {
    await expect(store.set('a'.repeat(129), 'x')).rejects.toThrowError(PluginStoreError);
  });

  it('大きすぎる値を拒否する', async () => {
    // 上限が無いと、Plugin ひとつでデータベースを埋められる。
    const huge = 'a'.repeat(300 * 1024);

    await expect(store.set('huge', huge)).rejects.toThrowError(PluginStoreError);
  });

  it('循環参照を含む値を拒否する', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    await expect(store.set('circular', circular)).rejects.toThrowError(PluginStoreError);
  });

  it('読み取りでもキーの形式を検証する', async () => {
    await expect(store.get('BAD KEY')).rejects.toThrowError(PluginStoreError);
    await expect(store.getSecret('BAD KEY')).rejects.toThrowError(PluginStoreError);
  });
});
