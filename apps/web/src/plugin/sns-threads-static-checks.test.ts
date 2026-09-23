import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_EXTENSION_KINDS, validateManifest } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';
import { CORE_PERMISSIONS } from '@/domain/permission';

/**
 * Threads 配信 Plugin の静的検査（040-sns-threads 設計 §8.1 / §10.2）。
 *
 * ここで見るのは「ファイルに何が書かれているか」だけで、実行しない。
 * 走査の仕方は `sns-instagram-static-checks.test.ts` / `sns-x-static-checks.test.ts` の流儀に揃えてある。
 *
 * 担当する受け入れ条件（この時点）：#5、#6（実装プラン T1）。
 * #1〜#4、#7〜#13、#102、#104、#107（E 側）は実装プラン T28 でこのファイルに足す。
 */

const PLUGIN_ID = 'sns-threads';
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLUGIN_DIR = join(REPO_ROOT, 'plugins', PLUGIN_ID);

function read(name: string): string {
  return readFileSync(join(PLUGIN_DIR, name), 'utf8');
}

function manifest(): Record<string, unknown> {
  return JSON.parse(read('plugin.json')) as Record<string, unknown>;
}

describe('#5 Manifest', () => {
  it('#5 validateManifest に通る', () => {
    const result = validateManifest(manifest(), { knownPermissions: [...CORE_PERMISSIONS] });

    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });

  it('#5 id が sns-threads、name が Threads配信、apiVersion が 1', () => {
    const raw = manifest();

    expect(raw['id']).toBe(PLUGIN_ID);
    expect(raw['name']).toBe('Threads配信');
    expect(raw['apiVersion']).toBe(1);
  });

  it('#5 Permission を 1 つも要求しない', () => {
    // Data API を 1 度も呼ばない（設計 §8）。
    expect(manifest()['permissions']).toEqual([]);
  });

  it('#5 拡張点は social ちょうど（ui を含まない）', () => {
    // 使わない拡張点を宣言しない（設計 §8.1）。
    expect(manifest()['extensions']).toEqual(['social']);
  });

  it('#5 拡張点は PLUGIN_EXTENSION_KINDS にある値だけ', () => {
    for (const kind of manifest()['extensions'] as string[]) {
      expect(PLUGIN_EXTENSION_KINDS as readonly string[], kind).toContain(kind);
    }
  });

  it('#5 dependencies を持たない', () => {
    // 他の Plugin を知らない（設計 §4.1）。
    expect('dependencies' in manifest()).toBe(false);
  });
});

describe('#6 Manifest の name と description に他の Plugin の名前が無い', () => {
  // 既存の E2E は /plugins の行を Manifest の name で絞る。Threads の行の文言に他の名前が入ると、
  // 既存のロケータが 2 行に当たって strict mode で落ちる（設計 §8.1 / #105）。
  it.each(['Bluesky配信', 'Instagram配信', 'X配信', 'Instagram'])(
    '#6 name に「%s」が現れない',
    (word) => {
      expect(String(manifest()['name'])).not.toContain(word);
    },
  );

  it.each(['Bluesky配信', 'Instagram配信', 'X配信', 'Instagram'])(
    '#6 description に「%s」が現れない',
    (word) => {
      expect(String(manifest()['description'])).not.toContain(word);
    },
  );

  it('#6 description は空でない（検査が素通りしないための前提）', () => {
    expect(typeof manifest()['description']).toBe('string');
    expect(String(manifest()['description']).trim().length).toBeGreaterThan(0);
  });
});
