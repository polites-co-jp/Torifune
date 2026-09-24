import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as labels from './labels';

/**
 * `ui/help/` の静的検査（041-plugin-help-docs 設計 §7.3.2・§4.2・§7.7、受け入れ条件 #30・#65・#73）。
 *
 * * #30：**HTML の文字列を経由しない**。`dangerouslySetInnerHTML` を使えば Markdown の描画の安全が
 *   文字列の上の確かめになり、`rehype-raw` を入れれば手順書の生の HTML が要素として描かれる（設計 §3.2・§4.2）
 * * #65：Markdown の描画はサーバだけで行う。`markdown-view.tsx` と `react-markdown` / `remark-gfm` / `rehype-slug` を
 *   import するファイルは `'use client'` を持たず、`'use client'` を持つどのファイルからも**直接** import されない
 *   （推移的な持ち込みは実装プラン T27 の 2 がバンドルの中身で確かめる）
 * * #73：§7.7 の文言を部品に直書きしない（`labels.ts` から読む）
 *
 * 「無いこと」を見る検査は、対象が空なら素通りする。**検査の関数そのものが禁止の綴りを見つけられること**
 * （判別力）を、禁止の綴りを 1 つ足した写しで確かめる（実装プラン T18 の注意）。
 */

const HELP_DIR = import.meta.dirname;
const SRC_DIR = resolve(HELP_DIR, '..', '..');

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

/* -------------------------------------------------------------------------- */
/* #65 'use client' との境界                                                    */
/* -------------------------------------------------------------------------- */

/** `apps/web/src/` の `.ts` / `.tsx`（テストを除く）。 */
function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      files.push(...sourceFiles(path));
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue;
    files.push(path);
  }
  return files;
}

/** ファイルの先頭の指令として `'use client'` を持つか（1 行だけの `'use client'` / `"use client"`）。 */
function hasUseClient(source: string): boolean {
  return /^\s*(['"])use client\1;?\s*$/m.test(source);
}

/** import の指定子（`from '…'`・`import '…'`・`import('…')`・`export … from '…'`）。 */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"]+)\1/g)].map(
    (match) => match[2] ?? '',
  );
}

const MARKDOWN_PACKAGES = ['react-markdown', 'remark-gfm', 'rehype-slug'] as const;

function isMarkdownPackage(specifier: string): boolean {
  return MARKDOWN_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

function isMarkdownView(specifier: string): boolean {
  return /(^|\/)markdown-view(\.tsx?)?$/.test(specifier);
}

/** Markdown の描画の部品か、その解釈器を直接 import しているか。 */
function importsMarkdownRenderer(source: string): boolean {
  return importSpecifiers(source).some(
    (specifier) => isMarkdownPackage(specifier) || isMarkdownView(specifier),
  );
}

function importsMarkdownPackage(source: string): boolean {
  return importSpecifiers(source).some(isMarkdownPackage);
}

interface SourceFile {
  readonly name: string;
  readonly source: string;
}

function allSources(): SourceFile[] {
  return sourceFiles(SRC_DIR).map((path) => ({
    name: relative(SRC_DIR, path).split(sep).join('/'),
    source: readFileSync(path, 'utf8'),
  }));
}

describe('#65 検査の関数の判別力', () => {
  it("#65 'use client' を先頭に持つ写しを見分ける", () => {
    expect(hasUseClient("'use client';\n\nimport x from 'y';\n")).toBe(true);
    expect(hasUseClient('"use client"\nexport const a = 1;\n')).toBe(true);
    expect(hasUseClient("import x from 'y';\n// 'use client' とは書かない\n")).toBe(false);
  });

  it('#65 markdown-view の import を見分ける（別名のパスでも）', () => {
    expect(importsMarkdownRenderer("import { MarkdownView } from '@/ui/help/markdown-view';")).toBe(
      true,
    );
    expect(importsMarkdownRenderer("import { MarkdownView } from './markdown-view';")).toBe(true);
    expect(
      importsMarkdownRenderer("import { MarkdownView } from '../help/markdown-view.tsx';"),
    ).toBe(true);
    expect(importsMarkdownRenderer("import { HelpLink } from '@/ui/help/help-link';")).toBe(false);
  });

  it('#65 3 つのパッケージの import を見分ける（下位のパスと動的な import を含む）', () => {
    expect(importsMarkdownPackage("import Markdown from 'react-markdown';")).toBe(true);
    expect(importsMarkdownPackage("import remarkGfm from 'remark-gfm';")).toBe(true);
    expect(importsMarkdownPackage("import rehypeSlug from 'rehype-slug';")).toBe(true);
    expect(importsMarkdownPackage("const m = await import('react-markdown');")).toBe(true);
    expect(importsMarkdownPackage("import { x } from 'react-markdown/lib/index.js';")).toBe(true);
    expect(importsMarkdownPackage("import { x } from 'react-markdown-extra';")).toBe(false);
  });
});

describe("#65 Markdown の描画は 'use client' の外にある", () => {
  it('#65 markdown-view.tsx がある（空の集合で素通りしない）', () => {
    expect(existsSync(join(HELP_DIR, 'markdown-view.tsx'))).toBe(true);
  });

  it("#65 markdown-view.tsx は 'use client' を持たない", () => {
    expect(hasUseClient(readFileSync(join(HELP_DIR, 'markdown-view.tsx'), 'utf8'))).toBe(false);
  });

  it('#65 3 つのパッケージを import するファイルが少なくとも 1 つある（markdown-view.tsx）', () => {
    const importers = allSources()
      .filter((file) => importsMarkdownPackage(file.source))
      .map((file) => file.name);

    expect(importers).toContain('ui/help/markdown-view.tsx');
  });

  it("#65 3 つのパッケージを import するどのファイルも 'use client' を持たない", () => {
    for (const file of allSources().filter((f) => importsMarkdownPackage(f.source))) {
      expect(hasUseClient(file.source), file.name).toBe(false);
    }
  });

  it("#65 'use client' を持つファイルが検査の対象にある（social-accounts.tsx を含む）", () => {
    const clients = allSources()
      .filter((file) => hasUseClient(file.source))
      .map((file) => file.name);

    expect(clients).toContain('ui/social/social-accounts.tsx');
  });

  it("#65 'use client' を持つどのファイルも markdown-view と 3 つのパッケージを直接 import しない", () => {
    for (const file of allSources().filter((f) => hasUseClient(f.source))) {
      expect(importsMarkdownRenderer(file.source), file.name).toBe(false);
    }
  });

  it("#65 'use client' の部品から import されるヘルプボタン（help-link.tsx）と文言（labels.ts）も Markdown の部品を import しない", () => {
    // `social-accounts.tsx`（'use client'）が直接 import する 2 つ。ここから持ち込めばブラウザのバンドルに入る
    // （実装プラン T9 の注意・§7 の 7）。
    for (const name of ['help-link.tsx', 'labels.ts']) {
      const path = join(HELP_DIR, name);
      expect(existsSync(path), name).toBe(true);
      expect(importsMarkdownRenderer(readFileSync(path, 'utf8')), name).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #73 文言の直書き                                                              */
/* -------------------------------------------------------------------------- */

/** コメントを除く（コメントの中の言葉は画面に出ないので数えない）。URL の `//` は残す。 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/**
 * 画面に出る文言の直書きの有無。
 *
 * 長い文言は字面の一部として現れれば直書きとみなす。短い語（「手順書」「プラグイン」など）は
 * 文の一部に自然に現れる（例：「連携プラグインが行います」）ので、**その語だけの文字列リテラル・
 * JSX の文字**として現れたときだけ直書きとみなす。
 */
function hardCodedLabels(source: string, values: readonly string[]): string[] {
  const code = withoutComments(source);
  return values.filter((value) => {
    if (value.length >= 8) return code.includes(value);
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 左が文字列・JSX の区切り（' " ` > }）、右も区切り（' " ` < { $）のときだけ。
    return new RegExp(`[>}'"\`]\\s*${escaped}\\s*[<{'"\`$]`).test(code);
  });
}

/** `labels.ts` の文言（関数の文言は、引数を差し込む前後の固定の部分）。 */
function labelValues(): string[] {
  const constants = (Object.values(labels) as unknown[]).filter(
    (value): value is string => typeof value === 'string',
  );
  const fromFunctions = [
    // helpDocSubtitle(name, id, version) → 「<Plugin名>（<id> <version>）の手順書」
    ...fixedPartsOf(labels.helpDocSubtitle('\u0000', '\u0000', '\u0000')),
    // helpIndexHeading(name) → 「<Plugin名> の手順書」
    ...fixedPartsOf(labels.helpIndexHeading('\u0000')),
    // imagePlaceholder(alt) → 「［画像：<alt>］」「［画像］」
    ...fixedPartsOf(labels.imagePlaceholder('\u0000')),
    labels.imagePlaceholder(''),
  ];
  return [...new Set([...constants, ...fromFunctions])];
}

/** 差し込み（`\u0000`）の間の固定の部分のうち、括弧だけ・空白だけでないもの。 */
function fixedPartsOf(rendered: string): string[] {
  return rendered
    .split('\u0000')
    .map((part) => part.trim())
    .filter((part) => /[^\s（）()［］]/.test(part));
}

/** #73 の対象：`ui/help/` の `.ts` / `.tsx`（`labels.ts`・テストを除く）と `social-accounts.tsx`。 */
function labelCheckTargets(): SourceFile[] {
  const helpFiles = implementationFiles(HELP_DIR)
    .filter((path) => /\.tsx?$/.test(path))
    .filter((path) => relative(HELP_DIR, path) !== 'labels.ts');
  const socialAccounts = resolve(HELP_DIR, '..', 'social', 'social-accounts.tsx');
  return [...helpFiles, socialAccounts].map((path) => ({
    name: relative(SRC_DIR, path).split(sep).join('/'),
    source: readFileSync(path, 'utf8'),
  }));
}

describe('#73 検査の関数の判別力', () => {
  it('#73 labels.ts の文言が取り出せる（空の集合で素通りしない）', () => {
    const values = labelValues();

    expect(values).toContain('新しいタブで開きます。入力中の内容はこの画面に残ります。');
    expect(values).toContain('この Plugin には、この画面で変える設定がありません。');
    expect(values).toContain('手順書：');
    expect(values).toContain('プラグインの設定へ戻る');
    expect(values).toContain('［画像］');
  });

  it('#73 長い文言の直書きを見つける', () => {
    const copy =
      'export const x = <p>新しいタブで開きます。入力中の内容はこの画面に残ります。</p>;\n';

    expect(hardCodedLabels(copy, labelValues())).toContain(
      '新しいタブで開きます。入力中の内容はこの画面に残ります。',
    );
  });

  it('#73 短い語だけの文字列リテラル・JSX の文字を見つける', () => {
    expect(hardCodedLabels("const h = '手順書';", ['手順書'])).toEqual(['手順書']);
    expect(hardCodedLabels('<h2>手順書</h2>', ['手順書'])).toEqual(['手順書']);
    expect(hardCodedLabels('<a href="/plugins">プラグイン</a>', ['プラグイン'])).toEqual([
      'プラグイン',
    ]);
    expect(hardCodedLabels('<span>手順書：{title}</span>', ['手順書：'])).toEqual(['手順書：']);
    expect(hardCodedLabels('<h1>{name} の手順書</h1>', ['の手順書'])).toEqual(['の手順書']);
    expect(hardCodedLabels('const t = `［画像：${alt}］`;', ['［画像：'])).toEqual(['［画像：']);
  });

  it('#73 文の一部やコメントの中の短い語は数えない', () => {
    expect(hardCodedLabels('<p>連携プラグインが行います。</p>', ['プラグイン'])).toEqual([]);
    expect(hardCodedLabels('// 手順書を開く\nconst a = 1;', ['手順書'])).toEqual([]);
    expect(hardCodedLabels("/** '手順書' */\nconst a = 1;", ['手順書'])).toEqual([]);
  });

  it('#73 labels.ts から import して使う書き方は直書きとみなさない', () => {
    const copy =
      "import { HELP_SETTINGS_HEADING } from './labels';\nexport const h = <h2>{HELP_SETTINGS_HEADING}</h2>;\n";

    expect(hardCodedLabels(copy, labelValues())).toEqual([]);
  });
});

describe('#73 §7.7 の文言を部品に直書きしない', () => {
  it('#73 検査の対象に設計・実装プランが名指しした部品が含まれる', () => {
    const names = labelCheckTargets().map((file) => file.name);

    expect(names).toContain('ui/help/help-link.tsx');
    expect(names).toContain('ui/help/markdown-view.tsx');
    expect(names).toContain('ui/help/help-document.tsx');
    expect(names).toContain('ui/help/plugin-settings-help.tsx');
    expect(names).toContain('ui/social/social-accounts.tsx');
  });

  it('#73 どの部品にも labels.ts の文言が直書きで現れない', () => {
    const values = labelValues();

    for (const file of labelCheckTargets()) {
      expect(hardCodedLabels(file.source, values), file.name).toEqual([]);
    }
  });
});
