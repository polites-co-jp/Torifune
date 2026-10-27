import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `Cache-Control: no-store` の付与の外に出るルートを固定する静的検査（058-api-no-store 設計 §5.5・§14、受け入れ条件 #33・#34）。
 *
 * - #33：`defineRoute(` を使わない `route.ts` は許可の一覧の 4 つだけ。**双方向で一致**させる（足しても消しても落ちる）。
 *   `defineRoute` を通らないルートには出口の `no-store` が付かないので、新しく足すなら一覧に足して理由を書く。
 *   あわせて、`defineRoute(` を使う `route.ts` の export がすべて `export const <METHOD> = defineRoute(` の形であることを見る
 *   （素の `export async function POST` を混ぜたファイルは、ファイル単位の一致では素通りする。検証レポート §1.4 の軽微-1）
 * - #34：ヘッダの変えられない応答（`Response.redirect(`・`Response.error(`）を返さない。返すと出口の `headers.set` が
 *   例外になる（設計 §14 の R1）
 *
 * パスは `apps/web/src/app` からの相対で、区切りを `/` に揃えて比べる（Windows でも通す。実装プラン §8 の 10）。
 */

const SRC_DIR = join(import.meta.dirname, '..');
const APP_DIR = join(SRC_DIR, 'app');
const APP_API_DIR = join(APP_DIR, 'api');
const API_DIR = join(SRC_DIR, 'api');

/**
 * `defineRoute` を通らないルートの許可の一覧（設計 §5.5）。**足すときは理由を書く。**
 */
const ROUTES_WITHOUT_DEFINE_ROUTE: Readonly<Record<string, string>> = {
  // Liveness。認証が無く、返すのは `{ status: 'ok' }` だけ。
  'api/health/route.ts': '認証が無く、返すのは { status: ok } だけ',
  // Readiness。認証が無く、返すのは DB への到達の真偽だけ。
  'api/ready/route.ts': '認証が無く、返すのは DB への到達の真偽だけ',
  // API 仕様。既に `Cache-Control: no-store` を自分で付けている。
  'api/v1/openapi.json/route.ts': '既に no-store が付いている',
  // 計測スクリプト。測る側のサイトの全ページから読まれる配布物で、保存させるのが意図（018 設計 §3.4）。
  't.js/route.ts': '保存させる配布物。認証も利用者のデータも無い',
};

/** この文字の後の `/` は割り算ではなく正規表現のリテラルの始まり（`previous` が空＝ファイルの頭）。 */
const REGEX_PRECEDERS = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);

/**
 * コードの部分だけを残す：コメントを落とし、文字列・テンプレート・正規表現のリテラルの中身を空白にする
 * （テンプレートの `${…}` の中はコードとして残す）。文字列の中の `//`（URL）をコメントと取り違えず、
 * 文字列の中の `'defineRoute('`・`'export …'` を数えない。
 */
function codeOf(source: string): string {
  let out = '';
  let index = 0;
  /** 直前の空白でない文字（識別子・`)`・`]` は `w`）。正規表現と割り算の見分けに使う。 */
  let previous = '';
  /** テンプレートの `${` の中にいるときの、`{` の深さの積み。 */
  const templateDepths: number[] = [];

  const skipQuoted = (quote: string): void => {
    out += quote;
    index += 1;
    while (index < source.length && source[index] !== quote && source[index] !== '\n') {
      if (source[index] === '\\') {
        out += ' ';
        index += 1;
      }
      out += ' ';
      index += 1;
    }
    out += quote;
    index += 1;
  };

  /** `` ` `` か、`${…}` を閉じた `}` の位置から、テンプレートの終わりか次の `${` まで。 */
  const skipTemplate = (): void => {
    out += source[index];
    index += 1;
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        out += '  ';
        index += 2;
      } else if (char === '`') {
        out += '`';
        index += 1;
        return;
      } else if (char === '$' && source[index + 1] === '{') {
        out += '${';
        index += 2;
        templateDepths.push(0);
        return;
      } else {
        out += char === '\n' ? '\n' : ' ';
        index += 1;
      }
    }
  };

  const skipRegex = (): void => {
    out += '/';
    index += 1;
    let inClass = false;
    while (index < source.length && source[index] !== '\n') {
      const char = source[index];
      if (char === '\\') {
        out += '  ';
        index += 2;
        continue;
      }
      if (char === '/' && !inClass) break;
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      out += ' ';
      index += 1;
    }
    out += '/';
    index += 1;
  };

  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      out += ' ';
    } else if (char === "'" || char === '"') {
      skipQuoted(char);
      previous = 'w';
    } else if (char === '`') {
      skipTemplate();
      previous = 'w';
    } else if (char === '/' && REGEX_PRECEDERS.has(previous)) {
      skipRegex();
      previous = 'w';
    } else {
      const top = templateDepths.length - 1;
      if (top >= 0 && char === '}' && templateDepths[top] === 0) {
        templateDepths.pop();
        skipTemplate();
        previous = 'w';
        continue;
      }
      if (top >= 0 && char === '{') templateDepths[top] = (templateDepths[top] ?? 0) + 1;
      if (top >= 0 && char === '}') templateDepths[top] = (templateDepths[top] ?? 0) - 1;
      out += char;
      index += 1;
      if (!/\s/.test(char)) previous = /[\w$)\]]/.test(char) ? 'w' : char;
    }
  }
  return out;
}

function usesDefineRoute(source: string): boolean {
  return codeOf(source).includes('defineRoute(');
}

const EXPORT_KEYWORD = /(?<![\w$.])export\b/g;
const DEFINE_ROUTE_EXPORT = /^export\s+const\s+(?:GET|POST|PUT|PATCH|DELETE)\s*=\s*defineRoute\(/;

/** `export` の数（コメント・文字列の中は数えない）。 */
function exportCount(source: string): number {
  return [...codeOf(source).matchAll(EXPORT_KEYWORD)].length;
}

/**
 * `export` のうち `export const <METHOD> = defineRoute(` の形でないものの、その行の頭から行末まで
 * （コメント・文字列の中は数えない。返す字面は `codeOf` の後のもので、文字列の中身は空白になっている）。
 */
function exportsOutsideDefineRoute(source: string): string[] {
  const code = codeOf(source);
  return [...code.matchAll(EXPORT_KEYWORD)]
    .filter((match) => !DEFINE_ROUTE_EXPORT.test(code.slice(match.index)))
    .map((match) => code.slice(match.index).split('\n')[0]?.trim() ?? '');
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

async function filesIn(dir: string, predicate: (name: string) => boolean): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('defineRoute を通らないルート（§10.5）', () => {
  /** #33 */
  it('#33 defineRoute( を使わない route.ts が許可の一覧と双方向で一致する', async () => {
    const routes = await filesIn(APP_DIR, (name) => name === 'route.ts');
    expect(routes.length, 'route.ts が 1 つも見つからない').toBeGreaterThan(0);

    const withoutDefineRoute = routes
      .filter((file) => !usesDefineRoute(readFileSync(file, 'utf8')))
      .map((file) => toPosix(relative(APP_DIR, file)))
      .sort();

    expect(withoutDefineRoute).toEqual(Object.keys(ROUTES_WITHOUT_DEFINE_ROUTE).sort());
  });

  /** #33 */
  it('#33 defineRoute( を使う route.ts の export はすべて export const <METHOD> = defineRoute( の形', async () => {
    const routes = (await filesIn(APP_DIR, (name) => name === 'route.ts')).filter((file) =>
      usesDefineRoute(readFileSync(file, 'utf8')),
    );
    expect(routes.length, 'defineRoute( を使う route.ts が 1 つも見つからない').toBeGreaterThan(0);

    const offenders = routes.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const path = toPosix(relative(APP_DIR, file));
      if (exportCount(source) === 0) return [`${path}: export が無い`];
      return exportsOutsideDefineRoute(source).map((head) => `${path}: ${head}`);
    });

    expect(offenders).toEqual([]);
  });

  it('#33 判別力：defineRoute の route.ts に素の export async function POST を足した写しは落ちる', () => {
    const original = readFileSync(join(APP_DIR, 'api/v1/auth/csrf/route.ts'), 'utf8');
    expect(usesDefineRoute(original)).toBe(true);
    expect(exportsOutsideDefineRoute(original)).toEqual([]);

    const mutated = `${original}\nexport async function POST() {\n  return new Response(null);\n}\n`;
    expect(usesDefineRoute(mutated)).toBe(true);
    expect(exportsOutsideDefineRoute(mutated)).toEqual(['export async function POST() {']);
  });

  it('#33 判別力：export default・export { }・defineRoute でない export const も形に合わない', () => {
    const head =
      "import { defineRoute } from '@/api/route';\nexport const GET = defineRoute({ path: '/x' });\n";
    expect(exportsOutsideDefineRoute(head)).toEqual([]);
    expect(exportsOutsideDefineRoute(`${head}export default function handler() {}\n`)).toHaveLength(
      1,
    );
    expect(
      exportsOutsideDefineRoute(`${head}const POST = () => new Response();\nexport { POST };\n`),
    ).toHaveLength(1);
    expect(
      exportsOutsideDefineRoute(`${head}export const POST = async () => new Response();\n`),
    ).toHaveLength(1);
    expect(exportsOutsideDefineRoute(`${head}export function PUT() {}\n`)).toHaveLength(1);
  });

  it('#33 判別力：文字列・テンプレート・コメントの中の defineRoute( では使うことにならない', () => {
    const fake = [
      "const note = 'defineRoute(';",
      'const other = "defineRoute(";',
      'const tpl = `defineRoute(`;',
      '// defineRoute(',
      '/* defineRoute( */',
      'export async function GET() {',
      '  return new Response(null);',
      '}',
    ].join('\n');
    expect(usesDefineRoute(fake)).toBe(false);
  });

  it('#33 判別力：文字列の中の //（URL）の後ろのコードを取りこぼさない', () => {
    // 粗い取り除き方（`//` から行末まで）では URL の後ろが消え、同じ行の `defineRoute(` が見えなくなる
    const sameLine = "const u = 'https://example.com/a'; export const GET = defineRoute({});\n";
    expect(usesDefineRoute(sameLine)).toBe(true);
    expect(exportsOutsideDefineRoute(sameLine)).toEqual([]);

    const hidden =
      "export const GET = defineRoute({ url: 'https://example.com/a' }); export function POST() {}\n";
    expect(exportsOutsideDefineRoute(hidden)).toEqual(['export function POST() {}']);
  });

  it('#33 判別力：コメント・文字列・テンプレート・正規表現の中の export は数えず、${} の中のコードは残す', () => {
    const source = [
      "import { defineRoute } from '@/api/route';",
      '// export async function POST() {}',
      '/* export function PUT() {} */',
      "const a = 'export function PATCH() {}';",
      'const b = `export default ${defineRoute.name}`;',
      'const re = /export function/;',
      'export const GET = defineRoute({});',
    ].join('\n');
    expect(exportCount(source)).toBe(1);
    expect(exportsOutsideDefineRoute(source)).toEqual([]);
    expect(codeOf(source)).toContain('${defineRoute.name}');
  });
});

describe('ヘッダの変えられない応答（§10.5）', () => {
  /** #34 */
  it('#34 app/api/** と api/**（テストを除く）に Response.redirect( ・ Response.error( が無い', async () => {
    const isSource = (name: string): boolean => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name);
    const files = [
      ...(await filesIn(APP_API_DIR, isSource)),
      ...(await filesIn(API_DIR, isSource)),
    ];
    expect(files.length, '検査するファイルが 1 つも見つからない').toBeGreaterThan(0);

    const offenders = files
      .filter((file) => /\bResponse\.(redirect|error)\(/.test(codeOf(readFileSync(file, 'utf8'))))
      .map((file) => toPosix(relative(SRC_DIR, file)));

    expect(offenders).toEqual([]);
  });
});
