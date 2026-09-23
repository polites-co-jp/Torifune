import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_EXTENSION_KINDS, validateManifest } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';
import { CORE_PERMISSIONS } from '@/domain/permission';

/**
 * X 配信 Plugin（`sns-x-manual` / `sns-x-api`）の静的検査（037-sns-x 設計 §10.1 / §10.2 / §10.14 / §10.15）。
 *
 * ここで見るのは「ファイルに何が書かれているか」だけで、実行しない。
 * 走査の仕方は `sns-instagram-static-checks.test.ts` の流儀に揃えてある。
 *
 * 担当する受け入れ条件（このファイルの最終形）：#1〜#9、#11、#12、#84、#85、#88、#89（E 側）、#92（E 側）。
 * **いま置いてあるのは #5（実装プラン T1）と #9（T6）だけ。** 残りは T24 で足す。
 */

const PLUGINS_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'plugins');

const PLUGIN_IDS = ['sns-x-manual', 'sns-x-api'] as const;
type PluginId = (typeof PLUGIN_IDS)[number];

function readPlugin(id: PluginId, name: string): string {
  return readFileSync(join(PLUGINS_DIR, id, name), 'utf8');
}

function manifest(id: PluginId): Record<string, unknown> {
  return JSON.parse(readPlugin(id, 'plugin.json')) as Record<string, unknown>;
}

describe.each(PLUGIN_IDS)('#5 %s の Manifest', (id) => {
  it('#5 validateManifest に通る', () => {
    const result = validateManifest(manifest(id), { knownPermissions: [...CORE_PERMISSIONS] });

    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });

  it('#5 id がディレクトリ名と同じで、apiVersion が 1', () => {
    const raw = manifest(id);

    expect(raw['id']).toBe(id);
    expect(raw['apiVersion']).toBe(1);
  });

  it('#5 Permission を 1 つも要求しない', () => {
    // Data API を 1 度も呼ばない（設計 §8）。
    expect(manifest(id)['permissions']).toEqual([]);
  });

  it('#5 拡張点は social ちょうど（ui を含まない）', () => {
    // 使わない拡張点を宣言しない（設計 §8.1）。
    expect(manifest(id)['extensions']).toEqual(['social']);
  });

  it('#5 拡張点は PLUGIN_EXTENSION_KINDS にある値だけ', () => {
    for (const kind of manifest(id)['extensions'] as string[]) {
      expect(PLUGIN_EXTENSION_KINDS as readonly string[], kind).toContain(kind);
    }
  });

  it('#5 dependencies を持たない', () => {
    // 2 つは同時に有効にできないので、依存で結ぶとどちらも有効にできなくなる（設計 §4.1）。
    expect('dependencies' in manifest(id)).toBe(false);
  });

  it('#5 description に「同時には有効にできない」が現れる', () => {
    // 導入前の /plugins で読まれる場所に、入れ替えの前提を置く（設計 §8.1）。
    expect(String(manifest(id)['description'])).toContain('同時には有効にできない');
  });
});

describe('#5 sns-x-manual の Manifest の description', () => {
  it('#5 資格情報を使わない趣旨がある', () => {
    // /plugins の「資格情報を受け取ります」は Core の固定文なので、description で補う（設計 §7 / §11 #9）。
    expect(String(manifest('sns-x-manual')['description'])).toMatch(/資格情報[^。]*使わない/);
  });
});

describe('#87 の前提：Manifest の name', () => {
  it.each([
    ['sns-x-manual', 'X配信（手動投稿）'],
    ['sns-x-api', 'X配信（X API）'],
  ] as const)('%s の name は %s（E2E は name の全体で行を絞る）', (id, name) => {
    // 2 つの name は「X配信」を共有する。E2E は全体（括弧は全角）で絞るので、ここが変わると #87 が当たらない。
    expect(manifest(id)['name']).toBe(name);
  });
});

/**
 * #9。**2 つの `x-text.ts` はバイト単位で同じ**（設計 §4.2 の案 D）。
 *
 * 比較は文字列にせず `Buffer` のまま行う（改行コード・BOM・末尾の改行の差も拾う）。
 */
describe('#9 2 つの x-text.ts の一致', () => {
  function xTextBytes(id: PluginId): Buffer {
    return readFileSync(join(PLUGINS_DIR, id, 'x-text.ts'));
  }

  /** #9 の比較関数。判別力の検査にも同じ関数を掛ける。 */
  function sameBytes(left: Buffer, right: Buffer): boolean {
    return left.equals(right);
  }

  it('#9 plugins/sns-x-manual/x-text.ts と plugins/sns-x-api/x-text.ts がバイト単位で一致する', () => {
    const manual = xTextBytes('sns-x-manual');
    const api = xTextBytes('sns-x-api');

    expect(manual.length, '空のファイル同士の一致は検査にならない').toBeGreaterThan(0);
    expect(sameBytes(manual, api)).toBe(true);
  });

  it('#9 比較は 1 文字足した写しを見分ける（判別力）', () => {
    const original = xTextBytes('sns-x-manual');
    const appended = Buffer.concat([original, Buffer.from('a', 'utf8')]);

    expect(sameBytes(original, appended)).toBe(false);
  });

  it('#9 比較は 1 バイトだけ置き換えた写しを見分ける（判別力）', () => {
    const original = xTextBytes('sns-x-manual');
    const replaced = Buffer.from(original);
    const middle = Math.floor(replaced.length / 2);
    replaced[middle] = (replaced[middle] ?? 0) ^ 0x01;

    expect(replaced.length).toBe(original.length);
    expect(sameBytes(original, replaced)).toBe(false);
  });

  it('#9 比較は同じ内容の写しを一致と判定する', () => {
    const original = xTextBytes('sns-x-manual');

    expect(sameBytes(original, Buffer.from(original))).toBe(true);
  });
});
