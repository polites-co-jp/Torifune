import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_EXTENSION_KINDS, validateManifest } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';
import { CORE_PERMISSIONS } from '@/domain/permission';

/**
 * Bluesky 配信 Plugin の静的検査（036-sns-bluesky 設計 §10）。
 *
 * ここで見るのは「ファイルに何が書かれているか」だけで、実行しない。
 * 走査の仕方は `example-plugin.integration.test.ts` の流儀に揃えてある。
 *
 * **G1 の範囲は #4（Manifest）と #3（`text.ts` の import 制限）。**
 * 残り（#1 / #2 / #5 / #6 / #7 / #8 / #52 / #71 / #73）は、
 * 検査の対象になるファイルが揃う G5（実装プラン T21）で足す。
 */

const PLUGIN_ID = 'sns-bluesky';
const PLUGIN_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'plugins', PLUGIN_ID);

function read(name: string): string {
  return readFileSync(join(PLUGIN_DIR, name), 'utf8');
}

describe('#4 Manifest', () => {
  function manifest(): unknown {
    return JSON.parse(read('plugin.json'));
  }

  it('validateManifest に通る', () => {
    const result = validateManifest(manifest(), { knownPermissions: [...CORE_PERMISSIONS] });

    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });

  it('id が sns-bluesky で apiVersion が 1', () => {
    const raw = manifest() as Record<string, unknown>;

    expect(raw['id']).toBe(PLUGIN_ID);
    expect(raw['apiVersion']).toBe(1);
  });

  it('Permission を1つも要求しない', () => {
    // Data API を1度も呼ばない。投稿も資格情報も引数として渡ってくる（設計 §8）。
    expect((manifest() as Record<string, unknown>)['permissions']).toEqual([]);
  });

  it('拡張点は social と ui の2つ', () => {
    const extensions = (manifest() as Record<string, unknown>)['extensions'];

    expect(Array.isArray(extensions)).toBe(true);
    expect([...(extensions as string[])].sort()).toEqual(['social', 'ui']);
  });

  it('拡張点は PLUGIN_EXTENSION_KINDS にある値だけ', () => {
    // 独自の値を足すと /plugins に生の値がそのまま出る（設計 §9.1）。
    for (const kind of (manifest() as Record<string, unknown>)['extensions'] as string[]) {
      expect(PLUGIN_EXTENSION_KINDS as readonly string[], kind).toContain(kind);
    }
  });
});

describe('#3 text.ts は純関数だけ', () => {
  it('@torifune/plugin-api を型としてしか import しない', () => {
    const source = read('text.ts');

    for (const match of source.matchAll(/^import\s+([^\n]*?)\s+from\s+'([^']+)';$/gm)) {
      const [, clause, specifier] = match;
      if (specifier === '@torifune/plugin-api') {
        expect(clause, `text.ts: ${match[0]}`).toMatch(/^type\s/);
      }
    }
  });

  it('store や fetch を持ち込まない', () => {
    const source = read('text.ts');

    expect(source).not.toMatch(/(?<![.\w])fetch\s*\(/);
    expect(source).not.toContain('globalThis.fetch');
    expect(source).not.toMatch(/from\s+'\.\/(settings|social|atproto)'/);
    expect(source).not.toContain('PluginStore');
  });
});
