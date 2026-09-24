import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `ui/help/` の静的検査（041-plugin-help-docs 設計 §7.3.2、受け入れ条件 #30）。
 *
 * **HTML の文字列を経由しない**ことを、実装の外から固定する。
 * `dangerouslySetInnerHTML` を使えば Markdown の描画の安全が文字列の上の確かめになり、
 * `rehype-raw` を入れれば手順書の生の HTML が要素として描かれる（設計 §3.2・§4.2）。
 *
 * #65・#73（`'use client'` との境界・文言の直書き）は G6 でこのファイルに足す。
 */

const HELP_DIR = import.meta.dirname;

/** `ui/help/` の実装のファイル（テストを除く）。 */
function implementationFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      files.push(...implementationFiles(path));
      continue;
    }
    if (/\.test\.tsx?$/.test(name)) continue;
    files.push(path);
  }
  return files;
}

describe('#30 ui/help/ は HTML の文字列を差し込まない', () => {
  it('#30 検査の対象に markdown-view.tsx と help-links.ts が含まれる（空の集合で素通りしない）', () => {
    const names = implementationFiles(HELP_DIR).map((path) => relative(HELP_DIR, path));

    expect(names).toContain('markdown-view.tsx');
    expect(names).toContain('help-links.ts');
  });

  it('#30 どのファイルにも dangerouslySetInnerHTML が現れない', () => {
    for (const path of implementationFiles(HELP_DIR)) {
      expect(readFileSync(path, 'utf8'), relative(HELP_DIR, path)).not.toContain(
        'dangerouslySetInnerHTML',
      );
    }
  });

  it('#30 どのファイルにも rehype-raw が現れない', () => {
    for (const path of implementationFiles(HELP_DIR)) {
      expect(readFileSync(path, 'utf8'), relative(HELP_DIR, path)).not.toContain('rehype-raw');
    }
  });
});
