import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_EXTENSION_KINDS, validateManifest } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';
import { CORE_PERMISSIONS } from '@/domain/permission';

/**
 * Instagram 配信 Plugin の静的検査（038-sns-instagram 設計 §10）。
 *
 * ここで見るのは「ファイルに何が書かれているか」だけで、実行しない。
 * 走査の仕方は `sns-bluesky-static-checks.test.ts` の流儀に揃えてある。
 *
 * 担当する受け入れ条件（G1 の時点）：#3、#5。
 *
 * > **「無いこと」を見る検査は、実装が無いうちは素通りする**（実装プラン §7 の 2）。
 * > 判別力が付くのは実装が入った後なので、**T24 で全件そろえて走らせる**。
 */

const PLUGIN_ID = 'sns-instagram';
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLUGIN_DIR = join(REPO_ROOT, 'plugins', PLUGIN_ID);

function read(name: string): string {
  return readFileSync(join(PLUGIN_DIR, name), 'utf8');
}

describe('#3 caption.ts と token.ts は純関数だけ', () => {
  const PURE_FILES = ['caption.ts', 'token.ts'] as const;

  it.each(PURE_FILES)('#3 %s は @torifune/plugin-api を型としてしか import しない', (name) => {
    const source = read(name);

    for (const match of source.matchAll(/^import\s+([^\n]*?)\s+from\s+'([^']+)';$/gm)) {
      const [, clause, specifier] = match;
      if (specifier === '@torifune/plugin-api') {
        expect(clause, `${name}: ${match[0]}`).toMatch(/^type\s/);
      }
    }
  });

  it.each(PURE_FILES)('#3 %s は fetch を持ち込まない', (name) => {
    const source = read(name);

    expect(source).not.toMatch(/(?<![.\w])fetch\s*\(/);
    expect(source).not.toContain('globalThis.fetch');
    expect(source).not.toMatch(/from\s+'\.\/(social|graph)'/);
  });

  it.each(PURE_FILES)('#3 %s は時計を持たない（Date.now / 引数なしの new Date()）', (name) => {
    // 時刻は引数で受ける（設計 §4）。
    const source = read(name);

    expect(source).not.toContain('Date.now');
    expect(source).not.toMatch(/new Date\(\s*\)/);
  });
});

describe('#5 Manifest', () => {
  function manifest(): Record<string, unknown> {
    return JSON.parse(read('plugin.json')) as Record<string, unknown>;
  }

  it('#5 validateManifest に通る', () => {
    const result = validateManifest(manifest(), { knownPermissions: [...CORE_PERMISSIONS] });

    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });

  it('#5 id が sns-instagram で apiVersion が 1', () => {
    const raw = manifest();

    expect(raw['id']).toBe(PLUGIN_ID);
    expect(raw['apiVersion']).toBe(1);
  });

  it('#5 Permission を1つも要求しない', () => {
    // Data API を1度も呼ばない（設計 §8）。
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
});
