import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 原型の名前をキーにした辞書の読み書きの静的検査
 * （047-prototype-key-sweep 設計 §4.1・§10.4、受け入れ条件 #12・#13）。
 *
 * * #12：角括弧で引いた先を `??=`・`||=` で空の配列・オブジェクトに初期化する形
 *   （`(obj[key] ??= []).push(...)`）を、テスト以外のソースで禁じる。素のオブジェクトでこう書くと、
 *   キーが `constructor` のとき `??=` が代入せず TypeError になる（設計 §1.1）。`Map` で書く。
 *   変更前に当たるのは K1（`role-repository.ts`）と K17（`openapi.ts`）の 2 つだけ（設計 §10.4 の注）
 * * #13：直したファイルに旧い読み方が残っていないことと、`ownValue` を値として import していること
 *
 * `withoutComments` は `application/analytics/static-checks.test.ts` の形を写した。
 * 文字列の中の `//`（URL）より後ろが走査から漏れるのは受け入れる（実装プラン §7 の 1）。
 */

/** apps/web/src/application → apps/web/src */
const SRC_DIR = join(import.meta.dirname, '..');
/** apps/web/src → リポジトリのルート */
const REPO_ROOT = join(SRC_DIR, '..', '..', '..');

function read(...segments: string[]): string {
  return readFileSync(join(SRC_DIR, ...segments), 'utf8');
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

/* -------------------------------------------------------------------------- */
/* #12 走査                                                                     */
/* -------------------------------------------------------------------------- */

/** 設計 #12 の形。 */
const LAZY_INIT_PATTERN = /\]\s*(\?\?|\|\|)=\s*[[{]/;

/** 辿らないディレクトリ。 */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'test-support']);

/** 生成物（`pnpm generate:plugins`。Git 管理外で、在っても無くても結果を変えない）。 */
const GENERATED_FILES = new Set(['apps/web/src/plugin/generated-registry.ts']);

function isScannedFile(name: string): boolean {
  if (!/\.(ts|tsx)$/.test(name)) return false;
  if (/\.(test|spec)\./.test(name)) return false;
  return true;
}

/** `dir` 以下の走査対象を、リポジトリのルートからの相対パス（`/` 区切り）で返す。 */
function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      found.push(...sourceFiles(path));
    } else if (entry.isFile() && isScannedFile(entry.name)) {
      const relativePath = relative(REPO_ROOT, path).split(sep).join('/');
      if (!GENERATED_FILES.has(relativePath)) {
        found.push(relativePath);
      }
    }
  }
  return found;
}

/** 設計 #12 の範囲：`apps/web/src`・`packages/*\/src`・`plugins/*`。 */
function scannedFiles(): string[] {
  const packagesDir = join(REPO_ROOT, 'packages');
  const pluginsDir = join(REPO_ROOT, 'plugins');
  const packageSources = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => sourceFiles(join(packagesDir, entry.name, 'src')));
  const pluginSources = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => sourceFiles(join(pluginsDir, entry.name)));
  return [...sourceFiles(SRC_DIR), ...packageSources, ...pluginSources].sort();
}

/** 当たった箇所を `ファイル:行: 本文` で返す（行番号はコメントを除いた本文のもの）。 */
function lazyInitializations(files: readonly string[]): string[] {
  const hits: string[] = [];
  const pattern = new RegExp(LAZY_INIT_PATTERN.source, 'g');
  for (const file of files) {
    // 行ごとではなく本文全体に掛ける（`]` と `??=` の間の改行も `\s*` に含める）。
    const body = withoutComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
    for (const match of body.matchAll(pattern)) {
      const line = body.slice(0, match.index).split('\n').length;
      const text = body.split('\n')[line - 1] ?? '';
      hits.push(`${file}:${line}: ${text.trim()}`);
    }
  }
  return hits;
}

describe('#12 角括弧で引いた先を ??=・||= で空の配列・オブジェクトに初期化する形が無い', () => {
  it('#12 走査したファイルが 300 以上（空振りで緑にしない）', () => {
    expect(scannedFiles().length).toBeGreaterThanOrEqual(300);
  });

  it('#12 生成物・テスト・test-support を走査しない', () => {
    const files = scannedFiles();

    expect(files).not.toContain('apps/web/src/plugin/generated-registry.ts');
    expect(files.filter((file) => /\.(test|spec)\./.test(file))).toEqual([]);
    expect(files.filter((file) => file.includes('/test-support/'))).toEqual([]);
    expect(files.filter((file) => file.includes('/node_modules/'))).toEqual([]);
  });

  it('#12 テスト以外のソースに「] の後の ??=・||= で [ か { を置く形」が 1 つも無い', () => {
    // 当たったらファイル名と行を失敗の文言に出す（実装プラン T9）。
    expect(lazyInitializations(scannedFiles())).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* #13 直したファイル                                                            */
/* -------------------------------------------------------------------------- */

/** 設計 #13：ファイル → 残っていてはいけない旧い読み方。 */
const OLD_READS: readonly (readonly [string, string])[] = [
  ['infrastructure/role-repository.ts', 'grants['],
  ['ui/settings/permission-matrix.tsx', 'grants['],
  ['domain/social/social.ts', 'overrides?.['],
  ['domain/social/social.ts', 'PROVIDER_LABELS['],
  ['ui/social/social-accounts.tsx', 'providerLabels['],
  ['ui/social/social-posts.tsx', 'publisherProviders['],
  ['domain/permission.ts', 'PERMISSION_DESCRIPTIONS as Record'],
];

/** 設計 #13：`ownValue` を値として import するファイルと、認める import 元。 */
const OWN_VALUE_IMPORTERS: readonly (readonly [string, readonly string[]])[] = [
  ['ui/settings/permission-matrix.tsx', ['@/domain/own-value']],
  ['ui/social/social-accounts.tsx', ['@/domain/own-value']],
  ['ui/social/social-posts.tsx', ['@/domain/own-value']],
  // `domain/` の中は相対でもよい（設計 #13）。
  ['domain/social/social.ts', ['@/domain/own-value', '../own-value']],
  ['domain/permission.ts', ['@/domain/own-value', './own-value']],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('#13 直したファイルに旧い読み方が無い', () => {
  it.each(OLD_READS)('#13 %s に %s が無い', (file, oldRead) => {
    expect(withoutComments(read(...file.split('/')))).not.toContain(oldRead);
  });
});

describe('#13 直したファイルが ownValue を値として import している', () => {
  it.each(OWN_VALUE_IMPORTERS)('#13 %s が ownValue を %j から import する', (file, sources) => {
    const source = withoutComments(read(...file.split('/')));
    const from = sources.map(escapeRegExp).join('|');
    // 値として呼ぶので `import type { ownValue }` も `{ type ownValue }` も認めない。
    const valueImport = new RegExp(
      `import\\s*\\{([^}]*\\bownValue\\b[^}]*)\\}\\s*from\\s*['"](?:${from})['"]`,
    );

    const match = valueImport.exec(source);

    expect(match).not.toBeNull();
    expect(match?.[1] ?? '').not.toMatch(/\btype\s+ownValue\b/);
  });
});
