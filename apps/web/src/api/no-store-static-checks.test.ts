import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `Cache-Control: no-store` の付与の外に出るルートを固定する静的検査（058-api-no-store 設計 §5.5・§14、受け入れ条件 #33・#34）。
 *
 * - #33：`defineRoute(` を使わない `route.ts` は許可の一覧の 4 つだけ。**双方向で一致**させる（足しても消しても落ちる）。
 *   `defineRoute` を通らないルートには出口の `no-store` が付かないので、新しく足すなら一覧に足して理由を書く
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

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
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
      .filter((file) => !withoutComments(readFileSync(file, 'utf8')).includes('defineRoute('))
      .map((file) => toPosix(relative(APP_DIR, file)))
      .sort();

    expect(withoutDefineRoute).toEqual(Object.keys(ROUTES_WITHOUT_DEFINE_ROUTE).sort());
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
      .filter((file) =>
        /\bResponse\.(redirect|error)\(/.test(withoutComments(readFileSync(file, 'utf8'))),
      )
      .map((file) => toPosix(relative(SRC_DIR, file)));

    expect(offenders).toEqual([]);
  });
});
