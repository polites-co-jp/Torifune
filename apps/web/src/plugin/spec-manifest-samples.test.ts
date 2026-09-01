import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';

/**
 * 仕様書に載っている Manifest のサンプルが、実際に導入できる形になっているか。
 *
 * **文章を直すだけでは同じことが起きる。**
 * `06_画面設計.md` §19 の `apiVersion` を文字列から数値へ直したとき、
 * **同じサンプルの `id` にドットが入っていることを見落とした**（`example.plugin`）。
 * `03_プラグイン設計.md` §11 に至っては丸ごと手つかずで、
 * `id` が無い・`apiVersion` が `"1.0"`・`dependencies` が配列、の3点が誤っていた。
 *
 * 仕様書どおりに書いた Plugin が導入時に必ず弾かれる、というのは
 * **OSS として最も避けたい種類の不整合**なので、機械で確かめる。
 */

const SPEC_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'docs', '仕様書');

/** ```json ... ``` のうち、Manifest に見えるもの（`apiVersion` を持つもの）。 */
function manifestSamplesIn(source: string): unknown[] {
  const blocks = [...source.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');

  const samples: unknown[] = [];
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      // Manifest 以外の JSON 例（応答の形など）に壊れたものがあっても、
      // ここでは関知しない。
      continue;
    }
    if (typeof parsed === 'object' && parsed !== null && 'apiVersion' in parsed) {
      samples.push(parsed);
    }
  }
  return samples;
}

function specFiles(): string[] {
  return (
    readdirSync(SPEC_DIR)
      .filter((name) => name.endsWith('.md'))
      // 改訂履歴は「直す前の誤った例」を意図的に引用することがある。
      .filter((name) => name !== '改訂履歴.md')
      .map((name) => join(SPEC_DIR, name))
  );
}

describe('仕様書の Manifest サンプル', () => {
  const found: { file: string; sample: unknown }[] = [];
  for (const file of specFiles()) {
    for (const sample of manifestSamplesIn(readFileSync(file, 'utf8'))) {
      found.push({ file, sample });
    }
  }

  /** サンプルを1つも拾えていないと、この検査は素通りする。 */
  it('サンプルを拾えている', () => {
    expect(found.length).toBeGreaterThanOrEqual(3);
  });

  for (const { file, sample } of found) {
    const id = (sample as { id?: unknown }).id;
    it(`${file.split(/[/\\]/).pop()} の ${String(id ?? '(id なし)')} が導入できる`, () => {
      const result = validateManifest(sample);

      expect(
        result.ok,
        result.ok ? '' : `仕様書どおりに書くと弾かれる: ${JSON.stringify(result.problems)}`,
      ).toBe(true);
    });
  }
});
