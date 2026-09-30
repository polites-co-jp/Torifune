import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 画面の `?page=` の読み方の静的検査（044-screen-page-param 設計 §10.4、受け入れ条件 #17・#18）。
 *
 * 画面（Server Component）を直接描いて検査する型は無いので、ソースの形を固定する。
 * 実行時の確認は E2E（`e2e/screen-page-param.spec.ts`）で行う。
 */

/** apps/web/src/application → apps/web/src */
const SRC_DIR = join(import.meta.dirname, '..');
const APP_DIR = join(SRC_DIR, 'app');

function read(...segments: string[]): string {
  return readFileSync(join(SRC_DIR, ...segments), 'utf8');
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

/** `app/` 配下の `page.tsx`（`api/` を除く）を、`app/` からの相対パスで返す。 */
function pageFiles(dir: string = APP_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === APP_DIR && entry.name === 'api') continue;
      found.push(...pageFiles(path));
    } else if (entry.name === 'page.tsx') {
      found.push(relative(APP_DIR, path).split(sep).join('/'));
    }
  }
  return found.sort();
}

/** 設計 §3 の 6 画面と、`page` を読むキー。 */
const SCREENS: readonly { readonly file: string; readonly key: string }[] = [
  { file: 'sites/page.tsx', key: 'page' },
  { file: 'campaigns/page.tsx', key: 'page' },
  { file: 'settings/page.tsx', key: 'page' },
  { file: 'social/history/page.tsx', key: 'page' },
  { file: 'social/page.tsx', key: 'postPage' },
  { file: 'analytics/page.tsx', key: 'page' },
];

describe('#17 6 画面は page を normalizePage で読む', () => {
  for (const { file, key } of SCREENS) {
    const source = (): string => withoutComments(read('app', ...file.split('/')));

    it(`#17 ${file} は normalizePage(params['${key}']) を含む`, () => {
      expect(source()).toContain(`normalizePage(params['${key}'])`);
    });

    it(`#17 ${file} は Math.max(1, Number( を含まない`, () => {
      expect(source()).not.toContain('Math.max(1, Number(');
    });

    it(`#17 ${file} は function parsePage を含まない`, () => {
      expect(source()).not.toContain('function parsePage');
    });

    it(`#17 ${file} は normalizePage を @/domain/repository から import する`, () => {
      // 値として呼ぶので `import type` は認めない。
      expect(source()).toMatch(
        /import\s*\{[^}]*\bnormalizePage\b[^}]*\}\s*from\s*['"]@\/domain\/repository['"]/,
      );
    });
  }
});

describe('#18 app/ のすべての page.tsx（api/ を除く）で page を含むキーは normalizePage で読む', () => {
  const files = pageFiles();

  /** `params['…page…']`（大文字小文字を問わない）の各出現と、その直前の文字列。 */
  function pageReads(source: string): { key: string; before: string }[] {
    const reads: { key: string; before: string }[] = [];
    for (const match of source.matchAll(/params\[\s*['"]([^'"]*page[^'"]*)['"]\s*\]/gi)) {
      reads.push({ key: match[1] ?? '', before: source.slice(0, match.index) });
    }
    return reads;
  }

  const sources = files.map((file) => ({
    file,
    source: withoutComments(read('app', ...file.split('/'))),
  }));

  it('#18 走査の対象の page.tsx が見つかる（空振りで緑にしない）', () => {
    expect(files.length).toBeGreaterThanOrEqual(SCREENS.length);
    for (const { file } of SCREENS) {
      expect(files).toContain(file);
    }
  });

  it('#18 page を含むキーの読み出しが 6 画面ぶん以上ある（空振りで緑にしない）', () => {
    const count = sources.reduce((sum, { source }) => sum + pageReads(source).length, 0);

    expect(count).toBeGreaterThanOrEqual(SCREENS.length);
  });

  it('#18 normalizePage( の出現が 6 以上ある', () => {
    const count = sources.reduce(
      (sum, { source }) => sum + (source.match(/\bnormalizePage\(/g)?.length ?? 0),
      0,
    );

    expect(count).toBeGreaterThanOrEqual(SCREENS.length);
  });

  it('#18 page を含むキーの読み出しはすべて normalizePage( の直後にある', () => {
    const offenders = sources.flatMap(({ file, source }) =>
      pageReads(source)
        .filter(({ before }) => !/normalizePage\(\s*$/.test(before))
        .map(({ key }) => `${file}: params['${key}']`),
    );

    expect(offenders).toEqual([]);
  });

  it('#18 どの page.tsx にも Number(params[ が無い', () => {
    const offenders = sources
      .filter(({ source }) => /Number\(\s*params\[/.test(source))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('#18 どの page.tsx にも Number(asString(params[ が無い', () => {
    const offenders = sources
      .filter(({ source }) => /Number\(\s*asString\(\s*params\[/.test(source))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });
});
