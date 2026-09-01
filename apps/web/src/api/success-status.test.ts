import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 201 を返すのに OpenAPI が 200 と書く、という食い違いを防ぐ。
 *
 * **`defineRoute` の既定は 200。** `createdResponse(...)`（201）を返すのに
 * `successStatus: 201` を書き忘れると、**文書だけが嘘になる**。
 * 実装は動くのでテストも通り、OpenAPI を読んだ人だけが騙される。
 * `05_API設計.md` §40 の「仕様と実装が乖離しないよう」に直接反する。
 *
 * 目で見て揃えるのではなく、実際の route.ts と突き合わせる。
 */

const API_DIR = join(import.meta.dirname, '..', 'app', 'api');

async function routeFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name === 'route.ts')
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('成功ステータスの宣言', () => {
  it('createdResponse を返す経路は successStatus: 201 を宣言している', async () => {
    const offenders: string[] = [];

    for (const file of await routeFiles(API_DIR)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('createdResponse(')) {
        continue;
      }
      // `/api/health` など defineRoute を使わない経路は対象外。
      if (!source.includes('defineRoute(')) {
        continue;
      }
      if (!/successStatus:\s*201/.test(source)) {
        offenders.push(file.replace(/.*[/\\]app[/\\]/, 'app/'));
      }
    }

    expect(
      offenders,
      `201 を返すのに successStatus を宣言していない。OpenAPI が 200 と嘘をつく:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
