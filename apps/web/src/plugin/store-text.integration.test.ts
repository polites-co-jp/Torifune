import { PluginStoreError, type PluginStore } from '@torifune/plugin-api';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withConnection } from '@/application/transaction';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { createPluginStore } from './store';

/**
 * Plugin Store の保存できない文字（L3。046-input-500-nul-and-ranges 設計 §9.3、受け入れ条件 #30・#31）。
 *
 * - #30：`set` の値（文字列・入れ子の値・オブジェクトのキー）に NUL（U+0000）か対になっていないサロゲート（片割れ）があれば、
 *   Postgres の `DatabaseError` ではなく `PluginStoreError`（`key` はその `key`、`message` に値が無い）で reject し、保存しない。
 *   その後の `get` は前の値（無ければ `null`）
 * - #31：`keys(prefix)` の `prefix` に NUL・片割れ → `[]`（問い合わせない）。`setSecret` の NUL は従来どおり成功し、
 *   `getSecret` が渡した値を返す。絵文字の文字列は `set` できて、`get` が同じ文字列を返す
 *
 * `store.integration.test.ts` の作り方を写した。**ソースに壊れた文字を置かない。**
 */

const MARKER = 'marker-046';
/** U+1F44D（対になったサロゲート）。 */
const EMOJI = String.fromCodePoint(0x1f44d);

let scratch: ScratchDatabase;
let store: PluginStore;

async function storeFor(pluginId: string): Promise<PluginStore> {
  return withConnection(async (connection) => createPluginStore({ connection, pluginId }));
}

/** 返した Promise が reject したときの例外。resolve したらテストを落とす。 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return expect.unreachable('reject されなかった');
}

/** 設計 #30 の 5 つの値。 */
const UNSTORABLE: readonly (readonly [string, unknown])[] = [
  ["'v\\u0000'（文字列の NUL）", `v${MARKER}\u0000`],
  ["{ a: 'v\\u0000' }（入れ子の値の NUL）", { a: `v${MARKER}\u0000` }],
  ["{ 'a\\u0000': 1 }（キーの NUL）", { [`a${MARKER}\u0000`]: 1 }],
  ["'v\\ud800'（文字列の片割れ）", `v${MARKER}\ud800`],
  ["{ 'a\\ud800': 1 }（キーの片割れ）", { [`a${MARKER}\ud800`]: 1 }],
  [
    "{ list: ['ok', { deep: 'v\\ud800' }] }（深い入れ子の片割れ）",
    { list: ['ok', { deep: `v${MARKER}\ud800` }] },
  ],
];

beforeAll(async () => {
  scratch = await useScratchDatabase('pluginstoretext');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  store = await storeFor('store-text-plugin');
});

afterEach(async () => {
  await withConnection((connection) => connection.db.deleteFrom('plugin_store').execute());
});

describe('#30 set の値に NUL・片割れがあれば PluginStoreError', () => {
  it.each(UNSTORABLE)(
    '#30 set(k, %s) → PluginStoreError（DatabaseError ではない）',
    async (_label, value) => {
      const error = await rejectionOf(store.set('k', value));

      expect(error).not.toBeInstanceOf(pg.DatabaseError);
      expect(error).toBeInstanceOf(PluginStoreError);
    },
  );

  it.each(UNSTORABLE)("#30 set(k, %s) → PluginStoreError の key === 'k'", async (_label, value) => {
    const error = await rejectionOf(store.set('k', value));

    expect((error as PluginStoreError).key).toBe('k');
  });

  it.each(UNSTORABLE)('#30 set(k, %s) → message に値が無い', async (_label, value) => {
    const error = await rejectionOf(store.set('k', value));

    expect((error as Error).message).not.toContain(MARKER);
  });

  it.each(UNSTORABLE)('#30 set(k, %s) の後、前に入れた値が残る', async (_label, value) => {
    await store.set('k', { previous: true });

    await rejectionOf(store.set('k', value));

    await expect(store.get('k')).resolves.toEqual({ previous: true });
  });

  it.each(UNSTORABLE)(
    '#30 set(k, %s) の後、前の値が無ければ get は null',
    async (_label, value) => {
      await rejectionOf(store.set('k', value));

      await expect(store.get('k')).resolves.toBeNull();
    },
  );
});

describe('#31 keys の接頭辞・setSecret・絵文字', () => {
  beforeEach(async () => {
    await store.set('k/one', 1);
    await store.set('k/two', 2);
  });

  it("#31 keys('k\\u0000') → []（DatabaseError ではない）", async () => {
    await expect(store.keys('k\u0000')).resolves.toEqual([]);
  });

  it("#31 keys('k\\ud800') → []", async () => {
    await expect(store.keys('k\ud800')).resolves.toEqual([]);
  });

  it('#31 対照：NUL の無い接頭辞は従来どおりキーを返す', async () => {
    await expect(store.keys('k/')).resolves.toEqual(['k/one', 'k/two']);
  });

  it("#31 setSecret('s', 'v\\u0000') → 成功し、getSecret('s') が 'v\\u0000'", async () => {
    await store.setSecret('s', 'v\u0000');

    await expect(store.getSecret('s')).resolves.toBe('v\u0000');
  });

  it('#31 絵文字の文字列を set → 成功し、get が同じ文字列', async () => {
    const value = `いいね${EMOJI}`;

    await store.set('emoji', value);

    await expect(store.get('emoji')).resolves.toBe(value);
  });

  it('#31 絵文字のキーと値を持つオブジェクトを set → 成功し、get が同じ値', async () => {
    const value = { [`k${EMOJI}`]: [EMOJI, { nested: EMOJI }] };

    await store.set('emoji-object', value);

    await expect(store.get('emoji-object')).resolves.toEqual(value);
  });
});
